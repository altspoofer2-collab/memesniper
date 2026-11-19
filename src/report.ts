/** `npm run report` — P&L summary from data/trades.jsonl. */
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const file = path.join(config.dataDir, "trades.jsonl");
if (!fs.existsSync(file)) {
  console.log("no trades yet");
  process.exit(0);
}
const mode = process.argv[2]; // optional: paper | live
const closes = fs
  .readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .filter((t) => t.kind === "close" && (!mode || t.mode === mode));

if (!closes.length) {
  console.log("no closed trades yet");
  process.exit(0);
}
const wins = closes.filter((t) => t.pnlSol > 0);
const total = closes.reduce((s, t) => s + t.pnlSol, 0);
const invested = closes.reduce((s, t) => s + t.solIn, 0);
const byReason = new Map<string, { n: number; pnl: number }>();
for (const t of closes) {
  const r = String(t.reason).split(" ")[0] + " " + (String(t.reason).split(" ")[1] ?? "");
  const e = byReason.get(r) ?? { n: 0, pnl: 0 };
  e.n++;
  e.pnl += t.pnlSol;
  byReason.set(r, e);
}
const best = [...closes].sort((a, b) => b.pnlPct - a.pnlPct);

console.log(`trades: ${closes.length}   win rate: ${((wins.length / closes.length) * 100).toFixed(0)}%`);
console.log(`P&L: ${total >= 0 ? "+" : ""}${total.toFixed(4)} SOL on ${invested.toFixed(3)} SOL deployed (${((total / invested) * 100).toFixed(1)}%)`);
console.log(`avg hold: ${(closes.reduce((s, t) => s + t.holdMin, 0) / closes.length).toFixed(1)} min`);
console.log("\nexit reasons:");
for (const [r, e] of byReason) console.log(`  ${r.padEnd(18)} ${String(e.n).padStart(4)}  ${e.pnl >= 0 ? "+" : ""}${e.pnl.toFixed(4)} SOL`);
console.log("\nbest:  " + best.slice(0, 3).map((t) => `${t.symbol} ${t.pnlPct.toFixed(0)}%`).join(", "));
console.log("worst: " + best.slice(-3).reverse().map((t) => `${t.symbol} ${t.pnlPct.toFixed(0)}%`).join(", "));
