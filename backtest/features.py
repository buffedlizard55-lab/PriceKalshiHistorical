"""
backtest.features — feature extraction for prediction models.
Ports the live scanner in server/analysis.js into batch features over SQLite,
plus additional microstructure / lifecycle features useful for entry/exit learning.
"""
import json
import sqlite3
import math
from typing import Dict, List

def mee_features(conn: sqlite3.Connection):
    """
    For each mutually-exclusive event, compute Σ mids, Σ bids, Σ asks, deviation.
    Mirrors server/analysis.js::meeSummary() and /api/analysis/mee.
    Returns list sorted by |deviation| desc: {event, title, markets, sumMid, sumBid, sumAsk, deviation}
    """
    conn.row_factory = sqlite3.Row
    evs = conn.execute("SELECT * FROM events WHERE mutually_exclusive=1").fetchall()
    open_mkts = {r["ticker"]: [] for r in evs}
    for r in conn.execute("SELECT * FROM markets WHERE status='open'").fetchall():
        # markets event_ticker col
        try:
            ek = r["event_ticker"]
        except:
            ek = r[1] if len(r)>1 else None
        if ek in open_mkts:
            open_mkts[ek].append(r)
    out = []
    for ev in evs:
        mkts = open_mkts.get(ev["ticker"], [])
        if len(mkts) < 2:
            continue
        sumMid = sum((m["mid"] or 0) for m in mkts)
        sumAsk = sum((m["yes_ask"] if m["yes_ask"] and m["yes_ask"]>0 else 1) for m in mkts)
        sumBid = sum((m["yes_bid"] if m["yes_bid"] and m["yes_bid"]>0 else 0) for m in mkts)
        out.append({
            "event": ev["ticker"], "title": ev["title"], "markets": len(mkts),
            "sumMid": round(sumMid,4), "sumAsk": round(sumAsk,4), "sumBid": round(sumBid,4),
            "deviation": round(sumMid-1,4),
            "is_arb_buy": sumAsk < 0.99, "is_arb_sell": sumBid > 1.01,
            "arb_edge_buy": round(1 - sumAsk,4) if sumAsk < 0.99 else 0,
            "arb_edge_sell": round(sumBid - 1,4) if sumBid > 1.01 else 0,
        })
    out.sort(key=lambda x: abs(x["deviation"]), reverse=True)
    return out

def market_microstructure(conn: sqlite3.Connection, ticker: str, lookback=200):
    """
    For a single ticker, pull recent snapshots and books and compute:
      spread, spreadTicks, mid, volume regime, volatility, book depth.
    Returns dict.

    """
    cur = conn.execute("SELECT mid, bid, ask, last, volume_24h, ts FROM snapshots WHERE ticker=? ORDER BY ts DESC LIMIT ?", (ticker, lookback))
    snaps = cur.fetchall()
    if not snaps:
        return None
    snaps = list(reversed(snaps))  # chronological
    mids = [r[0] for r in snaps]
    bids = [r[1] for r in snaps]
    asks = [r[2] for r in snaps]
    lasts = [r[3] for r in snaps]
    vols = [r[4] for r in snaps]
    # current
    cur_mid, cur_bid, cur_ask = mids[-1], bids[-1], asks[-1]
    spread = (cur_ask - cur_bid) if cur_bid and cur_ask else 0
    spreadTicks = round(spread/0.01) if spread else 0
    # vol stats
    ret5 = (mids[-1] - mids[-6]) if len(mids)>=6 else 0
    ret20 = (mids[-1] - mids[-21]) if len(mids)>=21 else 0
    # realized vol (stdev of 1-step returns)
    rets = [mids[i]-mids[i-1] for i in range(1,len(mids))]
    vol = math.sqrt(sum(r*r for r in rets)/len(rets)) if rets else 0
    # volume regime: last vs median
    import statistics
    vol_med = statistics.median(vols) if vols else 0
    vol_ratio = (vols[-1]/vol_med) if vol_med else 1
    # time to close
    row = conn.execute("SELECT close_time, anchor, liquidity FROM markets WHERE ticker=?", (ticker,)).fetchone()
    ttl_hours = None
    if row and row[0]:
        try:
            import datetime
            ct = datetime.datetime.fromisoformat(row[0].replace("Z","+00:00"))
            ttl_hours = (ct.timestamp() - snaps[-1][5] /1000)/3600 if len(snaps[-1])>5 else None
            # ts is at index 5? Actually tuple is (mid,bid,ask,last,volume_24h,ts) — fix:
            # re-read correctly:
            pass
        except: pass
    # fix ttl: snaps rows were (mid,bid,ask,last,volume_24h,ts)
    # but mids list above loses ts; recompute
    cur2 = conn.execute("SELECT ts FROM snapshots WHERE ticker=? ORDER BY ts DESC LIMIT 1", (ticker,)).fetchone()
    ttl_hours = None
    if row and row[0] and cur2:
        try:
            import datetime
            ct = datetime.datetime.fromisoformat(row[0].replace("Z","+00:00"))
            ttl_hours = (ct.timestamp() - cur2[0]/1000)/3600
        except: pass

    # book depth
    brow = conn.execute("SELECT bids, asks FROM book_snapshots WHERE ticker=? ORDER BY ts DESC LIMIT 1", (ticker,)).fetchone()
    bid_depth = ask_depth = 0
    best_bid = best_ask = 0
    if brow:
        try:
            bids_j = json.loads(brow[0]) if brow[0] else []
            asks_j = json.loads(brow[1]) if brow[1] else []
            bid_depth = sum(s for _, s in bids_j)
            ask_depth = sum(s for _, s in asks_j)
            best_bid = bids_j[0][0] if bids_j else 0
            best_ask = asks_j[0][0] if asks_j else 0
        except: pass

    return {
        "ticker": ticker,
        "mid": cur_mid, "bid": cur_bid, "ask": cur_ask, "last": lasts[-1],
        "spread": round(spread,4), "spreadTicks": spreadTicks,
        "isWide": spreadTicks >= 4,
        "ret5": round(ret5,4), "ret20": round(ret20,4),
        "vol": round(vol,5),
        "volume24h": vols[-1], "volRatio": round(vol_ratio,2),
        "bidDepth": bid_depth, "askDepth": ask_depth, "bestBid": best_bid, "bestAsk": best_ask,
        "imbalance": round((bid_depth - ask_depth)/(bid_depth+ask_depth+1),3) if (bid_depth+ask_depth) else 0,
        "ttlHours": round(ttl_hours,1) if ttl_hours is not None else None,
        "anchor": row[1] if row else None, "liquidity": row[2] if row else None,
    }

def snapshot_features_frame(conn: sqlite3.Connection, limit=5000):
    """
    Load recent snapshots into a pandas DataFrame with derived features.
    Requires pandas (optional). Returns DataFrame or list if pandas not installed.
    """
    try:
        import pandas as pd
    except Exception:
        pd = None
    rows = conn.execute("SELECT ts, ticker, mid, bid, ask, last, volume_24h FROM snapshots ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
    if pd is not None:
        df = pd.DataFrame(rows, columns=["ts","ticker","mid","bid","ask","last","volume_24h"])
        df["spread"] = df["ask"] - df["bid"]
        df["spreadTicks"] = (df["spread"]/0.01).round().astype(int)
        df["datetime"] = pd.to_datetime(df["ts"], unit="ms")
        return df
    else:
        return [{"ts": r[0], "ticker": r[1], "mid": r[2], "bid": r[3], "ask": r[4], "last": r[5], "volume_24h": r[6], "spread": (r[4]-r[3] if r[3] and r[4] else 0)} for r in rows]

def anomaly_clip(conn: sqlite3.Connection, kind=None, limit=200):
    q = "SELECT ts, kind, scope, severity, payload FROM anomalies ORDER BY ts DESC LIMIT ?"
    args = (limit,)
    if kind:
        q = "SELECT ts, kind, scope, severity, payload FROM anomalies WHERE kind=? ORDER BY ts DESC LIMIT ?"
        args = (kind, limit)
    rows = conn.execute(q, args).fetchall()
    out = []
    for ts, k, scope, sev, payload in rows:
        try:
            pl = json.loads(payload) if payload else {}
        except: pl = {}
        out.append({"ts": ts, "kind": k, "scope": scope, "severity": sev, "payload": pl})
    return out

def lifecycle(conn: sqlite3.Connection, ticker: str):
    """Time-series of mid + volume for a market — for chart/backtest warm-up."""
    snaps = conn.execute("SELECT ts, mid, bid, ask, last FROM snapshots WHERE ticker=? ORDER BY ts", (ticker,)).fetchall()
    candles = conn.execute("SELECT t_open, o,h,l,c,v FROM candles WHERE ticker=? AND interval='1m' ORDER BY t_open", (ticker,)).fetchall()
    return {"snapshots": snaps, "candles": candles}
