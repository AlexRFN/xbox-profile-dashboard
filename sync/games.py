import asyncio
import logging

from database import (
    can_make_requests,
    create_sync_log,
    get_game,
    mark_game_fetched,
    update_game_stats,
    update_sync_log,
    upsert_games_bulk,
)
from models import SyncResult
from xbox_api import RateLimitExceeded, get_all_games, get_game_stats

from .achievements import (
    _check_x360,
    _merge_modern_achievements,
    _merge_player_achievements_only,
    _merge_x360_achievements,
)
from .profile import sync_profile

log = logging.getLogger("xbox.sync")

async def full_library_sync() -> SyncResult:
    log.info("Starting full library sync")
    sync_id = await create_sync_log("full_library")
    try:
        games = await get_all_games()
        count = await upsert_games_bulk(games)
        await sync_profile()  # store gamerpic (non-critical, +1 API call)
        await update_sync_log(sync_id, "success",
                                games_updated=count, api_calls_used=2)
        log.info("Full library sync complete: %d games", count)
        return SyncResult(
            success=True,
            message=f"Synced {count} games from Xbox Live.",
            games_updated=count,
            api_calls_used=2,
        )
    except RateLimitExceeded as e:
        log.warning("Full library sync blocked by rate limit: %s", e)
        await update_sync_log(sync_id, "failed", error_message=str(e))
        return SyncResult(success=False, message=str(e))
    except Exception as e:
        log.error("Full library sync failed: %s", e, exc_info=True)
        await update_sync_log(sync_id, "failed", error_message=str(e))
        return SyncResult(success=False, message=f"Sync failed: {e}")

async def sync_game_details(title_id: str, devices=None) -> SyncResult:
    if devices is not None:
        is_x360 = _check_x360(devices)
    else:
        game = await get_game(title_id)
        is_x360 = _check_x360(game.get("devices", "[]")) if game else False
    needed_calls = 2 if is_x360 else 3
    log.info("sync_game_details(%s) — x360=%s, need %d calls", title_id, is_x360, needed_calls)

    if not can_make_requests(needed_calls):
        log.warning("sync_game_details(%s) — not enough budget", title_id)
        return SyncResult(
            success=False,
            message="Not enough API budget. Try again later.",
        )

    sync_id = await create_sync_log("game_details", title_id)
    api_calls = 0
    errors = []

    async def _fetch_stats():
        stats = await get_game_stats(title_id)
        await update_game_stats(title_id, stats["minutes_played"])
        log.debug("%s: stats fetched — %s min played", title_id, stats["minutes_played"])
        return 1

    async def _fetch_achievements():
        if is_x360:
            ach_count, ach_api = await _merge_x360_achievements(title_id)
        else:
            ach_count, ach_api = await _merge_modern_achievements(title_id)
        log.debug("%s: %d achievements merged (%d API calls)", title_id, ach_count, ach_api)
        return ach_api

    # Run stats and achievements in parallel — they hit different endpoints and are independent.
    # return_exceptions=True lets one failure not cancel the other.
    results = await asyncio.gather(
        _fetch_stats(), _fetch_achievements(), return_exceptions=True,
    )
    for i, result in enumerate(results):
        label = "Stats" if i == 0 else "Achievements"
        if isinstance(result, Exception):
            log.error("%s: %s fetch failed: %s", title_id, label.lower(), result, exc_info=result)
            errors.append(f"{label}: {result}")
        else:
            api_calls += result  # type: ignore[operator]

    status = "success" if not errors else "partial"
    msg = f"Fetched details ({api_calls} API calls)."
    if errors:
        msg += " Errors: " + "; ".join(errors)

    if api_calls > 0:
        await mark_game_fetched(title_id)

    await update_sync_log(sync_id, status,
                            api_calls_used=api_calls,
                            error_message="; ".join(errors) if errors else None)
    log.info("sync_game_details(%s) — %s (%d API calls)", title_id, status, api_calls)
    return SyncResult(
        success=len(errors) == 0,
        message=msg,
        api_calls_used=api_calls,
    )

def detect_changed_games(api_games: list[dict], db_snapshot: dict) -> list[dict]:
    """Compare API game data against a pre-upsert DB snapshot to decide what needs syncing.

    The snapshot is taken BEFORE upserting so we can diff the API response against
    the previous state. After upsert the DB would match the API, making diff useless.
    """
    changes = []
    skipped = 0

    FIELDS = [
        ("current_gamerscore",  None),
        ("total_gamerscore",    None),
        ("current_achievements", None),
        # Skip total_achievements if API returns 0 — API quirk, not a real change
        ("total_achievements",  lambda api_val, _db_val: api_val == 0),
        # progress_percentage is omitted: it's derived from current/total achievements
        # (which are already watched above) and the title history API returns 0 for all
        # Xbox 360 games, causing perpetual false-positive syncs after recalc writes
        # the correct calculated value to the DB.
    ]

    for game in api_games:
        tid = game["title_id"]
        db = db_snapshot.get(tid)

        if db is None:
            changes.append({"game": game, "sync_type": "full", "api_cost": 3, "reason": "new game"})
            continue

        if db["stats_last_fetched"] is None:
            changes.append({"game": game, "sync_type": "full", "api_cost": 3, "reason": "never fetched"})
            continue

        diffs = []
        for field, ignore_fn in FIELDS:
            api_val = game.get(field) or 0
            db_val = db.get(field) or 0
            if api_val != db_val:
                if ignore_fn and ignore_fn(api_val, db_val):
                    continue
                diffs.append(f"{field}: {db_val}->{api_val}")

        if diffs:
            changes.append({
                "game": game, "sync_type": "full", "api_cost": 3,
                "reason": ", ".join(diffs),
            })
            continue

        if game.get("last_played") != db["last_played"]:
            changes.append({"game": game, "sync_type": "stats_only", "api_cost": 1,
                            "reason": "last_played changed"})
            continue

        # Catch games played after our last detail fetch even when numeric stats haven't
        # changed yet (e.g., launched but no achievements earned since last sync).
        db_played = (db.get("last_played") or "")[:10]
        db_fetched = (db.get("stats_last_fetched") or "")[:10]
        if db_played and db_fetched and db_played > db_fetched:
            changes.append({"game": game, "sync_type": "full", "api_cost": 3,
                            "reason": f"played after last detail sync ({db_played} > {db_fetched})"})
            continue

        skipped += 1

    changes.sort(key=lambda c: c["game"].get("last_played") or "", reverse=True)

    log.info("Change detection: %d changes, %d skipped, %d total", len(changes), skipped, len(api_games))
    return changes

async def sync_game_selective(title_id: str, sync_type: str) -> SyncResult:
    log.debug("sync_game_selective(%s, %s)", title_id, sync_type)
    if sync_type == "full":
        return await sync_game_details(title_id)

    api_calls = 0
    errors = []

    try:
        stats = await get_game_stats(title_id)
        api_calls += 1
        await update_game_stats(title_id, stats["minutes_played"])
    except Exception as e:
        log.error("%s: selective stats failed: %s", title_id, e, exc_info=True)
        errors.append(f"Stats: {e}")

    if sync_type == "player_achievements":
        try:
            _, ach_api = await _merge_player_achievements_only(title_id)
            api_calls += ach_api
        except Exception as e:
            log.error("%s: selective achievement progress failed: %s", title_id, e, exc_info=True)
            errors.append(f"Achievements: {e}")

    msg = f"Fetched ({api_calls} API calls)."
    if errors:
        msg += " Errors: " + "; ".join(errors)

    return SyncResult(
        success=len(errors) == 0,
        message=msg,
        api_calls_used=api_calls,
    )
