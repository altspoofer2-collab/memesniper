/**
 * Telegram alerts + remote control (long polling, no webhook/server needed).
 *
 * SECURITY: this bot can move money. It only obeys TELEGRAM_CHAT_ID. In a group
 * chat it additionally requires the sender to be in TELEGRAM_ALLOWED_USER_IDS.
 * Commands sent while the bot was offline (older than 60s) are ignored so a
 * stale /buy never fires on restart. Manual buys always need a button confirm.
 *
 * Setup: create a bot with @BotFather → TELEGRAM_BOT_TOKEN. Message your bot,
 * then message @userinfobot to get your id → TELEGRAM_CHAT_ID.
 */
import { config } from "./config.js";
import { log } from "./log.js";
import type { NarrativeTracker } from "./narrative.js";
import type { SafetyChecker, MockSafetyChecker } from "./safety.js";
import { fetchPairs } from "./sources/dexscreener.js";
import type { Executor } from "./trader/executor.js";
import type { PositionManager } from "./trader/positions.js";
import type { Candidate } from "./types.js";

type Button = { text: string; callback_data: string };
type Keyboard = Button[][];

export interface TelegramDeps {
  positions: PositionManager;
  exec: Executor;
  narratives: NarrativeTracker;
  safety: SafetyChecker | MockSafetyChecker;
  getCandidate: (mint: string) => Candidate | undefined;
}

/** Settings adjustable with /set <key> <value>, mapped to config fields. */
const SETTABLE: Record<string, { field: keyof typeof config; min: number; max: number; desc: string }> = {
  min_score: { field: "minScore", min: 0, max: 100, desc: "score needed to auto-buy" },
  buy_sol: { field: "buyAmountSol", min: 0.001, max: 10, desc: "SOL per auto-buy" },
  tp: { field: "takeProfitPct", min: 5, max: 10000, desc: "take profit %" },
  tp_sell: { field: "takeProfitSellPct", min: 1, max: 100, desc: "% sold at take profit" },
  sl: { field: "stopLossPct", min: 1, max: 95, desc: "stop loss %" },
  trail: { field: "trailingStopPct", min: 1, max: 95, desc: "trailing stop % from high" },
  max_hold: { field: "maxHoldMinutes", min: 1, max: 10080, desc: "time stop (minutes)" },
  max_positions: { field: "maxOpenPositions", min: 0, max: 50, desc: "max open auto positions" },
  daily_loss: { field: "dailyLossLimitSol", min: 0, max: 1000, desc: "daily loss limit (SOL)" },
};

const HELP = `memesniper commands

/status – balance, P&L today, hot narratives
/positions – open positions with sell buttons
/buy <mint> [sol] – manual buy (asks to confirm)
/sell <mint|symbol> [pct] – sell (default 100%)
/sellall – close every position
/pause – stop auto-buys (exits keep running)
/resume – resume auto-buys
/narratives – what's hot right now
/config – current settings
/set <key> <value> – change a setting, e.g. /set min_score 70
/help – this message`;

const isMint = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const fmtPct = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(0)}%`;

export class TelegramControl {
  private api = `${process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org"}/bot${config.telegramBotToken}`;
  private offset = 0;
  private running = false;
  private allowedUsers = new Set(
    (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  );
  private pending = new Map<string, { mint: string; symbol: string; sol: number; price: number; score: number; expires: number }>();

  constructor(private d: TelegramDeps) {}

  // ---------- outgoing ----------
  async send(text: string, keyboard?: Keyboard, chatId = config.telegramChatId) {
    try {
      const res = await this.call("sendMessage", {
        chat_id: chatId,
        text: text.slice(0, 4000),
        disable_web_page_preview: true,
        ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      });
      if (!res.ok) log.warn("telegram send:", res.description);
    } catch (e: any) {
      log.warn("telegram:", e.message);
    }
  }

  /** Used as the PositionManager notify hook. Buy alerts get sell buttons. */
  alert = (msg: string, mint?: string) => {
    void this.send(msg, mint ? this.sellButtons(mint) : undefined);
  };

  private sellButtons(mint: string): Keyboard {
    return [[
      { text: "Sell 25%", callback_data: `s:${mint}:25` },
      { text: "Sell 50%", callback_data: `s:${mint}:50` },
      { text: "Sell all", callback_data: `s:${mint}:100` },
    ]];
  }

  private async call(method: string, body: object, timeoutMs = 10_000): Promise<any> {
    const res = await fetch(`${this.api}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.json();
  }

  // ---------- incoming ----------
  async start() {
    this.running = true;
    await this.call("setMyCommands", {
      commands: HELP.split("\n").filter((l) => l.startsWith("/")).map((l) => {
        const [cmd, ...rest] = l.split(" – ");
        return { command: cmd.split(" ")[0].slice(1), description: rest.join(" – ").slice(0, 60) };
      }),
    }).catch(() => {});
    await this.send(`🤖 memesniper online — mode ${config.mode}. /help for commands.`);
    void this.loop();
  }

  stop() {
    this.running = false;
  }

  private async loop() {
    let backoff = 1000;
    while (this.running) {
      try {
        const res = await this.call(
          "getUpdates",
          { offset: this.offset, timeout: 30, allowed_updates: ["message", "callback_query"] },
          40_000,
        );
        if (!res.ok) throw new Error(res.description ?? "getUpdates failed");
        backoff = 1000;
        for (const u of res.result) {
          this.offset = u.update_id + 1;
          await this.handleUpdate(u).catch((e) => log.error("telegram handler:", e.message));
        }
      } catch (e: any) {
        log.warn(`telegram poll: ${e.message}; retry in ${backoff / 1000}s`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  private authorized(chat: any, from: any): boolean {
    if (!chat || String(chat.id) !== String(config.telegramChatId)) return false;
    if (chat.type === "private") return true;
    return from && this.allowedUsers.has(String(from.id));
  }

  private async handleUpdate(u: any) {
    if (u.callback_query) {
      const q = u.callback_query;
      if (!this.authorized(q.message?.chat, q.from)) {
        await this.call("answerCallbackQuery", { callback_query_id: q.id, text: "not authorized" });
        return;
      }
      await this.call("answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
      return this.onButton(String(q.data ?? ""), q.message);
    }
    const m = u.message;
    if (!m?.text) return;
    if (!this.authorized(m.chat, m.from)) {
      log.warn(`telegram: ignored message from unauthorized chat ${m.chat?.id}`);
      return;
    }
    if (Date.now() / 1000 - m.date > 60) return; // stale (sent while offline)
    const [rawCmd, ...args] = m.text.trim().split(/\s+/);
    const cmd = rawCmd.toLowerCase().replace(/@.*$/, "");
    switch (cmd) {
      case "/start":
      case "/help":
        return this.send(HELP);
      case "/status":
        return this.cmdStatus();
      case "/positions":
        return this.cmdPositions();
      case "/buy":
        return this.cmdBuy(args);
      case "/sell":
        return this.cmdSell(args);
      case "/sellall":
        return this.cmdSellAll();
      case "/pause":
        this.d.positions.paused = true;
        return this.send("⏸ auto-buy paused. Open positions are still managed (TP/SL/trailing).");
      case "/resume":
        this.d.positions.paused = false;
        return this.send("▶️ auto-buy resumed.");
      case "/narratives":
        return this.cmdNarratives();
      case "/config":
        return this.cmdConfig();
      case "/set":
        return this.cmdSet(args);
      default:
        // a bare contract address = shortcut for /buy
        if (isMint(rawCmd)) return this.cmdBuy([rawCmd, ...args]);
        return this.send("unknown command. /help");
    }
  }

  // ---------- commands ----------
  private async cmdStatus() {
    const { positions, exec, narratives } = this.d;
    const bal = await exec.balanceSol().catch(() => NaN);
    const hot = narratives.top(5).map((n) => n.term).join(", ") || "(warming up)";
    const day = positions.dayPnlSol;
    await this.send(
      `mode: ${exec.kind}${positions.paused ? " (auto-buy PAUSED)" : ""}\n` +
        `balance: ${bal.toFixed(4)} SOL\n` +
        `today: ${day >= 0 ? "+" : ""}${day.toFixed(4)} SOL (limit -${config.dailyLossLimitSol})\n` +
        `open: ${positions.open.size}/${config.maxOpenPositions}\n` +
        `hot: ${hot}`,
    );
  }

  private async cmdPositions() {
    const list = [...this.d.positions.open.values()];
    if (!list.length) return this.send("no open positions");
    for (const p of list) {
      const pnl = (p.lastPriceSol / p.entryPriceSol - 1) * 100;
      const value = p.tokens * p.lastPriceSol;
      const age = (Date.now() - p.openedAt) / 60_000;
      await this.send(
        `${p.symbol}  ${fmtPct(pnl)}  (high ${fmtPct((p.highPriceSol / p.entryPriceSol - 1) * 100)})\n` +
          `in ${p.solIn.toFixed(4)} SOL · now ~${value.toFixed(4)} SOL · realized ${p.realizedSol.toFixed(4)}\n` +
          `${age.toFixed(0)} min${p.tookProfit ? " · TP taken" : ""}\n` +
          `https://dexscreener.com/solana/${p.mint}`,
        this.sellButtons(p.mint),
      );
    }
  }

  private async cmdBuy(args: string[]) {
    const [mint, solArg] = args;
    if (!mint || !isMint(mint)) return this.send("usage: /buy <mint address> [sol]");
    const sol = solArg ? Number(solArg) : config.buyAmountSol;
    if (!(sol > 0) || sol > SETTABLE.buy_sol.max) return this.send(`amount must be between 0 and ${SETTABLE.buy_sol.max} SOL`);
    if (this.d.positions.open.has(mint)) return this.send("already holding this token — use /positions");

    // price + name: from our own feed if fresh, else DexScreener
    const known = this.d.getCandidate(mint);
    let price = known?.lastPriceSol ?? 0;
    let symbol = known?.symbol || "";
    let info = "";
    const pair = (await fetchPairs([mint]).catch(() => new Map())).get(mint);
    if (pair) {
      if (pair.priceNative > 0) price = pair.priceNative;
      symbol ||= pair.symbol;
      info = `liq $${Math.round(pair.liquidityUsd).toLocaleString()} · mcap $${Math.round(pair.marketCapUsd).toLocaleString()} · ${pair.ageHours.toFixed(1)}h old · ${pair.dexId}`;
    }
    if (!(price > 0)) return this.send("couldn't find a SOL price for that token (not on DexScreener yet?)");
    symbol ||= mint.slice(0, 6);

    const cand: Candidate = known ?? {
      mint, name: symbol, symbol, description: "", sources: new Set(), firstSeen: Date.now(), socials: {}, decided: true,
      flow: { buyers: new Set(), sellers: new Set(), buySol: 0, sellSol: 0, devSold: false, trades: 0 },
    };
    const s = await this.d.safety.check(cand);
    const safetyLine = s.ok ? "✅ safety checks passed" : `⛔ UNSAFE: ${s.reasons.join(", ")}`;
    const warn = s.warnings.length ? `\n⚠️ ${s.warnings.join(", ")}` : "";

    const id = Math.random().toString(36).slice(2, 10);
    this.pending.set(id, { mint, symbol, sol, price, score: 0, expires: Date.now() + 60_000 });
    await this.send(
      `Buy ${sol} SOL of ${symbol}? [${config.mode}]\n${info}\n${safetyLine}${warn}\n` +
        `exits: TP +${config.takeProfitPct}% · SL -${config.stopLossPct}% · trail ${config.trailingStopPct}%\n(expires in 60s)`,
      [[{ text: `✅ Buy ${sol} SOL`, callback_data: `b:${id}` }, { text: "Cancel", callback_data: `x:${id}` }]],
    );
  }

  private async cmdSell(args: string[]) {
    const [q, pctArg] = args;
    if (!q) return this.send("usage: /sell <mint|symbol> [pct]");
    const p = this.d.positions.find(q);
    if (!p) return this.send(`no open position matching "${q}"`);
    const pct = pctArg ? Number(pctArg.replace("%", "")) : 100;
    if (!(pct > 0 && pct <= 100)) return this.send("pct must be 1-100");
    const err = await this.d.positions.sellManual(p.mint, pct / 100);
    if (err) await this.send(`sell failed: ${err}`);
  }

  private async cmdSellAll() {
    const n = this.d.positions.open.size;
    if (!n) return this.send("no open positions");
    await this.send(`closing ${n} position(s)…`);
    await this.d.positions.closeAll("manual sell all");
  }

  private async cmdNarratives() {
    const top = this.d.narratives.top(15);
    if (!top.length) return this.send("no hot narratives yet (needs a few minutes of data)");
    const bar = (h: number) => "█".repeat(Math.round(h * 10)).padEnd(10, "·");
    await this.send("🔥 hot narratives\n\n" + top.map((n) => `${bar(n.heat)} ${n.term}`).join("\n"));
  }

  private async cmdConfig() {
    const lines = Object.entries(SETTABLE).map(([k, v]) => `${k} = ${config[v.field]}  (${v.desc})`);
    await this.send(`mode: ${config.mode}${this.d.positions.paused ? " (paused)" : ""}\n\n${lines.join("\n")}\n\nchange with /set <key> <value>`);
  }

  private async cmdSet(args: string[]) {
    const [key, val] = args;
    const spec = key && SETTABLE[key.toLowerCase()];
    if (!spec || val === undefined) return this.send(`usage: /set <key> <value>\nkeys: ${Object.keys(SETTABLE).join(", ")}`);
    const n = Number(val);
    if (!Number.isFinite(n) || n < spec.min || n > spec.max) return this.send(`${key} must be between ${spec.min} and ${spec.max}`);
    const old = config[spec.field];
    (config as any)[spec.field] = n;
    log.info(`telegram: set ${key} ${old} -> ${n}`);
    await this.send(`${key}: ${old} → ${n}  (until restart; put it in .env to keep it)`);
  }

  private async onButton(data: string, message: any) {
    const [kind, a, b] = data.split(":");
    const clearButtons = () =>
      message && this.call("editMessageReplyMarkup", { chat_id: message.chat.id, message_id: message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});

    if (kind === "s") {
      const err = await this.d.positions.sellManual(a, Number(b) / 100);
      if (err) await this.send(`sell failed: ${err}`);
      return;
    }
    if (kind === "b" || kind === "x") {
      const req = this.pending.get(a);
      this.pending.delete(a);
      await clearButtons();
      if (kind === "x") return this.send("cancelled");
      if (!req || Date.now() > req.expires) return this.send("that buy request expired — send /buy again");
      // refresh price right before buying so a stale quote doesn't skew TP/SL
      const fresh = (await fetchPairs([req.mint]).catch(() => new Map())).get(req.mint);
      const price = fresh?.priceNative || this.d.getCandidate(req.mint)?.lastPriceSol || req.price;
      const err = await this.d.positions.buy(req.mint, req.symbol, price, req.score, { manual: true, sol: req.sol });
      if (err) await this.send(`buy failed: ${err}`);
    }
    // clean up expired requests
    for (const [id, r] of this.pending) if (Date.now() > r.expires) this.pending.delete(id);
  }
}
