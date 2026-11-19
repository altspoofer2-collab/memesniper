/**
 * Rug filters. These are hard gates — a token that fails any of them is skipped
 * no matter how good its narrative/momentum looks.
 *
 * On-chain (via your RPC):
 *  - mint authority must be revoked (else the dev can print tokens)
 *  - freeze authority must be revoked (else the dev can freeze your tokens = honeypot)
 *  - holder concentration: top10 / single-wallet share, EXCLUDING program-owned
 *    accounts (pump.fun bonding curve, AMM pool vaults). Those owners are PDAs
 *    (off the ed25519 curve), so we drop any holder whose owner is off-curve.
 * Off-chain (optional): RugCheck summary, added as warnings + score penalty.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import type { Candidate, SafetyReport } from "./types.js";

export class SafetyChecker {
  private conn: Connection;
  constructor(rpcUrl = config.rpcUrl) {
    this.conn = new Connection(rpcUrl, "confirmed");
  }

  async check(c: Candidate): Promise<SafetyReport> {
    const r: SafetyReport = { ok: true, reasons: [], warnings: [] };
    const fail = (msg: string) => {
      r.ok = false;
      r.reasons.push(msg);
    };

    // dev behaviour (from pump.fun stream)
    if (c.devInitialBuyPct !== undefined && c.devInitialBuyPct > config.maxDevBuyPct)
      fail(`dev bought ${c.devInitialBuyPct.toFixed(1)}% at launch`);
    if (c.flow.devSold) fail("dev already sold");

    const mint = new PublicKey(c.mint);
    try {
      const info = await this.conn.getParsedAccountInfo(mint);
      const parsed: any = (info.value?.data as any)?.parsed?.info;
      if (!parsed) {
        fail("could not read mint account");
        return r;
      }
      r.mintAuthorityRevoked = !parsed.mintAuthority;
      r.freezeAuthorityRevoked = !parsed.freezeAuthority;
      if (!r.mintAuthorityRevoked) fail("mint authority NOT revoked");
      if (!r.freezeAuthorityRevoked) fail("freeze authority NOT revoked");

      const supply = Number(parsed.supply) / 10 ** Number(parsed.decimals);
      const largest = await this.conn.getTokenLargestAccounts(mint);
      const accounts = largest.value.slice(0, 20);
      const owners = await this.conn.getMultipleParsedAccounts(accounts.map((a) => a.address));
      const holders: number[] = [];
      owners.value.forEach((acc, i) => {
        const owner = (acc?.data as any)?.parsed?.info?.owner;
        if (!owner) return;
        if (!PublicKey.isOnCurve(new PublicKey(owner).toBytes())) return; // curve / pool / PDA
        holders.push(((accounts[i].uiAmount ?? 0) / supply) * 100);
      });
      holders.sort((a, b) => b - a);
      r.top10Pct = holders.slice(0, 10).reduce((s, x) => s + x, 0);
      r.maxHolderPct = holders[0] ?? 0;
      if (r.top10Pct > config.maxTop10Pct) fail(`top10 hold ${r.top10Pct.toFixed(1)}%`);
      if (r.maxHolderPct > config.maxSingleHolderPct) fail(`one wallet holds ${r.maxHolderPct.toFixed(1)}%`);
    } catch (e: any) {
      fail(`rpc error: ${e.message}`);
    }

    if (config.enableRugcheck) {
      try {
        const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${c.mint}/report/summary`, {
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const j: any = await res.json();
          r.rugcheckScore = Number(j.score_normalised ?? j.score ?? 0);
          for (const risk of j.risks ?? []) {
            if (risk.level === "danger") r.warnings.push(`rugcheck: ${risk.name}`);
          }
        }
      } catch {
        /* rugcheck is optional */
      }
    }
    return r;
  }
}

/** Stand-in used by --simulate so no RPC is needed. */
export class MockSafetyChecker {
  async check(c: Candidate): Promise<SafetyReport> {
    const r: SafetyReport = { ok: true, reasons: [], warnings: [], mintAuthorityRevoked: true, freezeAuthorityRevoked: true };
    if ((c.devInitialBuyPct ?? 0) > config.maxDevBuyPct) {
      r.ok = false;
      r.reasons.push(`dev bought ${c.devInitialBuyPct!.toFixed(1)}%`);
    }
    if (c.flow.devSold) {
      r.ok = false;
      r.reasons.push("dev already sold");
    }
    if (c.symbol.startsWith("RUG")) {
      r.ok = false;
      r.reasons.push("freeze authority NOT revoked");
    }
    return r;
  }
}
