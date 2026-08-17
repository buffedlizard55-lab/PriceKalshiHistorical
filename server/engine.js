'use strict';
// Live market engine. Maintains a latent fair value per market that
// mean-reverts with noise and occasional jumps, builds a realistic L2 order
// book around it, generates organic trading flow, aggregates candles, and
// settles markets at close time. Markets sourced from the upstream exchange
// adapter are passed through untouched.

const { q } = require('./db');
const { events: CATALOG } = require('./catalog');

const TICK_MS = 1000;
const SNAPSHOT_EVERY_MS = 5000;
const BOOK_SNAPSHOT_EVERY_MS = 15000;

// deterministic RNG (mulberry32)
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function gauss(rng) {
  const u = Math.max(rng(), 1e-9), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const state = {
  markets: new Map(),     // ticker -> runtime market object
  books: new Map(),       // ticker -> { bids:[[p,s],...], asks:[[p,s],...] }
  tapes: new Map(),       // ticker -> recent trades
  listeners: new Set(),   // change subscribers (for future push use)
  version: 0,
  startedAt: Date.now(),
  mode: 'sim',            // sim | live (live when upstream sync is active)
};

function roundTick(p, tick = 0.01) { return Math.round(p / tick) * tick; }
function clamp(p, lo = 0.005, hi = 0.995) { return Math.min(hi, Math.max(lo, p)); }

// ---------------- seeding ----------------
function seedCatalog() {
  for (const ev of CATALOG) {
    q(`INSERT OR REPLACE INTO events (ticker, title, subtitle, category, series, mutually_exclusive, close_time, image_seed)
       VALUES (?,?,?,?,?,?,?,?)`)
      .run(ev.ticker, ev.title, ev.subtitle || '', ev.category, ev.series || '', ev.mee ? 1 : 0, ev.closeTime, ev.ticker.toLowerCase());
    for (const mk of ev.markets) {
      q(`INSERT OR REPLACE INTO markets
        (ticker, event_ticker, title, yes_sub, no_sub, status, close_time, anchor, liquidity,
         volume, volume_24h, open_interest, last_price, prev_price, mid, source, rules)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(mk.ticker, ev.ticker, mk.title, mk.yesSub, mk.noSub, 'open', mk.closeTime,
          mk.anchor, mk.liquidity, mk.volume, mk.volume24h, mk.openInterest,
          mk.anchor, mk.anchor, mk.anchor, 'sim', mk.rules);
      state.markets.set(mk.ticker, {
        ticker: mk.ticker, event: ev.ticker, p: mk.anchor, anchor: mk.anchor,
        liquidity: mk.liquidity, mee: ev.mee, closeTs: new Date(mk.closeTime).getTime(),
        rng: mulberry32(hashSeed(mk.ticker)), lastTradeTs: 0, lastDir: 0,
      });
      seedHistory(mk.ticker, mk.anchor, mk.volume24h, hashSeed(mk.ticker));
    }
  }
}

// Generate plausible history: hourly candles back 60 days and 1m candles for
// the trailing 12h, derived from a backwards random walk ending at anchor.
function seedHistory(ticker, anchor, vol24h, seed) {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const nowMin = Math.floor(Date.now() / 60000) * 60000;

  // backwards hourly walk for 60 days
  const hours = 60 * 24;
  let p = anchor;
  const hourClose = new Array(hours);
  for (let i = hours - 1; i >= 0; i--) {
    hourClose[i] = p;
    const vol = 0.004 + 0.02 * p * (1 - p);
    p = clamp(p - gauss(rng) * vol + (0.5 - p) * 0.002, 0.01, 0.99);
  }
  const hourStart = Math.floor(nowMin / 3600000) * 3600000 - (hours - 1) * 3600000;
  const insH = q('INSERT OR REPLACE INTO candles (ticker,interval,t_open,o,h,l,c,v) VALUES (?,?,?,?,?,?,?,?)');
  for (let i = 0; i < hours; i++) {
    const c = hourClose[i];
    const o = i === 0 ? c : hourClose[i - 1];
    const w = 0.003 + 0.012 * rng();
    const h = clamp(Math.max(o, c) + w * rng(), 0.01, 0.99);
    const l = clamp(Math.min(o, c) - w * rng(), 0.01, 0.99);
    const v = Math.max(1, Math.round((vol24h / 24) * (0.3 + rng() * 1.4)));
    insH.run(ticker, '1h', hourStart + i * 3600000, round2(o), round2(h), round2(l), round2(c), v);
  }

  // 1-minute bars for trailing 12 hours ending at anchor
  const mins = 12 * 60;
  p = anchor;
  const minClose = new Array(mins);
  for (let i = mins - 1; i >= 0; i--) {
    minClose[i] = p;
    const vol = 0.0008 + 0.004 * p * (1 - p);
    p = clamp(p - gauss(rng) * vol + (anchor - p) * 0.004, 0.01, 0.99);
  }
  const minStart = nowMin - (mins - 1) * 60000;
  const insM = q('INSERT OR REPLACE INTO candles (ticker,interval,t_open,o,h,l,c,v) VALUES (?,?,?,?,?,?,?,?)');
  for (let i = 0; i < mins; i++) {
    const c = minClose[i];
    const o = i === 0 ? c : minClose[i - 1];
    const w = 0.0006 + 0.003 * rng();
    const h = clamp(Math.max(o, c) + w * rng(), 0.01, 0.99);
    const l = clamp(Math.min(o, c) - w * rng(), 0.01, 0.99);
    const v = Math.max(0, Math.round((vol24h / 720) * (0.2 + rng() * 2.2)));
    insM.run(ticker, '1m', minStart + i * 60000, round2(o), round2(h), round2(l), round2(c), v);
  }
}
function round2(x) { return Math.round(x * 10000) / 10000; }

// ---------------- order book ----------------
function buildBook(rt) {
  const mkt = q('SELECT * FROM markets WHERE ticker = ?').get(rt.ticker);
  if (!mkt || mkt.source === 'kalshi') return; // upstream-sourced books come from sync
  const mid = mkt.mid;
  const liquid = rt.liquidity;
  const rng = rt.rng;
  const tight = liquid > 15000 ? 0.01 : liquid > 6000 ? 0.01 : 0.02;
  const spread = mid <= 0.03 || mid >= 0.97 ? 0.01 : tight;
  const bestBid = clamp(roundTick(mid - spread / 2), 0.01, 0.98);
  const bestAsk = clamp(Math.max(bestBid + 0.01, roundTick(mid + spread / 2)), 0.02, 0.99);

  const bids = [];
  const asks = [];
  const levels = 7;
  for (let i = 0; i < levels; i++) {
    const bp = roundTick(bestBid - i * 0.01);
    if (bp <= 0.001) break;
    const size = sizeAt(liquid, i, rng);
    bids.push([round2(bp), Math.round(size * 100) / 100]);
    const ap = roundTick(bestAsk + i * 0.01);
    if (ap >= 0.999) break;
    asks.push([round2(ap), Math.round(sizeAt(liquid, i, rng) * 100) / 100]);
  }
  state.books.set(rt.ticker, { bids, asks, ts: Date.now() });
}
function sizeAt(liquidity, level, rng) {
  const base = liquidity / 25;
  const decay = 1 / (1 + level * 0.7);
  return Math.max(5, base * decay * (0.4 + rng() * 1.6));
}

// ---------------- engine tick ----------------
function tick() {
  const nowTs = Date.now();
  const updMarket = q(`UPDATE markets SET last_price=?, prev_price=?, yes_bid=?, yes_ask=?,
      yes_bid_size=?, yes_ask_size=?, mid=?, volume=?, volume_24h=?, open_interest=?, updated_at=?
      WHERE ticker=?`);

  for (const rt of state.markets.values()) {
    const mkt = q('SELECT * FROM markets WHERE ticker = ?').get(rt.ticker);
    if (!mkt || mkt.status !== 'open') continue;
    if (mkt.source === 'kalshi') continue; // upstream adapter owns price updates

    // latent price process: mean reversion + diffusion + occasional jumps
    const rng = rt.rng;
    const pNow = rt.p;
    const volBase = 0.0016 + 0.006 * pNow * (1 - pNow);
    const timeToClose = rt.closeTs - nowTs;
    const urgency = timeToClose < 2 * 86400000 ? 1.8 : 1; // more action near close
    let dp = (rt.anchor - pNow) * 0.006 + gauss(rng) * volBase * urgency;
    if (rng() < 0.004) dp += (rng() - 0.5) * (0.04 + 0.10 * rng()); // news jump
    rt.p = clamp(pNow + dp, 0.01, 0.99);

    const mid = roundTick(rt.p);
    buildBook(rt);
    const book = state.books.get(rt.ticker);
    const bestBid = book ? book.bids[0] : [mid - 0.01, 0];
    const bestAsk = book ? book.asks[0] : [mid + 0.01, 0];

    // organic flow: marketable orders hitting the book
    let last = mkt.last_price, vol = mkt.volume, v24 = mkt.volume_24h, oi = mkt.open_interest;
    const lambda = Math.min(0.55, (rt.liquidity / 40000) * 0.5 + 0.02) * urgency;
    if (rng() < lambda && book) {
      const buySide = rng() < 0.5 + (rt.p - mkt.last_price) * 2;
      const levels = buySide ? book.asks : book.bids;
      let remaining = Math.max(10, lognormalSize(rng, rt.liquidity));
      let filled = 0, cost = 0;
      for (const [price, size] of levels) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, size);
        filled += take; cost += take * price; remaining -= take;
      }
      if (filled > 0) {
        last = round2(cost / filled);
        vol += filled; v24 += filled;
        oi += buySide ? filled * (rng() < 0.7 ? 1 : -0.4) : filled * (rng() < 0.7 ? 1 : -0.4);
        oi = Math.max(0, oi);
        rt.lastTradeTs = nowTs; rt.lastDir = buySide ? 1 : -1;
        pushTrade(rt.ticker, { ts: nowTs, side: buySide ? 'buy' : 'sell', price: last, size: Math.round(filled) });
        bumpCandle(rt.ticker, last, filled);
      }
    }

    updMarket.run(last, mkt.last_price, bestBid[0], bestAsk[0], bestBid[1], bestAsk[1],
      mid, Math.round(vol), Math.round(v24), Math.round(oi), nowTs, rt.ticker);
    state.version++;
  }

  settleDueMarkets();
  snapshotsMaybe(nowTs);
}

function lognormalSize(rng, liquidity) {
  const mu = Math.log(Math.max(20, liquidity / 120));
  return Math.exp(mu + gauss(rng) * 0.9);
}

const candleMinute = new Map(); // ticker -> current 1m bar
function bumpCandle(ticker, price, vol) {
  const minute = Math.floor(Date.now() / 60000) * 60000;
  let bar = candleMinute.get(ticker);
  if (!bar || bar.t !== minute) {
    if (bar) commitCandle(ticker, bar);
    bar = { t: minute, o: price, h: price, l: price, c: price, v: 0 };
    candleMinute.set(ticker, bar);
  }
  bar.h = Math.max(bar.h, price); bar.l = Math.min(bar.l, price);
  bar.c = price; bar.v += vol;
}
function commitCandle(ticker, bar) {
  q('INSERT OR REPLACE INTO candles (ticker,interval,t_open,o,h,l,c,v) VALUES (?,?,?,?,?,?,?,?)')
    .run(ticker, '1m', bar.t, bar.o, bar.h, bar.l, bar.c, Math.round(bar.v));
}
setInterval(() => {
  const minute = Math.floor(Date.now() / 60000) * 60000;
  for (const [ticker, bar] of candleMinute) {
    if (bar.t < minute) { commitCandle(ticker, bar); candleMinute.delete(ticker); }
  }
}, 15000);

function pushTrade(ticker, trade) {
  let tape = state.tapes.get(ticker);
  if (!tape) { tape = []; state.tapes.set(ticker, tape); }
  tape.unshift(trade);
  if (tape.length > 80) tape.pop();
}

// ---------------- snapshots (dataset for analytics) ----------------
let lastSnap = 0, lastBookSnap = 0;
function snapshotsMaybe(nowTs) {
  if (nowTs - lastSnap >= SNAPSHOT_EVERY_MS) {
    lastSnap = nowTs;
    const ins = q('INSERT INTO snapshots (ts,ticker,mid,bid,ask,last,volume_24h) VALUES (?,?,?,?,?,?,?)');
    const rows = q('SELECT ticker, mid, yes_bid, yes_ask, last_price, volume_24h FROM markets WHERE status = ?').all('open');
    for (const r of rows) ins.run(nowTs, r.ticker, r.mid, r.yes_bid, r.yes_ask, r.last_price, r.volume_24h);
    if (rows.length) q('DELETE FROM snapshots WHERE ts < ?').run(nowTs - 3 * 86400000);
  }
  if (nowTs - lastBookSnap >= BOOK_SNAPSHOT_EVERY_MS) {
    lastBookSnap = nowTs;
    const ins = q('INSERT INTO book_snapshots (ts,ticker,bids,asks) VALUES (?,?,?,?)');
    for (const [ticker, book] of state.books) {
      ins.run(nowTs, ticker, JSON.stringify(book.bids), JSON.stringify(book.asks));
    }
    q('DELETE FROM book_snapshots WHERE ts < ?').run(nowTs - 86400000);
  }
}

// ---------------- settlement ----------------
function settleDueMarkets() {
  const nowTs = Date.now();
  const due = q('SELECT * FROM markets WHERE status = ? AND close_time <= ?').all('open', new Date(nowTs).toISOString());
  for (const mkt of due) {
    const rt = state.markets.get(mkt.ticker);
    const pYes = rt ? rt.p : mkt.mid;
    const resultYes = Math.random() < pYes;
    q(`UPDATE markets SET status='settled', result=?, yes_bid=?, yes_ask=?, yes_bid_size=0, yes_ask_size=0,
       last_price=?, mid=?, close_time=? WHERE ticker=?`)
      .run(resultYes ? 'YES' : 'NO', resultYes ? 1 : 0, resultYes ? 1 : 0,
        resultYes ? 1 : 0, resultYes ? 1 : 0, mkt.close_time, mkt.ticker);
    // notify trading layer to settle positions
    try { require('./trading').onSettlement(mkt.ticker, resultYes); } catch (e) { /* noop */ }
  }
}

// ---------------- public api ----------------
function start() {
  seedCatalog();
  // initial books + candles commit
  for (const rt of state.markets.values()) buildBook(rt);
  setInterval(tick, TICK_MS);
  tick();
}

function getBook(ticker) { return state.books.get(ticker) || { bids: [], asks: [] }; }
function getTape(ticker) { return state.tapes.get(ticker) || []; }
function getState() { return state; }

// External writers (kalshi sync) can override quotes for upstream markets.
function upsertKalshiQuotes(rows) {
  const upd = q(`UPDATE markets SET last_price=?, yes_bid=?, yes_ask=?, yes_bid_size=?, yes_ask_size=?,
    mid=?, volume=?, volume_24h=?, open_interest=?, prev_price=?, updated_at=? WHERE ticker=?`);
  for (const r of rows) {
    upd.run(r.last, r.bid, r.ask, r.bidSize, r.askSize, r.mid, r.volume, r.volume24h, r.oi, r.prev, Date.now(), r.ticker);
    state.version++;
  }
}

module.exports = { start, getBook, getTape, getState, upsertKalshiQuotes, seedCatalog, bumpCandle };
