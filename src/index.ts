/**
 * memesniper — narrative-driven Solana meme coin sniper.
 *
 *   pump.fun launches ─┐                         ┌─ hard safety gates ─┐
 *   DexScreener paid ──┼─► narrative tracker ──► score ────────────────┼─► buy ─► exits (TP/SL/trail/time)
 *   GMGN trending ─────┘   (what's hot now)                            │
 *                                                       paper or live executor
 */
import { config } from "./config.js";
import { log, record } from "./log.js";
import { NarrativeTracker } from "./narrative.js";
import { notify } from "./notify.js";
import { MockSafetyChecker, SafetyChecker } from "./safety.js";
import { scoreCandidate } from "./scorer.js";
import { DexScreenerSource, fetchPairs } from "./sources/dexscreener.js";
import { GmgnSource } from "./sources/gmgn.js";
import { MockPumpSource } from "./sources/mock.js";
import { fetchMetadata, PumpFunSource } from "./sources/pumpfun.js";
import { LiveExecutor, PaperExecutor, type Executor } from "./trader/executor.js";
import { PositionManager } from "./trader/positions.js";
import type { Candidate, ExternalTokenEvent, NewTokenEvent, Source } from "./types.js";

const simulate = process.argv.includes("--simulate");
if (simulate) {
  Object.assign(config, {
    mode: "paper",
    watchSeconds: 8,
    maxHoldMinutes: 3,
    enableDexScreener: false,
    enableGmgn: false,
    telegramBotToken: "",
    dataDir: config.dataDir,
  });
}

// ---------- wiring ----------
if (config.mode === "live" && config.liveConfirm !== "yes-i-understand") {
  console.error("MODE=live requires LIVE_CONFIRM=yes-i-understand in .env. Run in paper mode first.");
  process.exit(1);
}
const exec: Executor = config.mode === "live" ? new LiveExecutor() : new PaperExecutor();
const positions = new PositionManager(exec, notify);
const narratives = new NarrativeTracker({
  seeds: config.seedNarratives,
  ...(simulate ? { shortWindowMs: 60_000, longWindowMs: 10 * 60_000, minShortWeight: 3 } : {}),
});
const safety = simulate ? new MockSafetyChecker() : new SafetyChecker();
const pump = simulate ? new MockPumpSource() : new PumpFunSource(config.pumpPortalApiKey);
const candidates = new Map<string, Candidate>();
const externalQueue = new Set<string>();
const SOURCE_WEIGHT: Record<Source, number> = {
  pumpfun: 1, mock: 1, "dexscreener-profile": 2, "dexscreener-boost": 2, gmgn: 2,
};

function getCandidate(mint: string, source: Source): Candidate {
  let c = candidates.get(mint);
  if (!c) {
    c = {
      mint, name: "", symbol: "", description: "", sources: new Set(), firstSeen: Date.now(), socials: {},
      flow: { buyers: new Set(), sellers: new Set(), buySol: 0, sellSol: 0, devSold: false, trades: 0 },
      decided: false,
    };
    candidates.set(mint, c);
  }
  c.sources.add(source);
  return c;
}

// ---------- pump.fun path: watch early order flow, then decide ----------
pump.on("newToken", async (ev: NewTokenEvent) => {
  const c = getCandidate(ev.mint, simulate ? "mock" : "pumpfun");
  Object.assign(c, { name: ev.name, symbol: ev.symbol, creator: ev.creator, devInitialBuyPct: ev.devInitialBuyPct, lastPriceSol: ev.priceSol });
  narratives.observe(`${ev.name} ${ev.symbol}`, 1);
  pump.watchTrades(ev.mint);
  setTimeout(() => decidePump(c).catch((e) => log.error("decide:", e.message)), config.watchSeconds * 1000);

  const meta = ev.description !== undefined ? { description: ev.description, ...ev.socials } : ev.uri ? await fetchMetadata(ev.uri) : null;
  if (meta) {
    c.description = meta.description ?? "";
    c.socials = { twitter: meta.twitter, telegram: meta.telegram, website: meta.website };
    if (c.description) narratives.observe(c.description, 0.5);
  }
});

pump.on("trade", (t) => {
  const c = candidates.get(t.mint);
  if (c) {
    const f = c.flow;
    f.trades++;
    if (t.side === "buy") {
      f.buyers.add(t.trader);
      f.buySol += t.solAmount;
    } else {
      f.sellers.add(t.trader);
      f.sellSol += t.solAmount;
      if (t.trader === c.creator) f.devSold = true;
    }
    if (t.priceSol > 0) c.lastPriceSol = t.priceSol;
  }
  positions.onPrice(t.mint, t.priceSol);
});

pump.on("migrate", (mint) => {
  if (positions.open.has(mint)) log.info(`${candidates.get(mint)?.symbol ?? mint} migrated to AMM — tracking via DexScreener`);
});

async function decidePump(c: Candidate) {
  if (c.decided) return;
  c.decided = true;
  const pre = scoreCandidate(c, narratives);
  let bought = false;
  try {
    if (pre.total < config.minScore) {
      log.debug(`pass ${c.symbol} score ${pre.total}`);
      record("signals", { mint: c.mint, symbol: c.symbol, action: "pass", ...pre });
      return;
    }
    const s = await safety.check(c);
    const final = scoreCandidate(c, narratives, s);
    const line = `${c.symbol} "${c.name}" score ${final.total} (narr ${final.narrative} mom ${final.momentum} soc ${final.socials} ext ${final.external}) [${final.matchedNarratives.join(",")}] ${final.notes.join("; ")}`;
    if (!s.ok) {
      log.info(`⛔ ${line} — UNSAFE: ${s.reasons.join(", ")}`);
      record("signals", { mint: c.mint, symbol: c.symbol, action: "unsafe", ...final, safety: s });
      return;
    }
    if (final.total < config.minScore) {
      log.info(`· ${line} — below MIN_SCORE after safety`);
      record("signals", { mint: c.mint, symbol: c.symbol, action: "pass", ...final, safety: s });
      return;
    }
    log.info(`🎯 ${line}`);
    record("signals", { mint: c.mint, symbol: c.symbol, action: "buy", ...final, safety: s });
    await positions.buy(c.mint, c.symbol, c.lastPriceSol ?? 0, final.total);
    bought = positions.open.has(c.mint);
  } finally {
    if (!bought) pump.unwatchTrades(c.mint);
  }
}

// ---------- DexScreener / GMGN path: callouts on already-trading tokens ----------
function onExternal(ev: ExternalTokenEvent) {
  const c = getCandidate(ev.mint, ev.source);
  if (ev.name) c.name = ev.name;
  if (ev.symbol) c.symbol = ev.symbol;
  if (ev.description) c.description = ev.description;
  c.socials = { ...ev.socials, ...Object.fromEntries(Object.entries(c.socials).filter(([, v]) => v)) };
  if (ev.boostAmount) c.boostAmount = ev.boostAmount;
  narratives.observe(`${c.name} ${c.symbol} ${c.description}`, SOURCE_WEIGHT[ev.source]);
  if (!c.decided) externalQueue.add(ev.mint);
}

async function evaluateExternal() {
  if (!externalQueue.size) return;
  const mints = [...externalQueue];
  externalQueue.clear();
  const pairs = await fetchPairs(mints).catch((e) => (log.warn("dexscreener pairs:", e.message), new Map()));
  for (const mint of mints) {
    const c = candidates.get(mint);
    const p = pairs.get(mint);
    if (!c || !p || c.decided) continue;
    c.pair = p;
    c.name ||= p.name;
    c.symbol ||= p.symbol;
    c.lastPriceSol = p.priceNative;
    if (p.quoteSymbol !== "SOL" || p.liquidityUsd < config.minLiquidityUsd || p.ageHours > config.maxPairAgeHours) continue;
    c.decided = true; // evaluate each external token once
    const pre = scoreCandidate(c, narratives);
    if (pre.total < config.minScore) {
      record("signals", { mint, symbol: c.symbol, action: "pass", path: "external", ...pre });
      continue;
    }
    const s = await safety.check(c);
    const final = scoreCandidate(c, narratives, s);
    const tag = [...c.sources].join("+");
    if (!s.ok || final.total < config.minScore) {
      log.info(`· [${tag}] ${c.symbol} score ${final.total} ${s.ok ? "" : "UNSAFE: " + s.reasons.join(", ")}`);
      record("signals", { mint, symbol: c.symbol, action: s.ok ? "pass" : "unsafe", path: "external", ...final, safety: s });
      continue;
    }
    log.info(`🎯 [${tag}] ${c.symbol} score ${final.total} [${final.matchedNarratives.join(",")}] ${final.notes.join("; ")}`);
    record("signals", { mint, symbol: c.symbol, action: "buy", path: "external", ...final, safety: s });
    await positions.buy(mint, c.symbol, p.priceNative, final.total);
  }
}

// prices for open positions (covers migrated tokens and external buys)
async function pollPositionPrices() {
  if (simulate || !positions.open.size) return;
  const pairs = await fetchPairs([...positions.open.keys()]).catch(() => new Map());
  for (const [mint, p] of pairs) if (p.priceNative > 0) positions.onPrice(mint, p.priceNative);
}

function housekeeping() {
  narratives.prune();
  const cutoff = Date.now() - 60 * 60_000;
  for (const [mint, c] of candidates) if (c.firstSeen < cutoff && !positions.open.has(mint)) candidates.delete(mint);
}

async function status() {
  const top = narratives.top(8).map((n) => `${n.term}(${n.heat.toFixed(2)})`).join(" ");
  const bal = await exec.balanceSol().catch(() => NaN);
  const open = [...positions.open.values()]
    .map((p) => `${p.symbol} ${((p.lastPriceSol / p.entryPriceSol - 1) * 100).toFixed(0)}%`)
    .join(", ");
  log.info(`📊 hot: ${top || "(warming up)"} | ${exec.kind} bal ${bal.toFixed(3)} SOL | open: ${open || "none"} | tracking ${candidates.size}`);
}

// ---------- start ----------
log.info(`memesniper starting — mode=${config.mode}${simulate ? " (SIMULATION)" : ""} buy=${config.buyAmountSol} SOL minScore=${config.minScore}`);
positions.start();
if (simulate || config.enablePumpPortal) pump.start();
const timers: NodeJS.Timeout[] = [];
if (config.enableDexScreener) {
  const ds = new DexScreenerSource();
  ds.on("token", onExternal);
  ds.start();
}
if (config.enableGmgn) {
  const g = new GmgnSource();
  g.on("token", onExternal);
  g.start();
}
timers.push(setInterval(() => evaluateExternal().catch((e) => log.error("external:", e.message)), 15_000));
timers.push(setInterval(() => pollPositionPrices(), 10_000));
timers.push(setInterval(housekeeping, 5 * 60_000));
timers.push(setInterval(() => status(), simulate ? 15_000 : 60_000));

let shuttingDown = false;
process.on("SIGINT", async () => {
  if (shuttingDown) process.exit(1);
  shuttingDown = true;
  if (exec.kind === "paper") {
    log.info("shutting down — closing paper positions at last price");
    await positions.closeAll();
  } else if (positions.open.size) {
    log.warn(`shutting down with ${positions.open.size} LIVE position(s) still open — they are NOT sold automatically:`);
    for (const p of positions.open.values()) log.warn(`  ${p.symbol} ${p.mint}`);
  }
  log.info("bye. run `npm run report` for stats.");
  process.exit(0);
});
