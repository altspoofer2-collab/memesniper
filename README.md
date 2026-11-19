# memesniper

Narrative-driven Solana meme coin sniper. It watches pump.fun launches and the
DexScreener / GMGN callout feeds, works out which themes are hot right now,
filters out rugs, and buys tokens that score well. It **paper trades by default**.

```
pump.fun launches ─┐                         ┌─ hard safety gates ─┐
DexScreener paid ──┼─► narrative tracker ──► score ────────────────┼─► buy ─► exits (TP / SL / trailing / time)
GMGN trending ─────┘   (what's hot now)                            │
                                                     paper or live executor
```

## Quick start

```bash
npm install
npm run simulate        # fake feed, no network needed: see the whole pipeline work
cp .env.example .env    # then set RPC_URL (Helius/QuickNode/Triton recommended)
npm start               # paper trading on live data
npm run report          # P&L, win rate, exit reasons
```

Run it on a machine that stays on, such as a VPS or `tmux` / `pm2`. Every signal
and trade is written to `data/signals.jsonl` and `data/trades.jsonl`, so you can
look back at what it skipped and why.

## How it decides

**1. Narratives** (`src/narrative.ts`). Every pump.fun launch, paid DexScreener
profile or boost, and GMGN trending token counts as a vote for its words. A term
is "hot" when its count over the last 15 minutes spikes above its 3-hour
baseline. Paid callouts count double. You can also pin themes you believe in
with `NARRATIVES=ai,agent,...`.

**2. Order flow** (pump.fun path). A new launch is watched for `WATCH_SECONDS`.
The bot counts unique buyers, net SOL inflow and buy/sell pressure, and notes
whether the dev sold.

**3. Safety gates** (`src/safety.ts`). If any of these fail, the bot skips the token:
- mint authority not revoked (the dev can print more tokens)
- freeze authority not revoked (a honeypot: the dev can freeze your tokens)
- dev bought more than `MAX_DEV_BUY_PCT` at launch, or already sold
- top 10 wallets hold more than `MAX_TOP10_PCT`, or one wallet holds more than `MAX_SINGLE_HOLDER_PCT`
  (the bonding curve and pool accounts are excluded)
- RugCheck "danger" flags count as score penalties

**4. Score** (`src/scorer.ts`), out of 100: narrative 30, momentum 35, socials 15,
external callouts 20. The bot buys when the score is at least `MIN_SCORE`.

**5. Exits** (`src/trader/positions.ts`): at +`TAKE_PROFIT_PCT` it sells
`TAKE_PROFIT_SELL_PCT`% and trails the rest by `TRAILING_STOP_PCT`. It also has
a hard stop at −`STOP_LOSS_PCT`, a time stop at `MAX_HOLD_MINUTES`, a daily loss
limit and a cap on open positions.

## Going live

Only do this after days of paper trading with a positive `npm run report`. Paper
fills are already penalised for fees and slippage, but real fills are worse.

1. Make a **new wallet** just for the bot and fund it with what you can lose.
2. In `.env` set `MODE=live`, `LIVE_CONFIRM=yes-i-understand` and `WALLET_PRIVATE_KEY=`.
3. Use a paid RPC. Start with a small `BUY_AMOUNT_SOL`.

Live swaps use PumpPortal's local-transaction API with `pool: "auto"`, which
covers the pump.fun curve, PumpSwap and Raydium. PumpPortal builds the
transaction and **you sign it locally**, so your key never leaves your machine.
PumpPortal charges a small fee per trade. Ctrl-C in live mode does **not** sell
open positions; it lists them.

## Sources & caveats

| Source | Access | Notes |
|---|---|---|
| pump.fun | PumpPortal websocket, free | new tokens, trades, migrations |
| DexScreener | public API, free | latest paid profiles and boosts, pair stats |
| GMGN | unofficial, best effort | behind Cloudflare; disables itself after 5 failures |
| RugCheck | public API | optional extra signal |
| Twitter/X | *not yet* | add a source that calls `narratives.observe(tweetText, weight)` |

## Adding Twitter/X later

Write `src/sources/twitter.ts` that polls a search (official X API or
TwitterAPI.io) for watched KOL accounts and for `$TICKER` / contract-address
mentions. Then:
- call `narratives.observe(tweet.text, 3)` so KOL tweets drive the narrative heat
- add `"twitter"` to `Source` in `src/types.ts`, then send contract addresses found in tweets to `onExternal({ mint, source: "twitter" })`
  and give "twitter" a weight in the scorer's `external` block
