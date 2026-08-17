-- PriceKalshiHistorical schema — superset of the clone's server/db.js
-- Compatible with the Node engine (node:sqlite DatabaseSync) and Python sqlite3
-- All timestamps are ms since epoch unless noted (t_open is ms, close_time is ISO8601)

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS events (
  ticker TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  subtitle TEXT DEFAULT '',
  category TEXT NOT NULL,
  series TEXT DEFAULT '',
  mutually_exclusive INTEGER DEFAULT 0,
  close_time TEXT,
  image_seed TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS markets (
  ticker TEXT PRIMARY KEY,
  event_ticker TEXT NOT NULL,
  title TEXT NOT NULL,
  yes_sub TEXT DEFAULT 'Yes',
  no_sub TEXT DEFAULT 'No',
  status TEXT DEFAULT 'open',           -- open | closed | settled
  result TEXT DEFAULT '',               -- '' | YES | NO
  close_time TEXT,
  tick_size REAL DEFAULT 0.01,
  anchor REAL DEFAULT 0.5,
  liquidity REAL DEFAULT 5000,
  volume REAL DEFAULT 0,
  volume_24h REAL DEFAULT 0,
  open_interest REAL DEFAULT 0,
  last_price REAL DEFAULT 0,
  prev_price REAL DEFAULT 0,
  yes_bid REAL DEFAULT 0,
  yes_ask REAL DEFAULT 0,
  yes_bid_size REAL DEFAULT 0,
  yes_ask_size REAL DEFAULT 0,
  mid REAL DEFAULT 0,
  source TEXT DEFAULT 'sim',            -- sim | kalshi | hybrid
  rules TEXT DEFAULT '',
  updated_at INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_markets_event ON markets(event_ticker);
CREATE INDEX IF NOT EXISTS idx_markets_status ON markets(status);

CREATE TABLE IF NOT EXISTS candles (
  ticker TEXT NOT NULL,
  interval TEXT NOT NULL,               -- 1m | 15m | 1h | 1d
  t_open INTEGER NOT NULL,
  o REAL, h REAL, l REAL, c REAL, v REAL,
  PRIMARY KEY (ticker, interval, t_open)
);
CREATE INDEX IF NOT EXISTS idx_candles_ticker_interval ON candles(ticker, interval, t_open);

CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  mid REAL, bid REAL, ask REAL, last REAL,
  volume_24h REAL
);
CREATE INDEX IF NOT EXISTS idx_snap_t ON snapshots(ticker, ts);
CREATE INDEX IF NOT EXISTS idx_snap_ts ON snapshots(ts);

CREATE TABLE IF NOT EXISTS book_snapshots (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  bids TEXT, asks TEXT                  -- JSON [[price,size],...]
);
CREATE INDEX IF NOT EXISTS idx_book_t ON book_snapshots(ticker, ts);
CREATE INDEX IF NOT EXISTS idx_book_ts ON book_snapshots(ts);

CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,                  -- trade fill time (ms)
  ticker TEXT NOT NULL,
  price REAL NOT NULL,                  -- yes price 0..1
  size REAL NOT NULL,
  side TEXT DEFAULT '',                 -- buy|sell (taker side if known)
  source TEXT DEFAULT 'kalshi',         -- kalshi | sim
  raw TEXT DEFAULT '{}'                 -- full JSON payload for debug
);
CREATE INDEX IF NOT EXISTS idx_trades_ticker_ts ON trades(ticker, ts);
CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  side TEXT NOT NULL,                   -- yes | no
  action TEXT NOT NULL,                 -- buy | sell
  type TEXT NOT NULL,                   -- market | limit
  qty REAL NOT NULL,
  price REAL DEFAULT 0,
  status TEXT DEFAULT 'open',           -- open | filled | partial | cancelled | rejected
  filled_qty REAL DEFAULT 0,
  avg_fill_price REAL DEFAULT 0,
  fees REAL DEFAULT 0,
  note TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS positions (
  ticker TEXT NOT NULL,
  side TEXT NOT NULL,
  qty REAL DEFAULT 0,
  avg_price REAL DEFAULT 0,
  realized_pnl REAL DEFAULT 0,
  PRIMARY KEY (ticker, side)
);

CREATE TABLE IF NOT EXISTS account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  balance REAL NOT NULL,
  total_fees REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS anomalies (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,                   -- mee_sum | mee_arb | wide_spread | fast_move | stale_quote
  scope TEXT NOT NULL,                  -- event or market ticker
  severity REAL DEFAULT 0,
  payload TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_anom_ts ON anomalies(ts);
CREATE INDEX IF NOT EXISTS idx_anom_kind ON anomalies(kind);

CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  status TEXT NOT NULL,                 -- ok | fail | warn | info
  detail TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sync_ts ON sync_log(ts);

-- PriceKalshiHistorical extensions
CREATE TABLE IF NOT EXISTS collector_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS historical_cutoff (
  id INTEGER PRIMARY KEY CHECK (id=1),
  market_settled_ts INTEGER DEFAULT 0,
  trades_created_ts INTEGER DEFAULT 0,
  orders_updated_ts INTEGER DEFAULT 0,
  positions_last_updated_ts INTEGER DEFAULT 0,
  raw TEXT DEFAULT '{}',
  fetched_at INTEGER DEFAULT 0
);
