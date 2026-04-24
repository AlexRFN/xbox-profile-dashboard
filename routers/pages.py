import asyncio

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse

import database as db
from config import ACHIEVEMENTS_PAGE_SIZE, CAPTURES_PAGE_SIZE, LIBRARY_PAGE_SIZE, TIMELINE_PAGE_SIZE
from helpers import (
    LibraryFilters,
    build_heatmap_grid,
    get_filters,
    group_events_by_month,
    is_spa_nav,
    page_ctx,
    static_url,
    stream_shell_response,
    templates,
    timeline_active_preset,
)

router = APIRouter()


def _apply_heatmap(ctx: dict, heatmap_rows: list, year_range) -> None:
    """Add rolling heatmap data to template context."""
    if year_range:
        ctx["heatmap"] = build_heatmap_grid(heatmap_rows)
        ctx["heatmap_mode"] = "rolling"
        ctx["heatmap_year"] = None
        ctx["heatmap_min_year"] = year_range[0]
        ctx["heatmap_max_year"] = year_range[1]
    else:
        ctx["heatmap"] = None


@router.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    async def fetch_ctx() -> dict:
        ctx_task = asyncio.create_task(page_ctx(request))
        stats, heatmap_rows, year_range = await asyncio.gather(
            db.get_dashboard_stats(),
            db.get_heatmap_data(),
            db.get_heatmap_year_range(),
        )
        ctx = await ctx_task
        ctx["stats"] = stats
        _apply_heatmap(ctx, heatmap_rows, year_range)
        return ctx

    if is_spa_nav(request):
        ctx = await fetch_ctx()
        return templates.TemplateResponse(request, "index.html", ctx)

    return stream_shell_response(
        request,
        title="Profile - Xbox",
        content_template="index_content.html",
        data_factory=fetch_ctx,
        head_extra=f'<script defer src="{static_url("js/vendor/chart.umd.min.js")}"></script>',
        extra_scripts_template="index_scripts.html",
    )


@router.get("/library", response_class=HTMLResponse)
async def library(request: Request, f: LibraryFilters = Depends(get_filters)):
    async def fetch_ctx() -> dict:
        ctx_task = asyncio.create_task(page_ctx(request))
        (games, total), status_counts = await asyncio.gather(
            db.get_all_games(
                f.q, f.status, f.completion, f.platform,
                f.gamepass, f.sort_by, f.sort_dir),
            db.get_status_counts(),
        )
        ctx = await ctx_task
        ctx.update({
            "games": games,
            "total": total,
            "page": 1,
            "per_page": LIBRARY_PAGE_SIZE,
            "q": f.q,
            "status_filter": f.status,
            "completion": f.completion,
            "platform": f.platform,
            "gamepass": f.gamepass,
            "sort_by": f.sort_by,
            "sort_dir": f.sort_dir,
            "status_counts": status_counts,
        })
        return ctx

    if is_spa_nav(request):
        ctx = await fetch_ctx()
        return templates.TemplateResponse(request, "library.html", ctx)

    return stream_shell_response(
        request,
        title="Library - Xbox",
        content_template="library_content.html",
        data_factory=fetch_ctx,
    )


@router.get("/game/{title_id}", response_class=HTMLResponse)
async def game_detail(request: Request, title_id: str):
    # get_game is a single PK lookup (sub-ms) — running it before streaming
    # is cheap and lets us early-exit on 404 with a real error page rather
    # than mid-stream HTML.
    game = await db.get_game(title_id)
    if not game:
        ctx = await page_ctx(request)
        ctx["message"] = f"No game found with title ID: {title_id}"
        return templates.TemplateResponse(request, "404.html", ctx, status_code=404)

    async def fetch_ctx() -> dict:
        ctx_task = asyncio.create_task(page_ctx(request))
        screenshots, achievements, screenshot_count = await asyncio.gather(
            db.get_screenshots_for_game(title_id, 8),
            db.get_achievements(title_id),
            db.get_screenshot_count(title_id),
        )
        ctx = await ctx_task
        ctx.update({
            "game": game,
            "achievements": achievements,
            "screenshots": screenshots,
            "screenshot_count": screenshot_count,
        })
        return ctx

    if is_spa_nav(request):
        ctx = await fetch_ctx()
        return templates.TemplateResponse(request, "game_detail.html", ctx)

    return stream_shell_response(
        request,
        title=f"{game['name']} - Xbox",
        content_template="game_detail_content.html",
        data_factory=fetch_ctx,
        body_class="page-game-detail",
        head_extra=f'<script defer src="{static_url("js/vendor/confetti.browser.min.js")}"></script>',
    )


@router.get("/timeline", response_class=HTMLResponse)
async def timeline_page(request: Request, event_type: str = "", game_search: str = "",
                        date: str = "", date_from: str = "", date_to: str = ""):
    # Backwards compat: single 'date' param → both from/to
    if date and not date_from:
        date_from = date
        date_to = date

    async def fetch_ctx() -> dict:
        # page_ctx runs as a separate task so it runs concurrently with the
        # gather below without blowing past the 6-argument typed overload of
        # asyncio.gather. page_ctx's get_page_context_data is TTL-cached, so
        # on a warm cache `await ctx_task` is near-instant.
        ctx_task = asyncio.create_task(page_ctx(request))
        (events, has_more), (timeline_stats, month_counts), \
            heatmap_rows, year_range, ach_stats, near_completion = await asyncio.gather(
            db.get_timeline_events(1, TIMELINE_PAGE_SIZE, event_type, game_search, date_from, date_to),
            db.get_timeline_stats_and_months(event_type, game_search, date_from, date_to),
            db.get_heatmap_data(),
            db.get_heatmap_year_range(),
            db.get_achievement_stats(),
            db.get_near_completion_games(50, 20),
        )
        ctx = await ctx_task
        ctx.update({
            "grouped_events": group_events_by_month(events, month_counts),
            "has_more": has_more,
            "page": 1,
            "event_type": event_type,
            "game_search": game_search,
            "date_from": date_from,
            "date_to": date_to,
            "timeline_stats": timeline_stats,
            "ach_stats": ach_stats,
            "near_completion": near_completion,
            "active_range": timeline_active_preset(date_from, date_to),
        })
        _apply_heatmap(ctx, heatmap_rows, year_range)
        return ctx

    # SPA partial: htmx targeting #main only needs the content fragment;
    # streaming would produce a broken document shell. Use the conventional
    # TemplateResponse path (base.html's is_spa_nav branch emits a fragment).
    if is_spa_nav(request):
        ctx = await fetch_ctx()
        return templates.TemplateResponse(request, "timeline.html", ctx)

    # Full page: stream the <head> before running the DB work.
    return stream_shell_response(
        request,
        title="Timeline - Xbox",
        content_template="timeline_content.html",
        data_factory=fetch_ctx,
    )


@router.get("/achievements", response_class=HTMLResponse)
async def achievements_page(request: Request,
                            q: str = "", rarity: str = "", game: str = "",
                            status: str = "", sort: str = "date_desc",
                            group: str = "", page: int = 1):
    async def fetch_ctx() -> dict:
        ctx_task = asyncio.create_task(page_ctx(request))
        stats, games_list, near_completion, (achievements, total) = await asyncio.gather(
            db.get_achievement_stats(),
            db.get_games_with_achievements(),
            db.get_near_completion_games(),
            db.get_achievements_page(page, ACHIEVEMENTS_PAGE_SIZE, q, rarity, game, status, sort, group),
        )
        ctx = await ctx_task
        ctx.update({
            "stats": stats,
            "games_list": games_list,
            "near_completion": near_completion,
            "achievements": achievements,
            "ach_total": total,
            "ach_page": page,
            "ach_per_page": ACHIEVEMENTS_PAGE_SIZE,
            "q": q, "rarity": rarity, "game_filter": game,
            "status_filter": status, "sort": sort, "group": group,
        })
        return ctx

    if is_spa_nav(request):
        ctx = await fetch_ctx()
        return templates.TemplateResponse(request, "achievements.html", ctx)

    return stream_shell_response(
        request,
        title="Achievements - Xbox",
        content_template="achievements_content.html",
        data_factory=fetch_ctx,
    )


@router.get("/api/achievements/grid", response_class=HTMLResponse)
async def achievements_grid(request: Request,
                            q: str = "", rarity: str = "", game: str = "",
                            status: str = "", sort: str = "date_desc",
                            group: str = "", page: int = 1):
    achievements, total = await db.get_achievements_page(page, ACHIEVEMENTS_PAGE_SIZE, q, rarity, game, status, sort, group)
    return templates.TemplateResponse(request, "achievements_grid.html", {
        "achievements": achievements,
        "ach_total": total,
        "ach_page": page,
        "ach_per_page": ACHIEVEMENTS_PAGE_SIZE,
        "q": q, "rarity": rarity, "game_filter": game,
        "status_filter": status, "sort": sort, "group": group,
    })


@router.get("/captures", response_class=HTMLResponse)
async def captures_page(request: Request):
    async def fetch_ctx() -> dict:
        (screenshots, total, has_more), ctx = await asyncio.gather(
            db.get_all_screenshots(1, CAPTURES_PAGE_SIZE),
            page_ctx(request),
        )
        ctx.update({
            "screenshots": screenshots,
            "total_screenshots": total,
            "has_more": has_more,
            "view": "all",
        })
        return ctx

    if is_spa_nav(request):
        ctx = await fetch_ctx()
        return templates.TemplateResponse(request, "captures.html", ctx)

    return stream_shell_response(
        request,
        title="Captures - Xbox",
        content_template="captures_content.html",
        data_factory=fetch_ctx,
        overlay_template="captures_overlay.html",
        extra_scripts_template="captures_scripts.html",
    )


@router.get("/friends", response_class=HTMLResponse)
async def friends_page(request: Request):
    ctx, friends = await asyncio.gather(
        page_ctx(request),
        db.get_friends(),
    )
    ctx.update({
        "friends": friends,
        "online_count": sum(1 for f in friends if f.get("presenceState") == "Online"),
        # auto_fetch triggers an immediate sync on page load when the friends table is empty
        # (e.g. first run) so the page isn't blank.
        "auto_fetch": len(friends) == 0,
    })
    return templates.TemplateResponse(request, "friends.html", ctx)
