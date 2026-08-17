'use strict';
// SQLite storage layer. Holds catalog, price history, order book snapshots,
// trading account state, and detected anomalies. The snapshot tables double
// as the dataset the pricing-analysis tooling consumes.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const cfg = require('./config');

fs.mkdirSync(path.dirname(cfg.DB_PATH), { recursive: true });
const db = new DatabaseSync(cfg.DB_PATH);

db.exec(`
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
    anchor REAL DEFAULT 0.5,              -- latent fair value used by engine
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
    source TEXT DEFAULT 'sim',            -- sim | kalshi
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

  CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    ticker TEXT NOT NULL,
    mid REAL, bid REAL, ask REAL, last REAL,
    volume_24h REAL
  );
  CREATE INDEX IF NOT EXISTS idx_snap_t ON snapshots(ticker, ts);

  CREATE TABLE IF NOT EXISTS book_snapshots (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    ticker TEXT NOT NULL,
    bids TEXT, asks TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_book_t ON book_snapshots(ticker, ts);

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

  CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    status TEXT NOT NULL,
    detail TEXT DEFAULT ''
  );
`);

const stmts = {};
function q(sql) {
  if (!stmts[sql]) stmts[sql] = db.prepare(sql);
  return stmts[sql];
}

function ensureAccount(startingBalance) {
  const row = q('SELECT balance FROM account WHERE id = 1').get();
  if (!row) q('INSERT INTO account (id, balance) VALUES (1, ?)').run(startingBalance);
}

module.exports = { db, q, ensureAccount };
