'use strict';
// In-browser exchange engine. A faithful port of the Node server engine so
// the site is fully functional on static hosting (GitHub Pages): live price
// process, L2 order books, organic flow, candles, trading with a persisted
// paper portfolio (localStorage), settlement, and the pricing-analytics
// scanner. All state lives in memory except the portfolio.

window.Exchange = (function () {
  const DAY = 86400000;
  const NOW = Date.now();
  const iso = ts => new Date(ts).toISOString();

  // ---------------- seed catalog ----------------
  function m(ticker, title, anchor, opts = {}) {
    const liquidity = opts.liquidity ?? 8000;
    const volume = opts.volume ?? Math.round(anchor * liquidity * (3 + seededRand(ticker) * 30));
    return {
      ticker, title, anchor,
      yesSub: opts.yesSub || 'Yes', noSub: opts.noSub || 'No',
      liquidity,
      volume,
      volume24h: opts.volume24h ?? Math.round(volume * (0.05 + seededRand(ticker + 'v') * 0.3)),
      openInterest: opts.openInterest ?? Math.round(volume * (0.2 + seededRand(ticker + 'o') * 0.5)),
      closeTime: opts.closeTime || iso(NOW + 30 * DAY),
      rules: opts.rules || '',
    };
  }
  function seededRand(key) { const r = mulberry32(hashSeed(key))(); return r; }

  const CATALOG = [
    { ticker: 'KXPRES28DEM', title: 'Democratic nominee for President 2028', subtitle: 'Who will the Democratic Party nominate?', category: 'Politics', series: 'KXPRES28', mee: true, closeTime: iso(NOW + 700 * DAY), markets: [
      m('KXPRES28DEM-GNEWSOM', 'Gavin Newsom', 0.27, { liquidity: 42000, volume24h: 61000 }),
      m('KXPRES28DEM-JPRITZKER', 'JB Pritzker', 0.14, { liquidity: 21000, volume24h: 18000 }),
      m('KXPRES28DEM-GWHITMER', 'Gretchen Whitmer', 0.12, { liquidity: 19000, volume24h: 14000 }),
      m('KXPRES28DEM-JSHAPIRO', 'Josh Shapiro', 0.11, { liquidity: 17000, volume24h: 12500 }),
      m('KXPRES28DEM-KHARRIS', 'Kamala Harris', 0.09, { liquidity: 15000, volume24h: 11000 }),
      m('KXPRES28DEM-WMOORE', 'Wes Moore', 0.06, { liquidity: 9000 }),
      m('KXPRES28DEM-ABESHEAR', 'Andy Beshear', 0.05, { liquidity: 8000 }),
      m('KXPRES28DEM-PBUTTIGIEG', 'Pete Buttigieg', 0.04, { liquidity: 7000 }),
      m('KXPRES28DEM-AOC', 'Alexandria Ocasio-Cortez', 0.04, { liquidity: 9000, volume24h: 9000 }),
      m('KXPRES28DEM-CBOOKER', 'Cory Booker', 0.03, { liquidity: 5000 }),
      m('KXPRES28DEM-FIELD', 'Another candidate', 0.04, { liquidity: 6000 }),
    ]},
    { ticker: 'KXPRES28GOP', title: 'Republican nominee for President 2028', subtitle: 'Who will the Republican Party nominate?', category: 'Politics', series: 'KXPRES28', mee: true, closeTime: iso(NOW + 700 * DAY), markets: [
      m('KXPRES28GOP-JDVANCE', 'JD Vance', 0.41, { liquidity: 52000, volume24h: 74000 }),
      m('KXPRES28GOP-RDESANTIS', 'Ron DeSantis', 0.13, { liquidity: 24000, volume24h: 21000 }),
      m('KXPRES28GOP-NHALEY', 'Nikki Haley', 0.08, { liquidity: 14000 }),
      m('KXPRES28GOP-VRAMASWAMY', 'Vivek Ramaswamy', 0.07, { liquidity: 12000 }),
      m('KXPRES28GOP-MRUBIO', 'Marco Rubio', 0.06, { liquidity: 11000 }),
      m('KXPRES28GOP-TCRUZ', 'Ted Cruz', 0.04, { liquidity: 8000 }),
      m('KXPRES28GOP-GYOUNGKIN', 'Glenn Youngkin', 0.03, { liquidity: 6000 }),
      m('KXPRES28GOP-TSCOTT', 'Tim Scott', 0.02, { liquidity: 5000 }),
      m('KXPRES28GOP-BDONOLDS', 'Byron Donalds', 0.02, { liquidity: 5000 }),
      m('KXPRES28GOP-SHSANDERS', 'Sarah Huckabee Sanders', 0.015, { liquidity: 4000 }),
      m('KXPRES28GOP-FIELD', 'Another candidate', 0.10, { liquidity: 8000 }),
    ]},
    { ticker: 'KXHOUSE26', title: 'Republicans hold the House after the 2026 midterms', subtitle: 'Control of the U.S. House of Representatives', category: 'Politics', series: 'KXCONGRESS26', mee: false, closeTime: iso(NOW + 100 * DAY), markets: [
      m('KXHOUSE26-GOP', 'Republicans keep the majority', 0.57, { liquidity: 38000, volume24h: 42000 }),
    ]},
    { ticker: 'KXSENATE26', title: 'Republicans hold the Senate after the 2026 midterms', subtitle: 'Control of the U.S. Senate', category: 'Politics', series: 'KXCONGRESS26', mee: false, closeTime: iso(NOW + 100 * DAY), markets: [
      m('KXSENATE26-GOP', 'Republicans keep the majority', 0.83, { liquidity: 31000, volume24h: 27000 }),
    ]},
    { ticker: 'KXFEDSEP26', title: 'Fed cuts rates at the September 2026 FOMC meeting', subtitle: 'FOMC decision — September 16-17, 2026', category: 'Politics', series: 'KXFED', mee: false, closeTime: iso(NOW + 38 * DAY), markets: [
      m('KXFEDSEP26-CUT', 'Fed cuts the target range', 0.72, { liquidity: 46000, volume24h: 55000 }),
    ]},
    { ticker: 'KXFEDEND26', title: 'Fed policy rate range on December 31, 2026', subtitle: 'Upper bound of the fed funds target range', category: 'Politics', series: 'KXFED', mee: true, closeTime: iso(NOW + 143 * DAY), markets: [
      m('KXFEDEND26-LT325', 'Below 3.25%', 0.18, { liquidity: 12000 }),
      m('KXFEDEND26-325350', '3.25% - 3.50%', 0.36, { liquidity: 18000, volume24h: 16000 }),
      m('KXFEDEND26-350375', '3.50% - 3.75%', 0.31, { liquidity: 16000 }),
      m('KXFEDEND26-GTE375', '3.75% or above', 0.15, { liquidity: 10000 }),
    ]},
    { ticker: 'KXSHUTDOWN26', title: 'US government shutdown before October 1, 2026', subtitle: 'Any lapse in appropriations', category: 'Politics', series: 'KXSHUTDOWN', mee: false, closeTime: iso(NOW + 51 * DAY), markets: [
      m('KXSHUTDOWN26-Y', 'Shutdown occurs', 0.34, { liquidity: 22000, volume24h: 19000 }),
    ]},
    { ticker: 'KXCPIAUG26', title: 'August 2026 CPI year-over-year inflation', subtitle: 'BLS release, September 2026', category: 'Economics', series: 'KXCPI', mee: true, closeTime: iso(NOW + 33 * DAY), markets: [
      m('KXCPIAUG26-LT24', 'Below 2.4%', 0.13, { liquidity: 11000 }),
      m('KXCPIAUG26-2427', '2.4% - 2.7%', 0.38, { liquidity: 17000, volume24h: 13000 }),
      m('KXCPIAUG26-2730', '2.7% - 3.0%', 0.34, { liquidity: 15000 }),
      m('KXCPIAUG26-GTE30', '3.0% or above', 0.15, { liquidity: 9000 }),
    ]},
    { ticker: 'KXNFPAUG26', title: 'August nonfarm payrolls at or above 100k', subtitle: 'BLS employment report', category: 'Economics', series: 'KXNFP', mee: false, closeTime: iso(NOW + 26 * DAY), markets: [
      m('KXNFPAUG26-100K', 'Payrolls >= 100,000', 0.63, { liquidity: 14000 }),
    ]},
    { ticker: 'KXRECESSION26', title: 'US recession before 2027', subtitle: 'Two consecutive negative GDP quarters or NBER declaration', category: 'Economics', series: 'KXRECESSION', mee: false, closeTime: iso(NOW + 143 * DAY), markets: [
      m('KXRECESSION26-Y', 'Recession in 2026', 0.24, { liquidity: 19000, volume24h: 15000 }),
    ]},
    { ticker: 'KXBTC831', title: 'Bitcoin price on August 31, 2026 at 12 PM ET', subtitle: 'Settles on the reference index price', category: 'Crypto', series: 'KXBTC', mee: true, closeTime: iso(NOW + 21 * DAY), markets: [
      m('KXBTC831-LT100K', 'Below $100,000', 0.08, { liquidity: 21000, volume24h: 24000 }),
      m('KXBTC831-100110', '$100,000 - $110,000', 0.21, { liquidity: 26000, volume24h: 31000 }),
      m('KXBTC831-110120', '$110,000 - $120,000', 0.30, { liquidity: 30000, volume24h: 39000 }),
      m('KXBTC831-120130', '$120,000 - $130,000', 0.25, { liquidity: 24000, volume24h: 26000 }),
      m('KXBTC831-GTE130K', '$130,000 or above', 0.16, { liquidity: 18000, volume24h: 17000 }),
    ]},
    { ticker: 'KXETH831', title: 'Ethereum price on August 31, 2026 at 12 PM ET', subtitle: 'Settles on the reference index price', category: 'Crypto', series: 'KXETH', mee: true, closeTime: iso(NOW + 21 * DAY), markets: [
      m('KXETH831-LT3K', 'Below $3,000', 0.16, { liquidity: 12000 }),
      m('KXETH831-3K4K', '$3,000 - $4,000', 0.38, { liquidity: 16000, volume24h: 14000 }),
      m('KXETH831-4K5K', '$4,000 - $5,000', 0.31, { liquidity: 14000 }),
      m('KXETH831-GTE5K', '$5,000 or above', 0.15, { liquidity: 9000 }),
    ]},
    { ticker: 'KXBTC150K26', title: 'Bitcoin reaches $150,000 in 2026', subtitle: 'Any trade at or above $150k before Jan 1, 2027', category: 'Crypto', series: 'KXBTC', mee: false, closeTime: iso(NOW + 143 * DAY), markets: [
      m('KXBTC150K26-Y', 'BTC hits $150k', 0.33, { liquidity: 27000, volume24h: 22000 }),
    ]},
    { ticker: 'KXSOLETF26', title: 'Solana spot ETF approved in the US in 2026', subtitle: 'SEC approval of a spot SOL ETP', category: 'Crypto', series: 'KXETF', mee: false, closeTime: iso(NOW + 143 * DAY), markets: [
      m('KXSOLETF26-Y', 'Approved in 2026', 0.56, { liquidity: 13000 }),
    ]},
    { ticker: 'KXMLB-26AUG11LADNYM', title: 'Dodgers beat the Mets — August 11', subtitle: 'MLB moneyline', category: 'Sports', series: 'KXMLB', mee: false, closeTime: iso(NOW + 1 * DAY), markets: [
      m('KXMLB-26AUG11LADNYM-LAD', 'Los Angeles Dodgers win', 0.64, { liquidity: 16000, volume24h: 21000 }),
    ]},
    { ticker: 'KXMLB-26AUG11NYYBOS', title: 'Yankees beat the Red Sox — August 11', subtitle: 'MLB moneyline', category: 'Sports', series: 'KXMLB', mee: false, closeTime: iso(NOW + 1 * DAY), markets: [
      m('KXMLB-26AUG11NYYBOS-NYY', 'New York Yankees win', 0.52, { liquidity: 15000, volume24h: 19000 }),
    ]},
    { ticker: 'KXMLB-26AUG11PHIATL', title: 'Phillies beat the Braves — August 11', subtitle: 'MLB moneyline', category: 'Sports', series: 'KXMLB', mee: false, closeTime: iso(NOW + 1 * DAY), markets: [
      m('KXMLB-26AUG11PHIATL-PHI', 'Philadelphia Phillies win', 0.55, { liquidity: 13000, volume24h: 15000 }),
    ]},
    { ticker: 'KXWS26', title: '2026 World Series winner', subtitle: 'Who wins the 2026 World Series?', category: 'Sports', series: 'KXMLB', mee: true, closeTime: iso(NOW + 82 * DAY), markets: [
      m('KXWS26-LAD', 'Los Angeles Dodgers', 0.18, { liquidity: 20000, volume24h: 17000 }),
      m('KXWS26-NYY', 'New York Yankees', 0.13, { liquidity: 17000 }),
      m('KXWS26-PHI', 'Philadelphia Phillies', 0.10, { liquidity: 13000 }),
      m('KXWS26-ATL', 'Atlanta Braves', 0.08, { liquidity: 11000 }),
      m('KXWS26-BAL', 'Baltimore Orioles', 0.07, { liquidity: 9000 }),
      m('KXWS26-HOU', 'Houston Astros', 0.06, { liquidity: 8000 }),
      m('KXWS26-SEA', 'Seattle Mariners', 0.06, { liquidity: 8000 }),
      m('KXWS26-CHC', 'Chicago Cubs', 0.05, { liquidity: 7000 }),
      m('KXWS26-FIELD', 'Another team', 0.24, { liquidity: 9000 }),
    ]},
    { ticker: 'KXSB61', title: 'Super Bowl LXI winner', subtitle: 'February 2027', category: 'Sports', series: 'KXNFL', mee: true, closeTime: iso(NOW + 180 * DAY), markets: [
      m('KXSB61-KC', 'Kansas City Chiefs', 0.16, { liquidity: 23000, volume24h: 20000 }),
      m('KXSB61-PHI', 'Philadelphia Eagles', 0.13, { liquidity: 18000 }),
      m('KXSB61-BUF', 'Buffalo Bills', 0.12, { liquidity: 16000 }),
      m('KXSB61-BAL', 'Baltimore Ravens', 0.09, { liquidity: 12000 }),
      m('KXSB61-SF', 'San Francisco 49ers', 0.08, { liquidity: 11000 }),
      m('KXSB61-DET', 'Detroit Lions', 0.08, { liquidity: 10000 }),
      m('KXSB61-GB', 'Green Bay Packers', 0.06, { liquidity: 8000 }),
      m('KXSB61-DAL', 'Dallas Cowboys', 0.05, { liquidity: 9000 }),
      m('KXSB61-FIELD', 'Another team', 0.20, { liquidity: 10000 }),
    ]},
    { ticker: 'KXUSOPEN26M', title: 'US Open men’s singles champion 2026', subtitle: 'Tennis — Flushing Meadows', category: 'Sports', series: 'KXUSOPEN', mee: true, closeTime: iso(NOW + 34 * DAY), markets: [
      m('KXUSOPEN26M-ALCARAZ', 'Carlos Alcaraz', 0.38, { liquidity: 19000, volume24h: 16000 }),
      m('KXUSOPEN26M-SINNER', 'Jannik Sinner', 0.34, { liquidity: 18000, volume24h: 15000 }),
      m('KXUSOPEN26M-DJOKOVIC', 'Novak Djokovic', 0.07, { liquidity: 9000 }),
      m('KXUSOPEN26M-ZVEREV', 'Alexander Zverev', 0.05, { liquidity: 7000 }),
      m('KXUSOPEN26M-FRITZ', 'Taylor Fritz', 0.04, { liquidity: 7000 }),
      m('KXUSOPEN26M-FIELD', 'Another player', 0.10, { liquidity: 6000 }),
    ]},
    { ticker: 'KXNYHEAT-26AUG15', title: 'NYC hits 90°F or hotter on August 15', subtitle: 'Central Park official high temperature', category: 'Weather', series: 'KXNYTEMP', mee: false, closeTime: iso(NOW + 5 * DAY), markets: [
      m('KXNYHEAT-26AUG15-90F', 'High >= 90°F', 0.27, { liquidity: 11000, volume24h: 12000 }),
    ]},
    { ticker: 'KXHURLAND26', title: 'Three or more hurricanes make US landfall in 2026', subtitle: 'Named hurricanes, any intensity', category: 'Weather', series: 'KXHURRICANE', mee: false, closeTime: iso(NOW + 112 * DAY), markets: [
      m('KXHURLAND26-3PLUS', '3+ landfalls', 0.31, { liquidity: 12000 }),
    ]},
    { ticker: 'KXCAT4LAND26', title: 'Category 4+ hurricane makes US landfall in 2026', subtitle: 'At landfall intensity', category: 'Weather', series: 'KXHURRICANE', mee: false, closeTime: iso(NOW + 112 * DAY), markets: [
      m('KXCAT4LAND26-Y', 'Cat 4+ landfall', 0.14, { liquidity: 10000, volume24h: 8000 }),
    ]},
    { ticker: 'KXSTARSHIP26', title: 'Starship deploys payload to orbit in 2026', subtitle: 'SpaceX Starship orbital payload deployment', category: 'Science & Tech', series: 'KXSPACE', mee: false, closeTime: iso(NOW + 143 * DAY), markets: [
      m('KXSTARSHIP26-Y', 'Payload deployed', 0.58, { liquidity: 10000 }),
    ]},
    { ticker: 'KXAGI26', title: 'A frontier lab declares AGI before 2027', subtitle: 'OpenAI, Google DeepMind, or Anthropic publicly declares AGI', category: 'Science & Tech', series: 'KXAI', mee: false, closeTime: iso(NOW + 143 * DAY), markets: [
      m('KXAGI26-Y', 'AGI declared', 0.12, { liquidity: 12000, volume24h: 9500 }),
    ]},
    { ticker: 'KXROBOTAXI26', title: 'Tesla unsupervised robotaxi in 5+ states by end of 2026', subtitle: 'Commercial, no safety driver', category: 'Science & Tech', series: 'KXTSLA', mee: false, closeTime: iso(NOW + 143 * DAY), markets: [
      m('KXROBOTAXI26-Y', '5+ states live', 0.08, { liquidity: 9000 }),
    ]},
    { ticker: 'KXEMMYDRAMA26', title: '2026 Emmy — Outstanding Drama Series', subtitle: '78th Primetime Emmy Awards', category: 'Culture', series: 'KXEMMY', mee: true, closeTime: iso(NOW + 41 * DAY), markets: [
      m('KXEMMYDRAMA26-SEVERANCE', 'Severance', 0.34, { liquidity: 12000, volume24h: 9000 }),
      m('KXEMMYDRAMA26-WHITELOTUS', 'The White Lotus', 0.18, { liquidity: 9000 }),
      m('KXEMMYDRAMA26-TLOU', 'The Last of Us', 0.14, { liquidity: 8000 }),
      m('KXEMMYDRAMA26-SLOWHORSES', 'Slow Horses', 0.08, { liquidity: 6000 }),
      m('KXEMMYDRAMA26-ANDOR', 'Andor', 0.07, { liquidity: 6000 }),
      m('KXEMMYDRAMA26-DIPLOMAT', 'The Diplomat', 0.04, { liquidity: 4000 }),
      m('KXEMMYDRAMA26-FIELD', 'Another series', 0.13, { liquidity: 4000 }),
    ]},
    { ticker: 'KXGTA6SHIP26', title: 'GTA VI ships in 2026 without another delay', subtitle: 'Released for sale on or before Dec 31, 2026', category: 'Culture', series: 'KXGAMES', mee: false, closeTime: iso(NOW + 143 * DAY), markets: [
      m('KXGTA6SHIP26-Y', 'Ships in 2026', 0.62, { liquidity: 14000, volume24h: 11000 }),
    ]},
    { ticker: 'KXTAYALBUM26', title: 'Taylor Swift announces a new studio album in 2026', subtitle: 'Official announcement before Jan 1, 2027', category: 'Culture', series: 'KXMUSIC', mee: false, closeTime: iso(NOW + 143 * DAY), markets: [
      m('KXTAYALBUM26-Y', 'Announced in 2026', 0.41, { liquidity: 11000 }),
    ]},
    { ticker: 'KXTSLADEL26', title: 'Tesla delivers 1.9M+ vehicles in 2026', subtitle: 'Full-year delivery total', category: 'Companies', series: 'KXTSLA', mee: false, closeTime: iso(NOW + 145 * DAY), markets: [
      m('KXTSLADEL26-19M', '>= 1.9M deliveries', 0.37, { liquidity: 10000 }),
    ]},
    { ticker: 'KXAAPLEFOLD26', title: 'Apple announces a foldable iPhone in 2026', subtitle: 'Officially announced at any event', category: 'Companies', series: 'KXAAPL', mee: false, closeTime: iso(NOW + 143 * DAY), markets: [
      m('KXAAPLEFOLD26-Y', 'Announced', 0.47, { liquidity: 12000, volume24h: 9800 }),
    ]},
    { ticker: 'KXOPENAI500B', title: 'OpenAI valued at $500B+ before 2027', subtitle: 'Primary or secondary transaction price', category: 'Companies', series: 'KXOPENAI', mee: false, closeTime: iso(NOW + 143 * DAY), markets: [
      m('KXOPENAI500B-Y', '$500B valuation', 0.44, { liquidity: 13000 }),
    ]},
  ];

  // ---------------- RNG ----------------
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
  const clamp = (p, lo = 0.005, hi = 0.995) => Math.min(hi, Math.max(lo, p));
  const roundTick = (p, tick = 0.01) => Math.round(p / tick) * tick;
  const round2 = x => Math.round(x * 10000) / 10000;

  // ---------------- state ----------------
  const events = new Map();   // ticker -> event obj
  const markets = new Map();  // ticker -> market obj (quote fields live here)
  const runtime = new Map();  // ticker -> {p, anchor, rng, closeTs, liquidity, mee}
  const books = new Map();
  const tapes = new Map();
  const candles = new Map();  // ticker -> {'1m': [], '1h': []}
  const anomalies = [];       // newest first, capped
  const startedAt = Date.now();

  // ---------------- portfolio (localStorage) ----------------
  const store = {
    load() {
      try {
        return {
          balance: parseFloat(localStorage.getItem('kx_balance')) || 10000,
          totalFees: parseFloat(localStorage.getItem('kx_fees')) || 0,
          positions: JSON.parse(localStorage.getItem('kx_positions') || '{}'),
          orders: JSON.parse(localStorage.getItem('kx_orders') || '[]'),
          nextOrderId: parseInt(localStorage.getItem('kx_next_order') || '1', 10),
        };
      } catch { return { balance: 10000, totalFees: 0, positions: {}, orders: [], nextOrderId: 1 }; }
    },
    save() {
      try {
        localStorage.setItem('kx_balance', String(P.balance));
        localStorage.setItem('kx_fees', String(P.totalFees));
        localStorage.setItem('kx_positions', JSON.stringify(P.positions));
        localStorage.setItem('kx_orders', JSON.stringify(P.orders.slice(0, 300)));
        localStorage.setItem('kx_next_order', String(P.nextOrderId));
      } catch {}
    },
  };
  const P = store.load();

  // ---------------- seeding ----------------
  function seed() {
    for (const ev of CATALOG) {
      events.set(ev.ticker, { ...ev, markets: ev.markets.map(x => x.ticker) });
      for (const mk of ev.markets) {
        markets.set(mk.ticker, {
          ticker: mk.ticker, eventTicker: ev.ticker, title: mk.title,
          yesSub: mk.yesSub, noSub: mk.noSub, status: 'open', result: '',
          closeTime: mk.closeTime, liquidity: mk.liquidity,
          volume: mk.volume, volume24h: mk.volume24h, openInterest: mk.openInterest,
          last: mk.anchor, prev: mk.anchor, mid: mk.anchor,
          yesBid: 0, yesAsk: 0, yesBidSize: 0, yesAskSize: 0,
          rules: mk.rules, source: 'sim', category: ev.category,
        });
        runtime.set(mk.ticker, {
          p: mk.anchor, anchor: mk.anchor, liquidity: mk.liquidity, mee: ev.mee,
          closeTs: new Date(mk.closeTime).getTime(),
          rng: mulberry32(hashSeed(mk.ticker)), lastTradeTs: 0, lastDir: 0,
        });
        seedHistory(mk.ticker, mk.anchor, mk.volume24h, hashSeed(mk.ticker));
      }
    }
  }

  function seedHistory(ticker, anchor, vol24h, seedV) {
    const rng = mulberry32(seedV ^ 0x9e3779b9);
    const nowMin = Math.floor(Date.now() / 60000) * 60000;
    const store1h = [], store1m = [];

    const hours = 30 * 24;
    let p = anchor;
    const hourClose = new Array(hours);
    for (let i = hours - 1; i >= 0; i--) {
      hourClose[i] = p;
      const vol = 0.004 + 0.02 * p * (1 - p);
      p = clamp(p - gauss(rng) * vol + (0.5 - p) * 0.002, 0.01, 0.99);
    }
    const hourStart = Math.floor(nowMin / 3600000) * 3600000 - (hours - 1) * 3600000;
    for (let i = 0; i < hours; i++) {
      const c = hourClose[i];
      const o = i === 0 ? c : hourClose[i - 1];
      const w = 0.003 + 0.012 * rng();
      store1h.push({
        t_open: hourStart + i * 3600000, o: round2(o), h: round2(clamp(Math.max(o, c) + w * rng())),
        l: round2(clamp(Math.min(o, c) - w * rng())), c: round2(c),
        v: Math.max(1, Math.round((vol24h / 24) * (0.3 + rng() * 1.4))),
      });
    }

    const mins = 4 * 60;
    p = anchor;
    const minClose = new Array(mins);
    for (let i = mins - 1; i >= 0; i--) {
      minClose[i] = p;
      const vol = 0.0008 + 0.004 * p * (1 - p);
      p = clamp(p - gauss(rng) * vol + (anchor - p) * 0.004, 0.01, 0.99);
    }
    const minStart = nowMin - (mins - 1) * 60000;
    for (let i = 0; i < mins; i++) {
      const c = minClose[i];
      const o = i === 0 ? c : minClose[i - 1];
      const w = 0.0006 + 0.003 * rng();
      store1m.push({
        t_open: minStart + i * 60000, o: round2(o), h: round2(clamp(Math.max(o, c) + w * rng())),
        l: round2(clamp(Math.min(o, c) - w * rng())), c: round2(c),
        v: Math.max(0, Math.round((vol24h / 240) * (0.2 + rng() * 2.2))),
      });
    }
    candles.set(ticker, { '1m': store1m, '1h': store1h });
  }

  // ---------------- order book ----------------
  function sizeAt(liquidity, level, rng) {
    const base = liquidity / 25;
    return Math.max(5, base * (1 / (1 + level * 0.7)) * (0.4 + rng() * 1.6));
  }
  function buildBook(ticker) {
    const mkt = markets.get(ticker), rt = runtime.get(ticker);
    if (!mkt || !rt || mkt.status !== 'open') return;
    const mid = mkt.mid;
    const tight = rt.liquidity > 15000 ? 0.01 : 0.02;
    const spread = mid <= 0.03 || mid >= 0.97 ? 0.01 : tight;
    const bestBid = clamp(roundTick(mid - spread / 2), 0.01, 0.98);
    const bestAsk = clamp(Math.max(bestBid + 0.01, roundTick(mid + spread / 2)), 0.02, 0.99);
    const bids = [], asks = [];
    for (let i = 0; i < 7; i++) {
      const bp = roundTick(bestBid - i * 0.01);
      if (bp <= 0.001) break;
      bids.push([round2(bp), Math.round(sizeAt(rt.liquidity, i, rt.rng) * 100) / 100]);
      const ap = roundTick(bestAsk + i * 0.01);
      if (ap >= 0.999) break;
      asks.push([round2(ap), Math.round(sizeAt(rt.liquidity, i, rt.rng) * 100) / 100]);
    }
    books.set(ticker, { bids, asks, ts: Date.now() });
  }

  // ---------------- live tick ----------------
  const candleMinute = new Map();
  function bumpCandle(ticker, price, vol) {
    const minute = Math.floor(Date.now() / 60000) * 60000;
    const storeM = candles.get(ticker)?.['1m'];
    if (!storeM) return;
    let bar = candleMinute.get(ticker);
    if (!bar || bar.t !== minute) {
      if (bar) { storeM.push({ t_open: bar.t, o: round2(bar.o), h: round2(bar.h), l: round2(bar.l), c: round2(bar.c), v: Math.round(bar.v) }); if (storeM.length > 420) storeM.shift(); }
      bar = { t: minute, o: price, h: price, l: price, c: price, v: 0 };
      candleMinute.set(ticker, bar);
    }
    bar.h = Math.max(bar.h, price); bar.l = Math.min(bar.l, price); bar.c = price; bar.v += vol;
  }

  function pushTrade(ticker, trade) {
    let tape = tapes.get(ticker);
    if (!tape) { tape = []; tapes.set(ticker, tape); }
    tape.unshift(trade);
    if (tape.length > 80) tape.pop();
  }

  function lognormalSize(rng, liquidity) {
    return Math.exp(Math.log(Math.max(20, liquidity / 120)) + gauss(rng) * 0.9);
  }

  function tick() {
    const nowTs = Date.now();
    for (const [ticker, rt] of runtime) {
      const mkt = markets.get(ticker);
      if (!mkt || mkt.status !== 'open') continue;
      const rng = rt.rng;
      const volBase = 0.0016 + 0.006 * rt.p * (1 - rt.p);
      const timeToClose = rt.closeTs - nowTs;
      const urgency = timeToClose < 2 * 86400000 ? 1.8 : 1;
      let dp = (rt.anchor - rt.p) * 0.006 + gauss(rng) * volBase * urgency;
      if (rng() < 0.004) dp += (rng() - 0.5) * (0.04 + 0.10 * rng());
      rt.p = clamp(rt.p + dp, 0.01, 0.99);

      mkt.prev = mkt.last;
      mkt.mid = roundTick(rt.p);
      buildBook(ticker);
      const book = books.get(ticker);
      if (book) {
        mkt.yesBid = book.bids[0]?.[0] || 0; mkt.yesBidSize = book.bids[0]?.[1] || 0;
        mkt.yesAsk = book.asks[0]?.[0] || 0; mkt.yesAskSize = book.asks[0]?.[1] || 0;
      }

      const lambda = Math.min(0.55, (rt.liquidity / 40000) * 0.5 + 0.02) * urgency;
      if (rng() < lambda && book) {
        const buySide = rng() < 0.5 + (rt.p - mkt.last) * 2;
        const levels = buySide ? book.asks : book.bids;
        let remaining = Math.max(10, lognormalSize(rng, rt.liquidity));
        let filled = 0, cost = 0;
        for (const [price, size] of levels) {
          if (remaining <= 0) break;
          const take = Math.min(remaining, size);
          filled += take; cost += take * price; remaining -= take;
        }
        if (filled > 0) {
          mkt.last = round2(cost / filled);
          mkt.volume += filled; mkt.volume24h += filled;
          mkt.openInterest = Math.max(0, mkt.openInterest + filled * (rng() < 0.7 ? 1 : -0.4));
          rt.lastTradeTs = nowTs; rt.lastDir = buySide ? 1 : -1;
          pushTrade(ticker, { ts: nowTs, side: buySide ? 'buy' : 'sell', price: mkt.last, size: Math.round(filled) });
          bumpCandle(ticker, mkt.last, filled);
        }
      }
    }
    settleDue();
    matchRestingOrders();
  }

  function settleDue() {
    const nowIso = new Date().toISOString();
    for (const mkt of markets.values()) {
      if (mkt.status === 'open' && mkt.closeTime <= nowIso) {
        const rt = runtime.get(mkt.ticker);
        const resultYes = Math.random() < (rt ? rt.p : mkt.mid);
        mkt.status = 'settled'; mkt.result = resultYes ? 'YES' : 'NO';
        mkt.last = mkt.mid = resultYes ? 1 : 0;
        mkt.yesBid = mkt.yesAsk = resultYes ? 1 : 0; mkt.yesBidSize = mkt.yesAskSize = 0;
        onSettlement(mkt.ticker, resultYes);
      }
    }
  }

  // ---------------- trading ----------------
  const FEE_RATE = 0.07;
  const feeFor = (c, p) => Math.round(FEE_RATE * c * p * (1 - p) * 100) / 100;

  function fillAgainstBook(ticker, side, action, qty) {
    const book = books.get(ticker);
    if (!book || (!book.bids.length && !book.asks.length)) return null;
    const lifting = (side === 'yes' && action === 'buy') || (side === 'no' && action === 'sell');
    const levels = (lifting ? book.asks : book.bids)
      .map(([p, s]) => ({ p: side === 'yes' ? p : 1 - p, s }))
      .sort((a, b) => action === 'buy' ? a.p - b.p : b.p - a.p);
    let remaining = qty, filled = 0, cost = 0;
    for (const lv of levels) {
      if (remaining <= 0) break;
      if (lv.p <= 0 || lv.p >= 1) continue;
      const take = Math.min(remaining, lv.s);
      filled += take; cost += take * lv.p; remaining -= take;
    }
    if (filled <= 0) return null;
    return { filled, avgPrice: cost / filled, unfilled: remaining };
  }

  function posKey(ticker, side) { return ticker + '|' + side; }

  function applyFill(ticker, side, action, filled, avgPrice, fees, record = true) {
    if (action === 'buy') {
      const totalCost = filled * avgPrice + fees;
      if (P.balance < totalCost) return { error: 'Insufficient buying power' };
      P.balance -= totalCost; P.totalFees += fees;
      const key = posKey(ticker, side);
      const pos = P.positions[key] || { qty: 0, avgPrice: 0, realizedPnl: 0 };
      const newQty = pos.qty + filled;
      pos.avgPrice = (pos.avgPrice * pos.qty + avgPrice * filled) / newQty;
      pos.qty = newQty;
      P.positions[key] = pos;
    } else {
      const key = posKey(ticker, side);
      const pos = P.positions[key];
      const sellQty = Math.min(filled, pos ? pos.qty : 0);
      if (sellQty <= 0) return { error: 'No position to sell' };
      const proceeds = sellQty * avgPrice - fees;
      const pnl = (avgPrice - pos.avgPrice) * sellQty;
      P.balance += proceeds; P.totalFees += fees;
      pos.qty -= sellQty; pos.realizedPnl = (pos.realizedPnl || 0) + pnl;
      filled = sellQty;
    }
    let orderId = null;
    if (record) {
      orderId = P.nextOrderId++;
      P.orders.unshift({ id: orderId, ts: Date.now(), ticker, side, action, type: 'market', qty: filled, price: avgPrice, status: 'filled', filled_qty: filled, avg_fill_price: avgPrice, fees, note: '' });
    }
    store.save();
    return { ok: true, orderId, filledQty: filled, avgFillPrice: avgPrice, fees };
  }

  function placeOrder({ marketTicker, side, action, type, qty, price }) {
    const mkt = markets.get(marketTicker);
    if (!mkt) return { error: 'Unknown market' };
    if (mkt.status !== 'open') return { error: 'Market is not open for trading' };
    if (!['yes', 'no'].includes(side) || !['buy', 'sell'].includes(action)) return { error: 'Bad side/action' };
    if (!(qty > 0)) return { error: 'Quantity must be positive' };
    qty = Math.round(qty);

    if (type === 'market') {
      const res = fillAgainstBook(marketTicker, side, action, qty);
      if (!res) return { error: 'No liquidity available' };
      const fees = feeFor(res.filled, res.avgPrice);
      const out = applyFill(marketTicker, side, action, res.filled, res.avgPrice, fees);
      if (out.error) return out;
      out.status = res.unfilled > 0 ? 'partial' : 'filled';
      return out;
    }

    if (type === 'limit') {
      if (!(price > 0 && price < 1)) return { error: 'Limit price must be between 0 and 1' };
      price = Math.round(price * 100) / 100;
      const res = fillAgainstBook(marketTicker, side, action, qty);
      let filledNow = 0, avgNow = 0;
      if (res) {
        const marketable = action === 'buy' ? res.avgPrice <= price + 1e-9 : res.avgPrice >= price - 1e-9;
        if (marketable) { filledNow = res.filled; avgNow = res.avgPrice; }
      }
      const remainingQty = qty - filledNow;
      if (remainingQty <= 0) {
        const fees = feeFor(filledNow, avgNow);
        const out = applyFill(marketTicker, side, action, filledNow, avgNow, fees);
        if (out.error) return out;
        out.status = 'filled';
        return out;
      }
      if (action === 'buy') {
        const reserve = remainingQty * price + feeFor(remainingQty, price);
        if (P.balance < reserve) return { error: 'Insufficient buying power' };
        P.balance -= reserve;
      } else {
        const pos = P.positions[posKey(marketTicker, side)];
        if (!pos || pos.qty < remainingQty) return { error: 'Cannot sell more than your position' };
      }
      const id = P.nextOrderId++;
      P.orders.unshift({ id, ts: Date.now(), ticker: marketTicker, side, action, type: 'limit', qty, price, status: filledNow > 0 ? 'partial' : 'open', filled_qty: filledNow, avg_fill_price: avgNow, fees: 0, note: 'resting' });
      if (filledNow > 0) applyFill(marketTicker, side, action, filledNow, avgNow, feeFor(filledNow, avgNow), false);
      store.save();
      return { ok: true, orderId: id, status: filledNow > 0 ? 'partial' : 'open', filledQty: filledNow, avgFillPrice: avgNow, restingQty: remainingQty };
    }
    return { error: 'Unknown order type' };
  }

  function cancelOrder(id) {
    const ord = P.orders.find(o => o.id === id);
    if (!ord) return { error: 'Order not found' };
    if (!['open', 'partial'].includes(ord.status)) return { error: 'Order is not active' };
    const remaining = ord.qty - ord.filled_qty;
    if (ord.action === 'buy' && remaining > 0) P.balance += remaining * ord.price + feeFor(remaining, ord.price);
    ord.status = 'cancelled'; ord.note = 'user cancelled';
    store.save();
    return { ok: true };
  }

  function matchRestingOrders() {
    for (const ord of P.orders) {
      if (ord.type !== 'limit' || !['open', 'partial'].includes(ord.status)) continue;
      const mkt = markets.get(ord.ticker);
      if (!mkt || mkt.status !== 'open') { ord.status = 'cancelled'; ord.note = 'market closed'; continue; }
      const book = books.get(ord.ticker);
      if (!book) continue;
      const remaining = ord.qty - ord.filled_qty;
      if (remaining <= 0) continue;
      let cross = false;
      if (ord.side === 'yes' && ord.action === 'buy' && book.asks.length) cross = book.asks[0][0] <= ord.price;
      else if (ord.side === 'yes' && ord.action === 'sell' && book.bids.length) cross = book.bids[0][0] >= ord.price;
      else if (ord.side === 'no' && ord.action === 'buy' && book.bids.length) cross = (1 - book.bids[0][0]) <= ord.price;
      else if (ord.side === 'no' && ord.action === 'sell' && book.asks.length) cross = (1 - book.asks[0][0]) >= ord.price;
      if (!cross) continue;
      if (ord.action === 'buy') P.balance += remaining * ord.price + feeFor(remaining, ord.price); // release reserve
      const fees = feeFor(remaining, ord.price);
      const out = applyFill(ord.ticker, ord.side, ord.action, remaining, ord.price, fees, false);
      if (out.error) { ord.status = 'cancelled'; ord.note = out.error; continue; }
      ord.status = 'filled'; ord.filled_qty = ord.qty; ord.avg_fill_price = ord.price; ord.fees = fees; ord.note = 'crossed';
      store.save();
    }
  }

  function onSettlement(ticker, resultYes) {
    for (const side of ['yes', 'no']) {
      const key = posKey(ticker, side);
      const pos = P.positions[key];
      if (!pos || pos.qty <= 0) continue;
      const win = (side === 'yes') === resultYes;
      const payout = win ? pos.qty : 0;
      const pnl = payout - pos.avgPrice * pos.qty;
      P.balance += payout;
      pos.realizedPnl = (pos.realizedPnl || 0) + pnl;
      pos.qty = 0;
    }
    for (const ord of P.orders) {
      if (ord.ticker === ticker && ['open', 'partial'].includes(ord.status)) {
        const remaining = ord.qty - ord.filled_qty;
        if (ord.action === 'buy' && remaining > 0) P.balance += remaining * ord.price + feeFor(remaining, ord.price);
        ord.status = 'cancelled'; ord.note = 'market settled';
      }
    }
    store.save();
  }

  function portfolioSummary() {
    const positions = [];
    for (const [key, pos] of Object.entries(P.positions)) {
      if (pos.qty <= 0) continue;
      const [ticker, side] = key.split('|');
      const mkt = markets.get(ticker);
      const mark = side === 'yes' ? (mkt ? mkt.mid : pos.avgPrice) : (mkt ? 1 - mkt.mid : pos.avgPrice);
      const marketValue = mark * pos.qty;
      positions.push({
        ticker, side, qty: pos.qty, avgPrice: pos.avgPrice,
        mark: round2(mark), marketValue: Math.round(marketValue * 100) / 100,
        cost: Math.round(pos.avgPrice * pos.qty * 100) / 100,
        unrealizedPnl: Math.round((marketValue - pos.avgPrice * pos.qty) * 100) / 100,
        realizedPnl: pos.realizedPnl || 0,
        title: mkt ? mkt.title : ticker,
        status: mkt ? mkt.status : 'open', result: mkt ? mkt.result : '',
      });
    }
    const marketValue = positions.reduce((s, p) => s + p.marketValue, 0);
    const unrealized = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
    let realized = 0;
    for (const pos of Object.values(P.positions)) realized += pos.realizedPnl || 0;
    return {
      balance: Math.round(P.balance * 100) / 100,
      marketValue: Math.round(marketValue * 100) / 100,
      totalValue: Math.round((P.balance + marketValue) * 100) / 100,
      unrealizedPnl: Math.round(unrealized * 100) / 100,
      realizedPnl: Math.round(realized * 100) / 100,
      totalFees: P.totalFees,
      positions,
    };
  }

  // ---------------- analytics ----------------
  const MEE_SUM_FLAG = 0.025, MEE_ARB_ASK = 0.99, MEE_ARB_BID = 1.01, WIDE_SPREAD_TICKS = 4, FAST_MOVE = 0.05;
  let lastMids = new Map();

  function openMarketsList() { return [...markets.values()].filter(m => m.status === 'open'); }
  const r4 = x => Math.round(x * 10000) / 10000;

  function scan() {
    const nowTs = Date.now();
    const findings = [];
    const open = openMarketsList();

    for (const ev of events.values()) {
      if (!ev.mee) continue;
      const mkts = open.filter(m => m.eventTicker === ev.ticker);
      if (mkts.length < 2) continue;
      const sumMid = mkts.reduce((s, m) => s + (m.mid || 0), 0);
      const sumAsk = mkts.reduce((s, m) => s + (m.yesAsk > 0 ? m.yesAsk : 1), 0);
      const sumBid = mkts.reduce((s, m) => s + (m.yesBid > 0 ? m.yesBid : 0), 0);
      const dev = sumMid - 1;
      if (Math.abs(dev) >= MEE_SUM_FLAG) findings.push({ ts: nowTs, kind: 'mee_sum', scope: ev.ticker, severity: Math.abs(dev), payload: { title: ev.title, markets: mkts.length, sumMid: r4(sumMid), deviation: r4(dev) } });
      if (sumAsk < MEE_ARB_ASK) findings.push({ ts: nowTs, kind: 'mee_arb', scope: ev.ticker, severity: 1 - sumAsk, payload: { title: ev.title, direction: 'buy_all_yes', sumAsk: r4(sumAsk), edge: r4(1 - sumAsk) } });
      if (sumBid > MEE_ARB_BID) findings.push({ ts: nowTs, kind: 'mee_arb', scope: ev.ticker, severity: sumBid - 1, payload: { title: ev.title, direction: 'sell_all_yes', sumBid: r4(sumBid), edge: r4(sumBid - 1) } });
    }

    for (const m of open) {
      if (m.yesBid > 0 && m.yesAsk > 0) {
        const spreadTicks = Math.round((m.yesAsk - m.yesBid) / 0.01);
        if (spreadTicks >= WIDE_SPREAD_TICKS && m.volume24h > 500) {
          findings.push({ ts: nowTs, kind: 'wide_spread', scope: m.ticker, severity: spreadTicks, payload: { title: m.title, bid: m.yesBid, ask: m.yesAsk, spreadTicks, volume24h: m.volume24h } });
        }
      }
      const prev = lastMids.get(m.ticker);
      if (prev && nowTs - prev.ts <= 10 * 60000) {
        const move = Math.abs((m.mid || 0) - prev.mid);
        if (move >= FAST_MOVE) findings.push({ ts: nowTs, kind: 'fast_move', scope: m.ticker, severity: move, payload: { title: m.title, from: r4(prev.mid), to: r4(m.mid), move: r4(m.mid - prev.mid), windowSec: Math.round((nowTs - prev.ts) / 1000) } });
      }
    }

    for (const m of open) {
      const prev = lastMids.get(m.ticker);
      if (!prev || nowTs - prev.ts > 5 * 60000) lastMids.set(m.ticker, { mid: m.mid, ts: nowTs });
    }

    for (const f of findings) { anomalies.unshift({ id: anomalies.length + 1, ...f }); }
    if (anomalies.length > 300) anomalies.length = 300;
    return findings;
  }

  function meeSummary() {
    const out = [];
    const open = openMarketsList();
    for (const ev of events.values()) {
      if (!ev.mee) continue;
      const mkts = open.filter(m => m.eventTicker === ev.ticker);
      if (mkts.length < 2) continue;
      const sumMid = mkts.reduce((s, m) => s + (m.mid || 0), 0);
      const sumAsk = mkts.reduce((s, m) => s + (m.yesAsk > 0 ? m.yesAsk : 1), 0);
      const sumBid = mkts.reduce((s, m) => s + (m.yesBid > 0 ? m.yesBid : 0), 0);
      out.push({ event: ev.ticker, title: ev.title, markets: mkts.length, sumMid: r4(sumMid), sumAsk: r4(sumAsk), sumBid: r4(sumBid), deviation: r4(sumMid - 1) });
    }
    return out.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation));
  }

  // ---------------- candle aggregation ----------------
  function aggregate(rows, bucketMs) {
    const out = [];
    let cur = null;
    for (const r of rows) {
      const b = Math.floor(r.t_open / bucketMs) * bucketMs;
      if (!cur || cur.t_open !== b) { if (cur) out.push(cur); cur = { t_open: b, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }; }
      else { cur.h = Math.max(cur.h, r.h); cur.l = Math.min(cur.l, r.l); cur.c = r.c; cur.v += r.v; }
    }
    if (cur) out.push(cur);
    return out;
  }
  function getCandles(ticker, interval, limit = 180) {
    const c = candles.get(ticker);
    if (!c) return [];
    if (interval === '1m' || interval === '1h') return c[interval].slice(-limit);
    if (interval === '15m') return aggregate(c['1m'].slice(-(limit * 15)), 15 * 60000);
    if (interval === '1d') return aggregate(c['1h'].slice(-(limit * 24)), 86400000);
    return [];
  }

  // ---------------- boot ----------------
  let started = false;
  function start() {
    if (started) return;
    started = true;
    seed();
    for (const t of markets.keys()) buildBook(t);
    for (const m of openMarketsList()) lastMids.set(m.ticker, { mid: m.mid, ts: Date.now() });
    tick();
    setTimeout(scan, 3000);
    setInterval(tick, 1000);
    setInterval(scan, 8000);
  }

  return {
    start, events, markets, books, tapes,
    getBook: t => books.get(t) || { bids: [], asks: [] },
    getTape: t => tapes.get(t) || [],
    getCandles, placeOrder, cancelOrder, portfolioSummary,
    orderList: () => P.orders.slice(0, 200),
    anomalies: () => anomalies, meeSummary,
    categories: () => [...new Set(CATALOG.map(e => e.category))],
    counts: () => ({ events: events.size, markets: markets.size, openMarkets: openMarketsList().length }),
    startedAt,
  };
})();
