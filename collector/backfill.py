"""
collector.backfill — one-shot and incremental historical backfill.
Runs without manual input: auto-paginates markets/events/trades/candles,
stores in SQLite (and Parquet), checkpoints cursors so it can resume.
"""
import json
import logging
import time
import sqlite3
import urllib.parse
from typing import List

from . import config
from .kalshi_client import KalshiClient, paginated_fetch, fetch_with_retry
from .storage import _connect, upsert_event, upsert_market, insert_candle, insert_trade, log_sync, set_collector_state, get_collector_state
from .poller import _parse_kalshi_candle, _store_candles

log = logging.getLogger("collector.backfill")

def _dollars(x):
    try: return float(x)
    except: return 0.0
def _fp(x):
    try: return float(x)
    except: return 0.0

def backfill_events_and_markets(client: KalshiClient, conn: sqlite3.Connection, live=True, historical=True):
    """Fetch live open markets + historical settled markets and upsert."""
    total = 0
    # Live open markets
    if live:
        log.info("backfill: fetching live markets (open)...")
        j, err = client.get_markets(limit=config.BATCH_MARKETS_LIMIT, status="open")
        if j and "markets" in j:
            markets = j["markets"]
            # paginate
            cursor = j.get("cursor")
            all_markets = list(markets)
            pages = 1
            while cursor and pages < 30:
                time.sleep(0.2)
                j2, err2 = client.get_markets(limit=config.BATCH_MARKETS_LIMIT, status="open", cursor=cursor)
                if not j2 or "markets" not in j2 or not j2["markets"]:
                    break
                all_markets.extend(j2["markets"])
                cursor = j2.get("cursor")
                pages += 1
                if not cursor:
                    break
            log.info("live markets fetched: %d across %d pages", len(all_markets), pages)
            # also fetch events for those markets (documented filter param is `tickers`)
            event_ids = list({m.get("event_ticker") for m in all_markets if m.get("event_ticker")})
            event_map = {}
            for i in range(0, len(event_ids), 50):
                chunk = event_ids[i:i+50]
                code, jj, _ = fetch_with_retry(client.base, "/events", {"tickers": ",".join(chunk), "limit": 50}, timeout_ms=client.timeout_ms)
                if code == 200 and "events" in jj:
                    for e in jj["events"]:
                        event_map[e.get("event_ticker") or e.get("ticker")] = e
                time.sleep(0.15)
            # upsert
            for m in all_markets:
                if m.get("is_provisional"):
                    continue
                et = m.get("event_ticker") or ""
                ev = event_map.get(et, {})
                try:
                    upsert_event(conn, et, ev.get("title") or et, ev.get("sub_title") or ev.get("subtitle") or "",
                                 ev.get("category") or "Other", ev.get("series_ticker") or ev.get("series") or "",
                                 1 if ev.get("mutually_exclusive") else 0, m.get("close_time") or "", et.lower())
                    yes_bid = _dollars(m.get("yes_bid_dollars") or m.get("yes_bid"))
                    yes_ask = _dollars(m.get("yes_ask_dollars") or m.get("yes_ask"))
                    last = _dollars(m.get("last_price_dollars") or m.get("last_price") or (yes_bid+yes_ask)/2 if yes_bid and yes_ask else 0)
                    mid = (yes_bid+yes_ask)/2 if yes_bid and yes_ask else last
                    upsert_market(conn, m.get("ticker"), et, m.get("title") or m.get("ticker"),
                                  m.get("yes_sub_title") or "Yes", m.get("no_sub_title") or "No",
                                  m.get("status") or "open", m.get("close_time") or "",
                                  last, yes_bid, yes_ask, _fp(m.get("yes_bid_size_fp") or m.get("yes_bid_size")),
                                  _fp(m.get("yes_ask_size_fp") or m.get("yes_ask_size")), mid,
                                  _fp(m.get("volume_fp") or m.get("volume")), _fp(m.get("volume_24h_fp") or m.get("volume_24h")),
                                  _fp(m.get("open_interest_fp") or m.get("open_interest")), last, "kalshi")
                    total += 1
                except Exception as e:
                    log.debug("upsert live market failed %s: %s", m.get("ticker"), e)
            conn.commit()
            log_sync(conn, "ok", f"backfill live markets upserted {total}")
        else:
            log.warning("live markets fetch failed: %s", str(err or j)[:400])

    # Historical settled markets (paginated, only if we can)
    if historical:
        log.info("backfill: fetching historical settled markets (if available)...")
        cursor = get_collector_state(conn, "historical_markets_cursor")
        fetched_hist = 0
        max_hist_pages = 20  # cap per run to avoid rate-limit storm; will resume next run via cursor checkpoint
        hist_pages = 0
        # Start from stored cursor or none
        j, err = client.get_historical_markets(limit=200, cursor=cursor)
        if j is None or err and "401" in str(err) or (j and "error" in j):
            log.info("historical markets not accessible (auth required or empty): %s", str((err or j))[:300])
        else:
            # j may contain markets
            markets = j.get("markets") if j else []
            while True:
                if markets:
                    for m in markets:
                        try:
                            et = m.get("event_ticker") or ""
                            # don't clobber enriched event metadata if it exists
                            if not conn.execute("SELECT 1 FROM events WHERE ticker = ?", (et,)).fetchone():
                                upsert_event(conn, et, m.get("event_ticker") or et, "", "Other", "", 0, m.get("close_time") or "", et.lower())
                            yes_bid = _dollars(m.get("yes_bid_dollars"))
                            yes_ask = _dollars(m.get("yes_ask_dollars"))
                            last = _dollars(m.get("last_price_dollars"))
                            mid = (yes_bid+yes_ask)/2 if yes_bid and yes_ask else last
                            # historical markets carry the settlement label
                            status = m.get("status") or "settled"
                            result = str(m.get("result") or "").upper()  # yes|no -> YES|NO
                            upsert_market(conn, m.get("ticker"), et, m.get("title") or m.get("ticker"),
                                          "Yes","No", status, m.get("close_time") or "", last, yes_bid, yes_ask, 0,0, mid,
                                          _fp(m.get("volume_fp")), _fp(m.get("volume_24h_fp")), _fp(m.get("open_interest_fp")), last, "kalshi",
                                          result=result)
                            fetched_hist += 1
                        except Exception as e:
                            log.debug("hist market upsert fail: %s", e)
                    conn.commit()
                hist_pages += 1
                nxt = j.get("cursor") if j else None
                if not nxt or hist_pages >= max_hist_pages:
                    if nxt:
                        set_collector_state(conn, "historical_markets_cursor", nxt)
                    else:
                        set_collector_state(conn, "historical_markets_cursor", "")
                    break
                time.sleep(0.2)
                j, err = client.get_historical_markets(limit=200, cursor=nxt)
                if not j or "markets" not in j or not j["markets"]:
                    break
                markets = j["markets"]
            log.info("historical markets upserted %d across %d pages", fetched_hist, hist_pages)
            log_sync(conn, "ok", f"historical markets backfill {fetched_hist}")
    return total

def _series_for_market(conn, ticker):
    try:
        row = conn.execute(
            "SELECT e.series FROM events e JOIN markets m ON m.event_ticker = e.ticker WHERE m.ticker = ?",
            (ticker,),
        ).fetchone()
        return row[0] if row and row[0] else None
    except Exception:
        return None

def _candles_via_series(client, conn, ticker, period, start_ts, end_ts):
    """GET /series/{series_ticker}/markets/{ticker}/candlesticks (documented single-market path)."""
    series = _series_for_market(conn, ticker)
    if not series:
        return None
    path = f"/series/{urllib.parse.quote(series, safe='')}/markets/{urllib.parse.quote(ticker, safe='')}/candlesticks"
    params = {"period_interval": period}
    if start_ts is not None:
        params["start_ts"] = start_ts
    if end_ts is not None:
        params["end_ts"] = end_ts
    code, j, _ = fetch_with_retry(client.base, path, params, timeout_ms=client.timeout_ms)
    return j if code == 200 and isinstance(j, dict) else None

def backfill_candles(client: KalshiClient, conn: sqlite3.Connection, tickers: List[str] = None, lookback_days: int = None):
    """Backfill 1m/1h/1d candles for tickers. If tickers is None, uses top volume markets."""
    if tickers is None:
        cur = conn.execute("SELECT ticker FROM markets WHERE status IN ('open','active') ORDER BY volume_24h DESC LIMIT 80")
        tickers = [r[0] for r in cur.fetchall()]
        if not tickers:
            log.info("no tickers for candle backfill")
            return 0
    lookback_days = lookback_days if lookback_days is not None else config.CANDLE_LOOKBACK_DAYS
    import time as _time
    end_ts = int(_time.time())
    start_ts = end_ts - lookback_days*86400
    log.info("candle backfill: %d tickers, %d days, periods=%s", len(tickers), lookback_days, config.CANDLE_PERIODS)
    total = 0
    # Batch in groups of 20 (endpoint supports up to 100 but we keep small for rate limit)
    for period in config.CANDLE_PERIODS:
        interval_label = {1:"1m", 60:"1h", 1440:"1d"}.get(period, f"{period}m")
        for i in range(0, len(tickers), 20):
            batch = tickers[i:i+20]
            j, err = client.get_candlesticks(batch, period, start_ts, end_ts)
            stored = 0
            if j:
                # current documented shape: {"markets": [{market_ticker, candlesticks}]}
                # legacy shapes (dict keyed by ticker / list of entries) still tolerated
                mcs = j.get("markets") or j.get("market_candlesticks") or j.get("candlesticks") or []
                if isinstance(mcs, dict):
                    for tk, candles in mcs.items():
                        stored += _store_candles(conn, tk, candles or [], interval_label)
                elif isinstance(mcs, list):
                    for entry in mcs:
                        if not isinstance(entry, dict):
                            continue
                        tk = entry.get("market_ticker") or entry.get("ticker")
                        candles = entry.get("candlesticks") or entry.get("candles")
                        if tk and isinstance(candles, list):
                            stored += _store_candles(conn, tk, candles, interval_label)
                total += stored
                conn.commit()
            if not stored:
                log.debug("candles batch empty/failed period %s tickers %s: %s", period, batch[:2], str(err or j)[:300])
                # per-ticker fallback: series path (documented), then historical archive
                for tk in batch:
                    jj = _candles_via_series(client, conn, tk, period, start_ts, end_ts)
                    if not jj:
                        jj, ee = client.get_historical_candlesticks(tk, period, start_ts, end_ts)
                    if jj and isinstance(jj.get("candlesticks"), list):
                        n = _store_candles(conn, tk, jj["candlesticks"], interval_label)
                        total += n
                        conn.commit()
                    time.sleep(0.1)
            time.sleep(0.3)
    log.info("candle backfill done: %d candles", total)
    log_sync(conn, "ok", f"candle backfill {total}")
    return total

def backfill_trades(client: KalshiClient, conn: sqlite3.Connection, max_pages=15):
    """Fetch recent + historical trades (paginated) and persist."""
    log.info("trade backfill: fetching recent trades...")
    total = 0
    # recent trades (live)
    cursor = get_collector_state(conn, "trades_cursor") or None
    j, err = client.get_trades(limit=200, cursor=cursor)
    pages = 0
    if j and "trades" in j:
        while pages < max_pages:
            trades = j.get("trades") or []
            if not trades:
                break
            for t in trades:
                try:
                    ticker = t.get("ticker") or t.get("market_ticker")
                    price = _dollars(t.get("yes_price_dollars") or t.get("price_dollars") or t.get("price") or 0)
                    size = _fp(t.get("count_fp") or t.get("size") or t.get("count") or 0)
                    ts_raw = t.get("created_time") or t.get("ts") or t.get("created_ts")
                    # parse ISO or ms
                    ts = None
                    if isinstance(ts_raw, (int,float)):
                        ts = int(ts_raw*1000) if ts_raw < 1e12 else int(ts_raw)
                    elif isinstance(ts_raw, str):
                        try:
                            import datetime
                            # handle "2026-08-17T..."
                            ts = int(datetime.datetime.fromisoformat(ts_raw.replace("Z","+00:00")).timestamp()*1000)
                        except:
                            ts = int(time.time()*1000)
                    else:
                        ts = int(time.time()*1000)
                    side = t.get("taker_outcome_side") or t.get("taker_side") or t.get("side") or ""
                    insert_trade(conn, ts, ticker, price, size, side, "kalshi", t)
                    total += 1
                except Exception as e:
                    log.debug("trade insert fail: %s", e)
            conn.commit()
            nxt = j.get("cursor") or j.get("next_cursor")
            if not nxt or nxt == cursor:
                # store empty to not loop forever
                set_collector_state(conn, "trades_cursor", nxt or "")
                break
            cursor = nxt
            set_collector_state(conn, "trades_cursor", cursor)
            pages += 1
            time.sleep(0.2)
            j, err = client.get_trades(limit=200, cursor=cursor)
            if not j or "trades" not in j or not j["trades"]:
                break
        log.info("recent trades upserted %d across %d pages", total, pages+1)
        log_sync(conn, "ok", f"trades backfill {total}")
    else:
        log.warning("recent trades fetch failed: %s", str(err or j)[:400])
    # historical trades
    if client.get_historical_trades:
        cursor_h = get_collector_state(conn, "historical_trades_cursor") or None
        jh, eh = client.get_historical_trades(limit=200, cursor=cursor_h)
        if jh and "trades" in jh:
            hist_total = 0
            hist_pages = 0
            while hist_pages < max_pages:
                trades = jh.get("trades") or []
                if not trades:
                    break
                for t in trades:
                    try:
                        ticker = t.get("ticker")
                        price = _dollars(t.get("yes_price_dollars"))
                        size = _fp(t.get("count_fp"))
                        side = t.get("taker_outcome_side") or t.get("taker_side") or ""
                        ts_raw = t.get("created_time")
                        import datetime
                        try:
                            ts = int(datetime.datetime.fromisoformat(ts_raw.replace("Z","+00:00")).timestamp()*1000)
                        except:
                            ts = int(time.time()*1000)
                        insert_trade(conn, ts, ticker, price, size, side, "kalshi", t)
                        hist_total += 1
                    except: pass
                conn.commit()
                nxt = jh.get("cursor")
                if not nxt or nxt == cursor_h:
                    set_collector_state(conn, "historical_trades_cursor", nxt or "")
                    break
                cursor_h = nxt
                set_collector_state(conn, "historical_trades_cursor", cursor_h)
                hist_pages += 1
                time.sleep(0.2)
                jh, eh = client.get_historical_trades(limit=200, cursor=cursor_h)
                if not jh or "trades" not in jh:
                    break
            log.info("historical trades upserted %d", hist_total)
            total += hist_total
    return total

def _is_offline(client: KalshiClient) -> bool:
    from .kalshi_client import _probe_upstream
    # quick probe — if unreachable, we skip heavy remote backfill and rely on local sim
    reachable = _probe_upstream(client.base, timeout_ms=3000)
    if not reachable:
        log.info("upstream unreachable (probe failed) — running in offline/local mode, skipping remote backfill")
    return not reachable

def run_full_backfill():
    """Entry point for autonomous backfill: markets + candles + trades."""
    from .storage import init_db
    init_db()
    conn = _connect()
    client = KalshiClient()
    # If offline (sandbox), skip remote-heavy backfill fast — Node already seeded the DB
    if _is_offline(client):
        # still log cutoff attempt quick
        try:
            jc, ec = client.get_historical_cutoff()
            if jc:
                conn.execute("INSERT OR REPLACE INTO historical_cutoff (id, market_settled_ts, trades_created_ts, orders_updated_ts, positions_last_updated_ts, raw, fetched_at) VALUES (1,?,?,?,?,?,?)",
                             (jc.get("market_settled_ts") or 0, jc.get("trades_created_ts") or 0, jc.get("orders_updated_ts") or 0,
                              jc.get("market_positions_last_updated_ts") or 0, json.dumps(jc), int(time.time()*1000)))
                conn.commit()
        except: pass
        log.info("offline mode: local DB already has markets/candles from Node engine — backfill skipped")
        # do a lightweight local validation: count existing candles
        try:
            c = conn.execute("SELECT COUNT(*) FROM candles").fetchone()[0]
            log.info("local candles available: %d (from Node seed)", c)
            log_sync(conn, "ok", f"offline backfill skipped, local candles={c}")
        except: pass
        conn.close()
        return
    try:
        # cutoff info (best effort)
        jc, ec = client.get_historical_cutoff()
        if jc:
            log.info("historical cutoff: %s", json.dumps(jc)[:500])
            try:
                conn.execute("INSERT OR REPLACE INTO historical_cutoff (id, market_settled_ts, trades_created_ts, orders_updated_ts, positions_last_updated_ts, raw, fetched_at) VALUES (1,?,?,?,?,?,?)",
                             (jc.get("market_settled_ts") or 0, jc.get("trades_created_ts") or 0, jc.get("orders_updated_ts") or 0,
                              jc.get("market_positions_last_updated_ts") or 0, json.dumps(jc), int(time.time()*1000)))
                conn.commit()
            except Exception as e:
                log.debug("cutoff store fail: %s", e)
        else:
            log.info("cutoff fetch failed (public mode): %s", str(ec)[:300])

        n_markets = backfill_events_and_markets(client, conn)
        n_trades = backfill_trades(client, conn)
        n_candles = backfill_candles(client, conn)
        log.info("backfill complete: markets=%d trades=%d candles=%d", n_markets, n_trades, n_candles)
        log_sync(conn, "ok", f"full backfill done: m={n_markets} t={n_trades} c={n_candles}")
    finally:
        conn.close()
    return

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    run_full_backfill()
