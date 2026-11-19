/**
 * GMGN trending (best effort).
 *
 * GMGN has no official public API; its site endpoints sit behind Cloudflare and
 * change without notice. This polls the trending-swaps ranking and quietly
 * disables itself after repeated failures so the rest of the bot keeps working.
 * If you get blocked, set ENABLE_GMGN=false or swap in a paid data provider.
 */
import { EventEmitter } from "node:events";
import { log } from "../log.js";
import type { ExternalTokenEvent } from "../types.js";

const URL =
  "https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h?orderby=swaps&direction=desc" +
  "&filters[]=renounced&filters[]=frozen";

export class GmgnSource extends EventEmitter<{ token: [ExternalTokenEvent] }> {
  private timer?: NodeJS.Timeout;
  private failures = 0;
  private seen = new Map<string, number>();

  constructor(private intervalMs = 60_000) {
    super();
  }

  start() {
    const tick = () => this.poll();
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }
  stop() {
    clearInterval(this.timer);
  }

  private async poll() {
    try {
      const res = await fetch(URL, {
        signal: AbortSignal.timeout(10_000),
        headers: {
          accept: "application/json",
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
          referer: "https://gmgn.ai/",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j: any = await res.json();
      const rows: any[] = j?.data?.rank ?? j?.data ?? [];
      if (!Array.isArray(rows)) throw new Error("unexpected response shape");
      this.failures = 0;
      const now = Date.now();
      for (const r of rows.slice(0, 50)) {
        const mint = r.address ?? r.token_address;
        if (!mint) continue;
        // re-emit a token at most every 30 min while it stays trending
        if (now - (this.seen.get(mint) ?? 0) < 30 * 60_000) continue;
        this.seen.set(mint, now);
        this.emit("token", {
          mint,
          source: "gmgn",
          name: r.name,
          symbol: r.symbol,
          socials: {
            twitter: r.twitter_username ? `https://x.com/${r.twitter_username}` : undefined,
            telegram: r.telegram || undefined,
            website: r.website || undefined,
          },
        });
      }
    } catch (e: any) {
      this.failures++;
      log.warn(`gmgn: ${e.message} (${this.failures}/5)`);
      if (this.failures >= 5) {
        log.warn("gmgn: disabling after repeated failures (likely Cloudflare). Bot continues without it.");
        this.stop();
      }
    }
  }
}
