import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config.js";
import { log } from "../log.js";

export interface Fill {
  tokens: number;
  sol: number; // SOL spent (buy) or received (sell), fees included
  sig?: string;
}

export interface Executor {
  readonly kind: "paper" | "live";
  buy(mint: string, sol: number, priceSol: number): Promise<Fill>;
  sell(mint: string, tokens: number, priceSol: number, fraction: number): Promise<Fill>;
  balanceSol(): Promise<number>;
}

/**
 * Paper executor: fills at the observed price with a realistic haircut for
 * platform fee + slippage + priority fee, so paper P&L isn't fantasy.
 */
export class PaperExecutor implements Executor {
  readonly kind = "paper" as const;
  private sol = config.paperStartSol;
  private fee = 0.0125; // pump.fun / AMM fees approx
  private slip = Number(process.env.PAPER_SLIPPAGE_PCT ?? 4) / 100;

  async buy(_mint: string, sol: number, priceSol: number): Promise<Fill> {
    if (priceSol <= 0) throw new Error("no price");
    const cost = sol + config.priorityFeeSol;
    if (cost > this.sol) throw new Error("insufficient paper balance");
    this.sol -= cost;
    const tokens = (sol * (1 - this.fee)) / (priceSol * (1 + this.slip));
    return { tokens, sol: cost };
  }

  async sell(_mint: string, tokens: number, priceSol: number): Promise<Fill> {
    const out = Math.max(0, tokens * priceSol * (1 - this.slip) * (1 - this.fee) - config.priorityFeeSol);
    this.sol += out;
    return { tokens, sol: out };
  }

  async balanceSol() {
    return this.sol;
  }
}

/**
 * Live executor via PumpPortal's Local Transaction API: PumpPortal builds the
 * swap transaction (pump.fun curve, PumpSwap or Raydium — pool "auto"), and we
 * sign it locally. Your private key never leaves this machine.
 */
export class LiveExecutor implements Executor {
  readonly kind = "live" as const;
  private conn = new Connection(config.rpcUrl, "confirmed");
  private kp: Keypair;

  constructor() {
    if (!config.walletPrivateKey) throw new Error("WALLET_PRIVATE_KEY is required for live mode");
    this.kp = Keypair.fromSecretKey(bs58.decode(config.walletPrivateKey));
    log.info(`live wallet: ${this.kp.publicKey.toBase58()}`);
  }

  async balanceSol() {
    return (await this.conn.getBalance(this.kp.publicKey)) / 1e9;
  }

  private async tokenBalance(mint: string): Promise<number> {
    const res = await this.conn.getParsedTokenAccountsByOwner(this.kp.publicKey, { mint: new PublicKey(mint) });
    return res.value.reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
  }

  private async swap(action: "buy" | "sell", mint: string, amount: string, inSol: boolean): Promise<string> {
    const res = await fetch("https://pumpportal.fun/api/trade-local", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publicKey: this.kp.publicKey.toBase58(),
        action,
        mint,
        amount,
        denominatedInSol: inSol ? "true" : "false",
        slippage: config.slippagePct,
        priorityFee: config.priorityFeeSol,
        pool: "auto",
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 200) throw new Error(`pumpportal ${res.status}: ${await res.text()}`);
    const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
    tx.sign([this.kp]);
    const sig = await this.conn.sendTransaction(tx, { skipPreflight: true, maxRetries: 3 });
    const bh = await this.conn.getLatestBlockhash();
    const conf = await this.conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    if (conf.value.err) throw new Error(`tx failed ${sig}: ${JSON.stringify(conf.value.err)}`);
    return sig;
  }

  async buy(mint: string, sol: number): Promise<Fill> {
    const before = await this.balanceSol();
    const sig = await this.swap("buy", mint, String(sol), true);
    const [after, tokens] = await Promise.all([this.balanceSol(), this.tokenBalance(mint)]);
    return { tokens, sol: before - after, sig };
  }

  async sell(mint: string, _tokens: number, _price: number, fraction: number): Promise<Fill> {
    const held = await this.tokenBalance(mint);
    const before = await this.balanceSol();
    const pct = `${Math.round(fraction * 100)}%`;
    const sig = await this.swap("sell", mint, pct, false);
    const [after, left] = await Promise.all([this.balanceSol(), this.tokenBalance(mint)]);
    return { tokens: held - left, sol: after - before, sig };
  }
}
