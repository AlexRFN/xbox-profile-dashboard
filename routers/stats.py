from fastapi import APIRouter
from fastapi.responses import ORJSONResponse

import database as db

router = APIRouter()


@router.get("/api/stats")
async def api_stats():
    return await db.get_dashboard_stats()


@router.get("/api/activity/month")
async def api_monthly_activity(year: int, month: int):
    return await db.get_monthly_activity(year, month)


@router.get("/api/rate-limit")
async def api_rate_limit():
    used = db.get_api_calls_last_hour()
    return {"used": used, "limit": db.RATE_LIMIT_MAX, "remaining": db.RATE_LIMIT_MAX - used}


@router.get("/api/games/index")
async def api_games_index():
    """Minimal game index for client-side search (MiniSearch).
    Short max-age=60 so new games appear in search quickly after a sync.
    """
    games = await db.get_game_index()
    return ORJSONResponse(
        content=games,
        headers={"Cache-Control": "public, max-age=60"},
    )


@router.get("/api/scheduler")
async def api_scheduler_status():
    """Show scheduled job status and next run times."""
    from scheduler import scheduler  # Local import avoids circular dependency at module load
    jobs = []
    for job in scheduler.get_jobs():
        jobs.append({
            "id": job.id,
            "name": job.name,
            "next_run": job.next_run_time.isoformat() if job.next_run_time else None,
            "paused": job.next_run_time is None,
        })
    return {"running": scheduler.running, "jobs": jobs}


@router.post("/api/scheduler/pause")
async def api_scheduler_pause():
    from scheduler import scheduler
    scheduler.pause()
    return {"paused": True}


@router.post("/api/scheduler/resume")
async def api_scheduler_resume():
    from scheduler import scheduler
    scheduler.resume()
    return {"paused": False}


@router.get("/api/random-backlog")
async def api_random_backlog():
    game = await db.get_random_backlog_game()
    if game:
        return {"found": True, "title_id": game["title_id"], "name": game["name"],
                "display_image": game["display_image"]}
    return {"found": False}
