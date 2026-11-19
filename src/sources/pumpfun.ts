/**
 * pump.fun via PumpPortal's public websocket (wss://pumpportal.fun/api/data).
 * Streams every new pump.fun launch and, on request, every trade for a mint.
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { log } from "../log.js";
import type { NewTokenEvent, TradeEvent } from "../types.js";

const PUMP_SUPPLY = 1_000_000_000;

export interface PumpFunEvents {
  newToken: [NewTokenEvent];
  trade: [TradeEvent];
  migrate: [string];
}

export class PumpFunSource extends EventEmitter<PumpFunEvents> {
  private ws?: WebSocket;
  private tradeKeys = new Set<string>();
  private backoff = 1000;
  private closed = false;

  constructor(private apiKey = "") {
    super();
  }

  start() {
    const url = "wss://pumpportal.fun/api/data" + (this.apiKey ? `?api-key=${this.apiKey}` : "");
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("open", () => {
      log.info("pumpportal: connected");
      this.backoff = 1000;
      this.send({ method: "subscribeNewToken" });
      this.send({ method: "subscribeMigration" });
      if (this.tradeKeys.size) this.send({ method: "subscribeTokenTrade", keys: [...this.tradeKeys] });
    });
    ws.on("message", (buf) => this.onMessage(buf.toString()));
    ws.on("error", (e) => log.warn("pumpportal error:", e.message));
    ws.on("close", () => {
      if (this.closed) return;
      log.warn(`pumpportal: disconnected, retrying in ${this.backoff / 1000}s`);
      setTimeout(() => this.start(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30_000);
    });
  }

  stop() {
    this.closed = true;
    this.ws?.close();
  }

  watchTrades(mint: string) {
    if (this.tradeKeys.has(mint)) return;
    this.tradeKeys.add(mint);
    this.send({ method: "subscribeTokenTrade", keys: [mint] });
  }

  unwatchTrades(mint: string) {
    if (!this.tradeKeys.delete(mint)) return;
    this.send({ method: "unsubscribeTokenTrade", keys: [mint] });
  }

  private send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(raw: string) {
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m?.mint || !m.txType) return; // subscription acks etc.
    const priceSol = Number(m.marketCapSol) / PUMP_SUPPLY ||
      (m.solAmount && m.tokenAmount ? Number(m.solAmount) / Number(m.tokenAmount) : 0);

    if (m.txType === "create") {
      this.emit("newToken", {
        mint: m.mint,
        name: String(m.name ?? ""),
        symbol: String(m.symbol ?? ""),
        uri: m.uri,
        creator: m.traderPublicKey,
        devInitialBuyPct: (Number(m.initialBuy ?? 0) / PUMP_SUPPLY) * 100,
        priceSol,
      });
    } else if (m.txType === "buy" || m.txType === "sell") {
      this.emit("trade", {
        mint: m.mint,
        side: m.txType,
        trader: m.traderPublicKey,
        solAmount: Number(m.solAmount ?? 0),
        tokenAmount: Number(m.tokenAmount ?? 0),
        priceSol,
      });
    } else if (m.txType === "migrate") {
      this.emit("migrate", m.mint);
    }
  }
}

/** Fetch pump.fun token metadata JSON (description + socials) from its IPFS uri. */
export async function fetchMetadata(uri: string): Promise<{
  description?: string;
  twitter?: string;
  telegram?: string;
  website?: string;
} | null> {
  try {
    const res = await fetch(uri, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const j: any = await res.json();
    return {
      description: typeof j.description === "string" ? j.description.slice(0, 500) : undefined,
      twitter: j.twitter || undefined,
      telegram: j.telegram || undefined,
      website: j.website || undefined,
    };
  } catch {
    return null;
  }
}
