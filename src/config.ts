import "dotenv/config";

function num(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Config ${name} must be a number, got "${v}"`);
  return n;
}
function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}
function str(name: string, def = ""): string {
  return process.env[name] ?? def;
}
function list(name: string, def: string[]): string[] {
  const v = process.env[name];
  if (!v) return def;
  return v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export const config = {
  mode: (str("MODE", "paper") as "paper" | "live"),
  liveConfirm: str("LIVE_CONFIRM"),
  rpcUrl: str("RPC_URL", "https://api.mainnet-beta.solana.com"),
  walletPrivateKey: str("WALLET_PRIVATE_KEY"),
  pumpPortalApiKey: str("PUMPPORTAL_API_KEY"),

  // sizing / risk
  buyAmountSol: num("BUY_AMOUNT_SOL", 0.05),
  maxOpenPositions: num("MAX_OPEN_POSITIONS", 3),
  dailyLossLimitSol: num("DAILY_LOSS_LIMIT_SOL", 0.5),
  slippagePct: num("SLIPPAGE_PCT", 15),
  priorityFeeSol: num("PRIORITY_FEE_SOL", 0.0005),
  paperStartSol: num("PAPER_START_SOL", 5),

  // exits
  takeProfitPct: num("TAKE_PROFIT_PCT", 100),
  takeProfitSellPct: num("TAKE_PROFIT_SELL_PCT", 50), // sell this % at TP, trail the rest
  stopLossPct: num("STOP_LOSS_PCT", 30),
  trailingStopPct: num("TRAILING_STOP_PCT", 25),
  maxHoldMinutes: num("MAX_HOLD_MINUTES", 30),

  // signal
  minScore: num("MIN_SCORE", 60),
  watchSeconds: num("WATCH_SECONDS", 45),
  maxDevBuyPct: num("MAX_DEV_BUY_PCT", 8),
  maxTop10Pct: num("MAX_TOP10_PCT", 30),
  maxSingleHolderPct: num("MAX_SINGLE_HOLDER_PCT", 8),
  minUniqueBuyers: num("MIN_UNIQUE_BUYERS", 8),
  // external (DexScreener/GMGN) candidates
  minLiquidityUsd: num("MIN_LIQUIDITY_USD", 15000),
  maxPairAgeHours: num("MAX_PAIR_AGE_HOURS", 12),

  seedNarratives: list("NARRATIVES", []),
  enablePumpPortal: bool("ENABLE_PUMPPORTAL", true),
  enableDexScreener: bool("ENABLE_DEXSCREENER", true),
  enableGmgn: bool("ENABLE_GMGN", true),
  enableRugcheck: bool("ENABLE_RUGCHECK", true),

  telegramBotToken: str("TELEGRAM_BOT_TOKEN"),
  telegramChatId: str("TELEGRAM_CHAT_ID"),
  dataDir: str("DATA_DIR", "./data"),
};

export type Config = typeof config;
