'use strict';
// Local API shim: implements the same REST surface as the Node server,
// backed entirely by the in-browser Exchange engine. Used when no backend
// is available (e.g. GitHub Pages static hosting).

window.LocalAPI = (function () {
  const r2 = x => Math.round((x ?? 0) * 100) / 100;

  function marketView(m) {
    return {
      ticker: m.ticker, eventTicker: m.eventTicker, title: m.title,
      yesSub: m.yesSub, noSub: m.noSub, status: m.status, result: m.result,
      closeTime: m.closeTime, last: m.last, prev: m.prev,
      yesBid: m.yesBid, yesAsk: m.yesAsk, yesBidSize: m.yesBidSize, yesAskSize: m.yesAskSize,
      mid: m.mid, volume: Math.round(m.volume), volume24h: Math.round(m.volume24h),
      openInterest: Math.round(m.openInterest), liquidity: m.liquidity,
      source: m.source, rules: m.rules,
    };
  }

  function eventView(ev) {
    const mkts = ev.markets.map(t => Exchange.markets.get(t)).filter(Boolean);
    const open = mkts.filter(m => m.status === 'open');
    const vol24 = mkts.reduce((s, m) => s + (m.volume24h || 0), 0);
    const vol = mkts.reduce((s, m) => s + (m.volume || 0), 0);
    const top = open.slice().sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0)).slice(0, 4);
    return {
      ticker: ev.ticker, title: ev.title, subtitle: ev.subtitle || '', category: ev.category,
      series: ev.series || '', mutuallyExclusive: !!ev.mee, closeTime: ev.closeTime,
      volume: Math.round(vol), volume24h: Math.round(vol24),
      marketCount: mkts.length, openCount: open.length,
      topMarkets: top.map(marketView),
    };
  }

  function handle(path, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const url = new URL(path, 'http://local');
    const p = url.pathname;
    const q = url.searchParams;

    if (p === '/api/health') {
      return ok({
        ok: true, mode: 'sim',
        sync: { mode: 'sim', upstream: 'in-browser engine', ok: false, detail: 'static build — no upstream', ts: Date.now() },
        uptimeSec: Math.round((Date.now() - Exchange.startedAt) / 1000),
        counts: Exchange.counts(),
      });
    }

    if (p === '/api/meta') {
      return ok({
        categories: Exchange.categories(),
        exchange: { name: 'Kalshi Clone', currency: 'USD', startingBalance: 10000, feeRate: 0.07 },
        sync: { mode: 'sim', upstream: 'in-browser engine', ok: false, detail: 'static build', ts: Date.now() },
      });
    }

    if (p === '/api/events') {
      const category = q.get('category');
      let evs = [...Exchange.events.values()];
      if (category && category !== 'All') evs = evs.filter(e => e.category === category);
      const out = evs.map(eventView).sort((a, b) => b.volume24h - a.volume24h);
      return ok({ events: out });
    }

    if (p.startsWith('/api/event/')) {
      const ticker = decodeURIComponent(p.slice('/api/event/'.length));
      const ev = Exchange.events.get(ticker);
      if (!ev) return err('Event not found');
      const mkts = ev.markets.map(t => Exchange.markets.get(t)).filter(Boolean)
        .sort((a, b) => (b.mid || 0) - (a.mid || 0));
      return ok({ event: eventView(ev), markets: mkts.map(marketView) });
    }

    if (p === '/api/markets') {
      const search = (q.get('q') || '').toLowerCase();
      const category = q.get('category');
      let mkts = [...Exchange.markets.values()].sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0)).slice(0, 500);
      if (category && category !== 'All') mkts = mkts.filter(m => m.category === category);
      if (search) mkts = mkts.filter(m => m.title.toLowerCase().includes(search) || m.ticker.toLowerCase().includes(search));
      return ok({ markets: mkts.map(marketView) });
    }

    if (p.startsWith('/api/market/')) {
      const rest = p.slice('/api/market/'.length);
      const parts = rest.split('/').map(decodeURIComponent);
      const ticker = parts[0];
      const mkt = Exchange.markets.get(ticker);
      if (!mkt) return err('Market not found');
      const ev = Exchange.events.get(mkt.eventTicker);

      if (parts[1] === 'book') return ok({ ticker, ...Exchange.getBook(ticker) });
      if (parts[1] === 'candles') {
        const interval = q.get('interval') || '1h';
        const limit = Math.min(500, parseInt(q.get('limit') || '180', 10));
        return ok({ ticker, interval, candles: Exchange.getCandles(ticker, interval, limit) });
      }
      if (parts[1] === 'trades') return ok({ ticker, trades: Exchange.getTape(ticker) });

      const siblings = [...Exchange.markets.values()]
        .filter(m => m.eventTicker === mkt.eventTicker && m.ticker !== ticker)
        .sort((a, b) => (b.mid || 0) - (a.mid || 0));
      return ok({
        market: marketView(mkt),
        event: ev ? eventView(ev) : null,
        siblings: siblings.map(marketView),
      });
    }

    if (p === '/api/portfolio') {
      return ok({ ...Exchange.portfolioSummary(), orders: Exchange.orderList() });
    }

    if (p === '/api/order' && method === 'POST') {
      const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : (opts.body || {});
      const result = Exchange.placeOrder(body);
      return result.error ? err(result.error) : ok(result);
    }

    if (p.startsWith('/api/order/') && p.endsWith('/cancel') && method === 'POST') {
      const id = parseInt(p.split('/')[3], 10);
      const result = Exchange.cancelOrder(id);
      return result.error ? err(result.error) : ok(result);
    }

    if (p === '/api/analysis/anomalies') {
      const kind = q.get('kind');
      let rows = Exchange.anomalies().slice(0, 200);
      if (kind) rows = rows.filter(r => r.kind === kind);
      return ok({ anomalies: rows });
    }
    if (p === '/api/analysis/mee') {
      return ok({ events: Exchange.meeSummary() });
    }
    if (p === '/api/sync/log') {
      return ok({ log: [{ ts: Exchange.startedAt, status: 'info', detail: 'static build runs the in-browser engine' }] });
    }

    return err('Not found');
  }

  function ok(data) { return { __local: true, status: 200, data }; }
  function err(message) { return { __local: true, status: 400, error: message }; }

  return { handle };
})();
