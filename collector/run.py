"""
collector.run — autonomous entry point.
Without manual input:
  1. init DB
  2. if BACKFILL_ON_START: run historical backfill (markets + candles + trades) in background thread, checkpointed
  3. start live poller forever (snapshots/books/trades/candles + fallback to local Node)
Usage:
  python -m collector.run              # full autonomous (backfill + poll)
  python -m collector.run --once       # one backfill+one poll cycle then exit
  python -m collector.run --backfill-only
  python -m collector.run --poller-only
"""
import argparse
import logging
import threading
import time

from . import config
from .storage import init_db
from .backfill import run_full_backfill
from .poller import Poller

log = logging.getLogger("collector.run")

def run_autonomous(backfill=True, poller=True, once=False):
    init_db()
    log.info("collector starting — config %s", config.summary())
    threads = []
    if backfill and config.BACKFILL_ON_START:
        def _bg():
            try:
                log.info("background backfill starting...")
                run_full_backfill()
                log.info("background backfill finished")
            except Exception as e:
                log.exception("background backfill failed: %s", e)
        t = threading.Thread(target=_bg, daemon=True, name="backfill")
        t.start()
        threads.append(t)
        # give backfill a head-start but don't block poller
        if once:
            t.join(timeout=120)
    if poller and config.LIVE_POLL_ON_START:
        if once:
            # single-cycle poll
            p = Poller()
            # run one iteration of each
            p.poll_markets_once()
            time.sleep(0.5)
            p.poll_books_once()
            time.sleep(0.3)
            p.poll_trades_once()
            time.sleep(0.2)
            p.poll_candles_once()
            log.info("once poll done stats=%s", p.stats)
            try:
                from .storage import get_counts, _connect
                conn = _connect()
                log.info("counts after once: %s", get_counts(conn))
                conn.close()
            except Exception as e:
                log.debug("counts fail: %s", e)
            return
        else:
            poller_obj = Poller()
            poller_obj.run_forever()
    # if only backfill and not once, wait for it
    for t in threads:
        t.join()

def main():
    parser = argparse.ArgumentParser(description="PriceKalshiHistorical autonomous collector")
    parser.add_argument("--once", action="store_true", help="run one backfill + one poll cycle then exit")
    parser.add_argument("--backfill-only", action="store_true", help="only run historical backfill then exit")
    parser.add_argument("--poller-only", action="store_true", help="only run live poller")
    parser.add_argument("--no-backfill", action="store_true", help="skip backfill even if BACKFILL_ON_START=1")
    args = parser.parse_args()

    logging.basicConfig(level=getattr(logging, config.LOG_LEVEL, logging.INFO),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    if args.backfill_only:
        logging.getLogger().setLevel(logging.INFO)
        init_db()
        run_full_backfill()
        return
    if args.poller_only:
        run_autonomous(backfill=False, poller=True, once=args.once)
        return
    if args.no_backfill:
        run_autonomous(backfill=False, poller=True, once=args.once)
        return
    run_autonomous(backfill=True, poller=True, once=args.once)

if __name__ == "__main__":
    main()
