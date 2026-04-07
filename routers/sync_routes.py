import logging

from fastapi import APIRouter
from fastapi.responses import ORJSONResponse

import database as db
from helpers import sse_response
from models import SyncResult
from sync import (
    full_library_sync, sync_game_details, unified_sync, sync_screenshots,
    is_sync_running, fire_and_forget, backfill_blurhashes, sync_guard,
)

log = logging.getLogger("xbox.sync_routes")
router = APIRouter()


def _busy_response():
    return ORJSONResponse({"success": False, "message": "A sync is already in progress."}, status_code=409)


async def _sync_response(result: SyncResult):
    """Build the standard JSON response after a sync operation."""
    # Warm the cache in the background so the next page load doesn't pay the miss cost
    fire_and_forget(db.warm_stats_cache())
    data = result.model_dump()
    data["rate_used"] = db.get_api_calls_last_hour()
    if not result.success:
        return ORJSONResponse(data, status_code=502)
    return data


@router.post("/api/sync/full")
async def api_sync_full():
    async with sync_guard("full_library") as acquired:
        if not acquired:
            return _busy_response()
        return await _sync_response(await full_library_sync())


@router.post("/api/sync/game/{title_id}")
async def api_sync_game(title_id: str):
    async with sync_guard(f"game:{title_id}") as acquired:
        if not acquired:
            return _busy_response()
        return await _sync_response(await sync_game_details(title_id))


@router.post("/api/sync")
async def api_unified_sync():
    # Returns SSE (text/event-stream) — unlike other sync endpoints which return JSON
    return sse_response(unified_sync())


@router.post("/api/sync/screenshots")
async def api_sync_screenshots():
    return sse_response(sync_screenshots())  # Also SSE


@router.get("/api/sync/status")
async def api_sync_status():
    return {"running": is_sync_running()}


@router.get("/api/sync/failures")
async def api_sync_failures(limit: int = 50):
    return await db.get_sync_failures(limit)


@router.delete("/api/sync/failures")
async def api_clear_sync_failures():
    await db.clear_sync_failures()
    return {"success": True}


@router.post("/api/sync/blurhash")
async def api_backfill_blurhash(count: int = 100):
    """Manually trigger blurhash backfill for games missing placeholders."""
    missing = await db.get_games_missing_blurhash(count)
    if not missing:
        return {"message": "All games already have blurhash", "processed": 0}
    fire_and_forget(backfill_blurhashes(count))
    return {"message": f"Backfilling {len(missing)} games in background", "queued": len(missing)}
