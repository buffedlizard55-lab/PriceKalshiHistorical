'use strict';
// Pricing analytics: continuously scans for irregularities that a companion
// analysis tool can consume — mutually-exclusive sum drift, basket
// arbitrage bounds, wide spreads, and fast moves. Findings are persisted in
// the anomalies table and exposed via the REST API.

const { q } = require('./db');
const engine = require('./engine');

const SCAN_INTERVAL_MS = 8000;
const MEE_SUM_FLAG = 0.025;      // |sum(mids) - 1| beyond this flags drift
const MEE_ARB_ASK = 0.99;        // sum(best asks) below this => buy-the-basket arb
const MEE_ARB_BID = 1.01;        // sum(best bids) above this => sell-the-basket arb
const WIDE_SPREAD_TICKS = 4;
const FAST_MOVE_THRESHOLD = 0.05;

let lastMids = new Map(); // ticker -> {mid, ts}

function scan() {
  const nowTs = Date.now();
  const findings = [];

  const openMarkets = q("SELECT * FROM markets WHERE status = 'open'").all();
  const byTicker = new Map(openMarkets.map(m => [m.ticker, m]));

  // --- MEE structure checks ---
  const meeEvents = q('SELECT * FROM events WHERE mutually_exclusive = 1').all();
  for (const ev of meeEvents) {
    const mkts = openMarkets.filter(m => m.event_ticker === ev.ticker);
    if (mkts.length < 2) continue;
    const sumMid = mkts.reduce((s, m) => s + (m.mid || 0), 0);
    const sumAsk = mkts.reduce((s, m) => s + (m.yes_ask > 0 ? m.yes_ask : 1), 0);
    const sumBid = mkts.reduce((s, m) => s + (m.yes_bid > 0 ? m.yes_bid : 0), 0);
    const dev = sumMid - 1;

    if (Math.abs(dev) >= MEE_SUM_FLAG) {
      findings.push({
        kind: 'mee_sum', scope: ev.ticker, severity: Math.abs(dev),
        payload: { title: ev.title, markets: mkts.length, sumMid: r4(sumMid), deviation: r4(dev) },
      });
    }
    if (sumAsk < MEE_ARB_ASK) {
      findings.push({
        kind: 'mee_arb', scope: ev.ticker, severity: 1 - sumAsk,
        payload: { title: ev.title, direction: 'buy_all_yes', sumAsk: r4(sumAsk), edge: r4(1 - sumAsk) },
      });
    }
    if (sumBid > MEE_ARB_BID) {
      findings.push({
        kind: 'mee_arb', scope: ev.ticker, severity: sumBid - 1,
        payload: { title: ev.title, direction: 'sell_all_yes', sumBid: r4(sumBid), edge: r4(sumBid - 1) },
      });
    }
  }

  // --- per-market microstructure checks ---
  for (const m of openMarkets) {
    if (m.yes_bid > 0 && m.yes_ask > 0) {
      const spreadTicks = Math.round((m.yes_ask - m.yes_bid) / 0.01);
      if (spreadTicks >= WIDE_SPREAD_TICKS && m.volume_24h > 500) {
        findings.push({
          kind: 'wide_spread', scope: m.ticker, severity: spreadTicks,
          payload: { title: m.title, bid: m.yes_bid, ask: m.yes_ask, spreadTicks, volume24h: m.volume_24h },
        });
      }
    }
    const prev = lastMids.get(m.ticker);
    if (prev && nowTs - prev.ts <= 10 * 60000) {
      const move = Math.abs((m.mid || 0) - prev.mid);
      if (move >= FAST_MOVE_THRESHOLD) {
        findings.push({
          kind: 'fast_move', scope: m.ticker, severity: move,
          payload: { title: m.title, from: r4(prev.mid), to: r4(m.mid), move: r4(m.mid - prev.mid), windowSec: Math.round((nowTs - prev.ts) / 1000) },
        });
      }
    }
  }

  // refresh rolling mid memory (keep the first observation inside the window)
  for (const m of openMarkets) {
    const prev = lastMids.get(m.ticker);
    if (!prev || nowTs - prev.ts > 5 * 60000) lastMids.set(m.ticker, { mid: m.mid, ts: nowTs });
  }

  if (findings.length) {
    const ins = q('INSERT INTO anomalies (ts,kind,scope,severity,payload) VALUES (?,?,?,?,?)');
    for (const f of findings) ins.run(nowTs, f.kind, f.scope, f.severity, JSON.stringify(f.payload));
    q('DELETE FROM anomalies WHERE ts < ?').run(nowTs - 7 * 86400000);
  }
  return findings;
}

function latestAnomalies(limit = 100) {
  return q('SELECT * FROM anomalies ORDER BY ts DESC LIMIT ?').all(limit).map(a => ({
    id: a.id, ts: a.ts, kind: a.kind, scope: a.scope, severity: a.severity,
    payload: safeJson(a.payload),
  }));
}

function meeSummary() {
  const out = [];
  const meeEvents = q('SELECT * FROM events WHERE mutually_exclusive = 1').all();
  const openMarkets = q("SELECT * FROM markets WHERE status = 'open'").all();
  for (const ev of meeEvents) {
    const mkts = openMarkets.filter(m => m.event_ticker === ev.ticker);
    if (mkts.length < 2) continue;
    const sumMid = mkts.reduce((s, m) => s + (m.mid || 0), 0);
    const sumAsk = mkts.reduce((s, m) => s + (m.yes_ask > 0 ? m.yes_ask : 1), 0);
    const sumBid = mkts.reduce((s, m) => s + (m.yes_bid > 0 ? m.yes_bid : 0), 0);
    out.push({
      event: ev.ticker, title: ev.title, markets: mkts.length,
      sumMid: r4(sumMid), sumAsk: r4(sumAsk), sumBid: r4(sumBid),
      deviation: r4(sumMid - 1),
    });
  }
  return out.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation));
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function r4(x) { return Math.round(x * 10000) / 10000; }

function start() {
  // prime the mid memory so fast_move needs two observations
  for (const m of q("SELECT ticker, mid FROM markets WHERE status='open'").all()) {
    lastMids.set(m.ticker, { mid: m.mid, ts: Date.now() });
  }
  setInterval(scan, SCAN_INTERVAL_MS);
  setTimeout(scan, 4000);
}

module.exports = { start, scan, latestAnomalies, meeSummary };
