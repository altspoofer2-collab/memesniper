export type Source = "pumpfun" | "dexscreener-profile" | "dexscreener-boost" | "gmgn" | "mock";

/** A token we've heard about from any source. */
export interface Candidate {
  mint: string;
  name: string;
  symbol: string;
  description: string;
  sources: Set<Source>;
  firstSeen: number;
  creator?: string;
  devInitialBuyPct?: number; // % of supply the creator bought at launch
  socials: { twitter?: string; telegram?: string; website?: string };
  /** early order flow, collected while watching (pump.fun tokens) */
  flow: {
    buyers: Set<string>;
    sellers: Set<string>;
    buySol: number;
    sellSol: number;
    devSold: boolean;
    trades: number;
  };
  lastPriceSol?: number;
  /** DexScreener pair stats (external candidates) */
  pair?: PairStats;
  boostAmount?: number;
  decided: boolean;
}

export interface PairStats {
  pairAddress: string;
  dexId: string;
  priceNative: number; // SOL per token when quote is SOL
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  ageHours: number;
  m5Buys: number;
  m5Sells: number;
  h1Buys: number;
  h1Sells: number;
  m5VolumeUsd: number;
  h1PriceChangePct: number;
  quoteSymbol: string;
}

export interface TradeEvent {
  mint: string;
  side: "buy" | "sell";
  trader: string;
  solAmount: number;
  tokenAmount: number;
  priceSol: number;
}

export interface NewTokenEvent {
  mint: string;
  name: string;
  symbol: string;
  uri?: string;
  creator: string;
  devInitialBuyPct: number;
  priceSol: number;
  description?: string;
  socials?: Candidate["socials"];
}

export interface ExternalTokenEvent {
  mint: string;
  source: Source;
  name?: string;
  symbol?: string;
  description?: string;
  socials?: Candidate["socials"];
  boostAmount?: number;
}

export interface SafetyReport {
  ok: boolean;
  reasons: string[]; // why it failed (hard gates)
  warnings: string[];
  mintAuthorityRevoked?: boolean;
  freezeAuthorityRevoked?: boolean;
  top10Pct?: number;
  maxHolderPct?: number;
  rugcheckScore?: number;
}

export interface ScoreBreakdown {
  total: number;
  narrative: number;
  momentum: number;
  socials: number;
  external: number;
  matchedNarratives: string[];
  notes: string[];
}

export interface Position {
  id: string;
  mint: string;
  symbol: string;
  openedAt: number;
  solIn: number; // total SOL spent incl. fees
  tokens: number; // tokens currently held
  entryPriceSol: number;
  highPriceSol: number;
  lastPriceSol: number;
  tookProfit: boolean;
  realizedSol: number; // SOL received from partial sells
  score: number;
}
