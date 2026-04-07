import asyncio
import logging
from datetime import date

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse

import database as db
from config import TIMELINE_PAGE_SIZE
from helpers import templates, group_events_by_month, build_heatmap_grid
from models import TrackingUpdate, ApiError

log = logging.getLogger("xbox.game")
router = APIRouter()


@router.get("/api/timeline/events", response_class=HTMLResponse)
async def timeline_events(request: Request, page: int = 2, event_type: str = "",
                          game_search: str = "", date_from: str = "", date_to: str = ""):
    # "Load More" (page > 1) uses hx-swap="beforeend" — only event rows are needed.
    # Stats and month counts don't change between pages, so skip those queries and
    # pass timeline_stats=None to suppress the OOB stats swap in the partial template.
    if page > 1:
        events, has_more = await db.get_timeline_events(
            page, TIMELINE_PAGE_SIZE, event_type, game_search, date_from, date_to)
        timeline_stats = None
        month_counts = {}
    else:
        (events, has_more), (timeline_stats, month_counts) = await asyncio.gather(
            db.get_timeline_events(page, 50, event_type, game_search, date_from, date_to),
            db.get_timeline_stats_and_months(event_type, game_search, date_from, date_to),
        )
    return templates.TemplateResponse("timeline_events.html", {
        "request": request,
        "grouped_events": group_events_by_month(events, month_counts),
        "has_more": has_more,
        "page": page,
        "event_type": event_type,
        "game_search": game_search,
        "date_from": date_from,
        "date_to": date_to,
        "timeline_stats": timeline_stats,
    })


@router.get("/api/heatmap", response_class=HTMLResponse)
async def heatmap_partial(request: Request, year: str = "rolling"):
    if year == "rolling":
        heatmap_rows = await db.get_heatmap_data()
        heatmap = build_heatmap_grid(heatmap_rows)
        heatmap_year = None
        heatmap_mode = "rolling"
    else:
        try:
            y = int(year)
        except (ValueError, TypeError):
            return JSONResponse({"error": "Invalid year parameter"}, status_code=400)
        heatmap_rows = await db.get_heatmap_data(y)
        heatmap = build_heatmap_grid(heatmap_rows, y)
        heatmap_year = y
        heatmap_mode = "year"
    year_range = await db.get_heatmap_year_range()
    return templates.TemplateResponse("heatmap_content.html", {
        "request": request,
        "heatmap": heatmap,
        "heatmap_mode": heatmap_mode,
        "heatmap_year": heatmap_year,
        "heatmap_min_year": year_range[0] if year_range else date.today().year,
        "heatmap_max_year": year_range[1] if year_range else date.today().year,
    })


@router.put("/api/game/{title_id}/tracking")
async def api_update_tracking(title_id: str, update: TrackingUpdate):
    try:
        # exclude_unset=True ensures only explicitly provided fields are forwarded —
        # omitted fields stay unchanged in the DB rather than being cleared.
        payload = update.model_dump(exclude_unset=True)
        await db.update_tracking(title_id, **payload)
        return {"success": True}
    except Exception as e:
        log.error("Tracking update failed for %s: %s", title_id, e, exc_info=True)
        return JSONResponse(ApiError(error="Internal server error").model_dump(), status_code=500)
