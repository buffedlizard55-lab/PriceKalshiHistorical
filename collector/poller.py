"""
collector.poller — autonomous live poller.
Runs forever without manual input:
- every SNAPSHOT_INTERVAL_MS: poll markets (quotes/volume) → snapshots + markets table
- every BOOK_SNAPSHOT_INTERVAL_MS: poll orderbooks → book_snapshots + Parquet staging
- every TRADE_POLL_INTERVAL_MS: poll trades → trades table
- every CANDLE_POLL_INTERVAL_MS: poll candles → candles table
Handles rate limits, backoff, fallback to local Node API if upstream unreachable,
and mirrors Node's kalshiSync behavior as a Python supplement.
"""
import json
import logging
import signal
import sqlite3
import time
from typing import List

from . import config
from .kalshi_client import KalshiClient
from .storage import _connect, upsert_event, upsert_market, insert_snapshot, insert_book_snapshot, insert_trade, insert_candle, log_sync, write_parquet_snapshots, write_parquet_books, get_counts

log = logging.getLogger("collector.poller")

def _dollars(x):
    try: return float(x)
    except: return 0.0
def _fp(x):
    try: return float(x)
    except: return 0.0

# --- Kalshi orderbook payload parsing (current documented schema) ---
# Current API (docs.kalshi.com OpenAPI v3.28.0):
#   single: {"orderbook_fp": {"yes_dollars": [[price_str, count_fp_str], ...],
#                             "no_dollars":  [[price_str, count_fp_str], ...]}}
#   batch : {"orderbooks": [{"ticker": ..., "orderbook_fp": {...}}, ...]}
# The book is BIDS ONLY: yes_dollars = YES bids; no_dollars = NO bids.
# A NO bid at q is a YES ask at (1-q), so YES asks are derived from NO bids.
def _as_book_payload(payload):
    if isinstance(payload, dict):
        for key in ("orderbook_fp", "orderbook", "book"):
            v = payload.get(key)
            if isinstance(v, dict):
                return v
    return payload

def _normalize_books_response(j):
    """Normalize GET /markets/orderbooks responses to {ticker: book_payload}."""
    books = {}
    if not isinstance(j, dict):
        return books
    raw = j.get("orderbooks")
    if isinstance(raw, list):
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            tk = entry.get("ticker") or entry.get("market_ticker")
            if tk:
                books[tk] = _as_book_payload(entry)
    elif isinstance(raw, dict):
        books = {tk: _as_book_payload(p) for tk, p in raw.items()}
    return books

def parse_kalshi_book(payload):
    """Parse a Kalshi orderbook payload into yes-side ([bids], [asks]) in dollars.

    Handles current {yes_dollars, no_dollars}, legacy cents {yes, no}, and
    third-party-shaped {yes_bids/yes_asks} payloads. Returns (bids, asks).
    """
    def conv(levels):
        out = []
        for lvl in levels or []:
            try:
                if isinstance(lvl, dict):
                    p, s = lvl.get("price"), lvl.get("size")
                elif isinstance(lvl, (list, tuple)) and len(lvl) >= 2:
                    p, s = lvl[0], lvl[1]
                else:
                    continue
                p, s = float(p), float(s)
                if p > 1.5:  # legacy integer cents
                    p /= 100.0
                if 0 < p < 1.5 and s > 0:
                    out.append([round(p, 4), round(s, 4)])
            except Exception:
                continue
        return out
    if not isinstance(payload, dict):
        return [], []
    payload = _as_book_payload(payload)
    yes_bids = conv(payload.get("yes_dollars") or payload.get("yes") or payload.get("yes_bids") or payload.get("bids"))
    explicit_asks = payload.get("yes_asks") or payload.get("asks")
    if explicit_asks:
        yes_asks = conv(explicit_asks)
    else:
        # derive YES asks from NO bids: yes_ask = 1 - no_bid (best NO bid = lowest YES ask)
        no_bids = conv(payload.get("no_dollars") or payload.get("no"))
        yes_asks = sorted([[round(1.0 - p, 4), s] for p, s in no_bids if 0 < p < 1.0])
    return yes_bids, yes_asks

# --- Kalshi candlestick parsing (current documented schema) ---
def _parse_kalshi_candle(c):
    """Parse a Kalshi MarketCandlestick dict -> (t_open_ms, o, h, l, cl, v) or None.

    Current schema: {end_period_ts (unix seconds), price: {open/high/low/close_dollars},
    volume_fp, open_interest_fp}. Tolerates legacy {t_open, o, h, l, c, v}.
    """
    if not isinstance(c, dict):
        return None
    try:
        t_open = c.get("end_period_ts") or c.get("t_open")
        if t_open is None:
            return None
        t_open = int(t_open)
        if t_open < 1e10:  # unix seconds -> ms
            t_open = int(t_open * 1000)
        price = c.get("price") or {}
        o = _dollars(price.get("open_dollars") or c.get("o"))
        h = _dollars(price.get("high_dollars") or c.get("h"))
        l = _dollars(price.get("low_dollars") or c.get("l"))
        cl = _dollars(price.get("close_dollars") or c.get("c") or c.get("close"))
        v = _fp(c.get("volume_fp") or c.get("v"))
        return t_open, o, h, l, cl, v
    except Exception:
        return None

def _store_candles(conn, ticker, candles, interval_label):
    n = 0
    for c in candles:
        parsed = _parse_kalshi_candle(c)
        if not parsed:
            continue
        t_open, o, h, l, cl, v = parsed
        if cl:  # candles with no trades have null close — skip
            try:
                insert_candle(conn, ticker, interval_label, t_open, o or cl, h or cl, l or cl, cl, v)
                n += 1
            except Exception:
                pass
    return n

class Poller:
    def __init__(self, client: KalshiClient = None, local_client: KalshiClient = None):
        self.client = client or KalshiClient(base=config.KALSHI_API_BASE)
        # Local fallback client (Node server running on same host)
        try:
            self.local_client = local_client or KalshiClient(base=config.LOCAL_API_BASE + "/api" if not config.LOCAL_API_BASE.endswith("/api") else config.LOCAL_API_BASE, timeout_ms=4000)
            # normalize: local_client base should be http://127.0.0.1:8080 (index.js serves /api/* under that)
            # We'll just use fetch via raw _do_fetch with special handling; simpler: use requests to local
            self.local_base = config.LOCAL_API_BASE
        except Exception:
            self.local_base = None
            self.local_client = None
        self.conn = _connect()
        self.running = True
        self.stats = {"snapshots":0, "books":0, "trades":0, "candles":0, "failures":0, "fallbacks":0}
        self.last_snapshot = 0
        self.last_book = 0
        self.last_trade = 0
        self.last_candle = 0
        self.last_markets_refresh = 0
        self.tickers_cache: List[str] = []

        # signal handling
        try:
            signal.signal(signal.SIGINT, self._stop)
            signal.signal(signal.SIGTERM, self._stop)
        except Exception:
            pass

    def _stop(self, *_):
        log.info("poller stopping...")
        self.running = False

    def _refresh_tickers(self, force=False):
        if not force and time.time()*1000 - self.last_markets_refresh < config.SYNC_INTERVAL_MS:
            return
        self.last_markets_refresh = int(time.time()*1000)
        # Prefer upstream, fallback to local DB or local API
        j, err = self.client.get_markets(limit=config.BATCH_MARKETS_LIMIT, status="open")
        tickers = []
        if j and "markets" in j and j["markets"]:
            for m in j["markets"]:
                if m.get("ticker"):
                    tickers.append(m["ticker"])
            # paginate a couple pages to get decent universe (bounded to avoid storm)
            cursor = j.get("cursor")
            pages = 1
            while cursor and pages < 4:
                time.sleep(0.2)
                j2, _ = self.client.get_markets(limit=config.BATCH_MARKETS_LIMIT, status="open", cursor=cursor)
                if not j2 or "markets" not in j2 or not j2["markets"]:
                    break
                for m in j2["markets"]:
                    if m.get("ticker"):
                        tickers.append(m["ticker"])
                cursor = j2.get("cursor")
                pages += 1
                if not cursor:
                    break
        if not tickers:
            # fallback to DB
            try:
                cur = self.conn.execute("SELECT ticker FROM markets WHERE status IN ('open','active') ORDER BY volume_24h DESC LIMIT 120")
                tickers = [r[0] for r in cur.fetchall()]
            except Exception:
                tickers = []
        if tickers:
            self.tickers_cache = list(dict.fromkeys(tickers))  # dedupe preserve order
            log.debug("tickers refreshed: %d", len(self.tickers_cache))
        return tickers

    def poll_markets_once(self):
        """Poll markets snapshot (quotes) and upsert + snapshot rows."""
        now = int(time.time()*1000)
        if now - self.last_snapshot < config.SNAPSHOT_INTERVAL_MS:
            return
        self.last_snapshot = now
        self._refresh_tickers()
        # Fetch markets batch via paginated get_markets; we already have tickers_cache, but need fresh quotes
        # Use per-page poll: first page of open markets gives us quotes for ~200 markets
        j, err = self.client.get_markets(limit=config.BATCH_MARKETS_LIMIT, status="open")
        markets = []
        if j and "markets" in j:
            markets = j["markets"]
            # optionally paginate a bit
            cursor = j.get("cursor")
            pages = 1
            while cursor and pages < 3 and len(markets) < 250:
                time.sleep(0.18)
                j2, _ = self.client.get_markets(limit=config.BATCH_MARKETS_LIMIT, status="open", cursor=cursor)
                if not j2 or "markets" not in j2 or not j2["markets"]:
                    break
                markets.extend(j2["markets"])
                cursor = j2.get("cursor")
                pages += 1
                if not cursor:
                    break
        else:
            # upstream failed — try local API snapshot fallback
            if self._try_local_fallback("markets"):
                self.stats["fallbacks"] += 1
                return
            self.stats["failures"] += 1
            log.debug("markets poll failed: %s", str(err or j)[:300])
            return

        # upsert markets and create snapshots
        rows_for_parquet = []
        for m in markets:
            if m.get("is_provisional"):
                continue
            ticker = m.get("ticker")
            if not ticker:
                continue
            try:
                yes_bid = _dollars(m.get("yes_bid_dollars"))
                yes_ask = _dollars(m.get("yes_ask_dollars"))
                last = _dollars(m.get("last_price_dollars"))
                mid = (yes_bid+yes_ask)/2 if yes_bid and yes_ask else last
                vol = _fp(m.get("volume_fp"))
                vol24 = _fp(m.get("volume_24h_fp"))
                oi = _fp(m.get("open_interest_fp"))
                prev = _fp(m.get("last_price_dollars"))  # approx
                et = m.get("event_ticker") or ""
                # ensure event exists (minimal) — but never overwrite metadata
                # that the backfill enriched (title/category/mutually_exclusive)
                try:
                    exists = self.conn.execute("SELECT 1 FROM events WHERE ticker = ?", (et,)).fetchone()
                    if not exists:
                        upsert_event(self.conn, et, et, "", "Other", "", 0, m.get("close_time") or "", et.lower())
                except: pass
                upsert_market(self.conn, ticker, et, m.get("title") or ticker,
                              m.get("yes_sub_title") or "Yes", m.get("no_sub_title") or "No",
                              m.get("status") or "open", m.get("close_time") or "",
                              last, yes_bid, yes_ask, _fp(m.get("yes_bid_size_fp")), _fp(m.get("yes_ask_size_fp")),
                              mid, vol, vol24, oi, prev, "kalshi")
                insert_snapshot(self.conn, now, ticker, mid, yes_bid, yes_ask, last, vol24)
                rows_for_parquet.append((now, ticker, mid, yes_bid, yes_ask, last, vol24))
                self.stats["snapshots"] += 1
            except Exception as e:
                log.debug("snapshot upsert fail %s: %s", ticker, e)
        try:
            self.conn.commit()
            if rows_for_parquet:
                write_parquet_snapshots(rows_for_parquet)
        except Exception as e:
            log.warning("snapshot commit failed: %s", e)
        # prune if configured (collector keeps forever by default; clone prunes)
        try:
            if config.PRUNE_DAYS_SNAPSHOTS > 0:
                cutoff = now - config.PRUNE_DAYS_SNAPSHOTS*86400000
                self.conn.execute("DELETE FROM snapshots WHERE ts < ?", (cutoff,))
                self.conn.commit()
        except Exception:
            pass
        log.info("snapshots: %d markets, total snapshots=%d", len(markets), self.stats["snapshots"])

    def poll_books_once(self):
        now = int(time.time()*1000)
        if now - self.last_book < config.BOOK_SNAPSHOT_INTERVAL_MS:
            return
        self.last_book = now
        if not self.tickers_cache:
            self._refresh_tickers(force=True)
        if not self.tickers_cache:
            return
        # Batch books in groups to respect rate limits
        batch = self.tickers_cache[:40]  # limit per interval to avoid 429; rotate ticker window each interval
        # rotate cache for next call
        if len(self.tickers_cache) > 40:
            self.tickers_cache = self.tickers_cache[40:] + self.tickers_cache[:40]
        # Try batch endpoint (unsigned, then signed); client falls back to per-ticker
        j, err = self.client.get_orderbooks_batch(batch)
        books = _normalize_books_response(j)
        if not books:
            if self._try_local_fallback("books"):
                self.stats["fallbacks"] += 1
                return
            log.debug("orderbook batch empty: %s", str(err or j)[:300])

        inserted = 0
        try:
            quote_rows = self.conn.execute(
                "SELECT ticker, yes_bid, yes_ask, yes_bid_size, yes_ask_size FROM markets").fetchall()
        except Exception:
            quote_rows = []
        quotes = {r[0]: r for r in quote_rows}
        for tk, payload in books.items():
            try:
                bids, asks = parse_kalshi_book(payload)
                if not bids and not asks and tk in quotes:
                    # keep book history advancing: synthesize a minimal book
                    # from the latest quotes rather than store nothing
                    q = quotes[tk]
                    bids = [[q[1], q[3] or 1.0]] if q[1] else []
                    asks = [[q[2], q[4] or 1.0]] if q[2] else []
                    log.debug("book %s synthesized from quotes", tk)
                if not bids and not asks:
                    continue
                insert_book_snapshot(self.conn, now, tk, bids, asks)
                write_parquet_books(now, tk, bids, asks)
                inserted += 1
                self.stats["books"] += 1
            except Exception as e:
                log.debug("book insert %s fail: %s", tk, e)
        try:
            self.conn.commit()
            if config.PRUNE_DAYS_BOOKS > 0:
                cutoff = now - config.PRUNE_DAYS_BOOKS*86400000
                self.conn.execute("DELETE FROM book_snapshots WHERE ts < ?", (cutoff,))
                self.conn.commit()
        except Exception as e:
            log.warning("book commit fail: %s", e)
        log.info("books: %d / %d inserted", inserted, len(batch))

    def poll_trades_once(self):
        now = int(time.time()*1000)
        if now - self.last_trade < config.TRADE_POLL_INTERVAL_MS:
            return
        self.last_trade = now
        j, err = self.client.get_trades(limit=100)
        if not j or "trades" not in j:
            if self._try_local_fallback("trades"):
                self.stats["fallbacks"] += 1
                return
            log.debug("trades poll failed: %s", str(err or j)[:300])
            self.stats["failures"] += 1
            return
        trades = j.get("trades") or []
        if not trades:
            return
        inserted = 0
        for t in trades:
            try:
                ticker = t.get("ticker") or t.get("market_ticker")
                price = _dollars(t.get("yes_price_dollars") or t.get("price_dollars") or t.get("price") or 0)
                size = _fp(t.get("count_fp") or t.get("size") or 0)
                side = t.get("taker_outcome_side") or t.get("taker_side") or t.get("side") or ""
                ts_raw = t.get("created_time") or t.get("ts")
                ts = now
                if isinstance(ts_raw, (int,float)):
                    ts = int(ts_raw*1000) if ts_raw < 1e12 else int(ts_raw)
                elif isinstance(ts_raw, str):
                    try:
                        import datetime
                        ts = int(datetime.datetime.fromisoformat(ts_raw.replace("Z","+00:00")).timestamp()*1000)
                    except: pass
                # dedupe: check if already exists (cheap check: recent exact ts+ticker+price+size)
                # skip if already present to avoid duplicates
                cur = self.conn.execute("SELECT 1 FROM trades WHERE ts=? AND ticker=? AND price=? AND size=? LIMIT 1", (ts, ticker, price, size))
                if cur.fetchone():
                    continue
                insert_trade(self.conn, ts, ticker, price, size, side, "kalshi", t)
                inserted += 1
                self.stats["trades"] += 1
            except Exception as e:
                log.debug("trade insert fail: %s", e)
        try:
            self.conn.commit()
        except: pass
        log.info("trades: +%d / %d", inserted, len(trades))

    def poll_candles_once(self):
        now = int(time.time()*1000)
        if now - self.last_candle < config.CANDLE_POLL_INTERVAL_MS:
            return
        self.last_candle = now
        # Only refresh 1m candles for active tickers, small batch per interval to avoid storm
        if not self.tickers_cache:
            return
        batch = self.tickers_cache[:20]
        import time as _time
        end_ts = int(_time.time())
        start_ts = end_ts - 3600*2  # last 2h
        j, err = self.client.get_candlesticks(batch, 1, start_ts, end_ts)
        if not j:
            log.debug("candles poll failed: %s", str(err)[:300])
            self.stats["failures"] += 1
            return
        # Current documented batch shape: {"markets": [{market_ticker, candlesticks}]}
        # Older shapes (dict keyed by ticker / list of entries) still tolerated.
        mcs = j.get("markets") or j.get("market_candlesticks") or j.get("candlesticks") or {}
        inserted = 0
        if isinstance(mcs, dict):
            for tk, candles in mcs.items():
                inserted += _store_candles(self.conn, tk, candles or [], "1m")
        elif isinstance(mcs, list):
            for entry in mcs:
                if not isinstance(entry, dict):
                    continue
                tk = entry.get("market_ticker") or entry.get("ticker")
                candles = entry.get("candlesticks") or entry.get("candles")
                if tk and isinstance(candles, list):
                    inserted += _store_candles(self.conn, tk, candles, "1m")
        try:
            self.conn.commit()
        except: pass
        self.stats["candles"] += inserted
        if inserted:
            log.info("candles: +%d 1m", inserted)

    def _try_local_fallback(self, kind):
        """Try to mirror from local Node API when upstream unreachable."""
        if not self.local_base:
            return False
        try:
            import urllib.request, json
            url = self.local_base.rstrip("/") + ("/api/markets" if kind=="markets" else "/api/markets" if kind=="books" else "/api/markets")
            # For simplicity, fetch local /api/markets and synthesize snapshots/books from it
            with urllib.request.urlopen(url, timeout=3) as r:
                j = json.loads(r.read().decode())
                if "markets" in j and j["markets"]:
                    now = int(time.time()*1000)
                    rows = []
                    for m in j["markets"]:
                        ticker = m.get("ticker")
                        mid = m.get("mid") or 0
                        bid = m.get("yesBid") or m.get("yes_bid") or 0
                        ask = m.get("yesAsk") or m.get("yes_ask") or 0
                        last = m.get("last") or mid
                        vol24 = m.get("volume24h") or m.get("volume_24h") or 0
                        if ticker and mid:
                            try:
                                et = m.get("eventTicker") or m.get("event_ticker") or ""
                                upsert_market(self.conn, ticker, et, m.get("title") or ticker,
                                              m.get("yesSub") or "Yes", m.get("noSub") or "No",
                                              m.get("status") or "open", m.get("closeTime") or "",
                                              last, bid, ask, m.get("yesBidSize") or 0, m.get("yesAskSize") or 0,
                                              mid, m.get("volume") or 0, vol24, m.get("openInterest") or 0, last, "sim")
                                insert_snapshot(self.conn, now, ticker, mid, bid, ask, last, vol24)
                                rows.append((now, ticker, mid, bid, ask, last, vol24))
                            except: pass
                    self.conn.commit()
                    # also try books
                    if kind == "books":
                        # fetch per-ticker books from local
                        for m in j["markets"][:30]:
                            tk = m.get("ticker")
                            try:
                                with urllib.request.urlopen(f"{self.local_base.rstrip('/')}/api/market/{tk}/book", timeout=2) as rb:
                                    bj = json.loads(rb.read().decode())
                                    bids = bj.get("bids") or []
                                    asks = bj.get("asks") or []
                                    if bids or asks:
                                        insert_book_snapshot(self.conn, now, tk, bids, asks)
                            except: pass
                        self.conn.commit()
                    if kind == "markets":
                        write_parquet_snapshots(rows)
                    log.info("local fallback %s: %d markets mirrored", kind, len(j["markets"]))
                    return True
        except Exception as e:
            log.debug("local fallback %s failed: %s", kind, e)
        return False

    def run_forever(self):
        log.info("poller starting — upstream=%s local=%s db=%s", config.KALSHI_API_BASE, config.LOCAL_API_BASE, config.DB_PATH)
        log.info("intervals: snapshot=%dms book=%dms trade=%dms candle=%dms rps=%.1f", config.SNAPSHOT_INTERVAL_MS, config.BOOK_SNAPSHOT_INTERVAL_MS, config.TRADE_POLL_INTERVAL_MS, config.CANDLE_POLL_INTERVAL_MS, config.MAX_RPS)
        # initial tick
        self._refresh_tickers(force=True)
        # log sync start
        try:
            log_sync(self.conn, "info", f"poller started upstream={config.KALSHI_API_BASE}")
        except: pass
        cycle = 0
        while self.running:
            cycle += 1
            try:
                self.poll_markets_once()
            except Exception as e:
                log.warning("poll markets error: %s", e)
            try:
                self.poll_books_once()
            except Exception as e:
                log.warning("poll books error: %s", e)
            try:
                self.poll_trades_once()
            except Exception as e:
                log.warning("poll trades error: %s", e)
            try:
                if cycle % 6 == 0:  # every ~30s if sleep 5s, but candle interval guards
                    self.poll_candles_once()
            except Exception as e:
                log.warning("poll candles error: %s", e)
            # heartbeat log every 5 min
            if cycle % 60 == 0:
                try:
                    counts = get_counts(self.conn)
                    log.info("heartbeat %d cycles — stats=%s counts=%s", cycle, self.stats, counts)
                    log_sync(self.conn, "info", f"heartbeat {counts}")
                except Exception as e:
                    log.debug("heartbeat fail: %s", e)
            # sleep 5s but interruptible
            for _ in range(50):
                if not self.running:
                    break
                time.sleep(0.1)
        log.info("poller stopped — final stats %s", self.stats)
        try:
            log_sync(self.conn, "info", f"poller stopped {self.stats}")
            self.conn.close()
        except: pass

def main():
    import logging
    logging.basicConfig(level=getattr(logging, config.LOG_LEVEL, logging.INFO), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    from .storage import init_db
    init_db()
    p = Poller()
    p.run_forever()

if __name__ == "__main__":
    main()
