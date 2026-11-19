/**
 * DexScreener public API (no key). Docs: https://docs.dexscreener.com/api/reference
 *  - token-profiles/latest: teams that just PAID for a DexScreener profile
 *  - token-boosts/latest:   tokens that just PAID for boosts (trending push)
 *  - tokens/v1/solana/<mints>: live pair stats (price, liquidity, txns)
 * Profile/boost payments are a common "callout" signal: someone is spending
 * money to promote the token right now.
 */
import { EventEmitter } from "node:events";
import { log } from "../log.js";
import type { ExternalTokenEvent, PairStats } from "../types.js";

const BASE = "https://api.dexscreener.com";

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function socialsFrom(links: any[] | undefined) {
  const s: ExternalTokenEvent["socials"] = {};
  for (const l of links ?? []) {
    const type = String(l.type ?? l.label ?? "").toLowerCase();
    if (type.includes("twitter") || /x\.com|twitter\.com/.test(l.url)) s.twitter ??= l.url;
    else if (type.includes("telegram") || /t\.me/.test(l.url)) s.telegram ??= l.url;
    else if (type.includes("website") || !type) s.website ??= l.url;
  }
  return s;
}

export class DexScreenerSource extends EventEmitter<{ token: [ExternalTokenEvent] }> {
  private seen = new Map<string, number>(); // key -> last emit
  private timer?: NodeJS.Timeout;

  constructor(private intervalMs = 20_000) {
    super();
  }

  start() {
    const tick = () => this.poll().catch((e) => log.warn("dexscreener:", e.message));
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }
  stop() {
    clearInterval(this.timer);
  }

  private async poll() {
    const [profiles, boosts] = await Promise.all([
      getJson(`${BASE}/token-profiles/latest/v1`).catch(() => []),
      getJson(`${BASE}/token-boosts/latest/v1`).catch(() => []),
    ]);
    for (const p of arr(profiles)) {
      if (p.chainId !== "solana") continue;
      this.emitOnce(`p:${p.tokenAddress}`, {
        mint: p.tokenAddress,
        source: "dexscreener-profile",
        description: p.description,
        socials: socialsFrom(p.links),
      });
    }
    for (const b of arr(boosts)) {
      if (b.chainId !== "solana") continue;
      // re-emit when the boost total grows (new payment)
      this.emitOnce(`b:${b.tokenAddress}:${b.totalAmount ?? b.amount}`, {
        mint: b.tokenAddress,
        source: "dexscreener-boost",
        description: b.description,
        socials: socialsFrom(b.links),
        boostAmount: Number(b.totalAmount ?? b.amount ?? 0),
      });
    }
    // keep the dedupe map bounded
    const cutoff = Date.now() - 6 * 3600_000;
    for (const [k, t] of this.seen) if (t < cutoff) this.seen.delete(k);
  }

  private emitOnce(key: string, ev: ExternalTokenEvent) {
    if (this.seen.has(key)) return;
    this.seen.set(key, Date.now());
    this.emit("token", ev);
  }
}

function arr(x: any): any[] {
  return Array.isArray(x) ? x : [];
}

/** Best SOL-quoted pair stats for up to 30 mints. */
export async function fetchPairs(mints: string[]): Promise<Map<string, PairStats & { name: string; symbol: string }>> {
  const out = new Map<string, PairStats & { name: string; symbol: string }>();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    const pairs = arr(await getJson(`${BASE}/tokens/v1/solana/${chunk.join(",")}`));
    for (const p of pairs) {
      const mint = p.baseToken?.address;
      if (!mint) continue;
      const liq = Number(p.liquidity?.usd ?? 0);
      const prev = out.get(mint);
      if (prev && prev.liquidityUsd >= liq) continue;
      const quote = String(p.quoteToken?.symbol ?? "");
      out.set(mint, {
        name: p.baseToken?.name ?? "",
        symbol: p.baseToken?.symbol ?? "",
        pairAddress: p.pairAddress,
        dexId: p.dexId,
        // priceNative is in quote units; only meaningful as SOL when quote is SOL
        priceNative: quote === "SOL" ? Number(p.priceNative) : 0,
        priceUsd: Number(p.priceUsd ?? 0),
        liquidityUsd: liq,
        marketCapUsd: Number(p.marketCap ?? p.fdv ?? 0),
        ageHours: p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3600_000 : 999,
        m5Buys: Number(p.txns?.m5?.buys ?? 0),
        m5Sells: Number(p.txns?.m5?.sells ?? 0),
        h1Buys: Number(p.txns?.h1?.buys ?? 0),
        h1Sells: Number(p.txns?.h1?.sells ?? 0),
        m5VolumeUsd: Number(p.volume?.m5 ?? 0),
        h1PriceChangePct: Number(p.priceChange?.h1 ?? 0),
        quoteSymbol: quote,
      });
    }
  }
  return out;
}
