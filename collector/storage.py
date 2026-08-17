"""
collector.storage — SQLite + Parquet persistence.
Reuses the same data/exchange.db as the Node engine when present, else creates it.
"""
import json
import logging
import pathlib
import sqlite3
import time
from typing import Any, Dict, List, Optional

from . import config

log = logging.getLogger("collector.storage")

def _connect():
    p = pathlib.Path(config.DB_PATH)
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p), timeout=30.0, isolation_level=None, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=10000;")
    return conn

def init_db():
    conn = _connect()
    schema_path = pathlib.Path(__file__).resolve().parents[1] / "storage" / "schema.sql"
    if not schema_path.exists():
        # fallback inline minimal schema
        schema = pathlib.Path(__file__).resolve().parents[1] / "server" / "db.js"
        # just execute via reading storage/schema.sql if exists else create tables minimally
        sql = open(schema_path).read() if schema_path.exists() else ""
    else:
        sql = schema_path.read_text()
    if sql.strip():
        conn.executescript(sql)
    # ensure account row
    try:
        cur = conn.execute("SELECT balance FROM account WHERE id=1")
        if not cur.fetchone():
            conn.execute("INSERT INTO account (id, balance) VALUES (1, ?)", (config.STARTING_BALANCE,))
            conn.commit()
            log.info("initialized account balance=%.2f", config.STARTING_BALANCE)
    except Exception as e:
        log.debug("ensureAccount: %s", e)
    conn.close()
    # ensure parquet dir
    if config.PARQUET_ENABLED:
        pathlib.Path(config.PARQUET_PATH).mkdir(parents=True, exist_ok=True)
    return True

# --- helpers ---
def upsert_event(conn, ticker, title, subtitle="", category="Other", series="", mee=0, close_time="", image_seed=""):
    conn.execute("""
        INSERT INTO events (ticker,title,subtitle,category,series,mutually_exclusive,close_time,image_seed)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(ticker) DO UPDATE SET title=excluded.title, subtitle=excluded.subtitle,
          category=excluded.category, series=excluded.series,
          mutually_exclusive=excluded.mutually_exclusive, close_time=excluded.close_time
    """, (ticker, title, subtitle or "", category or "Other", series or "", int(bool(mee)), close_time or "", image_seed or ticker.lower()))

def upsert_market(conn, ticker, event_ticker, title, yes_sub="Yes", no_sub="No",
                  status="open", close_time="", last_price=0, yes_bid=0, yes_ask=0,
                  yes_bid_size=0, yes_ask_size=0, mid=0, volume=0, volume_24h=0,
                  open_interest=0, prev_price=0, source="kalshi", tick_size=0.01, anchor=None, liquidity=None, rules=""):
    # Try full upsert including extended columns if they exist, else fallback
    # Check if columns exist by pragma
    # Use INSERT ... ON CONFLICT then UPDATE common cols
    try:
        conn.execute("""
            INSERT INTO markets (ticker,event_ticker,title,yes_sub,no_sub,status,close_time,
              last_price,yes_bid,yes_ask,yes_bid_size,yes_ask_size,mid,volume,volume_24h,open_interest,prev_price,source,updated_at, tick_size, anchor, liquidity, rules)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(ticker) DO UPDATE SET
              last_price=excluded.last_price, yes_bid=excluded.yes_bid, yes_ask=excluded.yes_ask,
              yes_bid_size=excluded.yes_bid_size, yes_ask_size=excluded.yes_ask_size, mid=excluded.mid,
              volume=excluded.volume, volume_24h=excluded.volume_24h, open_interest=excluded.open_interest,
              prev_price=excluded.prev_price, source=excluded.source, status=excluded.status, updated_at=excluded.updated_at
        """, (ticker, event_ticker, title, yes_sub, no_sub, status, close_time or "",
              last_price or 0, yes_bid or 0, yes_ask or 0, yes_bid_size or 0, yes_ask_size or 0, mid or 0,
              volume or 0, volume_24h or 0, open_interest or 0, prev_price or last_price or 0, source, int(time.time()*1000),
              tick_size or 0.01, anchor if anchor is not None else mid or 0.5, liquidity or 8000, rules or ""))
    except sqlite3.OperationalError as e:
        # fallback without tick_size/anchor/liquidity/rules if schema older
        conn.execute("""
            INSERT INTO markets (ticker,event_ticker,title,yes_sub,no_sub,status,close_time,
              last_price,yes_bid,yes_ask,yes_bid_size,yes_ask_size,mid,volume,volume_24h,open_interest,prev_price,source,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(ticker) DO UPDATE SET
              last_price=excluded.last_price, yes_bid=excluded.yes_bid, yes_ask=excluded.yes_ask,
              yes_bid_size=excluded.yes_bid_size, yes_ask_size=excluded.yes_ask_size, mid=excluded.mid,
              volume=excluded.volume, volume_24h=excluded.volume_24h, open_interest=excluded.open_interest,
              prev_price=excluded.prev_price, source=excluded.source, status=excluded.status, updated_at=excluded.updated_at
        """, (ticker, event_ticker, title, yes_sub, no_sub, status, close_time or "",
              last_price or 0, yes_bid or 0, yes_ask or 0, yes_bid_size or 0, yes_ask_size or 0, mid or 0,
              volume or 0, volume_24h or 0, open_interest or 0, prev_price or last_price or 0, source, int(time.time()*1000)))

def insert_snapshot(conn, ts, ticker, mid, bid, ask, last, volume_24h):
    conn.execute("INSERT INTO snapshots (ts,ticker,mid,bid,ask,last,volume_24h) VALUES (?,?,?,?,?,?,?)",
                 (ts, ticker, mid, bid, ask, last, volume_24h))

def insert_book_snapshot(conn, ts, ticker, bids, asks):
    conn.execute("INSERT INTO book_snapshots (ts,ticker,bids,asks) VALUES (?,?,?,?)",
                 (ts, ticker, json.dumps(bids), json.dumps(asks)))

def insert_trade(conn, ts, ticker, price, size, side="", source="kalshi", raw=None):
    try:
        conn.execute("INSERT INTO trades (ts,ticker,price,size,side,source,raw) VALUES (?,?,?,?,?,?,?)",
                     (ts, ticker, price, size, side or "", source, json.dumps(raw) if raw else "{}"))
    except sqlite3.OperationalError:
        # if trades table missing old schema, create it
        conn.execute("""CREATE TABLE IF NOT EXISTS trades (
          id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, ticker TEXT NOT NULL,
          price REAL, size REAL, side TEXT DEFAULT '', source TEXT DEFAULT 'kalshi', raw TEXT DEFAULT '{}')""")
        conn.execute("INSERT INTO trades (ts,ticker,price,size,side,source,raw) VALUES (?,?,?,?,?,?,?)",
                     (ts, ticker, price, size, side or "", source, json.dumps(raw) if raw else "{}"))

def insert_candle(conn, ticker, interval, t_open, o,h,l,c,v):
    conn.execute("INSERT OR REPLACE INTO candles (ticker,interval,t_open,o,h,l,c,v) VALUES (?,?,?,?,?,?,?,?)",
                 (ticker, interval, t_open, o,h,l,c,v))

def log_sync(conn, status, detail):
    try:
        conn.execute("INSERT INTO sync_log (ts,status,detail) VALUES (?,?,?)", (int(time.time()*1000), status, detail[:2000]))
        conn.commit()
    except Exception:
        pass

def set_collector_state(conn, key, value):
    conn.execute("INSERT INTO collector_state (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
                 (key, json.dumps(value) if not isinstance(value,str) else value, int(time.time()*1000)))
    conn.commit()

def get_collector_state(conn, key, default=None):
    cur = conn.execute("SELECT value FROM collector_state WHERE key=?", (key,))
    row = cur.fetchone()
    if not row:
        return default
    try:
        return json.loads(row[0])
    except Exception:
        return row[0]

def get_counts(conn):
    try:
        c = {}
        c["events"] = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        c["markets"] = conn.execute("SELECT COUNT(*) FROM markets").fetchone()[0]
        c["openMarkets"] = conn.execute("SELECT COUNT(*) FROM markets WHERE status='open'").fetchone()[0]
        c["snapshots"] = conn.execute("SELECT COUNT(*) FROM snapshots").fetchone()[0]
        c["book_snapshots"] = conn.execute("SELECT COUNT(*) FROM book_snapshots").fetchone()[0]
        c["candles"] = conn.execute("SELECT COUNT(*) FROM candles").fetchone()[0]
        c["trades"] = conn.execute("SELECT COUNT(*) FROM trades").fetchone()[0] if _table_exists(conn,"trades") else 0
        c["anomalies"] = conn.execute("SELECT COUNT(*) FROM anomalies").fetchone()[0]
        return c
    except Exception as e:
        return {"error": str(e)}

def _table_exists(conn, name):
    cur = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (name,))
    return cur.fetchone() is not None

# Parquet helper (optional)
def write_parquet_books(ts, ticker, bids, asks):
    if not config.PARQUET_ENABLED:
        return
    try:
        import pyarrow as pa, pyarrow.parquet as pq, pathlib as pl
        root = pathlib.Path(config.PARQUET_PATH) / "books"
        root.mkdir(parents=True, exist_ok=True)
        # one file per day per ticker
        import datetime
        dt = datetime.datetime.utcfromtimestamp(ts/1000).strftime("%Y-%m-%d")
        fname = root / f"dt={dt}" / f"{ticker}.parquet"
        fname.parent.mkdir(parents=True, exist_ok=True)
        # append: read existing if exists, concat, write
        # For simplicity, write a single row file per snapshot with append via dataset
        # Instead we batch in memory and spill periodically — here just append row to file via overwrite of aggregated list is too heavy
        # So we write a small file per snapshot in a staging dir and let compaction later
        # Easiest: write per-snapshot file under staging
        staging = root / "_staging" / f"dt={dt}"
        staging.mkdir(parents=True, exist_ok=True)
        # write tiny parquet
        table = pa.table({"ts": [ts], "ticker": [ticker], "bids": [json.dumps(bids)], "asks": [json.dumps(asks)]})
        pq.write_table(table, staging / f"{ticker}_{ts}.parquet")
    except Exception as e:
        log.debug("parquet write failed (books): %s", e)

def write_parquet_snapshots(rows):
    if not config.PARQUET_ENABLED or not rows:
        return
    try:
        import pyarrow as pa, pyarrow.parquet as pq, pathlib as pl, datetime
        root = pathlib.Path(config.PARQUET_PATH) / "snapshots"
        root.mkdir(parents=True, exist_ok=True)
        # group by date
        buckets = {}
        for r in rows:
            dt = datetime.datetime.utcfromtimestamp(r[0]/1000).strftime("%Y-%m-%d")
            buckets.setdefault(dt, []).append(r)
        for dt, bucket in buckets.items():
            table = pa.table({
                "ts": [b[0] for b in bucket],
                "ticker": [b[1] for b in bucket],
                "mid": [b[2] for b in bucket],
                "bid": [b[3] for b in bucket],
                "ask": [b[4] for b in bucket],
                "last": [b[5] for b in bucket],
                "volume_24h": [b[6] for b in bucket],
            })
            fname = root / f"dt={dt}.parquet"
            if fname.exists():
                # append
                existing = pq.read_table(str(fname))
                table = pa.concat_tables([existing, table])
            pq.write_table(table, str(fname))
    except Exception as e:
        log.debug("parquet write snapshots failed: %s", e)

