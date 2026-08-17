# PriceKalshiHistorical

**Autonomous Kalshi price-history collector + backtester.** No manual input after `docker compose up` or `./scripts/run_autonomous.sh` — it backfills history, polls live markets/orderbooks/trades/candles forever, stores everything in SQLite + Parquet, and lets you backtest entry/exit strategies against *captured* books (not just mids).

> Built on the live engine from [`karagemop466-tech/Kalshi`](https://karagemop466-tech.github.io/Kalshi/) (ported into `server/` + `docs/`), extended with a Python collector that mirrors real Kalshi via `https://api.elections.kalshi.com/trade-api/v2` when reachable, and falls back to the local sim when the upstream is blocked.

---

## TL;DR — one command, zero manual input

```bash
# option A: bare metal (Node + Python together)
./scripts/run_autonomous.sh
# -> Node exchange :8080 (live sim + Kalshi mirror)  +  Python collector (backfill thread + live poller) forever
# logs: logs/exchange.log logs/collector.log
# db:   data/exchange.db

# option B: docker (same, but containerized)
docker compose up -d
docker compose logs -f

# option C: python only (no Node needed, still collects real Kalshi if reachable)
python -m collector.run               # backfill in bg thread + poll forever
python -m collector.run --once        # one backfill + one poll cycle then exit (CI smoke test)
python -m collector.run --backfill-only
python -m collector.run --poller-only
```

Check it works:
```bash
curl -s http://127.0.0.1:8080/api/health | python3 -m json.tool
sqlite3 data/exchange.db "select count(*) as snapshots from snapshots; select count(*) as books from book_snapshots; select count(*) as candles from candles; select ts,status,detail from sync_log order by ts desc limit 8;"
python -m backtest.strategy_example --strat all   # runs 3 reference strategies on whatever was collected
```

---

## What it collects (and why)

| Data | How | Table / Parquet | Interval | Why it matters for backtests |
|---|---|---|---|---|
| **Markets + events** (quotes, `yes_bid/yes_ask/last/mid`, `volume/volume_24h/open_interest`, MEE flag) | `GET /markets?status=open` paginated + `GET /events` (mirrors `server/kalshiSync.js`, 15s) + fallback to local `/api/markets` | `markets`, `events` + `snapshots` | 15s full catalog, 5s snapshot | Without snapshots you only have point-in-time `volume` — no timeseries |
| **Snapshots** (`mid/bid/ask/last/volume_24h` per market) | Same poll, plus local fallback | `snapshots` + `data/parquet/snapshots/dt=YYYY-MM-DD.parquet` | **5s** | Price history at 5s resolution — the core feature for any predictor |
| **Orderbooks** (7-level L2 `bids/asks` [[price,size]]) | `GET /markets/orderbooks` batch 100, per-ticker fallback, synthesized from quotes if batch fails | `book_snapshots(bids JSON, asks JSON)` + `data/parquet/books/_staging/` | **15s** (rotates 40 tickers/interval to respect 8 rps) | **The hard part.** Kalshi has *no* historical orderbook endpoint — you must capture it live or buy it. This is the only way to backtest spread/slippage correctly |
| **Trades** (price/size/side/ts) | `GET /markets/trades` + `GET /historical/trades` | `trades` | **60s** | Ground-truth tape for fill modeling |
| **Candles** (`1m/1h/1d` OHLCV) | `GET /markets/candlesticks` batch, `GET /historical/markets/{ticker}/candlesticks` fallback | `candles(ticker,interval,t_open,o,h,l,c,v)` | 5 min (last 2h window) | Pre-aggregated history for momentum/volatility features |
| **Anomalies** | `server/analysis.js` scanner (every 8s) | `anomalies(kind=mee_sum|mee_arb|wide_spread|fast_move)` | 8s | Labeled edge cases for your model (e.g., `Σ mids` deviates >2.5¢ from 1) |
| **Parquet mirror** | Same writes, duplicated to columnar files | `data/parquet/` | — | For DuckDB / pandas at scale |

All timestamps in the DB are **ms since epoch** (except `close_time` ISO strings). The Node engine and Python collector share `data/exchange.db` via WAL, so you can `sqlite3` it while both run.

### Historical backfill (checkpointed, resumable)

On first start the collector spawns a background thread:

1. `GET /historical/cutoff` → stores the live/historical boundary
2. `GET /historical/markets` paginated (cursors kept in `collector_state`) → upserts settled markets (your training labels `$1/$0`)
3. `GET /markets?status=open` paginated → live open markets
4. `GET /markets/candlesticks` + `GET /historical/markets/{t}/candlesticks` for top-80 markets × 7 days × 3 periods
5. `GET /markets/trades` + `GET /historical/trades` (cursor checkpointed)

It caps history panes per run (20 pages each) to stay under the 8 rps budget; next restart resumes from `collector_state` cursors — no duplicate work, no manual cursor wrangling.

---

## Autonomous guarantees

- **No API keys required** for live data — public endpoints work unsigned. If you set `KALSHI_ACCESS_KEY` + `KALSHI_PRIVATE_KEY_PEM` it will also pull `/historical/*` authenticated endpoints; otherwise it logs and continues with live data only.
- **Rate-limit aware:** token-bucket at `KALSHI_MAX_RPS` (default 8, below the 10–20 Basic tier), jitter, 429 backoff.
- **Offline-safe:** if `api.elections.kalshi.com` is unreachable (sandbox/firewall), the poller transparently mirrors `http://127.0.0.1:8080/api/markets` and `/api/market/{t}/book` from the local Node engine — you still get advancing snapshots/books to test the whole pipeline.
- **Crash-resilient:** every write is committed; cursors and cutoffs are persisted to `collector_state` / `historical_cutoff` after each page; `sync_log` records every success/failure.
- **Never prunes history** by default (`PRUNE_DAYS_*=0`) — unlike the demo which keeps 3 days, this collector is configured to keep forever. Set env to prune if you run on a tiny disk.

---

## Backtesting (realistic fills, not mid fantasy)

```bash
pip install -r requirements.txt   # optional but faster (pandas/pyarrow/duckdb)
python -m backtest.strategy_example --strat all      # runs all 3 on current DB
python -m backtest.strategy_example --strat mee --qty 25 --balance 10000
```

The engine (`backtest/engine.py`) ports `server/trading.js::fillAgainstBook`:

- Walks your **captured** book (asks for buys, bids for sells; `buy No` = `1 - ask_yes`), respects size at each level, returns partial fills.
- Applies quadratic fee `fee = 0.07 × qty × p × (1-p)`.
- Tracks `positions(ticker,side,qty,avg_price,realized_pnl)`, `balance`, `equity_curve`.
- Settles at `$1` (winning side) / `$0` on `close_time`.
- Reports `mid vs book-walk` slippage — if edge disappears when you switch from mid to book, your strategy isn't tradable.

Three reference strategies (`backtest/strategy_example.py`):

| Name | Signal | Entry | Notes |
|---|---|---|---|
| `mee` | `|Σ mids -1|>2.5¢` on `mutually_exclusive` events | Buy cheapest / sell richest leg | Pure cross-market mean reversion; use `analysis/mee` as feature |
| `fade` | `|mid(t)-mid(t-5m)|≥5¢` + `spread≤3 ticks` | Fade the spike (buy dip) | Needs 5s snapshots |
| `mom` | `mid(t)-mid(t-20) > 2¢` + tight spread | Follow momentum | Candles + snapshots |

Add your own: produce a list of `{ts, ticker, side="yes"|"no", action="buy"|"sell", qty, type="market"|"limit", price?}` and call `BacktestEngine.replay_signals(signals)`.

Features helper (`backtest/features.py`): `mee_features(conn)`, `market_microstructure(ticker)`, `snapshot_features_frame()`, `anomaly_clip()`, `lifecycle(ticker)` → DataFrames ready for sklearn.

Metrics (`backtest/metrics.py`): Brier, log-loss, calibration table, Sharpe, max drawdown.

---

## Layout

```
server/          # Node engine (from karagemop466-tech/Kalshi): engine, trading, db, kalshiSync, analysis
docs/            # GitHub Pages SPA + in-browser engine (exchange.js / localapi.js) / chart.js
collector/       # Python autonomous collector (kalshi_client, storage, backfill, poller, run)
  config.py      # env defaults
  kalshi_client.py # urllib/requests + token-bucket + RSA-PSS signing
  storage.py     # SQLite + Parquet
  backfill.py    # historical backfill (checkpointed)
  poller.py      # live 5s/15s/60s/300s poll loop with local fallback
  run.py         # main: backfill thread + poll forever (no manual input)
backtest/        # fill engine + features + metrics + example strategies
  engine.py      # book-walking fills, position/balance/settlement
  features.py    # MEE + microstructure features
  metrics.py     # Brier/Sharpe/etc
  strategy_example.py
storage/schema.sql  # full DDL (superset of server/db.js)
data/            # exchange.db + parquet/ (gitignored)
scripts/run_autonomous.sh  # one-command launcher
docker-compose.yml          # Node + collector together
```

---

## Env (.env)

Copy `.env.example` → `.env` and edit. All defaults work with no keys.

```
KALSHI_API_BASE=https://api.elections.kalshi.com/trade-api/v2
#KALSHI_API_BASE=https://demo-api.kalshi.co/trade-api/v2  # safe testing
KALSHI_MAX_RPS=8
SYNC_INTERVAL_MS=15000
SNAPSHOT_INTERVAL_MS=5000
BOOK_SNAPSHOT_INTERVAL_MS=15000
DB_PATH=data/exchange.db
PARQUET_PATH=data/parquet
# Optional signed historical access
#KALSHI_ACCESS_KEY=...
#KALSHI_PRIVATE_KEY_PEM=...
```

---

## Limitations (read `ANALYSIS.md`)

- Official API has **no retroactive orderbook** — this collector *creates* the history you need by polling live. If your strategy needs depth before you started collecting, you must wait or buy a third-party archive (Lychee, Predexon, Dome — see ANALYSIS.md citations).
- Live polling at 5s/15s is **sampled**, not tick-level (100ms). For sub-second L2 you need WS `wss://api.elections.kalshi.com/trade-api/ws/v2` (not yet in the default poller — enable `ENABLE_WEBSOCKET=1` once implemented) or a paid feed.
- Fee model here is `0.07*p*(1-p)` — close but check your tier at `GET /account/endpoint_costs`.
- Markets settle binary `$1/$0`; selling Yes without a position is modeled as buying No in the sim — live Kalshi enforces position checks.

---

## Dev

```bash
# run collector once (for CI / smoke)
python -m collector.run --once
python -m collector.backfill          # just historical
python -m collector.poller            # just live poller (if you import poller main)

# run Node alone
node server/index.js                  # :8080, seeds 60d 1h + 12h 1m catalog

# backtest
python -m backtest.strategy_example --strat mee --db data/exchange.db
sqlite3 data/exchange.db "select * from anomalies order by ts desc limit 5;"
duckdb data/exchange.db "select ticker, count(*) c from snapshots group by ticker order by c desc limit 5"
```

See `ANALYSIS.md` for the full 20-page "what can be done vs hard limits" deep dive with citations.

