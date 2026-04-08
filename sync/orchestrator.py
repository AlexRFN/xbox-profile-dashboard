import asyncio
import logging

import orjson

from config import MIN_SYNC_BUDGET, UNIFIED_GAME_BUDGET_PCT, UNIFIED_SYNC_CONCURRENCY
from database import (
    RATE_LIMIT_BUDGET,
    create_sync_log,
    get_api_calls_last_hour,
    get_games_for_change_detection,
    log_sync_failure,
    update_sync_log,
    upsert_games_bulk,
    warm_stats_cache,
)
from models import SyncResult
from xbox_api import RateLimitExceeded, get_all_games

from .core import _guarded_sync, _json, fire_and_forget, fit_changes_to_budget
from .games import detect_changed_games, sync_game_selective
from .profile import backfill_blurhashes, sync_friends, sync_profile
from .screenshots import _sync_screenshots_inner

log = logging.getLogger("xbox.sync")


async def _process_one_change(
    change: dict, sem: asyncio.Semaphore
) -> tuple[str, str, "SyncResult"]:
    async with sem:
        game = change["game"]
        try:
            result = await asyncio.wait_for(
                sync_game_selective(game["title_id"], change["sync_type"]),
                timeout=120,
            )
            return game["name"], change["reason"], result
        except asyncio.CancelledError:
            raise
        except Exception as e:
            err = str(e)
            log.error("Unified sync crashed for %s: %s", game["name"], e, exc_info=True)
            await log_sync_failure(game["title_id"], game["name"], change["sync_type"], err)
            return game["name"], change["reason"], SyncResult(success=False, message=err)


def _build_sync_message(
    games_updated: int, failed_games: int, screenshots: int,
    remaining_changes: int, api_calls: int,
) -> str:
    parts = []
    if games_updated > 0:
        parts.append(f"{games_updated} games updated")
    if failed_games > 0:
        parts.append(f"{failed_games} games failed")
    if screenshots > 0:
        parts.append(f"{screenshots} new screenshots")
    if not parts:
        parts.append("Everything up to date")
    if remaining_changes > 0:
        parts.append(f"{remaining_changes} games remaining")
    return ". ".join(parts) + f" ({api_calls} API calls)."


def unified_sync():
    """SSE stream for unified sync (library + friends + game details + screenshots)."""
    return _guarded_sync(_unified_sync_inner(), {
        "message": "A sync is already in progress. Please wait.",
        "games_updated": 0, "api_calls_used": 0,
    })

async def _unified_sync_inner():
    log.info("Unified sync started")
    sync_id = await create_sync_log("unified_sync")
    total_api_calls = 0
    total_games_updated = 0
    total_screenshots = 0

    used = get_api_calls_last_hour()
    total_budget = RATE_LIMIT_BUDGET - used
    if total_budget < MIN_SYNC_BUDGET:
        log.warning("Unified sync: not enough budget (%d remaining)", total_budget)
        await update_sync_log(sync_id, "failed",
                                error_message=f"Only {total_budget} API calls remaining")
        yield _json({
            "type": "finished", "message": f"Not enough API budget ({total_budget} remaining). Try again later.",
            "games_updated": 0, "api_calls_used": 0,
        })
        return

    # ========== Phase 1: Library scan ==========
    yield _json({"type": "phase", "phase": "library", "message": "Scanning library..."})

    try:
        api_games = await get_all_games()
        total_api_calls += 1
    except RateLimitExceeded as e:
        log.warning("Unified sync blocked by rate limit: %s", e)
        await update_sync_log(sync_id, "failed", error_message=str(e))
        yield _json({"type": "finished", "message": str(e), "games_updated": 0, "api_calls_used": 0})
        return
    except Exception as e:
        log.error("Unified sync failed to fetch library: %s", e, exc_info=True)
        await update_sync_log(sync_id, "failed", error_message=str(e))
        yield _json({"type": "finished", "message": f"Failed to fetch library: {e}",
                          "games_updated": 0, "api_calls_used": 0})
        return

    await sync_profile()
    total_api_calls += 1

    # Snapshot BEFORE upsert: detect_changed_games diffs API vs old DB state.
    # After upsert the DB would match the API, making the diff useless.
    db_snapshot = await get_games_for_change_detection()
    games_upserted = await upsert_games_bulk(api_games)
    log.info("Unified sync: library scanned, %d games upserted", games_upserted)

    changes = detect_changed_games(api_games, db_snapshot)

    # ========== Phase 2: Friends ==========
    yield _json({"type": "phase", "phase": "friends", "message": "Syncing friends..."})

    try:
        await sync_friends()
        total_api_calls += 1
    except RateLimitExceeded as e:
        log.warning("Unified sync: friends blocked by rate limit: %s", e)
    except Exception as e:
        log.warning("Unified sync: friends failed (non-critical): %s", e)

    # ========== Phase 3: Game Details ==========
    used_now = get_api_calls_last_hour()
    remaining_after_library = RATE_LIMIT_BUDGET - used_now
    games_budget = int(remaining_after_library * UNIFIED_GAME_BUDGET_PCT)
    log.info("Unified sync: games budget=%d API calls (remaining=%d)", games_budget, remaining_after_library)

    batch = []
    if changes and games_budget > 0:
        yield _json({"type": "phase", "phase": "games",
                          "message": f"Updating {len(changes)} games..."})

        batch, batch_cost = fit_changes_to_budget(changes, games_budget)
        log.info("Unified sync: batching %d/%d games (cost %d API calls)",
                 len(batch), len(changes), batch_cost)

        if batch:
            fetched = 0
            skipped = 0
            sem = asyncio.Semaphore(UNIFIED_SYNC_CONCURRENCY)
            tasks = [asyncio.create_task(_process_one_change(c, sem)) for c in batch]

            # as_completed streams progress events as each game finishes rather than
            # waiting for the whole batch — important for SSE responsiveness.
            for coro in asyncio.as_completed(tasks):
                game_name, reason, result = await coro
                total_api_calls += result.api_calls_used
                if result.success:
                    fetched += 1
                else:
                    skipped += 1

                yield _json({
                    "type": "progress",
                    "phase": "games",
                    "game": game_name,
                    "reason": reason,
                    "done": fetched + skipped,
                    "total": len(batch),
                })

            total_games_updated = fetched

    # ========== Phase 4: Screenshots ==========
    used_now = get_api_calls_last_hour()
    captures_budget = RATE_LIMIT_BUDGET - used_now

    if captures_budget > 0:
        yield _json({"type": "phase", "phase": "captures", "message": "Fetching captures..."})

        async for item in _sync_screenshots_inner(max_api_calls=captures_budget):
            data = orjson.loads(item)
            if data.get("type") == "finished":
                total_api_calls += data.get("api_calls_used", 0)
                total_screenshots = data.get("total_screenshots", 0)
            else:
                yield item

    # ========== Final summary ==========
    batch_size = len(batch) if changes and games_budget > 0 else 0
    remaining_changes = len(changes) - batch_size
    failed_games = batch_size - total_games_updated if batch_size > 0 else 0
    msg = _build_sync_message(
        total_games_updated, failed_games, total_screenshots,
        remaining_changes, total_api_calls,
    )

    status = "success" if remaining_changes == 0 else "partial"
    await update_sync_log(sync_id, status,
                            games_updated=total_games_updated, api_calls_used=total_api_calls)
    log.info("Unified sync complete: %s — %d games, %d screenshots, %d API calls",
             status, total_games_updated, total_screenshots, total_api_calls)
    # Fire-and-forget so the SSE "finished" event isn't delayed by these follow-up tasks.
    fire_and_forget(warm_stats_cache())
    fire_and_forget(backfill_blurhashes(50))

    rate_used = get_api_calls_last_hour()
    yield _json({
        "type": "finished",
        "message": msg,
        "games_updated": total_games_updated,
        "screenshots_synced": total_screenshots,
        "api_calls_used": total_api_calls,
        "rate_used": rate_used,
    })
