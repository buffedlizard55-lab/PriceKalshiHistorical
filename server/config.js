'use strict';
const path = require('path');

module.exports = {
  PORT: parseInt(process.env.PORT || '8080', 10),
  HOST: process.env.HOST || '0.0.0.0',

  // Upstream: the real Kalshi public market-data API. When reachable, the
  // sync engine keeps this exchange mirror up to date with live data.
  KALSHI_API_BASE: process.env.KALSHI_API_BASE || 'https://api.elections.kalshi.com/trade-api/v2',
  SYNC_INTERVAL_MS: parseInt(process.env.SYNC_INTERVAL_MS || '15000', 10),
  SYNC_TIMEOUT_MS: parseInt(process.env.SYNC_TIMEOUT_MS || '8000', 10),

  // Paper-trading account given to every visitor.
  STARTING_BALANCE: parseFloat(process.env.STARTING_BALANCE || '10000'),

  DB_PATH: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'exchange.db'),

  // Where the frontend polls for updates.
  CLIENT_POLL_MS: 4000,
};
