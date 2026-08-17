"""
backtest.metrics — PnL, Sharpe, Brier, calibration for prediction markets.
"""
import math
from typing import List, Tuple

def pnl_summary(fills, initial_balance=10000):
    """Extract realized/unrealized from fills list returned by engine."""
    # fills is list of Fill objects; we can just compute sum
    fees = sum(f.fee for f in fills)
    # gross PnL requires settlement info — approximate as sum of sell proceeds minus buy costs
    # For binary markets, true PnL is only known after settlement. Here we just report fees and count.
    return {"fills": len(fills), "fees": round(fees,2)}

def sharpe(returns: List[float], periods_per_year=365*24*60):
    """Annualized Sharpe from per-minute returns."""
    if not returns or len(returns) < 2:
        return 0
    import statistics
    mu = statistics.mean(returns)
    sigma = statistics.pstdev(returns) if len(returns)>1 else 0
    if sigma == 0:
        return 0
    return mu/sigma * math.sqrt(periods_per_year)

def brier_score(preds: List[float], outcomes: List[int]):
    """Mean squared error of probabilistic preds vs {0,1} settlement."""
    if not preds: return None
    return sum((p - o)**2 for p, o in zip(preds, outcomes)) / len(preds)

def log_loss(preds: List[float], outcomes: List[int], eps=1e-6):
    tot = 0
    for p,o in zip(preds, outcomes):
        p = min(1-eps, max(eps, p))
        tot += o*math.log(p) + (1-o)*math.log(1-p)
    return -tot/len(preds) if preds else None

def calibration_table(preds: List[float], outcomes: List[int], bins=10):
    """Reliability diagram buckets."""
    import collections
    buckets = collections.defaultdict(list)
    for p,o in zip(preds, outcomes):
        b = min(bins-1, int(p*bins))
        buckets[b].append((p,o))
    out = []
    for b in range(bins):
        lst = buckets[b]
        if not lst:
            out.append({"bin": b, "range": f"{b/bins:.1f}-{(b+1)/bins:.1f}", "count": 0, "mean_pred": None, "empirical": None})
        else:
            mp = sum(x[0] for x in lst)/len(lst)
            emp = sum(x[1] for x in lst)/len(lst)
            out.append({"bin": b, "range": f"{b/bins:.1f}-{(b+1)/bins:.1f}", "count": len(lst), "mean_pred": round(mp,3), "empirical": round(emp,3)})
    return out

def max_drawdown(equity: List[Tuple[int,float]]):
    """equity is list of (ts, value). Returns (max_dd, peak, trough)."""
    if not equity:
        return (0,0,0)
    peak = equity[0][1]
    max_dd = 0
    best_peak = worst_trough = peak
    for _, v in equity:
        if v > peak:
            peak = v
        dd = (peak - v)/peak if peak else 0
        if dd > max_dd:
            max_dd = dd
            best_peak = peak
            worst_trough = v
    return (round(max_dd,4), round(best_peak,2), round(worst_trough,2))
