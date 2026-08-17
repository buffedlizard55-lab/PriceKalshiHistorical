#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== PriceKalshiHistorical — autonomous collector =="

if [ -f .env ]; then
  echo "loading .env"
  set -a; source .env; set +a
else
  echo "no .env — using defaults (copy .env.example to .env to customize)"
  cp -n .env.example .env 2>/dev/null || true
fi

mkdir -p data logs

# --- Node exchange (live sim + Kalshi mirror) ---
if ! command -v node >/dev/null; then
  echo "node not found — collector will run in Python-only mode"
  HAVE_NODE=0
else
  HAVE_NODE=1
  NODE_VER=$(node -v)
  echo "node $NODE_VER detected"
  if [ ! -f server/index.js ]; then
    echo "server/index.js missing!" >&2; exit 1
  fi
  # basic version check for node:sqlite (needs >=22.5)
  if ! node -e "require('node:sqlite')" 2>/dev/null; then
    echo "WARNING: node:sqlite not available (need Node >=22.5). Trying to run anyway..."
  fi
fi

# --- Python collector ---
if ! command -v python3 >/dev/null; then
  echo "python3 not found!" >&2; exit 1
fi

# install deps quietly (best effort)
if [ -f requirements.txt ]; then
  echo "installing python deps (best effort)..."
  pip3 install -q -r requirements.txt 2>&1 | tail -n 20 || echo "(pip install failed — will try stdlib-only mode)"
fi

# Start Node in background if available
PIDS=""
if [ "$HAVE_NODE" = "1" ]; then
  echo "starting Node exchange on :${PORT:-8080} ..."
  PORT=${PORT:-8080} HOST=${HOST:-0.0.0.0} DB_PATH=${DB_PATH:-data/exchange.db} \
    node server/index.js > logs/exchange.log 2>&1 &
  PIDS="$PIDS $!"
  echo "  pid $! (logs/exchange.log)"
  # wait for health
  echo "waiting for /api/health ..."
  for i in {1..25}; do
    if curl -sf "http://127.0.0.1:${PORT:-8080}/api/health" >/dev/null 2>&1; then
      echo "  exchange healthy after $i tries"
      break
    fi
    sleep 0.6
  done
  curl -s "http://127.0.0.1:${PORT:-8080}/api/health" | head -c 400; echo
else
  echo "skipping Node exchange"
fi

echo "starting Python collector (backfill + live poller) ..."
# One full autonomous run that never exits (backfill in background thread + poll loop)
# Use `python -m collector.run` which handles both.
python3 -m collector.run 2>&1 | tee logs/collector.log &
PIDS="$PIDS $!"
echo "  pid $! (logs/collector.log)"

echo ""
echo "All services running. PIDs:$PIDS"
echo "  - Exchange: http://127.0.0.1:${PORT:-8080}  (health: /api/health)"
echo "  - Logs: tail -f logs/exchange.log logs/collector.log"
echo "  - DB: ${DB_PATH:-data/exchange.db} (sqlite3)"
echo "  - Parquet: ${PARQUET_PATH:-data/parquet}/"
echo "  - Stop: kill $PIDS  or  pkill -f 'node server/index.js'; pkill -f 'collector.run'"
echo ""
echo "Quick checks:"
echo "  sqlite3 data/exchange.db 'select count(*) from snapshots; select count(*) from book_snapshots; select * from sync_log order by ts desc limit 5;'"
echo "  python3 -m backtest.strategy_example --strat mee"
echo ""
wait $PIDS
