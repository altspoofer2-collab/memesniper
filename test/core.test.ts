import assert from "node:assert/strict";
import { test } from "node:test";
process.env.DATA_DIR = "./data-test";
process.env.PAPER_SLIPPAGE_PCT = "0";

const { NarrativeTracker, tokenize } = await import("../src/narrative.js");
const { scoreCandidate } = await import("../src/scorer.js");
const { PaperExecutor } = await import("../src/trader/executor.js");
const { PositionManager } = await import("../src/trader/positions.js");
const { config } = await import("../src/config.js");

const cand = (over: any = {}) => ({
  mint: "M1", name: "Penguin King", symbol: "PENG", description: "", sources: new Set(["pumpfun"]),
  firstSeen: Date.now(), socials: {}, decided: false,
  flow: { buyers: new Set<string>(), sellers: new Set<string>(), buySol: 0, sellSol: 0, devSold: false, trades: 0 },
  ...over,
});

test("tokenize drops stopwords, urls and numbers", () => {
  assert.deepEqual(tokenize("The PENGUIN coin https://x.com/foo 2024 on Solana!!"), ["penguin"]);
});

test("a spiking theme gets heat, a one-off does not", () => {
  const t0 = 1_000_000_000;
  const n = new NarrativeTracker({ minShortWeight: 4 });
  for (let i = 0; i < 50; i++) n.observe(`random${i} dog`, 1, t0 + i * 60_000); // steady 'dog' baseline
  const now = t0 + 180 * 60_000;
  for (let i = 0; i < 10; i++) n.observe(`penguin ${i}x`, 1, now - i * 30_000); // burst
  n.observe("lonely", 1, now);
  assert.ok(n.heat("penguin", now) > 0.6, `penguin heat ${n.heat("penguin", now)}`);
  assert.equal(n.heat("lonely", now), 0);
  assert.equal(n.top(1, now)[0].term, "penguin");
});

test("score: hot narrative + broad buying beats a dead launch", () => {
  const n = new NarrativeTracker({ minShortWeight: 2 });
  for (let i = 0; i < 12; i++) n.observe("penguin");
  const hot = cand({ socials: { twitter: "x", telegram: "t" } });
  for (let i = 0; i < 35; i++) hot.flow.buyers.add("w" + i);
  hot.flow.buySol = 20;
  hot.flow.sellSol = 3;
  const dead = cand({ name: "Nothing", symbol: "ZZZ" });
  dead.flow.buyers.add("a");
  dead.flow.buySol = 0.2;
  const a = scoreCandidate(hot, n).total;
  const b = scoreCandidate(dead, n).total;
  assert.ok(a >= 70, `hot ${a}`);
  assert.ok(b < 15, `dead ${b}`);
});

test("positions: take profit, trailing stop, then stop loss", async () => {
  Object.assign(config, { buyAmountSol: 1, priorityFeeSol: 0, takeProfitPct: 100, takeProfitSellPct: 50, trailingStopPct: 25, stopLossPct: 30, maxOpenPositions: 2 });
  const ex = new PaperExecutor();
  const pm = new PositionManager(ex);
  await pm.buy("A", "AAA", 1, 80);
  assert.equal(pm.open.size, 1);
  pm.onPrice("A", 2.1); // +110% -> sell half
  await new Promise((r) => setImmediate(r));
  assert.equal(pm.open.get("A")!.tookProfit, true);
  pm.onPrice("A", 3); // new high
  pm.onPrice("A", 2.2); // -27% from high -> trailing exit
  await new Promise((r) => setImmediate(r));
  assert.equal(pm.open.size, 0);

  await pm.buy("B", "BBB", 1, 80);
  pm.onPrice("B", 0.65); // -35% -> stop
  await new Promise((r) => setImmediate(r));
  assert.equal(pm.open.size, 0);
  const bal = await ex.balanceSol();
  // A: 0.9875 tok; half @2.1, half @2.2 => ~2.1 SOL back (after 1.25% fees). B: ~0.63 back.
  assert.ok(bal > config.paperStartSol + 0.6 && bal < config.paperStartSol + 0.8, `bal ${bal}`);
});

test("positions: respects max open positions", async () => {
  Object.assign(config, { maxOpenPositions: 1, buyAmountSol: 0.1 });
  const pm = new PositionManager(new PaperExecutor());
  await pm.buy("X", "X", 1, 70);
  await pm.buy("Y", "Y", 1, 70);
  assert.equal(pm.open.size, 1);
});
