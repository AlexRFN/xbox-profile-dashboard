"""Scheduled background sync using APScheduler.

Three periodic jobs:
  1. Library scan — every 4 hours (2 API calls)
  2. Smart detail sync — every 2 hours, offset 1h (variable API calls)
  3. Friends refresh — every 30 minutes (1 API call)

All jobs respect rate limits, skip if a user-triggered sync is running,
and only consume up to 50% of remaining budget.
"""

import asyncio
import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
from config import (
    SCHEDULED_SYNC_CONCURRENCY, SCHEDULED_GAME_BUDGET_PCT,
    SCHEDULED_GAME_BUDGET_CAP, MIN_SYNC_BUDGET,
)

log = logging.getLogger("xbox.scheduler")

scheduler = AsyncIOScheduler(timezone="UTC")


async def scheduled_library_sync():
    """Full library scan — cheap (2 API calls), runs every 4 hours."""
    from sync import full_library_sync, backfill_blurhashes, fire_and_forget, sync_guard
    from database import can_make_requests

    async with sync_guard("scheduled_library") as acquired:
        if not acquired:
            log.debug("Skipping scheduled library sync — another sync is in progress")
            return
        if not can_make_requests(2):
            log.info("Skipping scheduled library sync — insufficient budget")
            return

        log.info("Scheduled library sync starting")
        result = await full_library_sync()
        log.info("Scheduled library sync: %s", result.message)

    fire_and_forget(backfill_blurhashes(30))


async def scheduled_detail_sync():
    """Smart detail sync — detects changed games and fetches only what's needed.

    Budget: min(30, 50% of remaining) API calls per run.
    """
    from sync import (
        detect_changed_games, sync_game_selective, fit_changes_to_budget, sync_guard,
    )
    from database import (
        get_api_calls_last_hour, get_games_for_change_detection,
        upsert_games_bulk,
        RATE_LIMIT_BUDGET,
    )
    from xbox_api import get_all_games

    async with sync_guard("scheduled_detail") as acquired:
        if not acquired:
            log.debug("Skipping scheduled detail sync — another sync is in progress")
            return

        used = get_api_calls_last_hour()
        remaining = RATE_LIMIT_BUDGET - used

        # Need at least 1 call for library scan + 2 for one game detail
        if remaining < MIN_SYNC_BUDGET:
            log.info("Skipping scheduled detail sync — insufficient budget (%d remaining)", remaining)
            return

        # Fetch current library (1 API call)
        try:
            api_games = await get_all_games()
        except Exception as e:
            log.warning("Scheduled detail sync — library fetch failed: %s", e)
            return

        # Snapshot DB before upserting, then upsert library data so
        # the games table stays current (prevents re-detecting same changes next cycle)
        db_snapshot = await get_games_for_change_detection()
        await upsert_games_bulk(api_games)

        # Detect what changed (comparing pre-upsert snapshot vs fresh API)
        changes = detect_changed_games(api_games, db_snapshot)
        if not changes:
            log.debug("Scheduled detail sync — no changes detected")
            return

        # Budget: use at most 30 calls or 50% of remaining (minus the 1 we just used)
        used_now = get_api_calls_last_hour()
        budget = min(SCHEDULED_GAME_BUDGET_CAP, int((RATE_LIMIT_BUDGET - used_now) * SCHEDULED_GAME_BUDGET_PCT))
        if budget < 2:
            log.info("Scheduled detail sync — budget too low after library scan")
            return

        batch, batch_cost = fit_changes_to_budget(changes, budget)
        log.info("Scheduled detail sync: %d/%d games, %d API calls budgeted",
                 len(batch), len(changes), batch_cost)

        sem = asyncio.Semaphore(SCHEDULED_SYNC_CONCURRENCY)

        async def _run(change):
            async with sem:
                try:
                    result = await sync_game_selective(change["game"]["title_id"], change["sync_type"])
                    return result.success
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    log.warning("Scheduled detail sync — %s failed: %s", change["game"]["name"], e)
                    return False

        results = await asyncio.gather(*[_run(c) for c in batch])
        fetched = sum(1 for r in results if r)
        log.info("Scheduled detail sync complete: %d/%d games updated", fetched, len(batch))


async def scheduled_friends_sync():
    """Friends refresh — cheap (1 API call), runs every 30 minutes."""
    from sync import sync_friends, sync_guard
    from database import can_make_requests

    async with sync_guard("scheduled_friends") as acquired:
        if not acquired:
            return
        if not can_make_requests():
            return

        try:
            count = await sync_friends()
            log.debug("Scheduled friends sync: %d friends", count)
        except Exception as e:
            log.warning("Scheduled friends sync failed: %s", e)


async def scheduled_db_optimize():
    """Run PRAGMA optimize to keep query planner stats fresh."""
    import database as db
    try:
        await db.run_optimize()
        log.debug("PRAGMA optimize completed")
    except Exception as e:
        log.warning("PRAGMA optimize failed: %s", e)


def register_jobs():
    """Register all scheduled jobs. Called once during app startup."""
    scheduler.add_job(
        scheduled_library_sync,
        trigger=IntervalTrigger(hours=4),
        id="library_sync",
        name="Library scan (4h)",
        replace_existing=True,
    )
    scheduler.add_job(
        scheduled_detail_sync,
        # start_date offsets the first run by 1h so detail sync doesn't fire at the same
        # time as library sync (which runs at the top of each 4h window).
        trigger=IntervalTrigger(hours=2, start_date="2000-01-01 01:00:00"),
        id="detail_sync",
        name="Smart detail sync (2h)",
        replace_existing=True,
    )
    scheduler.add_job(
        scheduled_friends_sync,
        trigger=IntervalTrigger(minutes=30),
        id="friends_sync",
        name="Friends refresh (30m)",
        replace_existing=True,
    )
    scheduler.add_job(
        scheduled_db_optimize,
        trigger=IntervalTrigger(hours=6),
        id="db_optimize",
        name="SQLite optimize (6h)",
        replace_existing=True,
    )
    log.info("Registered %d scheduled jobs", len(scheduler.get_jobs()))
