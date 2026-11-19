/**
 * Position manager: risk limits on entry, and exits on every price tick:
 *   - take profit: at +TAKE_PROFIT_PCT sell TAKE_PROFIT_SELL_PCT% (lock in), trail the rest
 *   - stop loss:   at -STOP_LOSS_PCT sell everything
 *   - trailing:    once in profit (TP hit or +30%), sell all if price drops TRAILING_STOP_PCT from high
 *   - time stop:   sell everything after MAX_HOLD_MINUTES
 */
import { config } from "../config.js";
import { log, record } from "../log.js";
import type { Position } from "../types.js";
import type { Executor } from "./executor.js";

/** mint is set on buy alerts so Telegram can attach sell buttons */
export type Notify = (msg: string, mint?: string) => void;

export class PositionManager {
  readonly open = new Map<string, Position>(); // by mint
  private busy = new Set<string>();
  private dayKey = "";
  private dayPnl = 0;
  private timer?: NodeJS.Timeout;
  /** when true, auto-buys are skipped (manual buys still work) */
  paused = false;

  constructor(private exec: Executor, public notify: Notify = () => {}) {}

  start() {
    this.timer = setInterval(() => {
      for (const p of this.open.values()) this.evaluate(p);
    }, 5000);
  }
  stop() {
    clearInterval(this.timer);
  }

  private today() {
    const k = new Date().toISOString().slice(0, 10);
    if (k !== this.dayKey) {
      this.dayKey = k;
      this.dayPnl = 0;
    }
    return this;
  }

  get dayPnlSol() {
    return this.today().dayPnl;
  }

  canOpen(mint: string, manual = false): string | null {
    this.today();
    if (this.open.has(mint) || this.busy.has(mint)) return "already in position";
    if (!manual && this.paused) return "auto-buy paused";
    if (!manual && this.open.size + this.busy.size >= config.maxOpenPositions) return "max open positions";
    if (-this.dayPnl >= config.dailyLossLimitSol) return "daily loss limit hit";
    return null;
  }

  /** Returns null on success, or the reason the buy didn't happen. */
  async buy(
    mint: string,
    symbol: string,
    priceSol: number,
    score: number,
    opts: { manual?: boolean; sol?: number } = {},
  ): Promise<string | null> {
    const why = this.canOpen(mint, opts.manual);
    if (why) {
      log.info(`skip buy ${symbol}: ${why}`);
      return why;
    }
    this.busy.add(mint);
    try {
      const fill = await this.exec.buy(mint, opts.sol ?? config.buyAmountSol, priceSol);
      if (fill.tokens <= 0) throw new Error("bought 0 tokens");
      const p: Position = {
        id: `${mint.slice(0, 6)}-${Date.now()}`,
        mint,
        symbol,
        openedAt: Date.now(),
        solIn: fill.sol,
        tokens: fill.tokens,
        entryPriceSol: priceSol, // market price at entry; cost basis incl. fees = solIn / tokens
        highPriceSol: priceSol,
        lastPriceSol: priceSol,
        tookProfit: false,
        realizedSol: 0,
        score,
      };
      this.open.set(mint, p);
      record("trades", { kind: "buy", mode: this.exec.kind, mint, symbol, sol: fill.sol, tokens: fill.tokens, price: priceSol, score, sig: fill.sig });
      const msg = `🟢 [${this.exec.kind}]${opts.manual ? " MANUAL" : ""} BUY ${symbol} ${fill.sol.toFixed(4)} SOL @ ${priceSol.toExponential(3)} (score ${score})\nhttps://dexscreener.com/solana/${mint}`;
      log.info(msg);
      this.notify(msg, mint);
      return null;
    } catch (e: any) {
      log.error(`buy ${symbol} failed: ${e.message}`);
      return e.message;
    } finally {
      this.busy.delete(mint);
    }
  }

  onPrice(mint: string, priceSol: number) {
    const p = this.open.get(mint);
    if (!p || !(priceSol > 0)) return;
    p.lastPriceSol = priceSol;
    if (priceSol > p.highPriceSol) p.highPriceSol = priceSol;
    this.evaluate(p);
  }

  private evaluate(p: Position) {
    if (this.busy.has(p.mint)) return;
    // compare against the fair price we bought at (not fee-inflated entry) so
    // TP/SL trigger on market moves; fees show up in realized P&L.
    const ref = p.entryPriceSol;
    const pnlPct = (p.lastPriceSol / ref - 1) * 100;
    const fromHighPct = (1 - p.lastPriceSol / p.highPriceSol) * 100;
    const ageMin = (Date.now() - p.openedAt) / 60_000;

    if (pnlPct <= -config.stopLossPct) return this.sell(p, 1, `stop loss ${pnlPct.toFixed(0)}%`);
    if (!p.tookProfit && pnlPct >= config.takeProfitPct)
      return this.sell(p, config.takeProfitSellPct / 100, `take profit +${pnlPct.toFixed(0)}%`);
    const highGain = (p.highPriceSol / ref - 1) * 100;
    if ((p.tookProfit || highGain >= 30) && fromHighPct >= config.trailingStopPct)
      return this.sell(p, 1, `trailing stop (-${fromHighPct.toFixed(0)}% from high, pnl ${pnlPct.toFixed(0)}%)`);
    if (ageMin >= config.maxHoldMinutes) return this.sell(p, 1, `time stop ${ageMin.toFixed(0)}m (pnl ${pnlPct.toFixed(0)}%)`);
  }

  private async sell(p: Position, fraction: number, reason: string) {
    this.busy.add(p.mint);
    try {
      const qty = fraction >= 1 ? p.tokens : p.tokens * fraction;
      const fill = await this.exec.sell(p.mint, qty, p.lastPriceSol, fraction);
      p.tokens = Math.max(0, p.tokens - fill.tokens);
      p.realizedSol += fill.sol;
      if (fraction < 1) p.tookProfit = true;
      const closed = fraction >= 1 || p.tokens <= 0;
      const pnl = p.realizedSol - p.solIn;
      record("trades", {
        kind: closed ? "close" : "partial",
        mode: this.exec.kind,
        mint: p.mint,
        symbol: p.symbol,
        reason,
        solOut: fill.sol,
        price: p.lastPriceSol,
        ...(closed ? { pnlSol: pnl, pnlPct: (pnl / p.solIn) * 100, solIn: p.solIn, holdMin: (Date.now() - p.openedAt) / 60_000 } : {}),
        sig: fill.sig,
      });
      const emoji = closed ? (pnl >= 0 ? "✅" : "🔴") : "💰";
      const msg = `${emoji} [${this.exec.kind}] ${closed ? "CLOSE" : "PARTIAL"} ${p.symbol}: ${reason}` +
        (closed ? ` → P&L ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL (${((pnl / p.solIn) * 100).toFixed(0)}%)` : ` → +${fill.sol.toFixed(4)} SOL`);
      log.info(msg);
      this.notify(msg);
      if (closed) {
        this.open.delete(p.mint);
        this.today().dayPnl += pnl;
      }
    } catch (e: any) {
      log.error(`sell ${p.symbol} failed: ${e.message}`);
    } finally {
      this.busy.delete(p.mint);
    }
  }

  /** Manual sell from Telegram. fraction 0..1. Returns null on success or an error. */
  async sellManual(mint: string, fraction: number): Promise<string | null> {
    const p = this.open.get(mint);
    if (!p) return "no open position";
    if (this.busy.has(mint)) return "a trade on this token is already in progress";
    await this.sell(p, Math.min(1, Math.max(0.01, fraction)), `manual ${Math.round(fraction * 100)}%`);
    return null;
  }

  /** Find an open position by mint or (case-insensitive) symbol. */
  find(q: string): Position | undefined {
    return this.open.get(q) ?? [...this.open.values()].find((p) => p.symbol.toLowerCase() === q.toLowerCase());
  }

  async closeAll(reason = "shutdown") {
    await Promise.all([...this.open.values()].map((p) => this.sell(p, 1, reason)));
  }
}
