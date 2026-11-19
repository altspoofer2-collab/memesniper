import { config } from "./config.js";
import { log } from "./log.js";

/** Telegram alerts (optional). Create a bot with @BotFather, get chat id from @userinfobot. */
export function notify(text: string) {
  if (!config.telegramBotToken || !config.telegramChatId) return;
  fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: config.telegramChatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(8000),
  }).catch((e) => log.warn("telegram:", e.message));
}
