'use strict';
// SPA: hash routing, rendering, live polling, and trading actions.

const $view = document.getElementById('view');
const state = {
  categories: [],
  category: 'All',
  events: [],
  balance: 0,
  marketPollers: [],
  timer: null,
};

// ---------------- utils ----------------
// Dual-mode API layer: if a Node backend answers /api/health we use the
// server REST API; otherwise (e.g. GitHub Pages static hosting) every call
// is served by the in-browser exchange engine via LocalAPI.
let SERVER_MODE = null; // null = unknown, true = backend, false = in-browser

async function detectMode() {
  try {
    const res = await fetch('api/health', { cache: 'no-store' });
    if (res.ok) {
      const j = await res.json();
      if (j && j.ok === true) { SERVER_MODE = true; return; }
    }
  } catch {}
  SERVER_MODE = false;
  if (window.Exchange) Exchange.start();
}

async function api(path, opts) {
  if (SERVER_MODE) {
    const res = await fetch(path, opts);
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }
  const r = LocalAPI.handle(path, opts);
  if (r.status >= 400) throw new Error(r.error || 'Request failed');
  return r.data;
}
const cents = p => p == null || isNaN(p) ? '—' : (p * 100).toFixed(p * 100 % 1 ? 1 : 0) + '¢';
const usd = x => x == null || isNaN(x) ? '—' : '$' + Number(x).toLocaleString('en-US', { maximumFractionDigits: 2 });
const compact = x => {
  if (x == null || isNaN(x)) return '—';
  if (x >= 1e6) return '$' + (x / 1e6).toFixed(1) + 'M';
  if (x >= 1e3) return '$' + (x / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(x);
};
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(msg, kind = '') {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}
function timeToClose(iso) {
  if (!iso) return '';
  const d = new Date(iso); const ms = d - Date.now();
  if (ms <= 0) return 'closed';
  const days = Math.floor(ms / 86400000);
  if (days > 60) return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  if (days >= 1) return `${days}d`;
  const hrs = Math.floor(ms / 3600000);
  if (hrs >= 1) return `${hrs}h`;
  return `${Math.max(1, Math.floor(ms / 60000))}m`;
}

function poll(fn, ms) {
  const id = setInterval(() => { try { fn(); } catch {} }, ms);
  state.marketPollers.push(id);
  fn();
}
function clearPollers() { state.marketPollers.forEach(clearInterval); state.marketPollers = []; }

// ---------------- nav ----------------
async function boot() {
  await detectMode();
  try {
    const meta = await api('/api/meta');
    state.categories = ['All', ...meta.categories];
    renderNav();
    const b = document.getElementById('sync-banner');
    if (SERVER_MODE) {
      const h = await api('/api/health');
      if (h.sync && !h.sync.ok) {
        b.textContent = `Upstream Kalshi API unreachable (${h.sync.detail}). Running the built-in exchange engine — all markets live-simulated. Deploy the Node server with open egress to mirror real Kalshi markets.`;
        b.classList.remove('hidden');
      }
    } else {
      b.textContent = 'Static build (GitHub Pages): the exchange engine runs entirely in your browser — live-simulated markets, order books and paper trading. Portfolio is stored locally in this browser.';
      b.classList.remove('hidden');
    }
  } catch (e) { /* still booting */ }
  refreshBalance();
  setInterval(refreshBalance, 6000);
  route();
}
function renderNav() {
  const nav = document.getElementById('cat-nav');
  nav.innerHTML = state.categories.map(c =>
    `<a href="#/category/${encodeURIComponent(c)}" data-cat="${esc(c)}">${esc(c)}</a>`).join('');
}
async function refreshBalance() {
  try {
    const p = await api('/api/portfolio');
    state.balance = p.totalValue;
    document.getElementById('balance-chip').textContent = usd(p.totalValue);
  } catch {}
}

// ---------------- routing ----------------
window.addEventListener('hashchange', route);
function route() {
  clearPollers();
  const hash = location.hash || '#/';
  const parts = hash.slice(2).split('/').map(decodeURIComponent);
  document.querySelectorAll('#cat-nav a').forEach(a => a.classList.toggle('active', a.dataset.cat === (parts[0] === 'category' ? parts[1] : 'All')));
  if (hash === '#/' || hash === '#') return renderHome('All');
  if (parts[0] === 'category') return renderHome(parts[1]);
  if (parts[0] === 'markets') return renderAllMarkets();
  if (parts[0] === 'event' && parts[1]) return renderEvent(parts[1]);
  if (parts[0] === 'market' && parts[1]) return renderMarket(parts[1], parts[2]);
  if (parts[0] === 'portfolio') return renderPortfolio();
  if (parts[0] === 'analysis') return renderAnalysis();
  renderHome('All');
}

// ---------------- home ----------------
async function renderHome(category) {
  state.category = category || 'All';
  $view.innerHTML = `<div class="hero">
      <div>
        <h1>Trade on what happens next.</h1>
        <p>Buy and sell contracts on politics, economics, crypto, sports, weather and more. Every contract settles at $1 or $0 — the price is the market's probability.</p>
      </div>
      <div class="hero-stats" id="hero-stats"><div class="stat"><b>—</b><span>24h volume</span></div><div class="stat"><b>—</b><span>open markets</span></div><div class="stat"><b>—</b><span>events</span></div></div>
    </div>
    <div class="chips" id="chips"></div>
    <div class="section-title">${esc(state.category) === 'All' ? 'Trending events' : esc(state.category)}</div>
    <div class="event-grid" id="event-grid"><div class="muted">Loading…</div></div>`;

  const chips = document.getElementById('chips');
  chips.innerHTML = state.categories.map(c =>
    `<a class="chip ${c === state.category ? 'active' : ''}" href="#/category/${encodeURIComponent(c)}">${esc(c)}</a>`).join('');

  loadEvents();
  poll(loadEvents, 5000);
}
async function loadEvents() {
  try {
    const data = await api('/api/events?category=' + encodeURIComponent(state.category));
    state.events = data.events;
    renderEventGrid();
    const stats = document.getElementById('hero-stats');
    if (stats) {
      const v24 = data.events.reduce((s, e) => s + e.volume24h, 0);
      const mkts = data.events.reduce((s, e) => s + e.openCount, 0);
      stats.innerHTML = `<div class="stat"><b>${compact(v24)}</b><span>24h volume</span></div>
        <div class="stat"><b>${mkts}</b><span>open markets</span></div>
        <div class="stat"><b>${data.events.length}</b><span>events</span></div>`;
    }
  } catch (e) {}
}
function renderEventGrid() {
  const grid = document.getElementById('event-grid');
  if (!grid) return;
  if (!state.events.length) { grid.innerHTML = '<div class="muted">No events found.</div>'; return; }
  grid.innerHTML = state.events.map(ev => {
    const rows = ev.topMarkets.map(m => `
      <div class="mkt-row">
        <a class="name" href="#/market/${encodeURIComponent(m.ticker)}">${esc(m.title)}</a>
        <div class="yesno">
          <button class="btn-side btn-yes" data-buy="yes" data-ticker="${esc(m.ticker)}"><small>Yes</small>${cents(m.yesAsk || m.mid)}</button>
          <button class="btn-side btn-no" data-buy="no" data-ticker="${esc(m.ticker)}"><small>No</small>${cents(m.yesAsk ? 1 - m.yesAsk : (m.mid ? 1 - m.mid : null))}</button>
        </div>
      </div>`).join('');
    return `<div class="event-card">
      <div class="event-head">
        <div class="event-title"><a href="#/event/${encodeURIComponent(ev.ticker)}">${esc(ev.title)}</a></div>
        <span class="cat-badge">${esc(ev.category)}</span>
      </div>
      ${rows}
      <div class="event-foot">
        <span>${compact(ev.volume24h)} Vol · ${ev.openCount} market${ev.openCount === 1 ? '' : 's'}</span>
        <a href="#/event/${encodeURIComponent(ev.ticker)}">${ev.mutuallyExclusive ? 'See all →' : 'Trade →'}</a>
      </div>
    </div>`;
  }).join('');
  grid.querySelectorAll('[data-buy]').forEach(b => b.addEventListener('click', quickBuy));
}
async function quickBuy(e) {
  const ticker = e.currentTarget.dataset.ticker;
  const side = e.currentTarget.dataset.buy;
  try {
    const r = await api('/api/order', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ marketTicker: ticker, side, action: 'buy', type: 'market', qty: 50 }),
    });
    toast(`Bought ${Math.round(r.filledQty)} ${side.toUpperCase()} @ ${cents(r.avgFillPrice)}`, 'ok');
    refreshBalance(); loadEvents();
  } catch (err) { toast(err.message, 'err'); }
}

// ---------------- all markets table ----------------
async function renderAllMarkets() {
  $view.innerHTML = `<div class="section-title">All markets</div>
    <div class="section-sub">Every listed contract, ordered by 24h volume. Click a ticker for the full order book.</div>
    <div class="table-card"><table class="data"><thead><tr>
      <th>Market</th><th>Last</th><th>Yes Bid</th><th>Yes Ask</th><th>Spread</th><th>24h Vol</th><th>Total Vol</th><th>OI</th><th>Closes</th><th></th>
    </tr></thead><tbody id="mk-body"><tr><td class="muted">Loading…</td></tr></tbody></table></div>`;
  const load = async () => {
    try {
      const data = await api('/api/markets');
      const body = document.getElementById('mk-body');
      if (!body) return;
      body.innerHTML = data.markets.map(m => {
        const spread = m.yesBid && m.yesAsk ? Math.round((m.yesAsk - m.yesBid) * 100) : '—';
        const chg = m.prev ? m.last - m.prev : 0;
        return `<tr>
          <td><a class="ticker-link" href="#/market/${encodeURIComponent(m.ticker)}">${esc(m.title)}</a><br><span class="muted" style="font-size:11px">${esc(m.ticker)}${m.source === 'kalshi' ? ' · live upstream' : ''}</span></td>
          <td class="${chg > 0 ? 'up' : chg < 0 ? 'down' : ''}">${cents(m.last)}</td>
          <td>${cents(m.yesBid)}</td><td>${cents(m.yesAsk)}</td>
          <td>${spread === '—' ? '—' : spread + '¢'}</td>
          <td>${compact(m.volume24h)}</td><td>${compact(m.volume)}</td><td>${Math.round(m.openInterest || 0).toLocaleString()}</td>
          <td class="muted">${timeToClose(m.closeTime)}</td>
          <td><span class="pill ${m.status}">${m.status}</span></td>
        </tr>`;
      }).join('');
    } catch {}
  };
  load(); poll(load, 5000);
}

// ---------------- event page ----------------
async function renderEvent(ticker) {
  $view.innerHTML = '<div class="muted">Loading…</div>';
  const load = async () => {
    try {
      const data = await api('/api/event/' + encodeURIComponent(ticker));
      const ev = data.event;
      $view.innerHTML = `
        <div class="crumb"><a href="#/">Home</a> / <span>${esc(ev.category)}</span></div>
        <div class="panel">
          <div class="market-head">
            <h1>${esc(ev.title)}</h1>
            <div class="muted">${esc(ev.subtitle || '')}</div>
            <div class="market-meta">
              <span>24h Vol <b>${compact(ev.volume24h)}</b></span>
              <span>Total Vol <b>${compact(ev.volume)}</b></span>
              ${ev.mutuallyExclusive ? '<span class="pill open">mutually exclusive</span>' : ''}
            </div>
          </div>
        </div>
        <div style="height:14px"></div>
        <div class="table-card"><table class="data"><thead><tr>
          <th>Outcome</th><th>Yes Bid</th><th>Yes Ask</th><th>Last</th><th>24h Vol</th><th>OI</th><th>Closes</th><th></th><th></th>
        </tr></thead><tbody>
        ${data.markets.map(m => `<tr>
          <td><a class="ticker-link" href="#/market/${encodeURIComponent(m.ticker)}">${esc(m.title)}</a></td>
          <td>${cents(m.yesBid)}</td><td>${cents(m.yesAsk)}</td>
          <td><b>${cents(m.last)}</b></td>
          <td>${compact(m.volume24h)}</td><td>${Math.round(m.openInterest || 0).toLocaleString()}</td>
          <td class="muted">${timeToClose(m.closeTime)}</td>
          <td><button class="btn-side btn-yes" data-buy="yes" data-ticker="${esc(m.ticker)}"><small>Yes</small>${cents(m.yesAsk || m.mid)}</button></td>
          <td><button class="btn-side btn-no" data-buy="no" data-ticker="${esc(m.ticker)}"><small>No</small>${cents(m.yesAsk ? 1 - m.yesAsk : (m.mid ? 1 - m.mid : null))}</button></td>
        </tr>`).join('')}
        </tbody></table></div>`;
      $view.querySelectorAll('[data-buy]').forEach(b => b.addEventListener('click', quickBuy));
    } catch (e) { $view.innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
  };
  load(); poll(load, 5000);
}

// ---------------- market page ----------------
let chart = null, chartInterval = '1h';
async function renderMarket(ticker, side) {
  $view.innerHTML = '<div class="muted">Loading…</div>';
  chart = null;
  let first = true;

  const load = async () => {
    try {
      const data = await api('/api/market/' + encodeURIComponent(ticker));
      const m = data.market;
      const ev = data.event;
      if (first) {
        first = false;
        $view.innerHTML = `
        <div class="crumb"><a href="#/">Home</a> / ${ev ? `<a href="#/event/${encodeURIComponent(ev.ticker)}">${esc(ev.title)}</a>` : ''}</div>
        <div class="market-layout">
          <div>
            <div class="panel market-head">
              <h1>${esc(m.title)}</h1>
              <div class="muted">${esc(m.yesSub)} vs ${esc(m.noSub)} · <span class="pill ${m.status}">${m.status}${m.result ? ' ' + m.result : ''}</span>${m.source === 'kalshi' ? ' <span class="pill open">live upstream</span>' : ''}</div>
              <div class="market-meta" id="m-meta"></div>
            </div>
            <div class="panel chart-panel">
              <div class="chart-toolbar">
                ${['15m', '1h', '1d'].map(tf => `<button class="tf-btn ${tf === chartInterval ? 'active' : ''}" data-tf="${tf}">${tf}</button>`).join('')}
                <div class="spacer"></div>
                <span class="muted" id="chart-last"></span>
              </div>
              <canvas id="chart-canvas"></canvas>
            </div>
            ${data.siblings.length ? `<div class="panel" style="margin-top:16px">
              <h3 style="font-size:14px;margin-bottom:8px">Related markets in this event</h3>
              ${data.siblings.slice(0, 8).map(s => `<div class="mkt-row">
                <a class="name" href="#/market/${encodeURIComponent(s.ticker)}">${esc(s.title)}</a>
                <b>${cents(s.mid)}</b></div>`).join('')}
            </div>` : ''}
            ${m.rules ? `<div class="panel rules-box"><h3>Rules</h3><div>${esc(m.rules)}</div></div>` : ''}
          </div>
          <div>
            <div class="panel trade-panel" id="trade-panel"></div>
            <div class="panel book" style="margin-top:14px">
              <div class="book-head"><span>Order book</span><span class="muted" style="font-weight:400">YES side</span></div>
              <div class="book-grid">
                <div class="book-side"><h4>Bids</h4><div id="book-bids"></div></div>
                <div class="book-side"><h4>Asks</h4><div id="book-asks"></div></div>
              </div>
            </div>
            <div class="panel" style="margin-top:14px">
              <div class="book-head"><span>Recent trades</span></div>
              <div class="tape" id="tape"><div class="muted">Waiting for trades…</div></div>
            </div>
          </div>
        </div>`;
        chart = KChart.create(document.getElementById('chart-canvas'));
        $view.querySelectorAll('.tf-btn').forEach(b => b.addEventListener('click', () => {
          chartInterval = b.dataset.tf;
          $view.querySelectorAll('.tf-btn').forEach(x => x.classList.toggle('active', x === b));
          loadCandles();
        }));
        renderTradePanel(m, side);
        loadCandles();
      }
      // live parts
      const meta = document.getElementById('m-meta');
      if (meta) meta.innerHTML = `
        <span>Last <b class="${m.last >= m.prev ? 'up' : 'down'}">${cents(m.last)}</b></span>
        <span>Bid <b>${cents(m.yesBid)}</b> × ${Math.round(m.yesBidSize || 0)}</span>
        <span>Ask <b>${cents(m.yesAsk)}</b> × ${Math.round(m.yesAskSize || 0)}</span>
        <span>24h Vol <b>${compact(m.volume24h)}</b></span>
        <span>OI <b>${Math.round(m.openInterest || 0).toLocaleString()}</b></span>
        <span>Closes <b>${timeToClose(m.closeTime)}</b></span>`;
      const cl = document.getElementById('chart-last');
      if (cl) cl.textContent = `last ${cents(m.last)}`;
      loadBook(); loadTape();
      updateTradeEstimates();
    } catch (e) { if (first) $view.innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
  };

  async function loadCandles() {
    try {
      const data = await api(`/api/market/${encodeURIComponent(ticker)}/candles?interval=${chartInterval}&limit=180`);
      if (chart) chart.setData(data.candles.map(c => ({ t_open: c.t_open, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v })));
    } catch {}
  }
  async function loadBook() {
    try {
      const data = await api(`/api/market/${encodeURIComponent(ticker)}/book`);
      const maxS = Math.max(1, ...data.bids.map(l => l[1]), ...data.asks.map(l => l[1]));
      const render = (levels, cls) => levels.slice(0, 7).map(([p, s]) =>
        `<div class="${cls} book-row"><div class="depth" style="width:${Math.round(s / maxS * 100)}%"></div><span>${cents(p)}</span><span>${Math.round(s)}</span></div>`).join('') || '<div class="muted">—</div>';
      const bids = document.getElementById('book-bids');
      const asks = document.getElementById('book-asks');
      if (bids) bids.innerHTML = render(data.bids.slice().sort((a, b) => b[0] - a[0]), 'bid');
      if (asks) asks.innerHTML = render(data.asks.slice().sort((a, b) => a[0] - b[0]), 'ask');
    } catch {}
  }
  async function loadTape() {
    try {
      const data = await api(`/api/market/${encodeURIComponent(ticker)}/trades`);
      const tape = document.getElementById('tape');
      if (tape && data.trades.length) {
        tape.innerHTML = data.trades.slice(0, 24).map(t =>
          `<div class="tape-row"><span class="${t.side === 'buy' ? 'up' : 'down'}">${t.side === 'buy' ? '▲' : '▼'} ${cents(t.price)}</span><span>${Math.round(t.size)}</span><span class="muted">${new Date(t.ts).toLocaleTimeString()}</span></div>`).join('');
      }
    } catch {}
  }

  function renderTradePanel(m, initialSide) {
    const tp = document.getElementById('trade-panel');
    if (!tp) return;
    tp.innerHTML = `
      <div class="seg">
        <button id="seg-buy" class="active-buy">Buy</button>
        <button id="seg-sell">Sell</button>
      </div>
      <div class="seg">
        <button id="seg-yes" class="active-buy" style="background:var(--yes)">Yes</button>
        <button id="seg-no" style="background:var(--no-bg);color:var(--no)">No</button>
      </div>
      <div class="field"><label>Quantity (contracts)</label><input id="qty" type="number" min="1" step="1" value="100"></div>
      <div class="field"><label>Order type</label>
        <select id="otype"><option value="market">Market</option><option value="limit">Limit</option></select>
      </div>
      <div class="field hidden" id="price-field"><label>Limit price (¢)</label><input id="lprice" type="number" min="1" max="99" step="1" value="50"></div>
      <div id="est"></div>
      <button class="submit-trade buy" id="submit">Buy Yes</button>
      <div class="hint" style="margin-top:8px;font-size:11.5px;color:var(--ink-3)">
        Contracts pay $1 if the outcome happens, $0 otherwise. Paper account — no real money.
      </div>`;
    const tstate = { action: 'buy', side: 'yes' };
    if (initialSide === 'no') setSide('no');

    function paint() {
      const buy = tstate.action === 'buy';
      document.getElementById('seg-buy').className = buy ? 'active-buy' : '';
      document.getElementById('seg-sell').className = buy ? '' : 'active-sell';
      document.getElementById('seg-yes').className = tstate.side === 'yes' ? 'active-buy' : '';
      document.getElementById('seg-yes').style.background = tstate.side === 'yes' ? 'var(--yes)' : '#fff';
      document.getElementById('seg-yes').style.color = tstate.side === 'yes' ? '#fff' : 'var(--yes)';
      document.getElementById('seg-no').className = tstate.side === 'no' ? 'active-sell' : '';
      document.getElementById('seg-no').style.background = tstate.side === 'no' ? 'var(--no)' : '#fff';
      document.getElementById('seg-no').style.color = tstate.side === 'no' ? '#fff' : 'var(--no)';
      const btn = document.getElementById('submit');
      btn.className = 'submit-trade ' + (buy ? 'buy' : 'sell');
      btn.textContent = `${buy ? 'Buy' : 'Sell'} ${tstate.side === 'yes' ? 'Yes' : 'No'}`;
      updateTradeEstimates();
    }
    function setSide(s) { tstate.side = s; paint(); }
    document.getElementById('seg-buy').onclick = () => { tstate.action = 'buy'; paint(); };
    document.getElementById('seg-sell').onclick = () => { tstate.action = 'sell'; paint(); };
    document.getElementById('seg-yes').onclick = () => setSide('yes');
    document.getElementById('seg-no').onclick = () => setSide('no');
    document.getElementById('otype').onchange = e => {
      document.getElementById('price-field').classList.toggle('hidden', e.target.value !== 'limit');
      updateTradeEstimates();
    };
    document.getElementById('qty').oninput = updateTradeEstimates;
    document.getElementById('lprice').oninput = updateTradeEstimates;
    document.getElementById('submit').onclick = submitTrade;
    tp.dataset.ticker = m.ticker;
    window._tstate = tstate;
    paint();
  }

  function currentQuote() { return api('/api/market/' + encodeURIComponent(ticker)).then(d => d.market); }
  async function updateTradeEstimates() {
    const est = document.getElementById('est');
    if (!est) return;
    try {
      const m = await currentQuote();
      const qty = parseInt(document.getElementById('qty')?.value || '0', 10);
      const type = document.getElementById('otype')?.value || 'market';
      const ts = window._tstate || { action: 'buy', side: 'yes' };
      let price;
      if (type === 'limit') price = (parseInt(document.getElementById('lprice')?.value || '50', 10)) / 100;
      else {
        price = ts.action === 'buy'
          ? (ts.side === 'yes' ? m.yesAsk : (m.yesAsk ? 1 - m.yesBid : 0.5))
          : (ts.side === 'yes' ? m.yesBid : (m.yesBid ? 1 - m.yesAsk : 0.5));
      }
      const fee = Math.round(0.07 * qty * price * (1 - price) * 100) / 100;
      const cost = qty * price;
      const maxPay = qty * 1;
      est.innerHTML = `
        <div class="est-line"><span>Est. price</span><b>${cents(price)}</b></div>
        <div class="est-line"><span>${ts.action === 'buy' ? 'Cost' : 'Proceeds'}</span><b>${usd(cost)}</b></div>
        <div class="est-line"><span>Fees (taker)</span><b>${usd(fee)}</b></div>
        <div class="est-line"><span>Max ${ts.action === 'buy' ? 'payout' : 'risk'}</span><b>${usd(maxPay)}</b></div>`;
    } catch {}
  }

  async function submitTrade() {
    const tp = document.getElementById('trade-panel');
    const ts = window._tstate;
    const qty = parseInt(document.getElementById('qty').value || '0', 10);
    const type = document.getElementById('otype').value;
    const body = { marketTicker: tp.dataset.ticker, side: ts.side, action: ts.action, type, qty };
    if (type === 'limit') body.price = (parseInt(document.getElementById('lprice').value || '50', 10)) / 100;
    try {
      const r = await api('/api/order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status === 'open' || r.status === 'partial') toast(`Limit order resting (${r.restingQty ?? qty - (r.filledQty || 0)} unfilled)`, 'ok');
      else toast(`${ts.action === 'buy' ? 'Bought' : 'Sold'} ${Math.round(r.filledQty)} ${ts.side.toUpperCase()} @ ${cents(r.avgFillPrice)}`, 'ok');
      refreshBalance(); load();
    } catch (err) { toast(err.message, 'err'); }
  }

  load();
  poll(load, 4000);
}

// ---------------- portfolio ----------------
async function renderPortfolio() {
  $view.innerHTML = '<div class="muted">Loading…</div>';
  const load = async () => {
    try {
      const p = await api('/api/portfolio');
      $view.innerHTML = `
        <div class="section-title">Portfolio</div>
        <div class="cards-row">
          <div class="stat-card"><div class="lbl">Total value</div><div class="val">${usd(p.totalValue)}</div></div>
          <div class="stat-card"><div class="lbl">Cash balance</div><div class="val">${usd(p.balance)}</div></div>
          <div class="stat-card"><div class="lbl">Positions value</div><div class="val">${usd(p.marketValue)}</div></div>
          <div class="stat-card"><div class="lbl">Unrealized P&L</div><div class="val ${p.unrealizedPnl >= 0 ? 'up' : 'down'}">${usd(p.unrealizedPnl)}</div></div>
          <div class="stat-card"><div class="lbl">Realized P&L</div><div class="val ${p.realizedPnl >= 0 ? 'up' : 'down'}">${usd(p.realizedPnl)}</div></div>
        </div>
        <div class="section-title">Positions</div>
        <div class="table-card"><table class="data"><thead><tr>
          <th>Market</th><th>Side</th><th>Qty</th><th>Avg price</th><th>Mark</th><th>Value</th><th>uP&L</th><th></th>
        </tr></thead><tbody>
        ${p.positions.length ? p.positions.map(pos => `<tr>
          <td><a class="ticker-link" href="#/market/${encodeURIComponent(pos.ticker)}">${esc(pos.title)}</a></td>
          <td><b style="color:${pos.side === 'yes' ? 'var(--yes)' : 'var(--no)'}">${pos.side.toUpperCase()}</b></td>
          <td>${Math.round(pos.qty)}</td><td>${cents(pos.avgPrice)}</td><td>${cents(pos.mark)}</td>
          <td>${usd(pos.marketValue)}</td>
          <td class="${pos.unrealizedPnl >= 0 ? 'up' : 'down'}">${usd(pos.unrealizedPnl)}</td>
          <td><button class="mini-btn" data-sell="${esc(pos.ticker)}" data-side="${pos.side}">Sell</button></td>
        </tr>`).join('') : '<tr><td class="muted" colspan="8">No open positions — pick a market and take a side.</td></tr>'}
        </tbody></table></div>
        <div class="section-title">Orders</div>
        <div class="table-card"><table class="data"><thead><tr>
          <th>Time</th><th>Market</th><th>Side</th><th>Type</th><th>Qty</th><th>Price</th><th>Filled</th><th>Status</th><th></th>
        </tr></thead><tbody>
        ${p.orders.length ? p.orders.slice(0, 40).map(o => `<tr>
          <td class="muted">${new Date(o.ts).toLocaleString()}</td>
          <td><a class="ticker-link" href="#/market/${encodeURIComponent(o.ticker)}">${esc(o.ticker)}</a></td>
          <td><b style="color:${o.side === 'yes' ? 'var(--yes)' : 'var(--no)'}">${o.action.toUpperCase()} ${o.side.toUpperCase()}</b></td>
          <td>${o.type}</td><td>${Math.round(o.qty)}</td><td>${cents(o.price)}</td><td>${Math.round(o.filled_qty)}</td>
          <td><span class="pill ${o.status === 'filled' ? 'settled' : o.status === 'cancelled' ? 'closed' : 'open'}">${o.status}</span></td>
          <td>${['open', 'partial'].includes(o.status) ? `<button class="mini-btn" data-cancel="${o.id}">Cancel</button>` : ''}</td>
        </tr>`).join('') : '<tr><td class="muted" colspan="9">No orders yet.</td></tr>'}
        </tbody></table></div>`;
      $view.querySelectorAll('[data-sell]').forEach(b => b.addEventListener('click', async () => {
        try {
          const pos = p.positions.find(x => x.ticker === b.dataset.sell && x.side === b.dataset.side);
          const r = await api('/api/order', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ marketTicker: b.dataset.sell, side: b.dataset.side, action: 'sell', type: 'market', qty: Math.round(pos?.qty || 0) }) });
          toast(`Sold ${Math.round(r.filledQty)} @ ${cents(r.avgFillPrice)}`, 'ok'); refreshBalance(); load();
        } catch (e) { toast(e.message, 'err'); }
      }));
      $view.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', async () => {
        try { await api(`/api/order/${b.dataset.cancel}/cancel`, { method: 'POST' }); toast('Order cancelled', 'ok'); load(); }
        catch (e) { toast(e.message, 'err'); }
      }));
    } catch (e) { $view.innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
  };
  load(); poll(load, 4000);
}

// ---------------- analysis ----------------
async function renderAnalysis() {
  $view.innerHTML = '<div class="muted">Loading…</div>';
  const load = async () => {
    try {
      const [anom, mee] = await Promise.all([api('/api/analysis/anomalies'), api('/api/analysis/mee')]);
      const KINDS = { mee_sum: 'MEE sum drift', mee_arb: 'Basket arbitrage', wide_spread: 'Wide spread', fast_move: 'Fast move' };
      $view.innerHTML = `
        <div class="section-title">Pricing analysis</div>
        <div class="section-sub">Live scan for pricing irregularities: mutually-exclusive probability sums, basket arbitrage bounds, spread outliers and rapid moves. The same data is persisted in the exchange database for the companion analysis repo.</div>
        <div class="table-card" style="margin-bottom:20px"><table class="data"><thead><tr>
          <th>Detected</th><th>Type</th><th>Scope</th><th>Detail</th><th>Severity</th>
        </tr></thead><tbody>
        ${anom.anomalies.length ? anom.anomalies.slice(0, 40).map(a => `<tr>
          <td class="muted">${new Date(a.ts).toLocaleTimeString()}</td>
          <td><span class="anom-kind ${a.kind}">${KINDS[a.kind] || a.kind}</span></td>
          <td><a class="ticker-link" href="#/${a.scope.startsWith('KX') && a.payload && a.payload.title && !a.scope.includes('-') ? 'event' : 'market'}/${encodeURIComponent(a.scope)}">${esc(a.scope)}</a></td>
          <td style="text-align:left;white-space:normal">${esc(detail(a))}</td>
          <td><b>${(a.severity).toFixed(a.severity < 1 ? 3 : 1)}</b></td>
        </tr>`).join('') : '<tr><td class="muted" colspan="5">No irregularities detected yet — the scanner runs every few seconds.</td></tr>'}
        </tbody></table></div>
        <div class="section-title">Mutually exclusive sums</div>
        <div class="section-sub">Sum of YES mid prices per mutually exclusive event. In equilibrium these total 100¢; deviations are potential mispricings.</div>
        <div class="table-card"><table class="data"><thead><tr>
          <th>Event</th><th>Markets</th><th>Σ Mid</th><th>Σ Ask</th><th>Σ Bid</th><th>Deviation</th>
        </tr></thead><tbody>
        ${mee.events.map(e => `<tr>
          <td><a class="ticker-link" href="#/event/${encodeURIComponent(e.event)}">${esc(e.title)}</a></td>
          <td>${e.markets}</td>
          <td><b>${(e.sumMid * 100).toFixed(1)}¢</b></td>
          <td>${(e.sumAsk * 100).toFixed(1)}¢</td><td>${(e.sumBid * 100).toFixed(1)}¢</td>
          <td class="${Math.abs(e.deviation) > 0.025 ? (e.deviation > 0 ? 'up' : 'down') : 'muted'}"><b>${(e.deviation * 100).toFixed(1)}¢</b></td>
        </tr>`).join('')}
        </tbody></table></div>`;
      function detail(a) {
        const p = a.payload || {};
        if (a.kind === 'mee_sum') return `${p.markets} markets sum to ${(p.sumMid * 100).toFixed(1)}¢ (${p.deviation > 0 ? '+' : ''}${(p.deviation * 100).toFixed(1)}¢ off parity)`;
        if (a.kind === 'mee_arb') return p.direction === 'buy_all_yes'
          ? `Buy every YES for ${(p.sumAsk * 100).toFixed(1)}¢ → risk-free edge ${(p.edge * 100).toFixed(1)}¢`
          : `Sell every YES for ${(p.sumBid * 100).toFixed(1)}¢ → edge ${(p.edge * 100).toFixed(1)}¢`;
        if (a.kind === 'wide_spread') return `${(p.bid * 100).toFixed(0)}¢ × ${(p.ask * 100).toFixed(0)}¢ — ${p.spreadTicks} tick spread`;
        if (a.kind === 'fast_move') return `moved ${(p.move * 100).toFixed(1)}¢ in ${p.windowSec}s (${(p.from * 100).toFixed(0)}¢ → ${(p.to * 100).toFixed(0)}¢)`;
        return JSON.stringify(p);
      }
    } catch (e) { $view.innerHTML = `<div class="muted">${esc(e.message)}</div>`; }
  };
  load(); poll(load, 6000);
}

// search
document.getElementById('search').addEventListener('keydown', async e => {
  if (e.key !== 'Enter') return;
  const q = e.target.value.trim();
  if (!q) return;
  location.hash = '#/markets';
  setTimeout(async () => {
    try {
      const data = await api('/api/markets?q=' + encodeURIComponent(q));
      const body = document.getElementById('mk-body');
      if (body) body.innerHTML = data.markets.map(m => `<tr>
        <td><a class="ticker-link" href="#/market/${encodeURIComponent(m.ticker)}">${esc(m.title)}</a></td>
        <td>${cents(m.last)}</td><td>${cents(m.yesBid)}</td><td>${cents(m.yesAsk)}</td>
        <td>${m.yesBid && m.yesAsk ? Math.round((m.yesAsk - m.yesBid) * 100) + '¢' : '—'}</td>
        <td>${compact(m.volume24h)}</td><td>${compact(m.volume)}</td><td>${Math.round(m.openInterest || 0).toLocaleString()}</td>
        <td class="muted">${timeToClose(m.closeTime)}</td>
        <td><span class="pill ${m.status}">${m.status}</span></td></tr>`).join('') || '<tr><td class="muted" colspan="10">No matches.</td></tr>';
    } catch {}
  }, 60);
});

boot();
