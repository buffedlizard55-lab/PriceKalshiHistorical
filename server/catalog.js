'use strict';
// Seed catalog of events and markets. Written as an original dataset modeled
// on the kinds of prediction contracts a real exchange lists (politics,
// economics, crypto, sports, weather, science, culture, companies).
// `anchor` = latent fair probability the engine mean-reverts around.
// Mutually exclusive (MEE) events intentionally drift a little so the
// analytics layer has real sum-of-probabilities structure to inspect.

const DAY = 86400000;
function iso(ts) { return new Date(ts).toISOString(); }

const now = Date.now();

// helper: market shorthand
function m(ticker, title, anchor, opts = {}) {
  return {
    ticker, title, anchor,
    yesSub: opts.yesSub || 'Yes',
    noSub: opts.noSub || 'No',
    liquidity: opts.liquidity ?? 8000,
    volume: opts.volume ?? Math.round(anchor * (opts.liquidity ?? 8000) * (3 + Math.random() * 30)),
    volume24h: opts.volume24h ?? Math.round((opts.volume ?? 0) * (0.05 + Math.random() * 0.3)),
    openInterest: opts.openInterest ?? Math.round((opts.volume ?? 0) * (0.2 + Math.random() * 0.5)),
    closeTime: opts.closeTime || iso(now + 30 * DAY),
    rules: opts.rules || '',
  };
}

const events = [
  // ---------------- POLITICS ----------------
  {
    ticker: 'KXPRES28DEM', title: 'Democratic nominee for President 2028',
    subtitle: 'Who will the Democratic Party nominate?', category: 'Politics',
    series: 'KXPRES28', mee: true, closeTime: iso(now + 700 * DAY),
    markets: [
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
    ],
  },
  {
    ticker: 'KXPRES28GOP', title: 'Republican nominee for President 2028',
    subtitle: 'Who will the Republican Party nominate?', category: 'Politics',
    series: 'KXPRES28', mee: true, closeTime: iso(now + 700 * DAY),
    markets: [
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
    ],
  },
  {
    ticker: 'KXHOUSE26', title: 'Republicans hold the House after the 2026 midterms',
    subtitle: 'Control of the U.S. House of Representatives', category: 'Politics',
    series: 'KXCONGRESS26', mee: false, closeTime: iso(now + 100 * DAY),
    markets: [m('KXHOUSE26-GOP', 'Republicans keep the majority', 0.57, { liquidity: 38000, volume24h: 42000 })],
  },
  {
    ticker: 'KXSENATE26', title: 'Republicans hold the Senate after the 2026 midterms',
    subtitle: 'Control of the U.S. Senate', category: 'Politics',
    series: 'KXCONGRESS26', mee: false, closeTime: iso(now + 100 * DAY),
    markets: [m('KXSENATE26-GOP', 'Republicans keep the majority', 0.83, { liquidity: 31000, volume24h: 27000 })],
  },
  {
    ticker: 'KXFEDSEP26', title: 'Fed cuts rates at the September 2026 FOMC meeting',
    subtitle: 'FOMC decision — September 16-17, 2026', category: 'Politics',
    series: 'KXFED', mee: false, closeTime: iso(now + 38 * DAY),
    markets: [m('KXFEDSEP26-CUT', 'Fed cuts the target range', 0.72, { liquidity: 46000, volume24h: 55000 })],
  },
  {
    ticker: 'KXFEDEND26', title: 'Fed policy rate range on December 31, 2026',
    subtitle: 'Upper bound of the fed funds target range', category: 'Politics',
    series: 'KXFED', mee: true, closeTime: iso(now + 143 * DAY),
    markets: [
      m('KXFEDEND26-LT325', 'Below 3.25%', 0.18, { liquidity: 12000 }),
      m('KXFEDEND26-325350', '3.25% - 3.50%', 0.36, { liquidity: 18000, volume24h: 16000 }),
      m('KXFEDEND26-350375', '3.50% - 3.75%', 0.31, { liquidity: 16000 }),
      m('KXFEDEND26-GTE375', '3.75% or above', 0.15, { liquidity: 10000 }),
    ],
  },
  {
    ticker: 'KXSHUTDOWN26', title: 'US government shutdown before October 1, 2026',
    subtitle: 'Any lapse in appropriations', category: 'Politics',
    series: 'KXSHUTDOWN', mee: false, closeTime: iso(now + 51 * DAY),
    markets: [m('KXSHUTDOWN26-Y', 'Shutdown occurs', 0.34, { liquidity: 22000, volume24h: 19000 })],
  },

  // ---------------- ECONOMICS ----------------
  {
    ticker: 'KXCPIAUG26', title: 'August 2026 CPI year-over-year inflation',
    subtitle: 'BLS release, September 2026', category: 'Economics',
    series: 'KXCPI', mee: true, closeTime: iso(now + 33 * DAY),
    markets: [
      m('KXCPIAUG26-LT24', 'Below 2.4%', 0.13, { liquidity: 11000 }),
      m('KXCPIAUG26-2427', '2.4% - 2.7%', 0.38, { liquidity: 17000, volume24h: 13000 }),
      m('KXCPIAUG26-2730', '2.7% - 3.0%', 0.34, { liquidity: 15000 }),
      m('KXCPIAUG26-GTE30', '3.0% or above', 0.15, { liquidity: 9000 }),
    ],
  },
  {
    ticker: 'KXNFPAUG26', title: 'August nonfarm payrolls at or above 100k',
    subtitle: 'BLS employment report', category: 'Economics',
    series: 'KXNFP', mee: false, closeTime: iso(now + 26 * DAY),
    markets: [m('KXNFPAUG26-100K', 'Payrolls >= 100,000', 0.63, { liquidity: 14000 })],
  },
  {
    ticker: 'KXRECESSION26', title: 'US recession before 2027',
    subtitle: 'Two consecutive negative GDP quarters or NBER declaration', category: 'Economics',
    series: 'KXRECESSION', mee: false, closeTime: iso(now + 143 * DAY),
    markets: [m('KXRECESSION26-Y', 'Recession in 2026', 0.24, { liquidity: 19000, volume24h: 15000 })],
  },

  // ---------------- CRYPTO ----------------
  {
    ticker: 'KXBTC831', title: 'Bitcoin price on August 31, 2026 at 12 PM ET',
    subtitle: 'Settles on the reference index price', category: 'Crypto',
    series: 'KXBTC', mee: true, closeTime: iso(now + 21 * DAY),
    markets: [
      m('KXBTC831-LT100K', 'Below $100,000', 0.08, { liquidity: 21000, volume24h: 24000 }),
      m('KXBTC831-100110', '$100,000 - $110,000', 0.21, { liquidity: 26000, volume24h: 31000 }),
      m('KXBTC831-110120', '$110,000 - $120,000', 0.30, { liquidity: 30000, volume24h: 39000 }),
      m('KXBTC831-120130', '$120,000 - $130,000', 0.25, { liquidity: 24000, volume24h: 26000 }),
      m('KXBTC831-GTE130K', '$130,000 or above', 0.16, { liquidity: 18000, volume24h: 17000 }),
    ],
  },
  {
    ticker: 'KXETH831', title: 'Ethereum price on August 31, 2026 at 12 PM ET',
    subtitle: 'Settles on the reference index price', category: 'Crypto',
    series: 'KXETH', mee: true, closeTime: iso(now + 21 * DAY),
    markets: [
      m('KXETH831-LT3K', 'Below $3,000', 0.16, { liquidity: 12000 }),
      m('KXETH831-3K4K', '$3,000 - $4,000', 0.38, { liquidity: 16000, volume24h: 14000 }),
      m('KXETH831-4K5K', '$4,000 - $5,000', 0.31, { liquidity: 14000 }),
      m('KXETH831-GTE5K', '$5,000 or above', 0.15, { liquidity: 9000 }),
    ],
  },
  {
    ticker: 'KXBTC150K26', title: 'Bitcoin reaches $150,000 in 2026',
    subtitle: 'Any trade at or above $150k before Jan 1, 2027', category: 'Crypto',
    series: 'KXBTC', mee: false, closeTime: iso(now + 143 * DAY),
    markets: [m('KXBTC150K26-Y', 'BTC hits $150k', 0.33, { liquidity: 27000, volume24h: 22000 })],
  },
  {
    ticker: 'KXSOLETF26', title: 'Solana spot ETF approved in the US in 2026',
    subtitle: 'SEC approval of a spot SOL ETP', category: 'Crypto',
    series: 'KXETF', mee: false, closeTime: iso(now + 143 * DAY),
    markets: [m('KXSOLETF26-Y', 'Approved in 2026', 0.56, { liquidity: 13000 })],
  },

  // ---------------- SPORTS ----------------
  {
    ticker: 'KXMLB-26AUG11LADNYM', title: 'Dodgers beat the Mets — August 11',
    subtitle: 'MLB moneyline', category: 'Sports',
    series: 'KXMLB', mee: false, closeTime: iso(now + 1 * DAY),
    markets: [m('KXMLB-26AUG11LADNYM-LAD', 'Los Angeles Dodgers win', 0.64, { liquidity: 16000, volume24h: 21000 })],
  },
  {
    ticker: 'KXMLB-26AUG11NYYBOS', title: 'Yankees beat the Red Sox — August 11',
    subtitle: 'MLB moneyline', category: 'Sports',
    series: 'KXMLB', mee: false, closeTime: iso(now + 1 * DAY),
    markets: [m('KXMLB-26AUG11NYYBOS-NYY', 'New York Yankees win', 0.52, { liquidity: 15000, volume24h: 19000 })],
  },
  {
    ticker: 'KXMLB-26AUG11PHIATL', title: 'Phillies beat the Braves — August 11',
    subtitle: 'MLB moneyline', category: 'Sports',
    series: 'KXMLB', mee: false, closeTime: iso(now + 1 * DAY),
    markets: [m('KXMLB-26AUG11PHIATL-PHI', 'Philadelphia Phillies win', 0.55, { liquidity: 13000, volume24h: 15000 })],
  },
  {
    ticker: 'KXWS26', title: '2026 World Series winner',
    subtitle: 'Who wins the 2026 World Series?', category: 'Sports',
    series: 'KXMLB', mee: true, closeTime: iso(now + 82 * DAY),
    markets: [
      m('KXWS26-LAD', 'Los Angeles Dodgers', 0.18, { liquidity: 20000, volume24h: 17000 }),
      m('KXWS26-NYY', 'New York Yankees', 0.13, { liquidity: 17000 }),
      m('KXWS26-PHI', 'Philadelphia Phillies', 0.10, { liquidity: 13000 }),
      m('KXWS26-ATL', 'Atlanta Braves', 0.08, { liquidity: 11000 }),
      m('KXWS26-BAL', 'Baltimore Orioles', 0.07, { liquidity: 9000 }),
      m('KXWS26-HOU', 'Houston Astros', 0.06, { liquidity: 8000 }),
      m('KXWS26-SEA', 'Seattle Mariners', 0.06, { liquidity: 8000 }),
      m('KXWS26-CHC', 'Chicago Cubs', 0.05, { liquidity: 7000 }),
      m('KXWS26-FIELD', 'Another team', 0.24, { liquidity: 9000 }),
    ],
  },
  {
    ticker: 'KXSB61', title: 'Super Bowl LXI winner',
    subtitle: 'February 2027', category: 'Sports',
    series: 'KXNFL', mee: true, closeTime: iso(now + 180 * DAY),
    markets: [
      m('KXSB61-KC', 'Kansas City Chiefs', 0.16, { liquidity: 23000, volume24h: 20000 }),
      m('KXSB61-PHI', 'Philadelphia Eagles', 0.13, { liquidity: 18000 }),
      m('KXSB61-BUF', 'Buffalo Bills', 0.12, { liquidity: 16000 }),
      m('KXSB61-BAL', 'Baltimore Ravens', 0.09, { liquidity: 12000 }),
      m('KXSB61-SF', 'San Francisco 49ers', 0.08, { liquidity: 11000 }),
      m('KXSB61-DET', 'Detroit Lions', 0.08, { liquidity: 10000 }),
      m('KXSB61-GB', 'Green Bay Packers', 0.06, { liquidity: 8000 }),
      m('KXSB61-DAL', 'Dallas Cowboys', 0.05, { liquidity: 9000 }),
      m('KXSB61-FIELD', 'Another team', 0.20, { liquidity: 10000 }),
    ],
  },
  {
    ticker: 'KXUSOPEN26M', title: 'US Open men’s singles champion 2026',
    subtitle: 'Tennis — Flushing Meadows', category: 'Sports',
    series: 'KXUSOPEN', mee: true, closeTime: iso(now + 34 * DAY),
    markets: [
      m('KXUSOPEN26M-ALCARAZ', 'Carlos Alcaraz', 0.38, { liquidity: 19000, volume24h: 16000 }),
      m('KXUSOPEN26M-SINNER', 'Jannik Sinner', 0.34, { liquidity: 18000, volume24h: 15000 }),
      m('KXUSOPEN26M-DJOKOVIC', 'Novak Djokovic', 0.07, { liquidity: 9000 }),
      m('KXUSOPEN26M-ZVEREV', 'Alexander Zverev', 0.05, { liquidity: 7000 }),
      m('KXUSOPEN26M-FRITZ', 'Taylor Fritz', 0.04, { liquidity: 7000 }),
      m('KXUSOPEN26M-FIELD', 'Another player', 0.10, { liquidity: 6000 }),
    ],
  },

  // ---------------- WEATHER ----------------
  {
    ticker: 'KXNYHEAT-26AUG15', title: 'NYC hits 90°F or hotter on August 15',
    subtitle: 'Central Park official high temperature', category: 'Weather',
    series: 'KXNYTEMP', mee: false, closeTime: iso(now + 5 * DAY),
    markets: [m('KXNYHEAT-26AUG15-90F', 'High >= 90°F', 0.27, { liquidity: 11000, volume24h: 12000 })],
  },
  {
    ticker: 'KXHURLAND26', title: 'Three or more hurricanes make US landfall in 2026',
    subtitle: 'Named hurricanes, any intensity', category: 'Weather',
    series: 'KXHURRICANE', mee: false, closeTime: iso(now + 112 * DAY),
    markets: [m('KXHURLAND26-3PLUS', '3+ landfalls', 0.31, { liquidity: 12000 })],
  },
  {
    ticker: 'KXCAT4LAND26', title: 'Category 4+ hurricane makes US landfall in 2026',
    subtitle: 'At landfall intensity', category: 'Weather',
    series: 'KXHURRICANE', mee: false, closeTime: iso(now + 112 * DAY),
    markets: [m('KXCAT4LAND26-Y', 'Cat 4+ landfall', 0.14, { liquidity: 10000, volume24h: 8000 })],
  },

  // ---------------- SCIENCE & TECH ----------------
  {
    ticker: 'KXSTARSHIP26', title: 'Starship deploys payload to orbit in 2026',
    subtitle: 'SpaceX Starship orbital payload deployment', category: 'Science & Tech',
    series: 'KXSPACE', mee: false, closeTime: iso(now + 143 * DAY),
    markets: [m('KXSTARSHIP26-Y', 'Payload deployed', 0.58, { liquidity: 10000 })],
  },
  {
    ticker: 'KXAGI26', title: 'A frontier lab declares AGI before 2027',
    subtitle: 'OpenAI, Google DeepMind, or Anthropic publicly declares AGI', category: 'Science & Tech',
    series: 'KXAI', mee: false, closeTime: iso(now + 143 * DAY),
    markets: [m('KXAGI26-Y', 'AGI declared', 0.12, { liquidity: 12000, volume24h: 9500 })],
  },
  {
    ticker: 'KXROBOTAXI26', title: 'Tesla unsupervised robotaxi in 5+ states by end of 2026',
    subtitle: 'Commercial, no safety driver', category: 'Science & Tech',
    series: 'KXTSLA', mee: false, closeTime: iso(now + 143 * DAY),
    markets: [m('KXROBOTAXI26-Y', '5+ states live', 0.08, { liquidity: 9000 })],
  },

  // ---------------- CULTURE ----------------
  {
    ticker: 'KXEMMYDRAMA26', title: '2026 Emmy — Outstanding Drama Series',
    subtitle: '78th Primetime Emmy Awards', category: 'Culture',
    series: 'KXEMMY', mee: true, closeTime: iso(now + 41 * DAY),
    markets: [
      m('KXEMMYDRAMA26-SEVERANCE', 'Severance', 0.34, { liquidity: 12000, volume24h: 9000 }),
      m('KXEMMYDRAMA26-WHITELOTUS', 'The White Lotus', 0.18, { liquidity: 9000 }),
      m('KXEMMYDRAMA26-TLOU', 'The Last of Us', 0.14, { liquidity: 8000 }),
      m('KXEMMYDRAMA26-SLOWHORSES', 'Slow Horses', 0.08, { liquidity: 6000 }),
      m('KXEMMYDRAMA26-ANDOR', 'Andor', 0.07, { liquidity: 6000 }),
      m('KXEMMYDRAMA26-DIPLOMAT', 'The Diplomat', 0.04, { liquidity: 4000 }),
      m('KXEMMYDRAMA26-FIELD', 'Another series', 0.13, { liquidity: 4000 }),
    ],
  },
  {
    ticker: 'KXGTA6SHIP26', title: 'GTA VI ships in 2026 without another delay',
    subtitle: 'Released for sale on or before Dec 31, 2026', category: 'Culture',
    series: 'KXGAMES', mee: false, closeTime: iso(now + 143 * DAY),
    markets: [m('KXGTA6SHIP26-Y', 'Ships in 2026', 0.62, { liquidity: 14000, volume24h: 11000 })],
  },
  {
    ticker: 'KXTAYALBUM26', title: 'Taylor Swift announces a new studio album in 2026',
    subtitle: 'Official announcement before Jan 1, 2027', category: 'Culture',
    series: 'KXMUSIC', mee: false, closeTime: iso(now + 143 * DAY),
    markets: [m('KXTAYALBUM26-Y', 'Announced in 2026', 0.41, { liquidity: 11000 })],
  },

  // ---------------- COMPANIES ----------------
  {
    ticker: 'KXTSLADEL26', title: 'Tesla delivers 1.9M+ vehicles in 2026',
    subtitle: 'Full-year delivery total', category: 'Companies',
    series: 'KXTSLA', mee: false, closeTime: iso(now + 145 * DAY),
    markets: [m('KXTSLADEL26-19M', '>= 1.9M deliveries', 0.37, { liquidity: 10000 })],
  },
  {
    ticker: 'KXAAPLEFOLD26', title: 'Apple announces a foldable iPhone in 2026',
    subtitle: 'Officially announced at any event', category: 'Companies',
    series: 'KXAAPL', mee: false, closeTime: iso(now + 143 * DAY),
    markets: [m('KXAAPLEFOLD26-Y', 'Announced', 0.47, { liquidity: 12000, volume24h: 9800 })],
  },
  {
    ticker: 'KXOPENAI500B', title: 'OpenAI valued at $500B+ before 2027',
    subtitle: 'Primary or secondary transaction price', category: 'Companies',
    series: 'KXOPENAI', mee: false, closeTime: iso(now + 143 * DAY),
    markets: [m('KXOPENAI500B-Y', '$500B valuation', 0.44, { liquidity: 13000 })],
  },
];

module.exports = { events };
