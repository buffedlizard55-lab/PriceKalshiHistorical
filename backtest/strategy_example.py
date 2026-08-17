"""
backtest.strategy_example — three reference strategies you can backtest immediately.
Runs on the collected SQLite snapshots/books/candles with no manual input.

Strategies:
  1. MeeReversion — fade Σ mids deviation (>2.5¢) on mutually-exclusive events
  2. WideSpreadFade — buy the dip when fast_move ≥5¢ snaps back
  3. Momentum — follow 20-period mid momentum if spread tight

Each produces a signals DataFrame: {ts, ticker, side, action, qty, type, price?}
which is replayed through BacktestEngine against captured books.

Run:
  python -m backtest.strategy_example           # runs all three on last 7 days
  python -m backtest.strategy_example --strat mee --balance 10000 --qty 25
"""
import argparse
import json
import logging
import sqlite3
import time
from typing import List, Dict

from .engine import BacktestEngine
from .features import mee_features, market_microstructure

log = logging.getLogger("backtest.example")

# --- helpers ---
def _get_db(db_path):
    import pathlib
    p = pathlib.Path(db_path)
    if not p.exists():
        print(f"[strategy] no db at {db_path} — did you run collector? Using synthetic fallback from Node if available.")
        # fallback: try data/exchange.db
        for alt in ["data/exchange.db", "storage.db"]:
            if pathlib.Path(alt).exists():
                return alt
    return db_path

def _signals_to_df(signals):
    try:
        import pandas as pd
        return pd.DataFrame(signals)
    except Exception:
        return signals

# --- strategies as signal generators ---
def strat_mee_reversion(conn, qty=25, dev_thresh=0.025) -> List[Dict]:
    """
    If Σ mids deviates > thresh from 1, trade the under/overpriced leg:
      sum > 1+thresh => basket rich → sell the richest leg(s)
      sum < 1-thresh => basket cheap → buy the cheapest leg
    Simplified: buy cheapest mid or sell richest mid.
    """
    feats = mee_features(conn)
    signals = []
    now = int(time.time()*1000)
    for f in feats:
        dev = f["deviation"]
        if abs(dev) < dev_thresh:
            continue
        ev = f["event"]
        # get markets in event sorted by mid
        rows = conn.execute("SELECT ticker, mid, yes_bid, yes_ask FROM markets WHERE event_ticker=? AND status='open' ORDER BY mid", (ev,)).fetchall()
        if not rows:
            continue
        if dev < -dev_thresh:
            # cheap basket → buy cheapest (mean reversion up)
            cheapest = rows[0]
            signals.append({"ts": now, "ticker": cheapest[0], "side": "yes", "action": "buy", "qty": qty, "type": "market", "note": f"mee cheap {dev:.3f} {f['sumMid']:.3f}"})
        else:
            # rich basket → sell richest (or buy its No)
            richest = rows[-1]
            signals.append({"ts": now, "ticker": richest[0], "side": "yes", "action": "sell" if _has_position(conn, richest[0]) else "buy", "qty": qty, "type": "market", "note": f"mee rich {dev:.3f}"})
            # alternative: buy NO of richest as hedge
            # signals.append({"ts": now, "ticker": richest[0], "side": "no", "action": "buy", "qty": qty, "type": "market"})
    return signals

def _has_position(conn, ticker):
    try:
        row = conn.execute("SELECT qty FROM positions WHERE ticker=? AND side='yes'", (ticker,)).fetchone()
        return row and row[0] > 0
    except: return False

def strat_fast_move_fade(conn, qty=20, thresh=0.05, spread_max_ticks=3) -> List[Dict]:
    """After a fast move ≥5¢ within 5 min, fade if spread is tight."""
    # use snapshots: compare mid now vs 5-min-ago
    signals = []
    now = int(time.time()*1000)
    five_min_ago = now - 5*60*1000
    for (ticker,) in conn.execute("SELECT ticker FROM markets WHERE status='open'").fetchall():
        cur = conn.execute("SELECT mid, yes_bid, yes_ask FROM markets WHERE ticker=?", (ticker,)).fetchone()
        if not cur or not cur[0]: continue
        mid_now = cur[0]
        # get snapshot 5 min ago
        row = conn.execute("SELECT mid FROM snapshots WHERE ticker=? AND ts>=? ORDER BY ts LIMIT 1", (ticker, five_min_ago)).fetchone()
        if not row: 
            row = conn.execute("SELECT mid FROM snapshots WHERE ticker=? ORDER BY ts DESC LIMIT 10 OFFSET 20", (ticker,)).fetchone()
        if not row: continue
        mid_then = row[0]
        move = mid_now - mid_then
        spread = (cur[2]-cur[1]) if cur[1] and cur[2] else 1
        spread_ticks = round(spread/0.01)
        if abs(move) >= thresh and spread_ticks <= spread_max_ticks:
            # fade: if moved up, sell; if down, buy
            action = "sell" if move > 0 else "buy"
            # need position to sell
            if action == "sell" and not _has_position(conn, ticker):
                # instead buy NO
                signals.append({"ts": now, "ticker": ticker, "side": "no", "action": "buy", "qty": qty, "type": "market", "note": f"fade {move:.3f} spread {spread_ticks}"})
            else:
                signals.append({"ts": now, "ticker": ticker, "side": "yes", "action": action, "qty": qty, "type": "market", "note": f"fade {move:.3f}"})
    return signals

def strat_momentum(conn, qty=15, lookback=20, thresh=0.02) -> List[Dict]:
    """If mid momentum over lookback snapshots > thresh and spread tight, follow trend with limit."""
    signals = []
    now = int(time.time()*1000)
    for (ticker,) in conn.execute("SELECT ticker FROM markets WHERE status='open' LIMIT 60").fetchall():
        rows = conn.execute("SELECT mid, bid, ask FROM snapshots WHERE ticker=? ORDER BY ts DESC LIMIT ?", (ticker, lookback+1)).fetchall()
        if len(rows) < lookback+1:
            continue
        mids = [r[0] for r in reversed(rows)]
        ret = mids[-1] - mids[0]
        spread = (rows[0][2] - rows[0][1]) if rows[0][1] and rows[0][2] else 1
        if spread and spread/0.01 > 3:
            continue
        if ret > thresh:
            # momentum up → buy yes at ask
            signals.append({"ts": now, "ticker": ticker, "side": "yes", "action": "buy", "qty": qty, "type": "market", "note": f"mom +{ret:.3f}"})
        elif ret < -thresh:
            # momentum down → buy no (or sell yes if long)
            if _has_position(conn, ticker):
                signals.append({"ts": now, "ticker": ticker, "side": "yes", "action": "sell", "qty": qty, "type": "market", "note": f"mom {ret:.3f}"})
            else:
                signals.append({"ts": now, "ticker": ticker, "side": "no", "action": "buy", "qty": qty, "type": "market", "note": f"mom {ret:.3f} no"})
    return signals

def run_backtest(strategy_name="all", db_path="data/exchange.db", initial_balance=10000, qty=20):
    db_path = _get_db(db_path)
    conn = sqlite3.connect(db_path)
    eng = BacktestEngine(initial_balance=initial_balance, db_path=db_path)
    print(f"[backtest] loading books/snapshots from {db_path} ...")
    eng.load_books_from_db(db_path)
    eng.load_snapshots_from_db(db_path)

    # generate signals
    all_signals = []
    chosen = []
    if strategy_name in ("mee","all"):
        s = strat_mee_reversion(conn, qty=qty)
        print(f"[strat] mee_reversion: {len(s)} signals")
        if s: print(json.dumps(s[:3], indent=2))
        chosen.extend(s); all_signals.extend(s)
    if strategy_name in ("fade","all"):
        s = strat_fast_move_fade(conn, qty=qty)
        print(f"[strat] fast_move_fade: {len(s)} signals")
        if s: print(json.dumps(s[:3], indent=2))
        chosen.extend(s); all_signals.extend(s)
    if strategy_name in ("mom","all"):
        s = strat_momentum(conn, qty=qty)
        print(f"[strat] momentum: {len(s)} signals")
        if s: print(json.dumps(s[:3], indent=2))
        chosen.extend(s); all_signals.extend(s)

    if not all_signals:
        print("[backtest] no signals — market may be in equilibrium (Σ mids ≈1, spreads tight). Try lowering thresh or wait for poller to accumulate data.")
        # still show a summary with no trades
        summary = eng.summary()
        print(json.dumps(summary, indent=2))
        return summary

    # replay
    fills, curve, summary = eng.replay_signals(all_signals)
    print("\n[backtest] fills:", len(fills))
    for f in fills[:10]:
        print(f"  {f.ticker} {f.side} {f.action} {f.qty} @ {f.price:.3f} fee {f.fee:.3f} ts={f.ts}")
    print("\n[backtest] summary:", json.dumps(summary, indent=2))
    if curve:
        try:
            from .metrics import max_drawdown
            dd, peak, trough = max_drawdown(curve)
            print(f"[metrics] max drawdown {dd:.2%} peak {peak} trough {trough}")
        except Exception as e:
            print(f"[metrics] drawdown fail: {e}")
    # mee features snapshot
    try:
        feats = mee_features(conn)
        print("\n[features] top MEE deviations:")
        for f in feats[:5]:
            print(f"  {f['event']}: Σ={f['sumMid']:.3f} dev={f['deviation']:+.3f} buy_arb={f['is_arb_buy']} sell_arb={f['is_arb_sell']}")
    except Exception as e:
        print(f"[features] fail: {e}")
    conn.close()
    return summary

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--strat", choices=["mee","fade","mom","all"], default="all", help="strategy")
    parser.add_argument("--db", default="data/exchange.db")
    parser.add_argument("--balance", type=float, default=10000)
    parser.add_argument("--qty", type=int, default=20)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    run_backtest(strategy_name=args.strat, db_path=args.db, initial_balance=args.balance, qty=args.qty)
