'use strict';
// Zero-dependency HTTP server: static frontend + REST API.

const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const { q } = require('./db');
const engine = require('./engine');
const trading = require('./trading');
const analysis = require('./analysis');
const kalshiSync = require('./kalshiSync');

const PUBLIC_DIR = path.join(__dirname, '..', 'docs');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

trading.init();
engine.start();
analysis.start();
kalshiSync.start();
setInterval(trading.matchRestingOrders, 1500);

// ---------- helpers ----------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function marketView(r) {
  return {
    ticker: r.ticker, eventTicker: r.event_ticker, title: r.title,
    yesSub: r.yes_sub, noSub: r.no_sub, status: r.status, result: r.result,
    closeTime: r.close_time, last: r.last_price, prev: r.prev_price,
    yesBid: r.yes_bid, yesAsk: r.yes_ask, yesBidSize: r.yes_bid_size, yesAskSize: r.yes_ask_size,
    mid: r.mid, volume: r.volume, volume24h: r.volume_24h, openInterest: r.open_interest,
    liquidity: r.liquidity, source: r.source, rules: r.rules,
  };
}
function eventView(ev, mkts) {
  const open = mkts.filter(m => m.status === 'open');
  const vol24 = mkts.reduce((s, m) => s + (m.volume_24h || 0), 0);
  const vol = mkts.reduce((s, m) => s + (m.volume || 0), 0);
  const top = open.slice().sort((a, b) => (b.volume_24h || 0) - (a.volume_24h || 0)).slice(0, 4);
  return {
    ticker: ev.ticker, title: ev.title, subtitle: ev.subtitle, category: ev.category,
    series: ev.series, mutuallyExclusive: !!ev.mutually_exclusive, closeTime: ev.close_time,
    volume: Math.round(vol), volume24h: Math.round(vol24),
    marketCount: mkts.length, openCount: open.length,
    topMarkets: top.map(marketView),
  };
}

// ---------- API routes ----------
async function api(req, res, url) {
  const p = url.pathname;

  if (p === '/api/health') {
    return send(res, 200, {
      ok: true, mode: kalshiSync.status().mode, sync: kalshiSync.status(),
      uptimeSec: Math.round(process.uptime()),
      counts: {
        events: q('SELECT COUNT(*) c FROM events').get().c,
        markets: q('SELECT COUNT(*) c FROM markets').get().c,
        openMarkets: q("SELECT COUNT(*) c FROM markets WHERE status='open'").get().c,
      },
    });
  }

  if (p === '/api/meta') {
    const cats = q('SELECT category, COUNT(*) c FROM events GROUP BY category ORDER BY c DESC').all();
    return send(res, 200, {
      categories: cats.map(c => c.category),
      exchange: { name: 'Kalshi Clone', currency: 'USD', startingBalance: cfg.STARTING_BALANCE, feeRate: 0.07 },
      sync: kalshiSync.status(),
    });
  }

  if (p === '/api/events') {
    const category = url.searchParams.get('category');
    let evs = q('SELECT * FROM events ORDER BY ticker').all();
    if (category && category !== 'All') evs = evs.filter(e => e.category === category);
    const mkts = q('SELECT * FROM markets').all();
    const byEvent = new Map();
    for (const m of mkts) {
      if (!byEvent.has(m.event_ticker)) byEvent.set(m.event_ticker, []);
      byEvent.get(m.event_ticker).push(m);
    }
    const out = evs.map(e => eventView(e, byEvent.get(e.ticker) || []));
    out.sort((a, b) => b.volume24h - a.volume24h);
    return send(res, 200, { events: out });
  }

  if (p.startsWith('/api/event/')) {
    const ticker = decodeURIComponent(p.slice('/api/event/'.length));
    const ev = q('SELECT * FROM events WHERE ticker = ?').get(ticker);
    if (!ev) return send(res, 404, { error: 'Event not found' });
    const mkts = q('SELECT * FROM markets WHERE event_ticker = ?').all(ticker);
    mkts.sort((a, b) => (b.mid || 0) - (a.mid || 0));
    return send(res, 200, { event: eventView(ev, mkts), markets: mkts.map(marketView) });
  }

  if (p === '/api/markets') {
    const search = (url.searchParams.get('q') || '').toLowerCase();
    const category = url.searchParams.get('category');
    let mkts = q('SELECT * FROM markets ORDER BY volume_24h DESC LIMIT 500').all();
    if (category && category !== 'All') {
      const evSet = new Set(q('SELECT ticker FROM events WHERE category = ?').all(category).map(e => e.ticker));
      mkts = mkts.filter(m => evSet.has(m.event_ticker));
    }
    if (search) mkts = mkts.filter(m => m.title.toLowerCase().includes(search) || m.ticker.toLowerCase().includes(search));
    return send(res, 200, { markets: mkts.map(marketView) });
  }

  if (p.startsWith('/api/market/')) {
    const rest = p.slice('/api/market/'.length);
    const parts = rest.split('/').map(decodeURIComponent);
    const ticker = parts[0];
    const mkt = q('SELECT * FROM markets WHERE ticker = ?').get(ticker);
    if (!mkt) return send(res, 404, { error: 'Market not found' });
    const ev = q('SELECT * FROM events WHERE ticker = ?').get(mkt.event_ticker);

    if (parts[1] === 'book') {
      let book = engine.getBook(ticker);
      if (mkt.source === 'kalshi' && (!book || (!book.bids.length && !book.asks.length))) {
        // synthesize a minimal book around upstream quotes
        const bids = mkt.yes_bid > 0 ? [[mkt.yes_bid, mkt.yes_bid_size || 100]] : [];
        const asks = mkt.yes_ask > 0 ? [[mkt.yes_ask, mkt.yes_ask_size || 100]] : [];
        book = { bids, asks };
      }
      return send(res, 200, { ticker, ...book });
    }
    if (parts[1] === 'candles') {
      const interval = url.searchParams.get('interval') || '1h';
      const limit = Math.min(500, parseInt(url.searchParams.get('limit') || '180', 10));
      let rows;
      if (interval === '1m' || interval === '1h') {
        rows = q('SELECT * FROM candles WHERE ticker = ? AND interval = ? ORDER BY t_open DESC LIMIT ?')
          .all(ticker, interval, limit).reverse();
      } else if (interval === '15m') {
        rows = aggregate(q('SELECT * FROM candles WHERE ticker = ? AND interval = ? ORDER BY t_open DESC LIMIT ?')
          .all(ticker, '1m', limit * 15).reverse(), 15 * 60000);
      } else if (interval === '1d') {
        rows = aggregate(q('SELECT * FROM candles WHERE ticker = ? AND interval = ? ORDER BY t_open DESC LIMIT ?')
          .all(ticker, '1h', limit * 24).reverse(), 86400000);
      } else rows = [];
      return send(res, 200, { ticker, interval, candles: rows });
    }
    if (parts[1] === 'trades') {
      return send(res, 200, { ticker, trades: engine.getTape(ticker) });
    }
    // market detail
    const siblings = q('SELECT * FROM markets WHERE event_ticker = ? AND ticker != ? ORDER BY mid DESC')
      .all(mkt.event_ticker, ticker);
    return send(res, 200, { market: marketView(mkt), event: ev ? eventView(ev, [mkt, ...siblings]) : null, siblings: siblings.map(marketView) });
  }

  if (p === '/api/portfolio') {
    return send(res, 200, { ...trading.portfolioSummary(), orders: trading.orderList() });
  }

  if (p === '/api/order' && req.method === 'POST') {
    const body = await readBody(req);
    const result = trading.placeOrder(body);
    return send(res, result.error ? 400 : 200, result);
  }

  if (p.startsWith('/api/order/') && p.endsWith('/cancel') && req.method === 'POST') {
    const id = parseInt(p.split('/')[3], 10);
    const result = trading.cancelOrder(id);
    return send(res, result.error ? 400 : 200, result);
  }

  if (p === '/api/analysis/anomalies') {
    const kind = url.searchParams.get('kind');
    let rows = analysis.latestAnomalies(200);
    if (kind) rows = rows.filter(r => r.kind === kind);
    return send(res, 200, { anomalies: rows });
  }
  if (p === '/api/analysis/mee') {
    return send(res, 200, { events: analysis.meeSummary() });
  }

  if (p === '/api/sync/log') {
    return send(res, 200, { log: q('SELECT * FROM sync_log ORDER BY ts DESC LIMIT 50').all() });
  }

  return send(res, 404, { error: 'Not found' });
}

function aggregate(rows, bucketMs) {
  const out = [];
  let cur = null;
  for (const r of rows) {
    const b = Math.floor(r.t_open / bucketMs) * bucketMs;
    if (!cur || cur.t_open !== b) {
      if (cur) out.push(cur);
      cur = { t_open: b, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v };
    } else {
      cur.h = Math.max(cur.h, r.h); cur.l = Math.min(cur.l, r.l); cur.c = r.c; cur.v += r.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ---------- static ----------
function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    try { send(res, 500, { error: String(err && err.message || err) }); } catch {}
  }
});

server.listen(cfg.PORT, cfg.HOST, () => {
  console.log(`exchange running on http://${cfg.HOST}:${cfg.PORT}`);
});
