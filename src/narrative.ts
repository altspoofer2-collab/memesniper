/**
 * Narrative tracker.
 *
 * Without Twitter, the best free proxy for "what narrative is hot right now" is
 * what deployers and promoters are spending money on: every pump.fun launch,
 * every paid DexScreener profile/boost and every GMGN trending entry is a vote
 * for a theme. We tokenize names/symbols/descriptions, keep timestamped counts,
 * and flag terms whose recent rate spikes above their longer baseline.
 *
 * A Twitter/X source can later feed the same `observe()` call with tweet text.
 */

const STOP = new Set(
  `the and for you your with this that from are was have has will just its it's not but all our
  out get got can now new coin token sol solana pump fun meme memecoin official first only real
  ever more most one two who what when how why buy sell moon send launch community ca dev
  https http www com twitter telegram org xyz app io here there season time day year back
  inu wif hat king queen classic daddy baby mini mega super lord based mania hold holders`.split(/\s+/),
);

export function tokenize(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && w.length <= 20 && !STOP.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)];
}

interface Hit {
  t: number;
  w: number;
}

export interface NarrativeOptions {
  shortWindowMs?: number;
  longWindowMs?: number;
  minShortWeight?: number;
  seeds?: string[];
}

export class NarrativeTracker {
  private hits = new Map<string, Hit[]>();
  private shortMs: number;
  private longMs: number;
  private minShort: number;
  private seeds: Set<string>;
  private startedAt = Date.now();

  constructor(opts: NarrativeOptions = {}) {
    this.shortMs = opts.shortWindowMs ?? 15 * 60_000;
    this.longMs = opts.longWindowMs ?? 3 * 60 * 60_000;
    this.minShort = opts.minShortWeight ?? 4;
    this.seeds = new Set(opts.seeds ?? []);
  }

  /** Record text seen from a source. weight: how much this sighting counts. */
  observe(text: string, weight = 1, now = Date.now()) {
    for (const term of tokenize(text)) {
      let arr = this.hits.get(term);
      if (!arr) this.hits.set(term, (arr = []));
      arr.push({ t: now, w: weight });
    }
  }

  prune(now = Date.now()) {
    const cutoff = now - this.longMs;
    for (const [k, arr] of this.hits) {
      const kept = arr.filter((h) => h.t >= cutoff);
      if (kept.length) this.hits.set(k, kept);
      else this.hits.delete(k);
    }
  }

  /**
   * Heat of a term in 0..1. Combines absolute recent activity with the spike
   * ratio vs. baseline, so both "suddenly everyone is launching X" and
   * "X has been steadily hot" score, but a single launch doesn't.
   */
  heat(term: string, now = Date.now()): number {
    const arr = this.hits.get(term);
    if (!arr) return 0;
    let short = 0;
    let long = 0;
    for (const h of arr) {
      if (now - h.t <= this.longMs) long += h.w;
      if (now - h.t <= this.shortMs) short += h.w;
    }
    if (short < this.minShort) return 0;
    // baseline rate per short-window, over however long we've been running
    const observedLong = Math.min(this.longMs, Math.max(this.shortMs, now - this.startedAt));
    const baselinePerWindow = ((long - short) / Math.max(1, observedLong - this.shortMs)) * this.shortMs;
    const ratio = short / Math.max(1, baselinePerWindow);
    const spike = Math.min(1, Math.max(0, (ratio - 1) / 3)); // 4x baseline => 1
    const volume = Math.min(1, short / (this.minShort * 4));
    return 0.6 * spike + 0.4 * volume;
  }

  /** Score a token's text against current narratives. */
  match(text: string, now = Date.now()): { score: number; terms: string[] } {
    const terms = tokenize(text);
    let best = 0;
    const matched: string[] = [];
    for (const t of terms) {
      let h = this.heat(t, now);
      if (this.seeds.has(t)) h = Math.max(h, 0.5);
      if (h > 0.15) matched.push(t);
      best = Math.max(best, h);
    }
    // small bonus for touching several hot themes at once
    const score = Math.min(1, best + Math.max(0, matched.length - 1) * 0.1);
    return { score, terms: matched };
  }

  top(n = 10, now = Date.now()): { term: string; heat: number }[] {
    return [...this.hits.keys()]
      .map((term) => ({ term, heat: this.heat(term, now) }))
      .filter((x) => x.heat > 0)
      .sort((a, b) => b.heat - a.heat)
      .slice(0, n);
  }
}
