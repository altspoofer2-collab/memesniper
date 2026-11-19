/**
 * Fake pump.fun feed for `npm run simulate`: lets you watch the whole pipeline
 * (narratives → scoring → safety → paper buys → exits) without network access.
 * One theme becomes "hot" partway through; hot tokens are more likely to pump,
 * and some launches are rugs (dev dumps or freeze authority kept).
 */
import { EventEmitter } from "node:events";
import type { PumpFunEvents } from "./pumpfun.js";

const THEMES = ["penguin", "agent", "frog", "cat", "trump", "grok", "dog", "pepe", "moo", "robot", "shark", "banana"];
const SUFFIX = ["Inu", "Coin", "AI", "King", "Wif Hat", "Classic", "Mania", "Army", "Of Sol", "Daddy"];
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
const addr = () => Array.from({ length: 44 }, () => pick([..."123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"])).join("");

interface Sim {
  price: number;
  drift: number;
  vol: number;
  rugAt?: number;
  dev: string;
  born: number;
  peakAt: number;
}

export class MockPumpSource extends EventEmitter<PumpFunEvents> {
  private sims = new Map<string, Sim>();
  private watched = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private hot = pick(THEMES);
  private started = Date.now();

  start() {
    this.timers.push(setInterval(() => this.launch(), 1500));
    this.timers.push(setInterval(() => this.trades(), 500));
  }
  stop() {
    this.timers.forEach(clearInterval);
  }
  watchTrades(mint: string) {
    this.watched.add(mint);
  }
  unwatchTrades(mint: string) {
    this.watched.delete(mint);
  }

  private launch() {
    const hotPhase = Date.now() - this.started > 20_000;
    const theme = hotPhase && Math.random() < 0.45 ? this.hot : pick(THEMES);
    const isHot = theme === this.hot && hotPhase;
    const rug = Math.random() < 0.25;
    const name = `${theme[0].toUpperCase()}${theme.slice(1)} ${pick(SUFFIX)}`;
    const symbol = (rug && Math.random() < 0.4 ? "RUG" : "") + theme.slice(0, 4).toUpperCase() + Math.floor(rand(1, 99));
    const mint = addr() + "pump";
    const dev = addr();
    const price = 2.8e-8;
    const now = Date.now();
    this.sims.set(mint, {
      price,
      drift: isHot ? rand(0.0, 0.05) : rand(-0.03, 0.025),
      vol: rand(0.02, 0.08),
      rugAt: rug ? now + rand(4000, 60_000) : undefined,
      dev,
      born: now,
      peakAt: now + rand(30_000, 150_000),
    });
    this.emit("newToken", {
      mint,
      name,
      symbol,
      creator: dev,
      devInitialBuyPct: Math.random() < 0.15 ? rand(10, 25) : rand(0, 6),
      priceSol: price,
      description: `${name} — the ${theme} of solana. ${isHot ? `${theme} season is here` : ""}`,
      socials: {
        twitter: Math.random() < 0.6 ? `https://x.com/${theme}${Math.floor(rand(1, 999))}` : undefined,
        telegram: Math.random() < 0.4 ? `https://t.me/${theme}` : undefined,
        website: Math.random() < 0.3 ? `https://${theme}.fun` : undefined,
      },
    });
    // forget old sims
    for (const [m, s] of this.sims) if (now - s.born > 10 * 60_000 && !this.watched.has(m)) this.sims.delete(m);
  }

  private trades() {
    const now = Date.now();
    for (const mint of this.watched) {
      const s = this.sims.get(mint);
      if (!s) continue;
      if (s.rugAt && now >= s.rugAt) {
        s.rugAt = undefined;
        s.price *= 0.25;
        s.drift = -0.05;
        this.emit("trade", { mint, side: "sell", trader: s.dev, solAmount: 20, tokenAmount: 2e8, priceSol: s.price });
        continue;
      }
      if (now > s.peakAt && s.drift > -0.03) s.drift -= 0.01; // every pump ends
      const n = Math.floor(rand(0, 4));
      for (let i = 0; i < n; i++) {
        const change = s.drift / 2 + rand(-s.vol, s.vol);
        s.price = Math.max(1e-10, s.price * (1 + change));
        const side = change >= 0 ? "buy" : "sell";
        const sol = rand(0.1, 2.5);
        this.emit("trade", { mint, side, trader: addr(), solAmount: sol, tokenAmount: sol / s.price, priceSol: s.price });
      }
    }
  }
}
