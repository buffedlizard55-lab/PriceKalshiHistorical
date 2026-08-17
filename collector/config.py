"""collector.config — env-driven configuration, zero manual input defaults."""
import os
import pathlib

try:
    from dotenv import load_dotenv  # optional
    load_dotenv()
except Exception:
    pass

def _int(name, default):
    try:
        return int(os.getenv(name, str(default)))
    except:
        return default

def _float(name, default):
    try:
        return float(os.getenv(name, str(default)))
    except:
        return default

ROOT = pathlib.Path(__file__).resolve().parents[1]

KALSHI_API_BASE = os.getenv("KALSHI_API_BASE", "https://api.elections.kalshi.com/trade-api/v2").rstrip("/")
# Alternate alias used by clone
if os.getenv("KALSHI_API_BASE") is None and os.getenv("KALSHI_API") :
    KALSHI_API_BASE = os.getenv("KALSHI_API").rstrip("/")

SYNC_INTERVAL_MS = _int("SYNC_INTERVAL_MS", 15000)
SYNC_TIMEOUT_MS = _int("KALSHI_SYNC_TIMEOUT_MS", _int("SYNC_TIMEOUT_MS", 8000))
SNAPSHOT_INTERVAL_MS = _int("SNAPSHOT_INTERVAL_MS", 5000)
BOOK_SNAPSHOT_INTERVAL_MS = _int("BOOK_SNAPSHOT_INTERVAL_MS", 15000)
TRADE_POLL_INTERVAL_MS = _int("TRADE_POLL_INTERVAL_MS", 60000)
CANDLE_POLL_INTERVAL_MS = _int("CANDLE_POLL_INTERVAL_MS", 300000)

MAX_RPS = _float("KALSHI_MAX_RPS", 8.0)  # conservative for Basic tier (~10-20)
BATCH_MARKETS_LIMIT = _int("KALSHI_BATCH_MARKETS_LIMIT", 200)
BATCH_ORDERBOOKS = _int("KALSHI_BATCH_ORDERBOOKS", 100)

PORT = _int("PORT", 8080)
HOST = os.getenv("HOST", "0.0.0.0")
LOCAL_API_BASE = os.getenv("LOCAL_API_BASE", f"http://127.0.0.1:{PORT}")

DB_PATH = os.getenv("DB_PATH", str(ROOT / "data" / "exchange.db"))
PARQUET_PATH = os.getenv("PARQUET_PATH", str(ROOT / "data" / "parquet"))

STARTING_BALANCE = _float("STARTING_BALANCE", 10000.0)
LOG_LEVEL = os.getenv("COLLECTOR_LOG_LEVEL", os.getenv("LOG_LEVEL", "INFO")).upper()

# Auth (optional) — only needed for /historical/* and private endpoints
KALSHI_ACCESS_KEY = os.getenv("KALSHI_ACCESS_KEY", "")
KALSHI_PRIVATE_KEY_PEM = os.getenv("KALSHI_PRIVATE_KEY_PEM", "")
KALSHI_PRIVATE_KEY_PATH = os.getenv("KALSHI_PRIVATE_KEY_PATH", "")

# Collector behavior
BACKFILL_ON_START = os.getenv("BACKFILL_ON_START", "1") not in ("0","false","False","no")
LIVE_POLL_ON_START = os.getenv("LIVE_POLL_ON_START", "1") not in ("0","false","False","no")
ENABLE_WEBSOCKET = os.getenv("ENABLE_WEBSOCKET", "0") in ("1","true","True","yes")
PARQUET_ENABLED = os.getenv("PARQUET_ENABLED", "1") not in ("0","false","False")
PRUNE_DAYS_SNAPSHOTS = _int("PRUNE_DAYS_SNAPSHOTS", 0)  # 0 = never prune (historical collector keeps forever)
PRUNE_DAYS_BOOKS = _int("PRUNE_DAYS_BOOKS", 0)
PRUNE_DAYS_ANOMALIES = _int("PRUNE_DAYS_ANOMALIES", 30)
PRUNE_DAYS_SYNCLOG = _int("PRUNE_DAYS_SYNCLOG", 14)

CANDLE_PERIODS = [1, 60, 1440]  # 1m, 1h, 1d
CANDLE_LOOKBACK_DAYS = _int("CANDLE_LOOKBACK_DAYS", 7)  # backfill this many days of 1m candles on start

def summary():
    return {
        "KALSHI_API_BASE": KALSHI_API_BASE,
        "LOCAL_API_BASE": LOCAL_API_BASE,
        "DB_PATH": DB_PATH,
        "MAX_RPS": MAX_RPS,
        "SYNC_INTERVAL_MS": SYNC_INTERVAL_MS,
        "SNAPSHOT_INTERVAL_MS": SNAPSHOT_INTERVAL_MS,
        "BOOK_SNAPSHOT_INTERVAL_MS": BOOK_SNAPSHOT_INTERVAL_MS,
        "PARQUET_ENABLED": PARQUET_ENABLED,
    }
