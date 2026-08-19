# REVIEW — ANALYSIS.md, verified line by line (no trust assumed)

**Reviewed:** `ANALYSIS.md` (330 lines) — the "What can be done & hard limitations" report.
**Date:** 2026-08-18. **Method:** every local claim was checked against the actual code in this
repo (all ~6.9k lines read; Node server and Python collector executed in this sandbox; collector
feed-tested with payloads matching the *current* Kalshi OpenAPI schemas), and every external claim
was checked against the cited sources (20+ pages fetched: docs.kalshi.com OpenAPI pages & changelog,
kalshibacktest.com, lycheedata.com, docs.predexon.com, docs.domeapi.io, turbinefi.com, predscope.com,
pm.wiki, karagemop466-tech/Kalshi on GitHub + its live Pages site).

## Verdict

> **UPDATE 2026-08-18 — fixes applied.** All Part D fixes below are now implemented (collector
> parsing + signing, event-metadata clobber, status normalization, settlement labels; ANALYSIS.md
> factual corrections). Verified end-to-end against a mock exchange (`tests/mock_kalshi.py`) serving
> the *current documented* Kalshi OpenAPI schemas: `python -m collector.run --once` against it
> stored **snapshots ✓, full-depth books with derived asks ✓, 1m/1h/1d candles ✓, trades with
> taker sides ✓, settled markets with YES/NO labels ✓, enriched event metadata (MEE flag) ✓, and the
> historical cutoff ✓** — 0 failures, and the offline→sim fallback still works (sim data labeled
> `source='sim'`, never mislabeled as Kalshi). Live-proof still requires a machine with outbound
> HTTPS (this sandbox blocks `api.elections.kalshi.com`); residual risk is limited to live
> auth quirks on the batch-orderbook endpoint, which the client handles with unsigned→signed→
> per-ticker→quote-synthesized fallbacks.

The report's **strategic conclusions are sound and well-sourced** — the big-ticket claims
(no retroactive L2 from the official API, the 2026-02-19 live/historical split, ~3-month live window,
20 req/s Basic tier, third-party archive stats for Lychee/Predexon/Dome/KalshiBacktest, the clone being
a synthetic simulation) are all **verified against primary sources**.

But it contains **10+ specific factual errors** — mostly *small* (line counts, thresholds, market
counts) but a few *material*, especially where it describes the **official API's current schemas**:
it documents the orderbook/candlestick/trade payloads as they looked in the **legacy API**, not as
they are **today**. That same schema drift is baked into this repo's Python collector, which — as
verified empirically below — **stores zero orderbook rows and zero candle rows when pointed at the
current Kalshi API**, and drops the trade side. So "automatically collecting and storing historical
pricing data from Kalshi" is currently true only for **market quote snapshots**; the two hardest
data products (books, candles) silently no-op, and signed `/historical/*` calls would be rejected.

---

## Part A — External claims in ANALYSIS.md, checked against primary sources

Legend: ✅ verified · ⚠️ partially right / stale / overclaimed · ❌ wrong or unsupported.

| Line(s) | Claim | Verdict | Evidence |
|---|---|---|---|
| 19–21 | Base URLs: `api.elections.kalshi.com` primary, `demo-api.kalshi.co` demo | ✅ | docs.kalshi.com lists both as supported hosts (new recommended host: `external-api.kalshi.com`) |
| 21 | `https://trading-api.kalshi.com/trade-api/v2` listed as current base URL, cited to predscope [6] | ❌ | Legacy 2022 host (old kalshi-python default). Not in current docs; predscope doesn't mention it. Outdated. |
| 23 | Public market-data reads need no key; trading needs RSA-PSS; SDK `kalshi-python` | ✅ | docs.kalshi.com auth quick start + pm.wiki + predscope all agree; kalshi-python exists on PyPI |
| 29 | `GET /markets` fields (`yes_bid_dollars`, `volume_fp`, `open_interest_fp`, …), cursor pagination ≤1000/page | ✅ | official Get Markets OpenAPI schema matches field-for-field; limit default 100, max 1000 |
| 30 | `GET /events`, `/{ticker}`, `/series`, `mutually_exclusive`, `with_nested_markets=true` | ✅ | docs.kalshi.com (incl. changelog fix for `with_nested_markets` limit) |
| 31 | `GET /markets/{ticker}/orderbook` = "L2 `yes`/`no` **bids & asks** `[price_cents, size]`" | ❌ | Current schema (OpenAPI v3.28.0): response `orderbook_fp` with `yes_dollars`/`no_dollars` arrays of `[dollar_string, count_fp_string]` — **bids only, no asks, no cents**. (Asks are implied: yes-ask = 1 − best no-bid.) Legacy API had `yes`/`no` cents arrays — still bids only. |
| 31 | "Public in practice despite spec saying auth" | ✅ | OpenAPI lists `kalshiAccessKey` security for it; pm.wiki/predscope list it as no-auth. Accurate as stated. |
| 32 | `GET /markets/orderbooks` batch up to 100 tickers | ✅ | Official OpenAPI: `tickers` param, maxItems 100. Note: this endpoint **requires auth** (quantvps + OpenAPI `security`), which the report doesn't mention. |
| 32 | "Added Mar 2026" | ⚠️ | Endpoint exists and is documented by Apr 2026, but **no source confirms the March 2026 introduction date**; predscope (the citation) doesn't state it. Unverified. |
| 33 | `GET /markets/trades` tape; older trades move to `/historical/trades` | ✅ | official Get Trades + Historical Data pages |
| 34 | Candles: intervals 1/60/1440; batch ≤100 markets / 10k candles | ✅ | official Batch Get Market Candlesticks page |
| 34 | Per-market candles at `GET /series/{s}/markets/{t}/candlesticks` | ✅ | still the current path per the official OpenAPI (`/series/{series_ticker}/markets/{ticker}/candlesticks`); note it requires `series_ticker`. |
| 35 | Event candles at `GET /events/{ticker}/candlesticks` | ❌ | The cited page [9] documents `GET /series/{series_ticker}/events/{ticker}/candlesticks`. The report's path doesn't exist. |
| 36 | WS `wss://api.elections.kalshi.com/trade-api/ws/v2`, `orderbook`/`ticker`/`trade`, no replay | ✅/⚠️ | URL ✅. Channel names are `ticker`, `trade`, `orderbook_delta` — and `orderbook_delta` is a **private** channel; the WS handshake itself **requires auth** (official Quick Start: WebSockets). "No replay" ✅. |
| 38 | Portfolio endpoints incl. `/portfolio/settlements`, `POST /portfolio/events/orders` | ✅ | official docs / parlay.run |
| 42–54 | Historical tier since **2026-02-19**; `/historical/cutoff` fields; endpoint list | ✅ | 2026-02-19 confirmed by Kalshi changelog (historical tier announcement) and parlay.run; endpoint list and cutoff field names match docs.kalshi.com Historical Data verbatim |
| 44 | "Live returns only last ~3 months" | ✅ | official docs: "The target window for live data is 3 months" |
| 60 | Token-bucket; Basic ≈ 20 req/s (10 tokens/call); `/account/limits`, `/account/endpoint_costs` | ✅ | official Rate Limits page: Basic read budget 200 tokens/s ÷ 10 = 20 req/s |
| 69 | "There is no `/historical/orderbook`" | ✅ | confirmed absent from the official historical endpoint list |
| 69 | Retroactive L2 via Dome / Predexon (since Jan 2026) / Lychee (July 2021) "— and those are paid" | ⚠️ | Start dates ✅ (Dome data from Oct 29 2025; Predexon Jan 7 2026; Lychee July 2021). But "those are paid" is wrong for Predexon: its orderbook-history endpoint is documented **"Free & Unlimited"**. |
| 74 | "72M trades at 20 req/s takes days"; "naïve 97M-trade pull … '56 days of continuous polling' [2]" | ✅/⚠️ | The 56-days figure = 97M ÷ 20 rps (≈56.1 days) i.e. **one request per trade** — quoted faithfully from TurbineFi. "72M" is Lychee's trade count, not the API's; "takes days" is loose (72M ÷ 1000/page ÷ 20 rps ≈ 1 h theoretical floor, longer in practice) but the same order of magnitude TurbineFi uses. |
| 76–78 | Candle gaps: no 5s/15m; sub-cent rounding; `mean/prev/min/max_dollars` added; no L2 depth in candles | ✅ | official event-candles schema has `mean_dollars`, `previous_dollars`, `min_dollars`, `max_dollars`; FixedPointDollars "up to 6 decimals"; candle payload has yes_bid/yes_ask OHLC but no depth |
| 81 | No market-wide order flow; fills/orders are yours only | ✅ | portfolio endpoints are user-scoped |
| 83 | Volume/OI/liquidity are point-in-time scalars, no volume-history endpoint | ✅ | confirmed by schema (no timeseries endpoint exists) |
| 91 | `fee = 0.07 × contracts × p × (1-p)`; real schedule "similar but tiered by volume" | ✅ | Kalshi's standard fee formula matches; tiers exist. (New: changelog says maker fees go live Aug 19–21, 2026 — worth noting, not contradicting.) |
| 94 | "**32+ categories in the wild**" | ❌ | **No source supports this.** Kalshi's category taxonomy is ~6–10 groups (Sports, Politics, Culture, Economics, Crypto, Climate/Weather, Finance, Entertainment). The number "32" is the clone's **event** count — a conflation. |
| 94, 303 | Clone seeds "32 events / **90** markets" | ❌ | Actual catalog = **32 events / 92 markets** (counted programmatically + confirmed by the live clone site "92 open markets"). The clone's own README rounds to "90+"; the report copied the rounding. |
| 146 | Clone quote "exchange engine runs entirely in your browser" / "Demo/research project. Not affiliated with Kalshi." | ✅ | verbatim in the clone's GitHub README and Pages header |
| 203–206 | Feasible-with-official-API playbook (candles + trades + MEE + settlement labels) | ✅ | consistent with verified endpoint set |
| 211–213 | Start a collector now: poll `/markets/orderbooks` batch 100 + WS; "industry-standard path" | ✅ | sound; matches Predexon/KalshiBacktest's own capture model |
| 214 | KalshiBacktest: 100ms snapshots + prints for BTC/ETH/SOL/DOGE/XRP 15m; Pro 31 days $19.90/mo; Free = last 50 markets, 1 req/s | ✅ | verified verbatim on kalshibacktest.com (incl. the quoted FAQ paragraph used at line 67–68) |
| 219–222 | Lychee 36GB+, 7.68M markets, 72.1M trades since July 2021 | ✅ | lycheedata.com verbatim |
| 220 | Lychee "every market+trade+orderbook behavior + CSV/**Parquet**NoCode" | ⚠️ | Lychee exports **CSV/XLSX/JSON — no Parquet mentioned** ("ParquetNoCode" looks garbled), and orderbook history is "**where available**", not every market. |
| 221 | Predexon tick-level since Jan 7 2026, Parquet dumps, normalized with Polymarket | ✅ | predexon.com + docs.predexon.com verbatim |
| 222 | Dome orderbook history from Oct 29 2025 | ✅ | dome docs ("history starting from October 29th, 2025"; API announced Oct 31, 2025) |
| 222 | Allium warehouse/SQL orderbook tables | ✅ | confirmed via Lychee's comparison table |
| 223 | "budget $50–$500/mo" | ⚠️ | plausible but unverified as a range; KalshiBacktest starts at $19.90/mo (one vertical) |
| 232 | Illiquid examples `KXAGI26-Y`, `KXROBOTAXI26-Y` have "liquidity 4k–6k" | ❌ | In `server/catalog.js`: KXAGI26-Y = **12,000**, KXROBOTAXI26-Y = **9,000**. Markets with 4–6k liquidity exist, but not these two. |
| 234 | "On a 50¢ market with 2¢ spread you need >5¢ edge to break even round-trip" | ⚠️ | Arithmetic: round-trip fees 2×1.75¢ = 3.5¢ + 2¢ spread = **5.5¢**. ">5¢" understates. |

---

## Part B — Claims about the clone / this repo's code (checked in the code itself)

| Claim | Verdict | Evidence (file:line) |
|---|---|---|
| `server/db.js` defines **9** tables | ❌ **10** | events, markets, candles, snapshots, book_snapshots, orders, positions, account, anomalies, **sync_log** (`server/db.js`). The report's own list on lines 116–123 shows 10 — internal inconsistency. |
| Schema listing (lines 116–123) incl. WAL, 5s/15s cadence, 3d/1d prunes | ✅ | `db.js` (WAL ✓), `engine.js` (`SNAPSHOT_EVERY_MS=5000`, `BOOK_SNAPSHOT_EVERY_MS=15000`, prunes `nowTs-3*86400000` / `nowTs-86400000`). Quirk: anomalies are pruned **only when new findings exist** (`analysis.js`: prune inside `if (findings.length)`). |
| `docs/js/exchange.js` 736 lines; `server/engine.js` 309; `kalshiSync.js` 113; `analysis.js` 131 | ✅ | `wc -l` matches all four |
| Engine `dp = (anchor − p)*0.006 + N(0, volBase)`, `volBase = 0.0016+0.006·p(1−p)`, 0.4% news jumps | ⚠️ | formula and 0.4% ✓ (`engine.js`), but code also multiplies noise by an **`urgency` factor (1.8× when <2 days to close)** — omitted from the report. |
| Book rebuilt every 1s, 7 levels, "tighter when liquidity >15000 (1¢) else 1–2¢" | ⚠️ | 1s/7-levels ✓. Threshold is actually **>6000** → 1¢, else 2¢ (`liquid > 15000 ? 0.01 : liquid > 6000 ? 0.01 : 0.02`); mids ≤3¢/≥97¢ also force 1¢. |
| Taker flow "Poisson λ ≈ 0.02–0.55" | ⚠️ | base λ = `min(0.55, liquidity/40000·0.5+0.02)` ✓ but multiplied by the same urgency (→ up to ~0.99). It's Bernoulli-per-tick, not Poisson. |
| Tape of last 80 trades; `sizeAt(liquidity/25)` levels | ✅ | `engine.js` (`tape.length > 80` pop; `sizeAt` base `liquidity/25`) |
| 60d of 1h + 12h of 1m seeded per market; 15m/1d derived on read via `aggregate()` | ✅ | `engine.js::seedHistory` + `index.js::aggregate`. **Verified at runtime**: 132,480 = 92×1,440 1h rows; 66,240 = 92×720 1m rows. |
| Snapshots 5s / books 15s; settlement sampled from fair value, pays $1/$0 | ✅ | `engine.js` (verified live) |
| `kalshiSync.js`: default base, 15s interval, `GET /markets?limit=200&status=open`, events batch 50, `source='kalshi'`, `mid=(bid+ask)/2`, engine skips those markets, `/api/health` mode, `/api/sync/log` | ✅ | all in `kalshiSync.js`/`index.js`/`config.js`; **verified at runtime** (health shows `mode:"sim"` when upstream unreachable, `sync_log` records the failure). Note: sync filters `is_provisional` and `volume_fp > 0` markets (not mentioned). |
| kalshiSync does **not** persist trades/books/candles, never calls `/historical/*` or candles | ✅ | confirmed — it only calls `/markets` + `/events` and upserts quote scalars |
| `trading.js`: Buy/Sell×Yes/No, price improvement, partial fills, 1.5s matching, cancellation, reserve, `fee=0.07·q·p(1−p)` | ✅ | `trading.js` (`FEE_RATE=0.07`; `setInterval(trading.matchRestingOrders,1500)` in `index.js`) |
| `analysis.js` every 8s: mee_sum >2.5¢, mee_arb <99¢/>101¢, wide_spread ≥4 ticks on vol>500 | ✅ | constants match (`SCAN_INTERVAL_MS=8000`, `MEE_SUM_FLAG=0.025`, `MEE_ARB_ASK=0.99`, `MEE_ARB_BID=1.01`, `WIDE_SPREAD_TICKS=4`, `volume_24h > 500`) |
| `fast_move` = "≥5¢ move within 5 min" | ⚠️ | code compares against a reference mid **up to 10 minutes old** (`nowTs - prev.ts <= 10*60000`, refresh at 5 min). The clone's own README makes the same 5-min claim. |
| REST surface list (lines 178–185) | ✅/⚠️ | All listed routes exist. Nit: `/api/events?category=&q=` — `q` is **not** implemented on `/api/events` (only on `/api/markets`). |
| Hash SPA routes `#/`, `#/category/:name`, `#/markets`, `#/event/:ticker`, `#/market/:ticker`, `#/portfolio`, `#/analysis` + canvas chart | ✅ | `docs/js/app.js` router + `docs/js/chart.js` |
| In-browser mode: localStorage portfolio, per-visitor, no shared DB | ✅ | `docs/js/exchange.js`, `localapi.js` |
| Clone caveats: synthetic prices (`mulberry32`), anchors Newsom 0.27 / Vance 0.41 / BTC $110–120k @ 0.30 | ✅ | `server/catalog.js` — all three anchors verbatim; `mulberry32` in `engine.js` |
| "a 700-day political nominee market" / "1-day MLB moneylines" | ✅ | catalog `closeTime` = now+700d (KXPRES28*) / now+1d (KXMLB-26AUG11*) |
| Section 7 side-by-side table | ✅ except the two ❌/⚠️ noted (90 markets; "Full archive (Lychee 72M+)" ✓) | — |
| "Naked short of Yes is synthetically Buy No in the clone" (checklist, line ~238) | ⚠️ | `trading.js` **rejects** sell-Yes without a position; the Yes→buy-No conversion happens in `backtest/strategy_example.py` signal generation, not the clone's trading engine. |

---

## Part C — Does the repo actually "automatically collect and store Kalshi price history"? (runtime + mock-schema tests)

**What was run in this sandbox (outbound HTTPS is blocked here):**
1. `node server/index.js` — boots, seeds 32 events / 92 markets, 198,720 candles, writes 5s snapshots & 15s books; stays in `mode: sim` and logs the upstream failure. ✅ (matches README/ANALYSIS descriptions of sim fallback)
2. `python -m collector.run --once` — probes upstream, detects offline, skips remote backfill, falls back to mirroring the local Node API, stores snapshots/books labeled `source='sim'`. ✅ **It never mislabels sim data as Kalshi data** — good.

**What was tested against the current official Kalshi schemas** (stubbed client returning payloads exactly per docs.kalshi.com OpenAPI v3.28.0, fresh DB):

| Data product | Result | Root cause |
|---|---|---|
| Market snapshots (`GET /markets`) | ✅ 1 row stored correctly (mid=(bid+ask)/2 etc.) | field names `yes_bid_dollars`, `volume_fp`, … match current schema |
| **Orderbooks** (`GET /markets/orderbooks`) | ❌ **0 rows stored** | poller looks for keys `yes`/`yes_bids`/`yes_asks`; current API returns `orderbook_fp:{yes_dollars,no_dollars}` → parsed as empty book → silently skipped. README calls books "the hard part" — and it silently no-ops against the live API. |
| **Candles** (batch `/markets/candlesticks`) | ❌ **0 rows stored** | poller & backfill look for `market_candlesticks`/`candlesticks` keys; current API returns `markets:[{market_ticker, candlesticks:[…]}]`. Inner fields (`price.open_dollars`, `end_period_ts`, `volume_fp`) are parsed correctly — only the wrapper key is wrong. Worse, the client's per-ticker fallback calls `/markets/{ticker}/candlesticks`, which doesn't exist (correct: `/series/{series_ticker}/markets/{ticker}/candlesticks`), so the fallback would 404 too. |
| Trades (`GET /markets/trades`) | ⚠️ rows stored but `side=''` | `taker_side` was deprecated (removal window began May 14, 2026); canonical field is `taker_outcome_side`/`taker_book_side`. Price/size/timestamp parse fine (`created_time` is a date-time string — handled). |
| Signed `/historical/*` | ❌ would 401 | `_sign_request` signs `path + query` relative to the base; official docs: sign `timestamp+method+path` **from the API root and without query parameters**. Any paginated signed request would fail auth. |

**Consequence:** as originally written, pointed at real Kalshi the collector would have accumulated **quote snapshots only**; its two headline datasets (orderbook depth, OHLCV candles) would be silently empty, trades would be missing sides, and authenticated backfill would fail. **All fixed** (single-function schema-mapping changes + signing format + the extra bugs listed in Part D), and the corrected pipeline is verified end-to-end against a mock exchange implementing the documented schemas. The fallback-to-sim path works as documented and is honestly labeled.

**Other repo-level nitpicks (not report claims, but adjacent):**
- `.env.example` sets `KALSHI_MAX_RPS=12` while `collector/config.py` default is 8 and README says 8.
- README says "Never prunes history by default (`PRUNE_DAYS_*=0`)" — but `PRUNE_DAYS_ANOMALIES=30` and `PRUNE_DAYS_SYNCLOG=14` defaults. (Price history itself is unpruned ✅.)
- README says backfill caps "20 pages each" — trades are capped at 15.
- Docker-compose Python image `python:3.11-slim` is fine, but `requirements.txt` pins `scikit-learn>=1.3` — collector never imports it; harmless.
- `poller.py` `_try_local_fallback` fetches `/api/markets` for every kind (books/trades/candles all collapse to markets) — acceptable degradation, but the books path does then fetch per-ticker books; trades/candles fallback yields nothing.

---

## Part D — Fix list (ranked)

**Correctness fixes to the report (`ANALYSIS.md`):** — *all DONE, applied 2026-08-18*
1. L21: drop or mark `trading-api.kalshi.com` as a legacy 2022 host (and add `external-api.kalshi.com` as the recommended one).
2. L31: orderbook returns **yes/no bids only** as `orderbook_fp.yes_dollars`/`no_dollars` (`[price_string, count_fp_string]`); asks derived as `1 − best no bid`.
3. L32: `/markets/orderbooks` requires auth; "Added Mar 2026" is unverified — remove the date or find the changelog entry.
4. L35: event candles live at `GET /series/{series_ticker}/events/{ticker}/candlesticks`, not `/events/{ticker}/candlesticks` (L34's per-market path is correct as written).
5. L94: replace "32+ categories" (unsupported) and fix "90 markets" → 92; same at L303.
6. L113: "10 tables", not 9 (or just don't count).
7. L131–133, 166: add the `urgency` multiplier; book-spread threshold is 6,000 (not 15,000) liquidity; `fast_move` window is ≤10 min (not 5).
8. L220: Lychee exports CSV/XLSX/JSON (no Parquet), orderbook history "where available".
9. L232: the two example tickers have liquidity 12k/9k — pick real 4–6k examples (e.g., `KXPRES28GOP-TSCOTT` 5k, `KXPRES28DEM-CBOOKER` 5k).
10. L69: Predexon's orderbook-history endpoint is free — "and those are paid" needs a carve-out.
11. L234: break-even is ~5.5¢, not >5¢.

**Correctness fixes to the collector (make it actually collect what the report promises):** — *all DONE, verified by E2E mock test*
1. `collector/poller.py::poll_books_once` — map `orderbook_fp.yes_dollars/no_dollars` → bids (and derive asks from no-bids), or use the documented `orderbooks` array shape `{ticker, orderbook_fp}`. ✅
2. `collector/poller.py::poll_candles_once` + `collector/backfill.py::backfill_candles` — read the `markets:[{market_ticker, candlesticks}]` wrapper; per-ticker fallback now uses the documented `/series/{series_ticker}/markets/{ticker}/candlesticks` path. ✅
3. Trade parsing — use `taker_outcome_side` (fallback `taker_side` for old data). ✅
4. `collector/kalshi_client.py::_sign_request` — sign `timestamp+method+"/trade-api/v2"+path` **without** the query string. ✅
5. Batch-orderbooks endpoint needs auth headers per spec — client tries unsigned→signed→per-ticker→quote-synthesized. ✅
6. **Extra bugs found & fixed during the pass:** `GET /events` filter param is `tickers` (not `event_tickers` — metadata enrichment was silently failing); the poller's minimal event upsert **clobbered** enriched event metadata; real lifecycle statuses (`active`, `finalized`) were stored raw so `status='open'` backtest queries matched nothing (now normalized to `open`/`settled`); `/historical/markets` settlement `result` labels were dropped (now stored `YES`/`NO`); a bad-edit indentation bug had made the historical-trades loop dead code.

---

## What held up well

The report's core thesis — official API cannot backfill L2; you capture it live or buy it; candles+trades backfill is feasible; synthetic clone data must never train a production model — is **fully supported** by the primary sources, and its third-party statistics (KalshiBacktest pricing/coverage, Lychee 36GB/7.68M/72.1M since July 2021, Predexon Jan 7 2026 Parquet, Dome Oct 29 2025, the verbatim KalshiBacktest FAQ quote, TurbineFi's 97M-trades/56-days figure, the 2026-02-19 historical split, 3-month live window, 20 req/s Basic tier) all check out. The clone analysis (modes, engine math, prunes, sync adapter, REST surface) is accurate except for the small threshold/count errors listed above. The repo's architecture and the collector's offline/fallback behavior are sound and honestly labeled — the fix needed is in **three parsing functions**, not in the design.
