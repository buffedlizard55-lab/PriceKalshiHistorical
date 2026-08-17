'use strict';
// Paper-trading engine: market and limit orders matched against the live
// order book, position tracking, balance management, and settlement. Fees
// follow the classic quadratic prediction-market fee shape:
//   fee = feeRate * contracts * price * (1 - price)   (charged on taker flow)

const { q, ensureAccount } = require('./db');
const cfg = require('./config');
const engine = require('./engine');

const FEE_RATE = 0.07;

function init() { ensureAccount(cfg.STARTING_BALANCE); }

function getAccount() {
  return q('SELECT * FROM account WHERE id = 1').get();
}

function feeFor(contracts, price) {
  return Math.round(FEE_RATE * contracts * price * (1 - price) * 100) / 100;
}

function getPositions() {
  const rows = q('SELECT * FROM positions WHERE qty > 0').all();
  return rows.map(r => {
    const mkt = q('SELECT ticker, title, mid, status, result FROM markets WHERE ticker = ?').get(r.ticker);
    const mark = r.side === 'yes' ? (mkt ? mkt.mid : r.avg_price) : (mkt ? 1 - mkt.mid : r.avg_price);
    const marketValue = mark * r.qty;
    const cost = r.avg_price * r.qty;
    return {
      ticker: r.ticker, side: r.side, qty: r.qty, avgPrice: r.avg_price,
      mark: Math.round(mark * 10000) / 10000,
      marketValue: Math.round(marketValue * 100) / 100,
      cost: Math.round(cost * 100) / 100,
      unrealizedPnl: Math.round((marketValue - cost) * 100) / 100,
      realizedPnl: r.realized_pnl,
      title: mkt ? mkt.title : r.ticker,
      status: mkt ? mkt.status : 'open',
      result: mkt ? mkt.result : '',
    };
  });
}

function portfolioSummary() {
  const acct = getAccount();
  const positions = getPositions();
  const marketValue = positions.reduce((s, p) => s + p.marketValue, 0);
  const unrealized = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const realized = q('SELECT COALESCE(SUM(realized_pnl),0) r FROM positions').get().r;
  return {
    balance: Math.round(acct.balance * 100) / 100,
    marketValue: Math.round(marketValue * 100) / 100,
    totalValue: Math.round((acct.balance + marketValue) * 100) / 100,
    unrealizedPnl: Math.round(unrealized * 100) / 100,
    realizedPnl: Math.round(realized * 100) / 100,
    totalFees: acct.total_fees,
    positions,
  };
}

// Fill an aggressive order against the engine's live book.
// side: 'yes' | 'no'; action: 'buy' | 'sell'.
// Buying NO is executed against the YES book's complement (price 1-p).
function fillAgainstBook(marketTicker, side, action, qty) {
  const book = engine.getBook(marketTicker);
  if (!book || (!book.bids.length && !book.asks.length)) return null;

  // We work in YES-price space. Buying YES lifts YES asks; selling YES hits
  // YES bids. Buying NO hits YES bids at (1 - bid); selling NO lifts YES asks at (1 - ask).
  const lifting = (side === 'yes' && action === 'buy') || (side === 'no' && action === 'sell');
  const levelsRaw = lifting ? book.asks.slice() : book.bids.slice();
  const levels = levelsRaw.map(([p, s]) => ({ p: side === 'yes' ? p : 1 - p, s })).sort((a, b) =>
    action === 'buy' ? a.p - b.p : b.p - a.p);

  let remaining = qty, filled = 0, cost = 0;
  const fills = [];
  for (const lv of levels) {
    if (remaining <= 0) break;
    if (lv.p <= 0 || lv.p >= 1) continue;
    const take = Math.min(remaining, lv.s);
    filled += take; cost += take * lv.p; remaining -= take;
    fills.push({ price: lv.p, size: take });
  }
  if (filled <= 0) return null;
  return { filled, avgPrice: cost / filled, fills, unfilled: remaining };
}

function placeOrder({ marketTicker, side, action, type, qty, price }) {
  const mkt = q('SELECT * FROM markets WHERE ticker = ?').get(marketTicker);
  if (!mkt) return { error: 'Unknown market' };
  if (mkt.status !== 'open') return { error: 'Market is not open for trading' };
  if (!['yes', 'no'].includes(side) || !['buy', 'sell'].includes(action)) return { error: 'Bad side/action' };
  if (!(qty > 0)) return { error: 'Quantity must be positive' };
  qty = Math.round(qty);

  const acct = getAccount();

  if (type === 'market') {
    const res = fillAgainstBook(marketTicker, side, action, qty);
    if (!res) return { error: 'No liquidity available' };
    const fees = feeFor(res.filled, res.avgPrice);
    return executeFill(marketTicker, side, action, res.filled, res.avgPrice, fees, acct, {
      type: 'market', qty, status: res.unfilled > 0 ? 'partial' : 'filled',
      note: res.unfilled > 0 ? `unfilled ${res.unfilled}` : '',
    });
  }

  if (type === 'limit') {
    if (!(price > 0 && price < 1)) return { error: 'Limit price must be between 0 and 1' };
    price = Math.round(price * 100) / 100;
    // Marketable limit? Fill immediately at the limit price.
    const res = fillAgainstBook(marketTicker, side, action, qty);
    let filledNow = 0, avgNow = 0;
    if (res) {
      const marketable = action === 'buy' ? res.avgPrice <= price + 1e-9 : res.avgPrice >= price - 1e-9;
      if (marketable) {
        filledNow = res.filled; avgNow = res.avgPrice;
      }
    }
    const remainingQty = qty - filledNow;
    if (remainingQty <= 0) {
      const fees = feeFor(filledNow, avgNow);
      return executeFill(marketTicker, side, action, filledNow, avgNow, fees, acct, {
        type: 'limit', qty, price, status: 'filled', note: '',
      });
    }
    // Reserve buying power for resting buy orders.
    if (action === 'buy') {
      const reserve = remainingQty * price + feeFor(remainingQty, price);
      if (acct.balance < reserve) return { error: 'Insufficient buying power' };
      q('UPDATE account SET balance = balance - ? WHERE id = 1').run(reserve);
    } else {
      const pos = q('SELECT qty FROM positions WHERE ticker = ? AND side = ?').get(marketTicker, side);
      if (!pos || pos.qty < remainingQty) return { error: 'Cannot sell more than your position' };
    }
    const info = q(`INSERT INTO orders (ts,ticker,side,action,type,qty,price,status,filled_qty,avg_fill_price,fees,note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(Date.now(), marketTicker, side, action, 'limit', qty, price,
        filledNow > 0 ? 'partial' : 'open', filledNow, avgNow, 0, 'resting').lastInsertRowid;
    return { ok: true, orderId: Number(info), status: filledNow > 0 ? 'partial' : 'open',
      filledQty: filledNow, avgFillPrice: avgNow, restingQty: remainingQty };
  }
  return { error: 'Unknown order type' };
}

function executeFill(marketTicker, side, action, filled, avgPrice, fees, acct, meta) {
  if (action === 'buy') {
    const totalCost = filled * avgPrice + fees;
    if (acct.balance < totalCost) return { error: 'Insufficient buying power' };
    q('UPDATE account SET balance = balance - ?, total_fees = total_fees + ? WHERE id = 1').run(totalCost, fees);
    const pos = q('SELECT * FROM positions WHERE ticker = ? AND side = ?').get(marketTicker, side);
    if (pos) {
      const newQty = pos.qty + filled;
      const newAvg = (pos.avg_price * pos.qty + avgPrice * filled) / newQty;
      q('UPDATE positions SET qty = ?, avg_price = ? WHERE ticker = ? AND side = ?').run(newQty, newAvg, marketTicker, side);
    } else {
      q('INSERT INTO positions (ticker, side, qty, avg_price) VALUES (?,?,?,?)').run(marketTicker, side, filled, avgPrice);
    }
  } else {
    const pos = q('SELECT * FROM positions WHERE ticker = ? AND side = ?').get(marketTicker, side);
    const sellQty = Math.min(filled, pos ? pos.qty : 0);
    if (sellQty <= 0) return { error: 'No position to sell' };
    const proceeds = sellQty * avgPrice - fees;
    const pnl = (avgPrice - pos.avg_price) * sellQty;
    q('UPDATE account SET balance = balance + ?, total_fees = total_fees + ? WHERE id = 1').run(proceeds, fees);
    q('UPDATE positions SET qty = qty - ?, realized_pnl = realized_pnl + ? WHERE ticker = ? AND side = ?')
      .run(sellQty, pnl, marketTicker, side);
    filled = sellQty;
  }
  let id = null;
  if (meta.record !== false) {
    id = q(`INSERT INTO orders (ts,ticker,side,action,type,qty,price,status,filled_qty,avg_fill_price,fees,note)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(Date.now(), marketTicker, side, action, meta.type, meta.qty, avgPrice,
        meta.status, filled, avgPrice, fees, meta.note).lastInsertRowid;
  }
  return { ok: true, orderId: id ? Number(id) : undefined, status: meta.status, filledQty: filled, avgFillPrice: avgPrice, fees };
}

// Called by the engine each tick: match resting limit orders against the book.
function matchRestingOrders() {
  const open = q("SELECT * FROM orders WHERE type='limit' AND status IN ('open','partial')").all();
  for (const ord of open) {
    const mkt = q('SELECT status FROM markets WHERE ticker = ?').get(ord.ticker);
    if (!mkt || mkt.status !== 'open') { cancelOrder(ord.id, 'market closed'); continue; }
    const book = engine.getBook(ord.ticker);
    if (!book) continue;
    const remaining = ord.qty - ord.filled_qty;
    if (remaining <= 0) continue;

    let cross = false;
    if (ord.side === 'yes' && ord.action === 'buy' && book.asks.length) cross = book.asks[0][0] <= ord.price;
    else if (ord.side === 'yes' && ord.action === 'sell' && book.bids.length) cross = book.bids[0][0] >= ord.price;
    else if (ord.side === 'no' && ord.action === 'buy' && book.bids.length) cross = (1 - book.bids[0][0]) <= ord.price;
    else if (ord.side === 'no' && ord.action === 'sell' && book.asks.length) cross = (1 - book.asks[0][0]) >= ord.price;
    if (!cross) continue;

    const fees = feeFor(remaining, ord.price);
    if (ord.action === 'buy') {
      // Release the original reserve first, then executeFill charges the actual cost.
      q('UPDATE account SET balance = balance + ? WHERE id = 1').run(remaining * ord.price + feeFor(remaining, ord.price));
    }
    const acct = getAccount();
    const res = executeFill(ord.ticker, ord.side, ord.action, remaining, ord.price, fees, acct, {
      type: 'limit', qty: ord.qty, status: 'filled', note: 'resting order crossed', record: false,
    });
    if (res.error) { cancelOrder(ord.id, res.error); continue; }
    q("UPDATE orders SET status='filled', filled_qty=?, avg_fill_price=?, fees=?, note='crossed' WHERE id=?")
      .run(ord.qty, ord.price, fees, ord.id);
  }
}

function cancelOrder(id, reason = 'user cancelled') {
  const ord = q('SELECT * FROM orders WHERE id = ?').get(id);
  if (!ord) return { error: 'Order not found' };
  if (!['open', 'partial'].includes(ord.status)) return { error: 'Order is not active' };
  const remaining = ord.qty - ord.filled_qty;
  if (ord.action === 'buy' && remaining > 0) {
    q('UPDATE account SET balance = balance + ? WHERE id = 1').run(remaining * ord.price + feeFor(remaining, ord.price));
  }
  q("UPDATE orders SET status='cancelled', note=? WHERE id=?").run(reason, id);
  return { ok: true };
}

// Market settlement: pay out positions $1 (winning side) or $0.
function onSettlement(ticker, resultYes) {
  const rows = q('SELECT * FROM positions WHERE ticker = ? AND qty > 0').all(ticker);
  for (const pos of rows) {
    const win = (pos.side === 'yes') === resultYes;
    const payout = win ? pos.qty : 0;
    const pnl = payout - pos.avg_price * pos.qty;
    q('UPDATE account SET balance = balance + ? WHERE id = 1').run(payout);
    q('UPDATE positions SET qty = 0, realized_pnl = realized_pnl + ? WHERE ticker = ? AND side = ?')
      .run(pnl, ticker, pos.side);
  }
  // cancel resting orders in this market without reserve math (market gone)
  const open = q("SELECT id FROM orders WHERE ticker = ? AND status IN ('open','partial')").all(ticker);
  for (const o of open) cancelOrder(o.id, 'market settled');
}

function orderList() {
  return q('SELECT * FROM orders ORDER BY ts DESC LIMIT 200').all();
}

module.exports = { init, placeOrder, cancelOrder, matchRestingOrders, onSettlement, portfolioSummary, orderList, getPositions };
