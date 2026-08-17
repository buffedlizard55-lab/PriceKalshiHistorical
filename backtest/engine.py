"""
backtest.engine — fill simulation for binary Yes/No markets.
Walks captured L2 books, applies Kalshi's quadratic fee, tracks positions,
settlement ($1/$0), and supports both backtest (historical replay) and paper/live modes.

Fills mirror server/trading.js::fillAgainstBook but use *captured* books,
not synthetic ones. This is the core of realistic slippage modeling.

Usage:
  from backtest.engine import BacktestEngine, Order, Side
  eng = BacktestEngine(initial_balance=10000)
  eng.load_books("data/exchange.db")  # or pass DataFrame
  eng.place_market_order(ticker="KXBTC831-110120", side="yes", action="buy", qty=20)
  # or replay a strategy
  fills = eng.replay_strategy(signals_df) -> fills, equity_curve
"""
import json
import math
import sqlite3
from dataclasses import dataclass, field
from typing import List, Dict, Optional, Tuple

FEE_RATE = 0.07  # 0.07 * contracts * p * (1-p) as in trading.js

def fee_for(qty: float, price: float) -> float:
    p = min(0.995, max(0.005, price))
    return FEE_RATE * qty * p * (1 - p)

@dataclass
class Level:
    price: float
    size: float

@dataclass
class Order:
    ticker: str
    side: str  # yes | no
    action: str  # buy | sell
    qty: float
    price: Optional[float] = None  # limit price, None for market
    type: str = "market"  # market | limit
    ts: int = 0

@dataclass
class Position:
    ticker: str
    side: str
    qty: float = 0
    avg_price: float = 0
    realized_pnl: float = 0

@dataclass
class Fill:
    ticker: str
    side: str
    action: str
    qty: float
    price: float
    fee: float
    ts: int
    note: str = ""

class BacktestEngine:
    def __init__(self, initial_balance: float = 10000, db_path: str = None):
        self.initial_balance = initial_balance
        self.balance = initial_balance
        self.total_fees = 0.0
        self.positions: Dict[Tuple[str,str], Position] = {}
        self.fills: List[Fill] = []
        self.equity_curve: List[Tuple[int,float]] = []
        self.db_path = db_path or "data/exchange.db"
        # book cache: ticker -> sorted list of snapshots {ts, bids, asks}
        self.books_by_ticker: Dict[str, List[Dict]] = {}
        self.snapshots_by_ticker: Dict[str, List[Dict]] = {}

    # --- book loading ---
    def load_books_from_db(self, db_path: str = None, limit_per_ticker=5000):
        path = db_path or self.db_path
        import pathlib
        if not pathlib.Path(path).exists():
            print(f"[engine] no db at {path} — run collector first")
            return
        conn = sqlite3.connect(path)
        conn.row_factory = sqlite3.Row
        tickers = [r[0] for r in conn.execute("SELECT DISTINCT ticker FROM book_snapshots").fetchall()]
        for tk in tickers:
            rows = conn.execute("SELECT ts, bids, asks FROM book_snapshots WHERE ticker=? ORDER BY ts DESC LIMIT ?", (tk, limit_per_ticker)).fetchall()
            snaps = []
            for r in rows:
                try:
                    bids = json.loads(r["bids"]) if r["bids"] else []
                    asks = json.loads(r["asks"]) if r["asks"] else []
                    snaps.append({"ts": r["ts"], "bids": bids, "asks": asks})
                except: pass
            snaps.reverse()  # chronological
            self.books_by_ticker[tk] = snaps
        print(f"[engine] loaded books for {len(tickers)} tickers")
        conn.close()

    def load_snapshots_from_db(self, db_path: str = None, limit_per_ticker=10000):
        path = db_path or self.db_path
        import pathlib
        if not pathlib.Path(path).exists():
            return
        conn = sqlite3.connect(path)
        tickers = [r[0] for r in conn.execute("SELECT DISTINCT ticker FROM snapshots").fetchall()]
        for tk in tickers:
            rows = conn.execute("SELECT ts, mid, bid, ask, last, volume_24h FROM snapshots WHERE ticker=? ORDER BY ts DESC LIMIT ?", (tk, limit_per_ticker)).fetchall()
            lst = [{"ts": r[0], "mid": r[1], "bid": r[2], "ask": r[3], "last": r[4], "volume_24h": r[5]} for r in rows]
            lst.reverse()
            self.snapshots_by_ticker[tk] = lst
        conn.close()

    def load_candles_from_db(self, db_path: str = None, interval="1m"):
        path = db_path or self.db_path
        import pathlib
        if not pathlib.Path(path).exists():
            return {}
        conn = sqlite3.connect(path)
        cur = conn.execute("SELECT ticker, t_open, o,h,l,c,v FROM candles WHERE interval=? ORDER BY t_open", (interval,))
        out = {}
        for tk, t_open, o,h,l,c,v in cur.fetchall():
            out.setdefault(tk, []).append({"t_open": t_open, "o": o, "h": h, "l": l, "c": c, "v": v})
        conn.close()
        return out

    # --- core fill logic (port of trading.js fillAgainstBook) ---
    def _book_for(self, ticker, ts):
        """Get most recent book at or before ts. If ts is 0, use latest."""
        books = self.books_by_ticker.get(ticker) or []
        if not books:
            return None
        if not ts:
            return books[-1]
        # binary search
        lo, hi = 0, len(books)-1
        best = None
        while lo <= hi:
            mid = (lo+hi)//2
            if books[mid]["ts"] <= ts:
                best = books[mid]
                lo = mid+1
            else:
                hi = mid-1
        return best or books[0]

    def fill_against_book(self, ticker, side, action, qty, ts=0, limit_price=None) -> Optional[Dict]:
        """
        Walk the book at time ts (0=latest). Returns {filled, avgPrice, fills, unfilled} or None if no book.
        side: yes|no, action: buy|sell
        Mirrors trading.js: lifting = (yes+buy) or (no+sell) hits asks; else hits bids. For NO side, prices are 1-p.
        """
        book = self._book_for(ticker, ts)
        if not book or (not book["bids"] and not book["asks"]):
            # fallback to snapshots mids if no book (e.g., only snapshots collected)
            snaps = self.snapshots_by_ticker.get(ticker)
            if snaps:
                snap = snaps[-1] if not ts else min(snaps, key=lambda s: abs(s["ts"]-ts)) if snaps else None
                if snap and snap["bid"] and snap["ask"]:
                    # synthesize one level each side
                    book = {"bids": [[snap["bid"], 100]], "asks": [[snap["ask"], 100]], "ts": snap["ts"]}
                elif snap and snap["mid"]:
                    book = {"bids": [[snap["mid"]-0.01, 100]], "asks": [[snap["mid"]+0.01, 100]], "ts": snap["ts"]}
                else:
                    return None
            else:
                return None
        lifting = (side == "yes" and action == "buy") or (side == "no" and action == "sell")
        # Build levels in yes-price space then convert if side==no
        raw_levels = (book["asks"][:] if lifting else book["bids"][:])
        levels = []
        for p,s in raw_levels:
            try:
                p = float(p); s = float(s)
                if side == "no":
                    p = 1 - p
                if 0 < p < 1 and s > 0:
                    levels.append((p,s))
            except: pass
        # sort: buy wants cheapest ask, sell wants highest bid
        if action == "buy":
            levels.sort(key=lambda x: x[0])
        else:
            levels.sort(key=lambda x: -x[0])
        # For limit orders, filter to marketable levels only
        if limit_price is not None:
            if action == "buy":
                levels = [lv for lv in levels if lv[0] <= limit_price + 1e-9]
            else:
                levels = [lv for lv in levels if lv[0] >= limit_price - 1e-9]
            if not levels:
                return {"filled": 0, "avgPrice": 0, "fills": [], "unfilled": qty}

        remaining = qty
        filled = 0
        cost = 0
        fills = []
        for p,s in levels:
            if remaining <= 0:
                break
            take = min(remaining, s)
            filled += take
            cost += take * p
            remaining -= take
            fills.append((p, take))
        if filled <= 0:
            return None
        avg = cost / filled
        # price improvement check for limits is handled above; for market we just fill at book
        return {"filled": filled, "avgPrice": avg, "fills": fills, "unfilled": remaining}

    # --- order placement ---
    def place_order(self, order: Order) -> Dict:
        """Execute order immediately against book at order.ts (0=latest). Returns result dict."""
        if order.qty <= 0:
            return {"error": "qty must be >0"}
        if order.side not in ("yes","no") or order.action not in ("buy","sell"):
            return {"error": "bad side/action"}
        res = self.fill_against_book(order.ticker, order.side, order.action, order.qty, ts=order.ts, limit_price=order.price if order.type=="limit" else None)
        if not res or res["filled"] <= 0:
            if order.type == "limit":
                # resting order — not filled immediately, would rest (paper)
                return {"ok": True, "status": "open", "filled": 0, "note": "resting (no cross)"}
            return {"error": "no liquidity / no book at that time"}
        filled = res["filled"]
        avg = res["avgPrice"]
        fee = fee_for(filled, avg)
        # balance / position checks
        key = (order.ticker, order.side)
        pos = self.positions.get(key)
        if order.action == "buy":
            cost = filled * avg + fee
            if self.balance < cost and cost > 0:
                return {"error": f"insufficient buying power: need {cost:.2f} have {self.balance:.2f}"}
            self.balance -= cost
            self.total_fees += fee
            if pos:
                new_qty = pos.qty + filled
                pos.avg_price = (pos.avg_price * pos.qty + avg * filled) / new_qty
                pos.qty = new_qty
            else:
                self.positions[key] = Position(ticker=order.ticker, side=order.side, qty=filled, avg_price=avg)
        else:  # sell
            if not pos or pos.qty < filled - 1e-9:
                # allow partial sell of what we have
                avail = pos.qty if pos else 0
                if avail <= 0:
                    return {"error": "no position to sell"}
                # adjust to available
                filled = avail
                fee = fee_for(filled, avg)
            proceeds = filled * avg - fee
            pnl = (avg - pos.avg_price) * filled
            self.balance += proceeds
            self.total_fees += fee
            pos.qty -= filled
            pos.realized_pnl += pnl
            if pos.qty <= 1e-9:
                pos.qty = 0
        fill = Fill(ticker=order.ticker, side=order.side, action=order.action, qty=filled, price=avg, fee=fee, ts=order.ts or int(time.time()*1000), note=f"{order.type} fill")
        self.fills.append(fill)
        # equity curve point
        self.equity_curve.append((fill.ts, self.portfolio_value_at(fill.ts)))
        return {"ok": True, "filled": filled, "avgPrice": avg, "fee": fee, "balance": self.balance, "status": "filled" if res["unfilled"]==0 else "partial"}

    def portfolio_value_at(self, ts=0):
        """Mark to mid at ts (or latest) + balance."""
        total = self.balance
        for (tk, side), pos in self.positions.items():
            if pos.qty <= 0:
                continue
            # mark using latest snapshot mid or candle close
            mid = 0.5
            snaps = self.snapshots_by_ticker.get(tk)
            if snaps:
                # find nearest snapshot at/before ts
                if ts:
                    cand = None
                    for s in reversed(snaps):
                        if s["ts"] <= ts:
                            cand = s
                            break
                    mid = (cand["mid"] if cand else snaps[-1]["mid"]) if cand or snaps else 0.5
                else:
                    mid = snaps[-1]["mid"] if snaps else 0.5
            # convert if side==no: mark is 1-mid
            mark = mid if side=="yes" else 1-mid if mid else 0.5
            total += pos.qty * mark
        return total

    def settle_market(self, ticker: str, result_yes: bool):
        """Settle all positions in ticker: Yes wins if result_yes else No wins. Pays $1 per winning contract."""
        for side in ("yes","no"):
            key = (ticker, side)
            pos = self.positions.get(key)
            if not pos or pos.qty <= 0:
                continue
            wins = (side == "yes") == result_yes
            payout = pos.qty if wins else 0
            pnl = payout - pos.avg_price * pos.qty
            self.balance += payout
            pos.realized_pnl += pnl
            pos.qty = 0
            self.fills.append(Fill(ticker=ticker, side=side, action="settle", qty=0, price=1 if wins else 0, fee=0, ts=int(time.time()*1000), note=f"settled {'YES' if result_yes else 'NO'}"))

    # --- replay ---
    def replay_signals(self, signals):
        """
        signals: iterable of dicts with {ts, ticker, side, action, qty, type, price?}
        Sorted by ts; executes sequentially.
        Returns (fills, equity_curve, summary)
        """
        signals = sorted(signals, key=lambda s: s.get("ts",0))
        for s in signals:
            o = Order(ticker=s["ticker"], side=s.get("side","yes"), action=s.get("action","buy"),
                      qty=s.get("qty", 10), price=s.get("price"), type=s.get("type","market"), ts=s.get("ts",0))
            res = self.place_order(o)
            if "error" in res:
                # log but continue
                pass
        summary = self.summary()
        return self.fills, self.equity_curve, summary

    def summary(self):
        unreal = 0
        for (tk, side), pos in self.positions.items():
            if pos.qty <= 0: continue
            snaps = self.snapshots_by_ticker.get(tk)
            mid = snaps[-1]["mid"] if snaps and snaps[-1].get("mid") else 0.5
            mark = mid if side=="yes" else 1-mid
            unreal += (mark - pos.avg_price) * pos.qty
        realized = sum(p.realized_pnl for p in self.positions.values())
        return {
            "balance": round(self.balance,2),
            "total_fees": round(self.total_fees,2),
            "unrealized": round(unreal,2),
            "realized": round(realized,2),
            "portfolio_value": round(self.portfolio_value_at(),2),
            "positions": [{"ticker": k[0], "side": k[1], "qty": v.qty, "avg": round(v.avg_price,4), "realized": round(v.realized_pnl,2)} for k,v in self.positions.items() if v.qty>0],
            "fills": len(self.fills),
        }

import time  # noqa at bottom to avoid circular
