import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

// fake Telegram Bot API
const sent: any[] = [];
const queue: any[] = [];
let waiter: (() => void) | null = null;
const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  const j = body ? JSON.parse(body) : {};
  const method = req.url!.split("/").pop();
  if (method === "getUpdates") {
    if (!queue.length) await new Promise<void>((r) => { waiter = r; setTimeout(r, 300); });
    const result = queue.splice(0);
    return res.end(JSON.stringify({ ok: true, result }));
  }
  if (method === "sendMessage") sent.push(j);
  res.end(JSON.stringify({ ok: true, result: {} }));
});
await new Promise<void>((r) => server.listen(0, r));
const port = (server.address() as any).port;

Object.assign(process.env, {
  DATA_DIR: "./data-test", TELEGRAM_API_BASE: `http://127.0.0.1:${port}`, TELEGRAM_BOT_TOKEN: "T",
  TELEGRAM_CHAT_ID: "42", PAPER_SLIPPAGE_PCT: "0", ENABLE_RUGCHECK: "false",
});
const { TelegramControl } = await import("../src/telegram.js");
const { PaperExecutor } = await import("../src/trader/executor.js");
const { PositionManager } = await import("../src/trader/positions.js");
const { NarrativeTracker } = await import("../src/narrative.js");
const { MockSafetyChecker } = await import("../src/safety.js");
const { config } = await import("../src/config.js");

const MINT = "So1aNaMemeMint1111111111111111111111111pump";
const cand: any = {
  mint: MINT, name: "Penguin", symbol: "PENG", description: "", sources: new Set(), firstSeen: Date.now(),
  socials: {}, decided: true, lastPriceSol: 1e-6,
  flow: { buyers: new Set(), sellers: new Set(), buySol: 0, sellSol: 0, devSold: false, trades: 0 },
};
const exec = new PaperExecutor();
const positions = new PositionManager(exec);
const tg = new TelegramControl({
  positions, exec, narratives: new NarrativeTracker(), safety: new MockSafetyChecker(),
  getCandidate: (m: string) => (m === MINT ? cand : undefined),
});
positions.notify = tg.alert;

let uid = 1;
const now = () => Math.floor(Date.now() / 1000);
const msg = (text: string, chatId = 42, date = now()) => ({
  update_id: uid++, message: { message_id: uid, date, text, chat: { id: chatId, type: "private" }, from: { id: chatId } },
});
const press = (data: string, chatId = 42) => ({
  update_id: uid++, callback_query: { id: "q" + uid, data, from: { id: chatId }, message: { message_id: 1, chat: { id: chatId, type: "private" } } },
});
async function push(...u: any[]) {
  const before = sent.length;
  queue.push(...u);
  waiter?.();
  for (let i = 0; i < 100 && sent.length === before; i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 150));
  return sent.slice(before);
}

test("telegram control end to end", async () => {
  await tg.start();
  assert.match(sent[0].text, /online/);

  let out = await push(msg("/status"));
  assert.match(out[0].text, /balance: 5\.0000 SOL/);

  // unauthorized chat and stale messages are ignored
  const n = sent.length;
  queue.push(msg("/sellall", 999), msg("/pause", 42, now() - 3600));
  waiter?.();
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(sent.length, n);
  assert.equal(positions.paused, false);

  // manual buy needs confirmation
  out = await push(msg(`/buy ${MINT} 0.2`));
  assert.match(out[0].text, /Buy 0\.2 SOL of PENG/);
  assert.match(out[0].text, /safety checks passed/);
  assert.equal(positions.open.size, 0);
  const confirm = out[0].reply_markup.inline_keyboard[0][0].callback_data;
  out = await push(press(confirm));
  assert.equal(positions.open.size, 1);
  assert.match(out[0].text, /MANUAL BUY PENG/);
  assert.equal(out[0].reply_markup.inline_keyboard[0].length, 3, "buy alert has sell buttons");

  // replaying the confirm button does nothing
  out = await push(press(confirm));
  assert.match(out[0].text, /expired/);

  // price doubles, sell 50% via button, then the rest via /sell symbol
  positions.onPrice(MINT, 1.5e-6);
  out = await push(press(`s:${MINT}:50`));
  assert.match(out[0].text, /PARTIAL PENG/);
  out = await push(msg("/sell peng"));
  assert.match(out[0].text, /CLOSE PENG.*P&L \+/);
  assert.equal(positions.open.size, 0);

  // settings
  out = await push(msg("/set min_score 72"));
  assert.equal(config.minScore, 72);
  out = await push(msg("/set buy_sol 999"));
  assert.match(out[0].text, /between/);
  out = await push(msg("/pause"));
  assert.equal(positions.paused, true);
  assert.equal(await positions.buy("Z", "Z", 1, 99), "auto-buy paused");

  tg.stop();
  server.close();
  server.closeAllConnections();
});
