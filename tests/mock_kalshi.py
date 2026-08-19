#!/usr/bin/env python3
"""Mock Kalshi Trade API v2 server for end-to-end collector tests.

Serves EXACTLY the response schemas documented in docs.kalshi.com (OpenAPI
v3.28.0, 2026-08) so the collector pipeline can be verified without network
access to the real exchange:

  GET /markets                  -> {"markets": [Market], "cursor": ""}
  GET /events?tickers=a,b       -> {"events": [EventData], "cursor": ""}
  GET /markets/orderbooks       -> {"orderbooks": [{ticker, orderbook_fp}]}
  GET /markets/{ticker}/orderbook -> {"orderbook_fp": {yes_dollars, no_dollars}}
  GET /markets/trades           -> {"trades": [Trade], "cursor": ""}
  GET /markets/candlesticks     -> {"markets": [{market_ticker, candlesticks}]}
  GET /historical/cutoff|markets|trades
  GET /series/{s}/markets/{t}/candlesticks
  GET /historical/markets/{t}/candlesticks

Usage:
  python tests/mock_kalshi.py [port]      # default 8765
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

T0 = int(time.time())

OPEN_MARKETS = [
    {
        "ticker": "KXTEST-UP",
        "event_ticker": "KXTESTSERIES-A",
        "title": "Test market up",
        "market_type": "binary",
        "yes_sub_title": "Yes",
        "no_sub_title": "No",
        "created_time": "2026-08-01T00:00:00Z",
        "updated_time": "2026-08-18T00:00:00Z",
        "open_time": "2026-08-01T00:00:00Z",
        "close_time": "2026-09-30T00:00:00Z",
        "latest_expiration_time": "2026-09-30T00:00:00Z",
        "settlement_timer_seconds": 3600,
        "status": "active",
        "notional_value_dollars": "1.0000",
        "yes_bid_dollars": "0.42",
        "yes_ask_dollars": "0.44",
        "no_bid_dollars": "0.56",
        "no_ask_dollars": "0.58",
        "yes_bid_size_fp": "100.00",
        "yes_ask_size_fp": "80.00",
        "last_price_dollars": "0.43",
        "previous_yes_bid_dollars": "0.41",
        "previous_yes_ask_dollars": "0.45",
        "previous_price_dollars": "0.42",
        "volume_fp": "1234.00",
        "volume_24h_fp": "500.00",
        "open_interest_fp": "900.00",
        "result": "",
        "can_close_early": False,
        "expiration_value": "1.0000",
        "rules_primary": "",
        "rules_secondary": "",
        "price_level_structure": "deci_cent",
        "price_ranges": [],
        "is_provisional": False,
    },
    {
        "ticker": "KXTEST-DN",
        "event_ticker": "KXTESTSERIES-A",
        "title": "Test market down",
        "market_type": "binary",
        "yes_sub_title": "Yes",
        "no_sub_title": "No",
        "created_time": "2026-08-01T00:00:00Z",
        "updated_time": "2026-08-18T00:00:00Z",
        "open_time": "2026-08-01T00:00:00Z",
        "close_time": "2026-09-30T00:00:00Z",
        "latest_expiration_time": "2026-09-30T00:00:00Z",
        "settlement_timer_seconds": 3600,
        "status": "active",
        "notional_value_dollars": "1.0000",
        "yes_bid_dollars": "0.55",
        "yes_ask_dollars": "0.57",
        "no_bid_dollars": "0.43",
        "no_ask_dollars": "0.45",
        "yes_bid_size_fp": "200.00",
        "yes_ask_size_fp": "150.00",
        "last_price_dollars": "0.56",
        "previous_yes_bid_dollars": "0.54",
        "previous_yes_ask_dollars": "0.58",
        "previous_price_dollars": "0.55",
        "volume_fp": "2000.00",
        "volume_24h_fp": "800.00",
        "open_interest_fp": "1500.00",
        "result": "",
        "can_close_early": False,
        "expiration_value": "1.0000",
        "rules_primary": "",
        "rules_secondary": "",
        "price_level_structure": "deci_cent",
        "price_ranges": [],
        "is_provisional": False,
    },
]

EVENTS = [
    {
        "event_ticker": "KXTESTSERIES-A",
        "series_ticker": "KXTESTSERIES",
        "sub_title": "Will the mock test pass?",
        "title": "Will the mock test pass?",
        "collateral_return_type": "binary",
        "mutually_exclusive": True,
        "available_on_brokers": False,
        "settlement_sources": [],
        "category": "Test",
    },
]

ORDERBOOKS = [
    {
        "ticker": "KXTEST-UP",
        "orderbook_fp": {
            "yes_dollars": [["0.42", "100.00"], ["0.41", "50.00"]],
            "no_dollars": [["0.55", "80.00"], ["0.56", "60.00"]],
        },
    },
    {
        "ticker": "KXTEST-DN",
        "orderbook_fp": {
            "yes_dollars": [["0.55", "200.00"]],
            "no_dollars": [["0.42", "120.00"]],
        },
    },
]

TRADES = [
    {
        "trade_id": "t1",
        "ticker": "KXTEST-UP",
        "count_fp": "3.00",
        "yes_price_dollars": "0.42",
        "no_price_dollars": "0.58",
        "taker_outcome_side": "yes",
        "taker_book_side": "bid",
        "created_time": "2026-08-18T10:00:00Z",
        "is_block_trade": False,
    },
    {
        "trade_id": "t2",
        "ticker": "KXTEST-DN",
        "count_fp": "2.00",
        "yes_price_dollars": "0.56",
        "no_price_dollars": "0.44",
        "taker_outcome_side": "no",
        "taker_book_side": "ask",
        "created_time": "2026-08-18T10:01:00Z",
        "is_block_trade": False,
    },
]

HIST_TRADES = [
    {
        "trade_id": "ht1",
        "ticker": "KXTEST-OLD",
        "count_fp": "5.00",
        "yes_price_dollars": "0.90",
        "no_price_dollars": "0.10",
        "taker_outcome_side": "yes",
        "taker_book_side": "bid",
        "created_time": "2026-07-01T10:00:00Z",
        "is_block_trade": False,
    },
]

HIST_MARKETS = [
    {
        "ticker": "KXTEST-OLD",
        "event_ticker": "KXTESTSERIES-OLD",
        "title": "Settled test market",
        "market_type": "binary",
        "yes_sub_title": "Yes",
        "no_sub_title": "No",
        "created_time": "2026-06-01T00:00:00Z",
        "updated_time": "2026-07-02T00:00:00Z",
        "open_time": "2026-06-01T00:00:00Z",
        "close_time": "2026-07-01T00:00:00Z",
        "latest_expiration_time": "2026-07-01T00:00:00Z",
        "settlement_timer_seconds": 3600,
        "status": "finalized",
        "notional_value_dollars": "1.0000",
        "yes_bid_dollars": "0.0000",
        "yes_ask_dollars": "0.0000",
        "no_bid_dollars": "1.0000",
        "no_ask_dollars": "1.0000",
        "yes_bid_size_fp": "0.00",
        "yes_ask_size_fp": "0.00",
        "last_price_dollars": "1.00",
        "previous_yes_bid_dollars": "0.00",
        "previous_yes_ask_dollars": "0.00",
        "previous_price_dollars": "0.90",
        "volume_fp": "5000.00",
        "volume_24h_fp": "0.00",
        "open_interest_fp": "5000.00",
        "result": "yes",
        "can_close_early": False,
        "expiration_value": "1.0000",
        "rules_primary": "",
        "rules_secondary": "",
        "price_level_structure": "deci_cent",
        "price_ranges": [],
        "is_provisional": False,
    },
]


def _candle(end_ts, close="0.44"):
    return {
        "end_period_ts": end_ts,
        "yes_bid": {"open_dollars": "0.40", "low_dollars": "0.39", "high_dollars": "0.43", "close_dollars": "0.42"},
        "yes_ask": {"open_dollars": "0.44", "low_dollars": "0.43", "high_dollars": "0.47", "close_dollars": "0.46"},
        "price": {"open_dollars": "0.40", "low_dollars": "0.39", "high_dollars": "0.45", "close_dollars": close,
                  "mean_dollars": "0.42", "previous_dollars": "0.41", "min_dollars": "0.39", "max_dollars": "0.45"},
        "volume_fp": "12.00",
        "open_interest_fp": "900.00",
    }


def candles_for(ticker, period_min):
    step = period_min * 60
    base = (T0 // step) * step
    return [_candle(base - i * step) for i in range(3)]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _json(self, obj, code=200):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        q = parse_qs(u.query)

        if p == "/markets":
            status = (q.get("status") or ["open"])[0]
            mkts = OPEN_MARKETS if status in ("open", "active") else []
            return self._json({"markets": mkts, "cursor": ""})
        if p == "/events":
            wanted = (q.get("tickers") or [""])[0].split(",")
            evs = [e for e in EVENTS if e["event_ticker"] in wanted] if wanted[0] else EVENTS
            return self._json({"events": evs, "cursor": ""})
        if p == "/markets/orderbooks":
            return self._json({"orderbooks": ORDERBOOKS})
        if p.startswith("/markets/") and p.endswith("/orderbook"):
            tk = p[len("/markets/"):-len("/orderbook")]
            for ob in ORDERBOOKS:
                if ob["ticker"] == tk:
                    return self._json({"orderbook_fp": ob["orderbook_fp"]})
            return self._json({"error": "not found"}, 404)
        if p == "/markets/trades":
            return self._json({"trades": TRADES, "cursor": ""})
        if p == "/markets/candlesticks":
            period = int((q.get("period_interval") or ["1"])[0])
            mts = (q.get("market_tickers") or q.get("tickers") or [""])[0].split(",")
            markets = [{"market_ticker": tk, "candlesticks": candles_for(tk, period)} for tk in mts if tk]
            return self._json({"markets": markets})
        if p == "/historical/cutoff":
            back = T0 - 86400 * 100
            return self._json({
                "market_settled_ts": back,
                "trades_created_ts": back,
                "orders_updated_ts": back,
                "market_positions_last_updated_ts": back,
            })
        if p == "/historical/markets":
            return self._json({"markets": HIST_MARKETS, "cursor": ""})
        if p == "/historical/trades":
            return self._json({"trades": HIST_TRADES, "cursor": ""})
        if p.startswith("/historical/markets/") and p.endswith("/candlesticks"):
            tk = p[len("/historical/markets/"):-len("/candlesticks")]
            period = int((q.get("period_interval") or ["1"])[0])
            return self._json({"candlesticks": candles_for(tk, period)})
        if "/markets/" in p and p.endswith("/candlesticks"):  # /series/{s}/markets/{t}/candlesticks
            tk = p.split("/markets/")[1][:-len("/candlesticks")]
            period = int((q.get("period_interval") or ["1"])[0])
            return self._json({"candlesticks": candles_for(tk, period)})
        self.send_response(404)
        self.end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    srv = HTTPServer(("127.0.0.1", port), Handler)
    print(f"mock Kalshi API on http://127.0.0.1:{port}")
    srv.serve_forever()
