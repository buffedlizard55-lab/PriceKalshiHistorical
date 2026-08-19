'use strict';
// Upstream live-data adapter. When this server can reach Kalshi's public
// market-data API (api.elections.kalshi.com/trade-api/v2), it mirrors real
// markets and keeps their quotes fresh; the local engine then skips those
// markets and only simulates the rest. When the API is unreachable (e.g.
// this sandboxed preview), the exchange runs fully on the local engine.

const { q } = require('./db');
const cfg = require('./config');
const engine = require('./engine');

const BASE = cfg.KALSHI_API_BASE;
let mode = 'sim'; // sim | live
let consecutiveFailures = 0;
let lastStatus = { ok: false, detail: 'not attempted yet', ts: 0 };

async function fetchJson(pathname, timeoutMs = cfg.SYNC_TIMEOUT_MS) {
  const res = await fetch(BASE + pathname, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function dollars(x) { const v = parseFloat(x); return Number.isFinite(v) ? v : 0; }
function fp(x) { const v = parseFloat(x); return Number.isFinite(v) ? v : 0; }

async function syncOnce() {
  try {
    const data = await fetchJson('/markets?limit=200&status=open');
    const markets = (data.markets || []).filter(m => !m.is_provisional && fp(m.volume_fp) > 0);
    if (!markets.length) throw new Error('no active markets returned');

    // Ensure events exist
    const eventTickers = [...new Set(markets.map(m => m.event_ticker))];
    let eventMeta = new Map();
    try {
      // batch fetch event metadata (best effort); documented filter param is `tickers`
      for (let i = 0; i < eventTickers.length; i += 50) {
        const slice = eventTickers.slice(i, i + 50).join(',');
        const ev = await fetchJson(`/events?tickers=${encodeURIComponent(slice)}&limit=50`);
        for (const e of ev.events || []) eventMeta.set(e.event_ticker, e);
      }
    } catch (e) { /* events metadata is optional */ }

    const upEvent = q(`INSERT INTO events (ticker,title,subtitle,category,series,mutually_exclusive,close_time,image_seed)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(ticker) DO UPDATE SET title=excluded.title, subtitle=excluded.subtitle,
        category=excluded.category, mutually_exclusive=excluded.mutually_exclusive`);
    const upMarket = q(`INSERT INTO markets (ticker,event_ticker,title,yes_sub,no_sub,status,close_time,
        last_price,yes_bid,yes_ask,yes_bid_size,yes_ask_size,mid,volume,volume_24h,open_interest,prev_price,source,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(ticker) DO UPDATE SET
        last_price=excluded.last_price, yes_bid=excluded.yes_bid, yes_ask=excluded.yes_ask,
        yes_bid_size=excluded.yes_bid_size, yes_ask_size=excluded.yes_ask_size, mid=excluded.mid,
        volume=excluded.volume, volume_24h=excluded.volume_24h, open_interest=excluded.open_interest,
        prev_price=excluded.prev_price, source='kalshi', status=excluded.status, updated_at=excluded.updated_at`);

    for (const m of markets) {
      const e = eventMeta.get(m.event_ticker);
      upEvent.run(
        m.event_ticker,
        e ? e.title : m.event_ticker,
        e ? (e.sub_title || '') : '',
        e ? (e.category || 'Other') : 'Other',
        e ? (e.series_ticker || '') : '',
        e && e.mutually_exclusive ? 1 : 0,
        m.close_time || '',
        m.event_ticker.toLowerCase(),
      );
      const yesBid = dollars(m.yes_bid_dollars);
      const yesAsk = dollars(m.yes_ask_dollars);
      const last = dollars(m.last_price_dollars);
      const mid = yesBid && yesAsk ? (yesBid + yesAsk) / 2 : last;
      upMarket.run(
        m.ticker, m.event_ticker, m.title || m.ticker,
        m.yes_sub_title || 'Yes', m.no_sub_title || 'No', 'open', m.close_time || '',
        last, yesBid, yesAsk, fp(m.yes_bid_size_fp), fp(m.yes_ask_size_fp), mid,
        fp(m.volume_fp), fp(m.volume_24h_fp), fp(m.open_interest_fp), last, 'kalshi', Date.now(),
      );
    }

    mode = 'live';
    consecutiveFailures = 0;
    lastStatus = { ok: true, detail: `synced ${markets.length} live markets`, ts: Date.now() };
    logSync('ok', lastStatus.detail);
    return true;
  } catch (err) {
    mode = consecutiveFailures === 0 && lastStatus.ok ? 'live' : mode;
    consecutiveFailures++;
    lastStatus = { ok: false, detail: String(err && err.message || err).slice(0, 200), ts: Date.now() };
    if (consecutiveFailures === 1 || consecutiveFailures % 20 === 0) {
      logSync('fail', `${lastStatus.detail} (running on local engine)`);
    }
    return false;
  }
}

function logSync(status, detail) {
  try { q('INSERT INTO sync_log (ts,status,detail) VALUES (?,?,?)').run(Date.now(), status, detail); } catch {}
}

function start() {
  const loop = async () => {
    await syncOnce();
    setTimeout(loop, cfg.SYNC_INTERVAL_MS);
  };
  loop();
}

function status() {
  return { mode: lastStatus.ok ? 'live' : mode, upstream: BASE, ...lastStatus };
}

module.exports = { start, status, syncOnce };
