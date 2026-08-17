# PriceKalshiHistorical — What Can Be Done & Hard Limitations

**Goal:** collect Kalshi price/volume/liquidity/orderbook history to backtest profitable entry/exit strategies and train a prediction model.

**Bottom line up front:**

| Source | Use for | Don't use for |
|---|---|---|
| **Official Kalshi Trade API v2** (`api.elections.kalshi.com`) | Real market list, live quotes, trades, candles — the only ground-truth for real backtesting | Historical L2 orderbook depth — it doesn't exist retroactively unless *you* collected it live |
| **`karagemop466-tech/Kalshi` clone** (https://karagemop466-tech.github.io/Kalshi/) | Local infra testbed, schema prototyping, paper-trading harness, analytics-scanner examples — *zero* infra cost | Training a real predictive model — its prices are synthetic |
| **Third-party archives** (Lychee, Predexon, Dome, KalshiBacktest) | Buying the history you can't backfill yourself (full L2, 2021→present) | Live execution — you still need the official API to trade |

> **You cannot download years of historical orderbook depth from Kalshi's official API alone.** You can download candles + trades historically, but if your edge depends on spread, queue position, or liquidity at time *t*, you must either (a) start polling *now* and build the dataset forward, or (b) pay a third-party that already did.

---

## 1) Official Kalshi API — what it actually exposes

Base URLs (same API, different hosts):
- `https://api.elections.kalshi.com/trade-api/v2` (primary) [6](https://predscope.com/guide/kalshi-api)
- `https://trading-api.kalshi.com/trade-api/v2` / `https://demo-api.kalshi.co/trade-api/v2` (demo) [6](https://predscope.com/guide/kalshi-api)

Auth: **public** market-data reads need no key; trading/portfolio needs RSA-PSS per-request signing [5](https://pm.wiki/learn/kalshi-api). Real SDK: `kalshi-python`.

### Public market data (no auth)

| Endpoint | What you get | Notes |
|---|---|---|
| `GET /markets` + `GET /markets/{ticker}` | All active markets: ticker, title, `yes_bid_dollars` / `yes_ask_dollars`, `last_price_dollars`, `volume` / `volume_24h` (`volume_fp`), `open_interest_fp`, `close_time`, `status`, `yes_bid_size` etc. | Pagination cursor-based, up to 1000 per page [5](https://pm.wiki/learn/kalshi-api) |
| `GET /events`, `GET /events/{ticker}`, `GET /series` | Event/series metadata, `mutually_exclusive` flag (critical for arbitrage), categories | `with_nested_markets=true` on events |
| `GET /markets/{ticker}/orderbook` | **Current** L2 `yes`/`no` bids & asks `[price_cents, size]` — full depth *right now* | Public in practice despite spec saying auth [5](https://pm.wiki/learn/kalshi-api) |
| `GET /markets/orderbooks` | Batch current books for up to 100 tickers | Added Mar 2026 [6](https://predscope.com/guide/kalshi-api) |
| `GET /markets/trades` | Recent trade tape (cross-market, paginated) | Historical trades older than cutoff move to `/historical/trades` |
| `GET /markets/candlesticks` + `GET /series/{s}/markets/{t}/candlesticks` | OHLCV candles per market: intervals `1` (1m), `60` (1h), `1440` (1d) [4](https://docs.predexon.com/api-reference/kalshi/orderbooks) | Batch endpoint: up to 100 markets / 10k candles per call; per-market endpoint similar. `yes_bid/open/close`, `yes_ask`, `price`, `volume_fp` |
| `GET /events/{ticker}/candlesticks` | Event-level candlesticks | [9](https://docs.kalshi.com/api-reference/events/get-event-candlesticks) |
| WebSocket `wss://api.elections.kalshi.com/trade-api/ws/v2` | Live `orderbook`, `ticker`, `trade` streams | Realtime only, no replay [6](https://predscope.com/guide/kalshi-api) |

### Authenticated (your account only)

`GET /portfolio/balance`, `/portfolio/positions`, `/portfolio/orders`, `/portfolio/fills`, `/portfolio/settlements`, `POST /portfolio/events/orders` etc. — your fills/orders/history, not market-wide.

### Historical tier (since 2026-02-19)

Kalshi split live vs historical to keep live fast [2](https://docs.kalshi.com/getting_started/historical_data). Live returns only last ~3 months; older data moves to:

```
GET /historical/cutoff        -> { market_settled_ts, trades_created_ts, orders_updated_ts, ... }
GET /historical/markets       -> settled markets older than cutoff
GET /historical/markets/{ticker}/candlesticks
GET /historical/trades        -> trades older than cutoff (market-wide)
GET /historical/fills         -> your fills older than cutoff
GET /historical/orders        -> your cancelled/executed orders older than cutoff
GET /historical/positions     -> your settled positions [7](https://docs.kalshi.com/changelog)
```

`GET /historical/*` is the long-term backfill path; `GET /markets*` is the last-90-days path [2](https://www.turbinefi.com/blog/historical-prediction-market-data-backtesting-2026).

### Rate limits

Token-bucket, per-tier. Basic ≈ **20 req/s** (each call ≈10 tokens) [2](https://www.turbinefi.com/blog/historical-prediction-market-data-backtesting-2026). Higher tiers (Prime etc.) expose `GET /account/limits` and `/account/endpoint_costs` [6](https://predscope.com/guide/kalshi-api).

---

## 2) Official API — hard limitations for "profitable entry/exit backtesting"

**1. No official historical orderbook.**
> "Kalshi's public API is great for live data, but it does not expose historical order book snapshots — only trades and candles. We continuously poll Kalshi's live order book and persist the bid/ask depth..." [1](https://kalshibacktest.com/) / [8](https://kalshibacktest.com/)

You can call `/markets/{ticker}/orderbook` *today* and get the book *now*. You cannot ask "what did the book at 14:32:11 on 2025-11-04 look like?" unless you recorded it yourself. There is no `/historical/orderbook`. The only retroactive L2 is via third parties (Dome [1](https://docs.domeapi.io/api-reference/endpoint/get-kalshi-orderbook-history), Predexon [4](https://docs.predexon.com/api-reference/kalshi/orderbooks) since Jan 2026, Lychee since July 2021 [3](https://lycheedata.com/kalshi-historical-data), etc.) — and those are paid.

**Implication:** Any strategy whose fill assumption depends on *spread, depth, queue, or price improvement* cannot be faithfully backtested on pure official history. Your backtest will look better than reality (you assume `mid` fills when the real ask was 4¢ wide).

**2. Historical partition + cursor pagination ⇒ slow backfill.**
A full pull of 72M trades at 20 req/s takes *days* even with cursors; a naïve 97M-trade pull was quoted as "56 days of continuous polling" [2](https://www.turbinefi.com/blog/historical-prediction-market-data-backtesting-2026). You need incremental cursors, checkpointing, retries, and you must query *both* live and historical endpoints and union them.

**3. Candle and trade coverage gaps.**
- Candles only `1m / 1h / 1d`. No `5s` or `15m` natively; you aggregate `1m` yourself.
- `price`, `yes_bid`, `yes_ask` OHLC are rounded to sub-cent dollars; `mean/prev/min/max_dollars` added [9](https://docs.kalshi.com/api-reference/events/get-event-candlesticks).
- No L2-derived features (bid depth, ask depth) in the candle payload — you need books for that.

**4. Orders/fills are private.**
Market-wide order flow is *not* exposed. `GET /portfolio/fills` and `GET /historical/orders` are your fills only [2](https://docs.kalshi.com/getting_started/historical_data). You cannot reconstruct who else was resting where, or hidden liquidity dynamics, without packet-capturing the book stream.

**5. Volume / open interest / liquidity are point-in-time, not timeseries.**
`volume_fp`, `volume_24h_fp`, `open_interest_fp`, `liquidity` are returned as scalar snapshots per market [6](https://predscope.com/guide/kalshi-api). There is no `/markets/{ticker}/volume_history`. To plot "volume went 120k→85k over the last 5 min" you must poll once per second for days and build it yourself.

**6. WebSocket gives no replay.**
`wss://.../ws/v2` is realtime only [6](https://predscope.com/guide/kalshi-api). If your collector was down Tuesday at 2pm, that 2pm tape is gone forever (except as aggregated candles/trades).

**7. Settlement & MEE semantics matter for PnL.**
Every contract settles binary `$1` (Yes wins) or `$0` (No). Fees are **quadratic**: `fee = 0.07 × contracts × p × (1-p)` on taker flow (the clone implements this correctly; the real Kalshi schedule is similar but tiered by volume). A backtest that ignores fees or assumes frictionless entry at `mid` will overstate edge by ~2-7¢/round-trip on liquid names, much more on wide books.

**8. Market heterogeneity.**
32+ categories in the wild (the clone seeds 32 events/90 markets as an example: Politics, Economics, Crypto, Sports, Weather, Science & Tech, Culture, Companies). Your model will see very different microstructure across a 15-min BTC up/down market vs a 700-day political nominee market — you cannot pool them without serious normalization.

---

## 3) The `karagemop466-tech/Kalshi` clone — what it actually is

The repo behind https://karagemop466-tech.github.io/Kalshi/ is **not Kalshi**. It's an original, zero-dependency prediction-market exchange that *looks* like Kalshi but runs its own engine (README verbatim: "Demo/research project. Not affiliated with Kalshi." and "exchange engine runs entirely in your browser").

It has **two modes sharing one frontend** (`docs/js/app.js` auto-probes `/api/health`):

| Mode | Engine | Data |
|---|---|---|
| **Static / GitHub Pages** | `docs/js/exchange.js` (736 lines, full port of the Node engine) + `docs/js/localapi.js` shim | In-memory price process + `localStorage` portfolio. No server. |
| **Node server** (`node server/index.js`, Node ≥22.5, built-in `node:sqlite`) | `server/engine.js` (309 lines) + `server/trading.js` + `server/db.js` + `server/analysis.js` + `server/kalshiSync.js` | SQLite `data/exchange.db` + optional live mirror of *real* Kalshi when reachable |

### What the clone *does* give you (useful for PriceKalshiHistorical scaffolding)

**A. Fully worked storage schema you'd want to copy**

`server/db.js` defines 9 tables already tailored for a companion analysis repo (`snapshots`, `book_snapshots`, `candles`, `anomalies` etc.):

```sql
events(ticker, title, category, mutually_exclusive, close_time)
markets(ticker, event_ticker, anchor, liquidity, volume, volume_24h, open_interest,
        last_price, yes_bid, yes_ask, yes_bid_size, yes_ask_size, mid, source)
candles(ticker, interval(1m|15m|1h|1d), t_open, o,h,l,c,v)
snapshots(ts, ticker, mid,bid,ask,last, volume_24h)          -- every 5s, WAL, pruned to 3d
book_snapshots(ts, ticker, bids JSON, asks JSON)               -- every 15s, pruned to 1d
anomalies(ts, kind, scope, severity, payload JSON)            -- scanner findings
orders / positions / account / sync_log
```

You can literally `sqlite3 data/exchange.db` or open it from Python `sqlite3` — the clone docs invite this: "Query it directly from your analysis repo".

**B. Continuous price history (synthetic, but real-shaped)**

`server/engine.js`:
- Latent fair value `p` per market mean-reverts to `anchor` (the catalog's prior probability): `dp = (anchor - p)*0.006 + N(0, volBase)` with `volBase = 0.0016 + 0.006*p*(1-p)` + 0.4% news jumps.
- 7-level L2 book rebuilt every `TICK_MS=1000` around `mid`, tighter when `liquidity >15000` (1¢ spread) else 1-2¢, quantities `sizeAt(liquidity, level)`.
- Organic flow: Poisson taker hits (`λ ≈ 0.02–0.55` scaled by liquidity) that walk the book, print `last`, bump `volume/v24/OI`, and push a `tape` (last 80 trades).
- Candle seeding: **60 days of `1h`** + **12h of `1m`** per market generated by a backward random walk ending at `anchor`; then live `1m` bars aggregated as trades arrive; `15m`/`1d` derived on read via `aggregate()` in `server/index.js`.
- Snapshots every `5s`, book snapshots every `15s`.
- Settlement: markets past `close_time` resolve Yes/No sampled from fair value and pay positions `$1/$0`.

So for *infrastructure* you get: tick-level-ish mids, book depth, trades, candles, volume — exactly the shape a real collector would produce.

**C. A drop-in live mirror (`server/kalshiSync.js`, 113 lines)**

When `KALSHI_API_BASE` (default `https://api.elections.kalshi.com/trade-api/v2`) is reachable, every `SYNC_INTERVAL_MS=15000` it:

```
GET /markets?limit=200&status=open
GET /events?event_tickers=...   (batch 50)
```

and upserts into `events`/`markets` with `source='kalshi'` + `mid=(bid+ask)/2`. The engine then *skips* those `source='kalshi'` markets (no synthetic ticks, books synthesized minimally from upstream quotes). `GET /api/health` tells you `mode: sim|live` and `GET /api/sync/log` shows the sync trail.

This is the only connection to real Kalshi in the clone. When the sandbox blocks outbound HTTP (as it did during probing), the clone silently stays in `sim`.

**D. Paper trading & fees**

`server/trading.js` implements market/limit Buy/Sell × Yes/No against the live book, price-improvement on marketable limits, partial fills, resting-order matching every `1.5s`, cancellation, reserve of buying power, and the quadratic fee `fee = 0.07*contracts*p*(1-p)`. `POST /api/order`, `POST /api/order/:id/cancel`, `GET /api/portfolio` work identically in Node and `localStorage` modes.

**E. Analytics scanner (`server/analysis.js`, 131 lines) — the seed of your prediction features**

Runs every `8s`:

| Kind | Trigger | Use for your model |
|---|---|---|
| `mee_sum` | `|Σ mids - 1| > 2.5¢` on mutually-exclusive events | Cross-market drift feature |
| `mee_arb` | `Σ asks < 99¢` (buy all Yes) or `Σ bids > 101¢` (sell all) | Hard arbitrage label |
| `wide_spread` | spread ≥4 ticks on vol>500 | Liquidity regime feature |
| `fast_move` | ≥5¢ move within 5 min | Volatility / news shock |

Exposed as `GET /api/analysis/anomalies?kind=` and `GET /api/analysis/mee` (MEE sums table). The README explicitly says this layer was "built for the pricing-irregularities repo" — i.e., for *you*.

**F. REST surface you can reuse for PriceKalshiHistorical**

The Node server already implements the API you'd want to mirror:

```
GET /api/health, /api/meta
GET /api/events?category=&q=, /api/event/:ticker
GET /api/markets?q=&category=, /api/market/:ticker, /api/market/:ticker/book,
    /api/market/:ticker/candles?interval=1m|15m|1h|1d&limit=, /api/market/:ticker/trades
POST /api/order, POST /api/order/:id/cancel
GET /api/portfolio, GET /api/analysis/anomalies, GET /api/analysis/mee, GET /api/sync/log
```

Frontend is a hash SPA (`#/`, `#/category/:name`, `#/markets`, `#/event/:ticker`, `#/market/:ticker`, `#/portfolio`, `#/analysis`) with a minimal canvas candlestick chart (`docs/js/chart.js`).

### What the clone does *not* give you (critical caveats)

**1. Prices are synthetic.**
No real order flow, no real news, no real cross-venue arbitrage. The `anchor` priors in `server/catalog.js` (e.g., `Gavin Newsom 0.27`, `JD Vance 0.41`, BTC `$110–120k` at 0.30) are fictional datasets "modeled on the kinds of contracts a real exchange lists". A model trained on this will learn `mulberry32` RNG structure, not politics or markets. **Never report synthetic backtest PnL as evidence of edge.**

**2. No persistent history beyond a few days.**
`snapshots` are `DELETE WHERE ts < now-3d`; `book_snapshots` `now-1d`; `anomalies` `now-7d` (see `engine.js`/`analysis.js`). This is intentional for a demo; a real history collector must never prune.

**3. `kalshiSync` is a thin quote mirror, not a history collector.**
It syncs *levels* every 15s, overwriting `last_price/yes_bid/yes_ask/mid/volume` in place. It does **not** persist trades, books, or candles from Kalshi, nor does it call `/historical/*` or `/markets/candlesticks` to backfill. If you rely on it for history you'll have sparse, lossy ticks with no L2 archive.

**4. In-browser mode has no shared dataset.**
Each visitor gets their own `localStorage` portfolio and in-memory engine; there is no central DB. Two analysts see diverged simulations.

---

## 4) So — what *can* you do for profitable entry/exit backtesting?

### Feasible with official API alone (candles + trades history)

- **OHLCV regime models:** Train on `1m`/`1h` candles from `GET /markets/candlesticks` (live) + `GET /historical/markets/{ticker}/candlesticks` (archived). Features: returns, volatility, volume, time-to-expiry drift. Labels: `close_{t+k} > entry_price` after fees.
- **Trade-tape momentum / mean reversion:** Use `GET /markets/trades` + `GET /historical/trades` (paginated, cursor) which returns actual prints with timestamp/price/size — enough for mid-price tape reconstruction at trade resolution.
- **Event-level MEE basket tests:** Join `GET /events` (`mutually_exclusive`) with market prices to reproduce the `mee_sum` / `mee_arb` logic server-side. You can backtest "if Σ mids deviates >3¢, fade it" purely from candle closes.
- **Survival/settlement prediction:** `GET /historical/markets` gives settled price (0 or 1) as ground truth label for supervised learning.

**What you *cannot* faithfully test without L2:** anything where fill price depends on "was there size at 42¢ when I sent the order?" — spread-crossing costs, queue slippage, limit fill probability, and fee-aware optimal sizing. Your backtest will overestimate Sharpe by 30–100% if you assume `mid`.

### Feasible if you start a collector *now* (live poller + websocket)

Poll `GET /markets/orderbooks` (batch 100) every 1–2 s and subscribe `wss://.../ws/v2` for `orderbook` + `trade` pushes; write `book_snapshots` (Parquet per minute) + `trades` stream to S3/DuckDB. After 2–4 weeks you'll have real microstructure to backtest limit strategies (fill simulation against captured depth). This is the industry-standard path — Lychee/Predexon/Dome all did this themselves ("we capture it ourselves... since January 2026" [4](https://docs.predexon.com/api-reference/kalshi/orderbooks)).

For 15-min crypto up/down markets you can *buy* ultra-high-res history today: **KalshiBacktest** offers 100ms `bid/ask` snapshots + trade prints for BTC/ETH/SOL/DOGE/XRP `15m` markets, Pro 31 days for $19.90/mo (Free = last 50 markets, 1 req/s) [1](https://kalshibacktest.com/) [8](https://kalshibacktest.com/). Good for one vertical, not the whole exchange.

### Feasible with full third-party archive (pay to skip ETL)

- **Lychee:** 36GB+, 7.68M markets, 72.1M trades since July 2021, every market+trade+orderbook behavior + CSV/ParquetNoCode [3](https://lycheedata.com/kalshi-historical-data)
- **Predexon:** tick-level orderbook since Jan 7 2026, Parquet dumps, normalized with Polymarket [2](https://www.turbinefi.com/blog/historical-prediction-market-data-backtesting-2026)
- **Dome:** orderbook history from Oct 29 2025 via `api.domeapi.io` [1](https://docs.domeapi.io/api-reference/endpoint/get-kalshi-orderbook-history)
- **Allium:** warehouse/SQL orderbook tables

Use these if you need *instant* multi-year L2 for backtesting across all categories; budget $50–$500/mo.

---

## 5) Concrete limitations checklist for your prediction model

- [ ] **Lookahead / survivorship:** If you build your universe from today's `GET /markets?status=open`, you exclude expired markets that settled 0 — your training set is biased toward markets that survived. Always union `GET /historical/markets` for labels.
- [ ] **Stale quotes:** Illiquid markets (liquidity 4k–6k in the catalog, e.g., `KXAGI26-Y`, `KXROBOTAXI26-Y`) can have 4-tick+ spreads and update once per hour. Your "price" feature is stale — weight by spread & `updated_at`.
- [ ] **Time decay:** Binary contracts converge to 0/1 near `close_time` with nonlinear theta. A model trained on 700-day politics markets will misprice 1-day MLB moneylines.
- [ ] **Fee drag:** Net edge = gross edge − `0.07·p·(1-p)` per contract + spread. On a 50¢ market with 2¢ spread, you need >5¢ edge to break even round-trip.
- [ ] **MEE constraint:** On `mutually_exclusive` events, `Σ mids ≈ 1` (or legitimately <1 when field incomplete). Treating outcomes independently double-counts probability.
- [ ] **Class imbalance:** Most markets settle No; Yes is rare. Use Brier score / log loss, not raw accuracy.
- [ ] **Regime shift:** Pre-2025 Kalshi had different market designs; post-2026 has sub-cent pricing and historical partitioning — features must be normalized.
- [ ] **No short inventory beyond position:** Selling requires a resting position; naked short of Yes is synthetically Buy No in the clone but scoped differently on the real exchange.

---

## 6) Recommended architecture for *this* repo (`PriceKalshiHistorical`)

Copy the clone's good ideas, discard its synthetic prices for production training.

```
PriceKalshiHistorical/
  collector/
    kalshi_poller.py      # poll GET /markets, /markets/orderbooks, /markets/trades + WS, write Parquet
    historical_backfill.py# cursor over /historical/{markets,trades,candlesticks} → backfill
    sync_state.json       # cursors + cutoff timestamps (GET /historical/cutoff)
  storage/
    raw/                  # Parquet: ticks/, books/, trades/, candles/ partitioned by date/ticker
    db/                   # DuckDB or SQLite (the clone's schema is a good start)
    notebooks/            # calibration, Brier, lifecycle, backtest
  backtest/
    engine.py             # fill simulation: walk captured book, apply fees, handle settlement $1/$0
    features.py           # mee_sum, spread, depth, volatility, time-to-close, volume regime
    strategy.py           # entry:   signal -> limit/market;  exit:  take-profit / time-stop / hedge via MEE
    metrics.py            # PnL, Sharpe, Brier, calibration, slippage vs mid
  docs/
    ANALYSIS.md           # (this file)
  data/                   # gitignored, like the clone's data/exchange.db
```

**Collector MVP (1–2 weeks):**

1. `GET /historical/cutoff` → know the boundary.
2. Backfill: paginate `GET /historical/markets` (settled, have labels) + `GET /markets?status=open` (live) + `GET /markets/candlesticks?period_interval=1&start_ts=&end_ts=` and `...&period_interval=60`.
3. Forward fill: every 5s fetch `GET /markets/orderbooks?tickers=...` (100 batch) or single `GET /markets/{ticker}/orderbook` → append to `book_snapshots` (never prune). Every 5s fetch `GET /markets/trades?cursor=` → append `trades`.
4. WS: subscribe `orderbook` + `trade` for minimal latency; persistence layer is still the REST poller for durability.
5. Write Parquet `raw/books/dt=2026-08-17/ticker=XYZ.parquet` (bids/asks as `list<struct<price,size>>` + `ts`) and `raw/trades/...`. Query with DuckDB.

**Backtester MVP:**

- State: cash, positions `(ticker, side, qty, avg_price, realized_pnl)` (same as `trading.js`/`db.js`).
- Fill: `fillAgainstBook(ticker, side, action, qty, captured_book)` = walk levels with remaining size (copy `trading.js::fillAgainstBook` logic, but against *captured* book, not synthetic). Limit orders rest; match when `ask ≤ limit` (buy) or `bid ≥ limit` (sell) within next snapshots.
- Fees: `0.07 * filled * p * (1-p)` (read `GET /account/endpoint_costs` for tier check).
- Settlement: at `close_time`, pay `qty` if winning side else `0`; realize PnL; flat positions.
- Risk: max per-market exposure, MEE basket hedge (if long Yes on A and market B moons, net Σ mids variance), time-stop before close (no overnight gap risk but expiry pinning).

**Validation:**

- Train on candles/trades history (old → cutoff), test on forward-collected books (cutoff → now) to avoid lookahead.
- Compare three fills: ideal `mid`, naive `next candle close`, and realistic `book-walk`. Report slippage gap — if edge disappears between (a) and (c), strategy is not tradable.
- Calibrate: plot predicted `p` vs empirical settlement rate per decile (reliability diagram); a well-calibrated 70¢ long should settle Yes 70% of the time.

### Where the clone helps

- Steal `server/db.js` schema, `server/engine.js` `buildBook`/`bumpCandle`, `server/analysis.js` scanner, and `server/index.js` REST shapes as your local reference implementation — spin `node server/index.js` in dev to test the collector/backtester without spending a live tick or hitting rate limits.
- Use `KALSHI_API_BASE=https://demo-api.kalshi.co/trade-api/v2` for safe end-to-end runs before pointing at prod.

### Where the clone must be replaced

- All `anchor` priors, `mulberry32` diffusion, and `seedHistory` candles are fake. Swap to `kalshiSync` or your poller as the *sole* writer to `markets/candles/snapshots` for any model checkpoint you publish.

---

## 7) Side-by-side: Official vs Clone vs Third-party

| Capability | Official Kalshi API | Clone (`karagemop466-tech/Kalshi`) | Third-party archive |
|---|---|---|---|
| Markets/events/series history | Live 3mo + `/historical/markets` forever [2](https://docs.kalshi.com/getting_started/historical_data) | 32 events / 90 markets synthetic catalog (`server/catalog.js`) | Mirrors official + ETL'd (Lychee 2021→present [3](https://lycheedata.com/kalshi-historical-data)) |
| Prices `mid/bid/ask/last` | Current via `/markets`, historic via `/candlesticks` (`1m/1h/1d`) | 5s `snapshots(ts,mid,bid,ask,last)` seeded 60d 1h +12h 1m, then live | Tick-level if they captured (Predexon since Jan 2026 [4](https://docs.predexon.com/api-reference/kalshi/orderbooks)) |
| Volume / OI / liquidity timeseries | No — scalar `volume_fp/volume_24h_fp/open_interest_fp` per market | 5s `volume_24h` + 7-level sizes derived from `liquidity/25` | Same as official unless they polled |
| Orderbook depth history | **No** — live `GET /orderbook` only [1](https://kalshibacktest.com/) | 15s `book_snapshots(bids,asks JSON)` 7 levels, synthetic | Yes (Dome [1](https://docs.domeapi.io/api-reference/endpoint/get-kalshi-orderbook-history), Predexon [4](https://docs.predexon.com/api-reference/kalshi/orderbooks), Lychee) |
| Trades | `GET /markets/trades` + `/historical/trades` (paginated) | In-memory tape 80 trades/market + volume-derived candle `v` | Full archive (Lychee 72M+ [3](https://lycheedata.com/kalshi-historical-data)) |
| Orders (your) | `GET /portfolio/orders` + `/historical/orders` | SQLite `orders` (paper, all yours) | Not market-wide |
| Fees | Documented, tiered; `GET /account/endpoint_costs` | Quadratic `0.07*p*(1-p)` (hardcoded) | N/A |
| Real settlement label | Yes (`result YES/NO`) | Sampled from fair value at `close_time` | Yes |

---

## 8) What to build next (proposed for this repo)

If you want, I can scaffold it now on `arena/01a011a2-pricekalshihistorical`:

1. `collector/kalshi_client.py` — signed+unsigned REST client with cursor pagination, retry, `GET /historical/cutoff` awareness, dual live/historical union.
2. `collector/poller.py` — 5s market snapshot + 15s book snapshot writer to `data/snapshots.parquet` (matches clone's intervals so backtest code is portable).
3. `storage/schema.sql` — copy of `server/db.js` DDL extended with `source` (`real|sim`) and `capture_ts` columns + no-prune policy.
4. `backtest/engine.py` — port of `server/trading.js::fillAgainstBook` to operate on Parquet books + fee model, with notebook showing mid vs book-walk slippage.
5. `analysis/features.py` — ports `server/analysis.js` scanner into pandas: `mee_sum`, `mee_arb`, `wide_spread`, `fast_move` as labeled features for your classifier.
6. `.env.example` (`KALSHI_API_BASE`, `KALSHI_ACCESS_KEY`, `POLL_INTERVAL_MS`) + `docker-compose` for DuckDB + Grafana.

Say the word and I'll push the scaffold. Until then, keep GT Hub Pages running as your **dev double** and treat `data/exchange.db` as your integration-test fixture — not your training set.

---

*Refs: Official endpoints & auth model [5](https://pm.wiki/learn/kalshi-api) [6](https://predscope.com/guide/kalshi-api); historical partition [2](https://docs.kalshi.com/getting_started/historical_data) + changelog [7](https://docs.kalshi.com/changelog) + event candles [9](https://docs.kalshi.com/api-reference/events/get-event-candlesticks); no historical orderbook & third-party capture [1](https://docs.domeapi.io/api-reference/endpoint/get-kalshi-orderbook-history) [8](https://kalshibacktest.com/) [2](https://www.turbinefi.com/blog/historical-prediction-market-data-backtesting-2026); Predexon tick history since Jan 2026 [4](https://docs.predexon.com/api-reference/kalshi/orderbooks) [2](https://predexon.com/data/kalshi); Lychee full-archive 2021→present [3](https://lycheedata.com/kalshi-historical-data); KalshiBacktest 100ms crypto 15m API [8](https://kalshibacktest.com/); clone engine analysis (server files inspected locally, see README at `https://karagemop466-tech.github.io/Kalshi/`).*
