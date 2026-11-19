/**
 * Scores a candidate 0..100. Weights:
 *   narrative  30  — does it ride a currently-hot theme?
 *   momentum   35  — real, broad buying (unique wallets, net SOL inflow)
 *   socials    15  — has twitter / telegram / website
 *   external   20  — paid DexScreener profile/boost, GMGN trending
 * minus penalties for safety warnings. Tune the weights after paper trading.
 */
import { config } from "./config.js";
import type { NarrativeTracker } from "./narrative.js";
import type { Candidate, SafetyReport, ScoreBreakdown } from "./types.js";

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function scoreCandidate(c: Candidate, narratives: NarrativeTracker, safety?: SafetyReport): ScoreBreakdown {
  const notes: string[] = [];

  // narrative
  const nm = narratives.match(`${c.name} ${c.symbol} ${c.description}`);
  const narrative = 30 * nm.score;

  // momentum
  let momentum = 0;
  if (c.pair) {
    // already-trading token (DexScreener/GMGN path)
    const p = c.pair;
    const buyRatio = p.m5Buys / Math.max(1, p.m5Buys + p.m5Sells);
    const activity = clamp01(p.m5Buys / 60);
    const vol = clamp01(p.m5VolumeUsd / 30_000);
    momentum = 35 * (0.4 * clamp01((buyRatio - 0.45) / 0.25) + 0.3 * activity + 0.3 * vol);
    notes.push(`m5 ${p.m5Buys}b/${p.m5Sells}s vol $${Math.round(p.m5VolumeUsd)} liq $${Math.round(p.liquidityUsd)}`);
  } else {
    const f = c.flow;
    const unique = f.buyers.size;
    const net = f.buySol - f.sellSol;
    const buyShare = f.buySol / Math.max(1e-9, f.buySol + f.sellSol);
    momentum =
      35 *
      (0.45 * clamp01(unique / 30) + // breadth: many distinct wallets
        0.3 * clamp01(net / 15) + // depth: net SOL flowing in
        0.25 * clamp01((buyShare - 0.5) / 0.3)); // pressure: buys dominate
    notes.push(`${unique} buyers, net ${net.toFixed(2)} SOL, ${(buyShare * 100).toFixed(0)}% buys`);
    if (unique < config.minUniqueBuyers) {
      momentum *= 0.3;
      notes.push("too few buyers");
    }
  }

  // socials
  const s = c.socials;
  const socials = (s.twitter ? 7 : 0) + (s.telegram ? 4 : 0) + (s.website ? 4 : 0);

  // external callout signals
  let external = 0;
  if (c.sources.has("dexscreener-profile")) external += 8;
  if (c.sources.has("dexscreener-boost")) external += 4 + Math.min(4, (c.boostAmount ?? 0) / 100);
  if (c.sources.has("gmgn")) external += 10;
  external = Math.min(20, external);

  let total = narrative + momentum + socials + external;
  if (safety) {
    const pen = Math.min(20, safety.warnings.length * 5);
    if (pen) notes.push(`-${pen} safety warnings`);
    total -= pen;
  }

  return {
    total: Math.round(Math.max(0, Math.min(100, total))),
    narrative: Math.round(narrative),
    momentum: Math.round(momentum),
    socials,
    external: Math.round(external),
    matchedNarratives: nm.terms,
    notes,
  };
}
