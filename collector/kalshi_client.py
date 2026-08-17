"""
collector.kalshi_client — thin REST client for Kalshi Trade API v2.
Zero required deps: uses urllib + stdlib. Falls back to `requests` if installed (faster).
Handles: pagination cursors, token-bucket rate limiting, retries with jitter, optional RSA-PSS signing.
"""
import base64
import json
import logging
import random
import time
import urllib.parse
import urllib.request
import urllib.error
from typing import Any, Dict, List, Optional, Tuple

from . import config

log = logging.getLogger("collector.kalshi")

try:
    import requests  # type: ignore
    HAS_REQUESTS = True
except Exception:
    HAS_REQUESTS = False

# --- Rate limiter (token bucket) ---
class TokenBucket:
    def __init__(self, rps: float, burst: float = None):
        self.rps = max(0.1, rps)
        self.capacity = burst if burst is not None else rps * 2
        self.tokens = self.capacity
        self.last = time.monotonic()

    def acquire(self, cost: float = 1.0):
        while True:
            now = time.monotonic()
            elapsed = now - self.last
            self.last = now
            self.tokens = min(self.capacity, self.tokens + elapsed * self.rps)
            if self.tokens >= cost:
                self.tokens -= cost
                return
            need = cost - self.tokens
            sleep = need / self.rps
            # jitter
            sleep = sleep * (0.9 + random.random()*0.2)
            time.sleep(min(sleep, 2.0))

_global_bucket = TokenBucket(config.MAX_RPS)

# --- Auth helper (RSA-PSS) ---
def _load_private_key():
    pem = config.KALSHI_PRIVATE_KEY_PEM
    if config.KALSHI_PRIVATE_KEY_PATH:
        try:
            import pathlib
            p = pathlib.Path(config.KALSHI_PRIVATE_KEY_PATH).expanduser()
            if p.exists():
                pem = p.read_text()
        except Exception as e:
            log.warning("failed to read private key file: %s", e)
    if not pem or "BEGIN" not in pem:
        return None
    try:
        # Try cryptography
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.backends import default_backend
        key = serialization.load_pem_private_key(pem.encode(), password=None, backend=default_backend())
        return key
    except Exception:
        try:
            # Try plain without cryptography — not usable for signing, return raw
            return pem
        except Exception:
            return None

_PRIVATE_KEY = None
def _get_private_key():
    global _PRIVATE_KEY
    if _PRIVATE_KEY is None:
        _PRIVATE_KEY = _load_private_key()
        if _PRIVATE_KEY is not None and not isinstance(_PRIVATE_KEY, str):
            log.info("RSA private key loaded for signed requests")
        elif config.KALSHI_ACCESS_KEY:
            log.warning("KALSHI_ACCESS_KEY set but no valid private key — signed endpoints will fail")
    return _PRIVATE_KEY

def _sign_request(method: str, path: str, timestamp_ms: str, body: str = "") -> Optional[str]:
    if not config.KALSHI_ACCESS_KEY:
        return None
    key = _get_private_key()
    if key is None or isinstance(key, str):
        return None
    try:
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding
        # Kalshi signs: timestamp + method + path + body (path includes query)
        # See https://docs.kalshi.com / kalshi-python reference
        msg = (timestamp_ms + method.upper() + path + body).encode()
        sig = key.sign(msg, padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=padding.PSS.DIGEST_LENGTH), hashes.SHA256())
        return base64.b64encode(sig).decode()
    except Exception as e:
        log.debug("sign failed: %s", e)
        return None

# --- HTTP ---
def _do_fetch(base: str, path: str, params: dict = None, method="GET", body_obj=None, timeout_ms=8000, signed=False) -> Tuple[int, dict, dict]:
    """
    Returns (status_code, json_body_or_empty, headers)
    Uses requests if available, else urllib.
    """
    q = ""
    if params:
        # filter Nones
        clean = {k: v for k, v in params.items() if v is not None and v != ""}
        if clean:
            q = "?" + urllib.parse.urlencode(clean, doseq=True)
    url = base + path + q
    # for signing, path must include query
    sign_path = path + q
    body_str = ""
    headers = {"Accept": "application/json", "User-Agent": "PriceKalshiHistorical/1.0"}
    data = None
    if body_obj is not None:
        body_str = json.dumps(body_obj, separators=(",",":"))
        data = body_str.encode()
        headers["Content-Type"] = "application/json"

    if signed and config.KALSHI_ACCESS_KEY:
        ts = str(int(time.time()*1000))
        sig = _sign_request(method, sign_path, ts, body_str)
        if sig:
            headers["KALSHI-ACCESS-KEY"] = config.KALSHI_ACCESS_KEY
            headers["KALSHI-ACCESS-TIMESTAMP"] = ts
            headers["KALSHI-ACCESS-SIGNATURE"] = sig

    _global_bucket.acquire(cost=1.0)

    if HAS_REQUESTS:
        try:
            fn = requests.get if method=="GET" else requests.post
            # we use requests.request to handle method flexibly
            import requests as rq
            resp = rq.request(method, url, headers=headers, data=data, timeout=timeout_ms/1000)
            try:
                j = resp.json()
            except Exception:
                j = {"_raw": resp.text[:4000]}
            return resp.status_code, j, dict(resp.headers)
        except Exception as e:
            return 0, {"error": str(e)[:500], "_exception": True}, {}
    else:
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout_ms/1000) as r:
                raw = r.read()
                hdrs = dict(r.headers)
                code = r.status
                try:
                    j = json.loads(raw.decode())
                except Exception:
                    j = {"_raw": raw[:4000].decode(errors="ignore")}
                return code, j, hdrs
        except urllib.error.HTTPError as e:
            try:
                raw = e.read()
                j = json.loads(raw.decode())
            except Exception:
                j = {"error": f"HTTP {e.code}", "_raw": (raw[:2000].decode(errors="ignore") if 'raw' in locals() else "")}
            return e.code, j, dict(e.headers) if e.headers else {}
        except Exception as e:
            return 0, {"error": str(e)[:500], "_exception": True}, {}

_UPSTREAM_PROBE_CACHE = {"ok": None, "ts": 0}

def _probe_upstream(base: str, timeout_ms: int = 3000) -> bool:
    """Fast check if Kalshi upstream is reachable. Cached 60s. Returns True if ok."""
    now = time.monotonic()
    if _UPSTREAM_PROBE_CACHE["ts"] and now - _UPSTREAM_PROBE_CACHE["ts"] < 60:
        return _UPSTREAM_PROBE_CACHE["ok"]
    try:
        # quick probe to /markets?limit=1 with short timeout, no retry, no rate-limit cost
        code, j, _ = _do_fetch(base, "/markets", {"limit": 1}, timeout_ms=min(timeout_ms, 3000), signed=False)
        ok = code == 200 and isinstance(j, dict) and ("markets" in j or "ok" in j or code == 200)
        # 429 also means reachable
        if code in (200, 429):
            ok = True
        # 401/403 also means reachable (just auth issue)
        if code in (401, 403):
            ok = True
        _UPSTREAM_PROBE_CACHE["ok"] = ok
        _UPSTREAM_PROBE_CACHE["ts"] = now
        return ok
    except Exception:
        _UPSTREAM_PROBE_CACHE["ok"] = False
        _UPSTREAM_PROBE_CACHE["ts"] = now
        return False

def fetch_with_retry(base, path, params=None, method="GET", body=None, timeout_ms=8000, signed=False, max_retries=4, quick_fail=False):
    # Auto quick-fail if upstream already probed unreachable — saves 30s per failing endpoint in offline/sandbox mode
    auto_quick = _UPSTREAM_PROBE_CACHE["ok"] is False and time.monotonic() - _UPSTREAM_PROBE_CACHE["ts"] < 60
    if auto_quick:
        quick_fail = True
    # If caller hints quick_fail and upstream previously probed as down, skip retries fast
    if quick_fail and _UPSTREAM_PROBE_CACHE["ok"] is False and time.monotonic() - _UPSTREAM_PROBE_CACHE["ts"] < 60:
        return 0, {"error": "upstream unreachable (cached probe)", "_exception": True}, {}
    last = None
    # For initial retries, use shorter timeout when quick_fail requested
    effective_retries = 1 if quick_fail else max_retries
    for attempt in range(effective_retries+1):
        code, body_j, hdrs = _do_fetch(base, path, params, method, body, timeout_ms if not quick_fail else min(timeout_ms, 4000), signed=signed)
        if code == 429:
            # rate-limited — backoff
            sleep = (1.5 ** attempt) + random.random()
            # check Retry-After header if present
            try:
                ra = hdrs.get("Retry-After") or hdrs.get("retry-after")
                if ra:
                    sleep = max(sleep, float(ra))
            except Exception:
                pass
            log.warning("429 rate-limited %s %s — backoff %.1fs (attempt %d)", method, path, sleep, attempt+1)
            time.sleep(sleep)
            continue
        if code in (500,502,503,504) or (code==0 and body_j.get("_exception")):
            # If quick_fail, don't keep retrying — treat as unreachable
            if quick_fail and attempt >= 1:
                return code, body_j, hdrs
            sleep = (1.2 ** attempt) + random.random()*0.5
            if attempt < effective_retries:
                log.debug("retry %s %s code=%s err=%s sleep=%.1fs", path, params, code, str(body_j)[:200], sleep)
                time.sleep(sleep)
                continue
        return code, body_j, hdrs
    return code, body_j, hdrs

# --- High-level client ---
class KalshiClient:
    def __init__(self, base: str = None, timeout_ms: int = None):
        self.base = (base or config.KALSHI_API_BASE).rstrip("/")
        self.timeout_ms = timeout_ms or config.SYNC_TIMEOUT_MS

    def _should_quick_fail(self):
        # During autonomous runs, if upstream already proven unreachable, fail fast
        return _UPSTREAM_PROBE_CACHE["ok"] is False

    # markets
    def get_markets(self, limit=200, cursor=None, status=None, event_ticker=None, series_ticker=None, **kw):
        params = {"limit": limit, "cursor": cursor, "status": status, "event_ticker": event_ticker, "series_ticker": series_ticker}
        params.update(kw)
        quick = self._should_quick_fail()
        code, j, _ = fetch_with_retry(self.base, "/markets", params, timeout_ms=self.timeout_ms, signed=False, quick_fail=quick)
        if code != 200:
            log.debug("get_markets failed %s %s", code, str(j)[:300])
            return None, j
        return j, None

    def get_market(self, ticker: str):
        code, j, _ = fetch_with_retry(self.base, f"/markets/{urllib.parse.quote(ticker, safe='')}", timeout_ms=self.timeout_ms)
        if code != 200:
            return None, j
        return j, None

    def get_orderbook(self, ticker: str):
        code, j, _ = fetch_with_retry(self.base, f"/markets/{urllib.parse.quote(ticker, safe='')}/orderbook", timeout_ms=self.timeout_ms)
        if code != 200:
            return None, j
        return j, None

    def get_orderbooks_batch(self, tickers: List[str]):
        """
        Try batch endpoint /markets/orderbooks?tickers=... if available (added 2026-03),
        else fall back to single calls with throttling.
        The batch endpoint name varies by docs: some say /markets/orderbooks, some /markets/orderbooks with tickers param.
        """
        if not tickers:
            return {}, None
        # Try batch first
        joined = ",".join(tickers)
        # endpoints seen: /markets/orderbooks and /markets/orderbooks?market_tickers= / ?tickers=
        for path in ["/markets/orderbooks"]:
            for param_name in ["tickers", "market_tickers", "ticker"]:
                code, j, _ = fetch_with_retry(self.base, path, {param_name: joined}, timeout_ms=self.timeout_ms)
                if code == 200 and ("orderbooks" in j or "markets" in j or "orderbook" in j or isinstance(j, dict) and any(k in j for k in ["orderbooks","books"])):
                    return j, None
                if code in (404, 405):
                    continue
                if code == 400 and "unknown" in str(j).lower():
                    continue
        # Fallback: single calls
        out = {}
        for t in tickers:
            j, err = self.get_orderbook(t)
            if j and "orderbook" in j:
                out[t] = j["orderbook"]
            time.sleep(0.06)  # ~16 rps inter-call spacing
        return {"orderbooks": out}, None

    def get_trades(self, limit=200, cursor=None, ticker=None, **kw):
        params = {"limit": limit, "cursor": cursor, "ticker": ticker}
        params.update(kw)
        code, j, _ = fetch_with_retry(self.base, "/markets/trades", params, timeout_ms=self.timeout_ms)
        if code != 200:
            return None, j
        return j, None

    def get_events(self, limit=200, cursor=None, with_nested_markets=False, **kw):
        params = {"limit": limit, "cursor": cursor}
        if with_nested_markets:
            params["with_nested_markets"] = "true"
        params.update(kw)
        code, j, _ = fetch_with_retry(self.base, "/events", params, timeout_ms=self.timeout_ms)
        if code != 200:
            return None, j
        return j, None

    def get_series(self, limit=200, cursor=None, **kw):
        params = {"limit": limit, "cursor": cursor}
        params.update(kw)
        code, j, _ = fetch_with_retry(self.base, "/series", params, timeout_ms=self.timeout_ms)
        if code != 200:
            return None, j
        return j, None

    def get_candlesticks(self, tickers: List[str], period_interval: int, start_ts: int = None, end_ts: int = None):
        """
        Batch candles: documented as GET /markets/candlesticks
        Query examples vary. Try several param combos.
        period_interval: 1, 60, 1440
        start_ts/end_ts: unix seconds
        """
        if not tickers:
            return None, {"error": "no tickers"}
        # Kalshi batch endpoint is GET /markets/candlesticks with body-like query
        # Try documented? https://docs.kalshi.com/api-reference/market/get-market-candlesticks
        # Search shows /markets/candlesticks and /series/{s}/markets/{t}/candlesticks
        # We'll try the batch form first.
        payload_variants = [
            {"tickers": ",".join(tickers), "period_interval": period_interval, "start_ts": start_ts, "end_ts": end_ts},
            {"market_tickers": ",".join(tickers), "period_interval": period_interval, "start_ts": start_ts, "end_ts": end_ts},
            {"tickers": ",".join(tickers), "interval": period_interval, "start_ts": start_ts, "end_ts": end_ts},
        ]
        for pl in payload_variants:
            # filter Nones
            pl = {k: v for k, v in pl.items() if v is not None}
            code, j, _ = fetch_with_retry(self.base, "/markets/candlesticks", pl, timeout_ms=self.timeout_ms)
            if code == 200:
                return j, None
            if code in (404, 405):
                continue
        # Fallback per-ticker
        out = {"market_candlesticks": []}
        for t in tickers:
            # try GET /markets/{ticker}/candlesticks or /series/... but simpler: /markets/{t}/candlesticks?
            for path in [f"/markets/{urllib.parse.quote(t, safe='')}/candlesticks", f"/markets/{urllib.parse.quote(t, safe='')}/candlesticks"]:
                # The single market candlestick often lives at /series/{series}/markets/{ticker}/candlesticks but we don't know series
                # Test with period_interval query
                params = {"period_interval": period_interval, "start_ts": start_ts, "end_ts": end_ts}
                code, j, _ = fetch_with_retry(self.base, path, params, timeout_ms=self.timeout_ms)
                if code == 200:
                    out["market_candlesticks"].append(j)
                    break
            time.sleep(0.08)
        if out["market_candlesticks"]:
            return out, None
        return None, {"error": "candlesticks endpoint not found for these tickers"}

    # historical
    def get_historical_cutoff(self):
        # Some docs require auth for historical, some not — try both
        code, j, _ = fetch_with_retry(self.base, "/historical/cutoff", timeout_ms=self.timeout_ms, signed=False)
        if code == 200:
            return j, None
        # try signed
        if config.KALSHI_ACCESS_KEY:
            code, j, _ = fetch_with_retry(self.base, "/historical/cutoff", timeout_ms=self.timeout_ms, signed=True)
            if code == 200:
                return j, None
        return None, j

    def get_historical_markets(self, limit=200, cursor=None, **kw):
        params = {"limit": limit, "cursor": cursor}
        params.update(kw)
        code, j, _ = fetch_with_retry(self.base, "/historical/markets", params, timeout_ms=self.timeout_ms, signed=bool(config.KALSHI_ACCESS_KEY))
        if code != 200:
            return None, j
        return j, None

    def get_historical_trades(self, limit=200, cursor=None, **kw):
        params = {"limit": limit, "cursor": cursor}
        params.update(kw)
        code, j, _ = fetch_with_retry(self.base, "/historical/trades", params, timeout_ms=self.timeout_ms, signed=bool(config.KALSHI_ACCESS_KEY))
        if code != 200:
            return None, j
        return j, None

    def get_historical_candlesticks(self, ticker: str, period_interval: int, start_ts: int = None, end_ts: int = None):
        params = {"period_interval": period_interval, "start_ts": start_ts, "end_ts": end_ts}
        path = f"/historical/markets/{urllib.parse.quote(ticker, safe='')}/candlesticks"
        code, j, _ = fetch_with_retry(self.base, path, params, timeout_ms=self.timeout_ms, signed=bool(config.KALSHI_ACCESS_KEY))
        if code != 200:
            return None, j
        return j, None

# helper for auto-paginated fetch
def paginated_fetch(fetch_fn, limit_key="limit", cursor_key="cursor", max_pages=500, **kwargs):
    """Generic auto-pagination: fetch_fn(cursor=...) returns (j, err) with j containing 'cursor' or 'next_cursor'."""
    out = []
    cursor = kwargs.pop("cursor", None)
    for _ in range(max_pages):
        j, err = fetch_fn(cursor=cursor, **kwargs)
        if err or not j:
            return out, err
        # Collect: markets, events, series, trades etc.
        for k in ("markets", "events", "series", "trades", "fills", "orders"):
            if k in j and isinstance(j[k], list):
                out.extend(j[k])
        # cursor variants
        nxt = j.get("cursor") or j.get("next_cursor") or j.get("pagination", {}).get("next_cursor") or j.get("pagination", {}).get("paginationKey")
        # Some endpoints return empty cursor when done
        if not nxt or nxt == cursor:
            break
        cursor = nxt
        time.sleep(0.12)
    return out, None

