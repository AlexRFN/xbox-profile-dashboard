import logging
import re
from urllib.parse import urlparse

from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse, Response

import database as db
from config import CAPTURES_PAGE_SIZE
from helpers import templates
from xbox_api import get_client

log = logging.getLogger("xbox.captures")
router = APIRouter()


@router.get("/api/captures/grid", response_class=HTMLResponse)
async def captures_grid(request: Request, page: int = 1):
    screenshots, total, has_more = await db.get_all_screenshots(page, CAPTURES_PAGE_SIZE)
    return templates.TemplateResponse("captures_grid.html", {
        "request": request,
        "screenshots": screenshots,
        "has_more": has_more,
        "page": page,
    })


@router.get("/api/captures/by-game", response_class=HTMLResponse)
async def captures_by_game(request: Request):
    by_game = await db.get_screenshots_by_game()
    return templates.TemplateResponse("captures_by_game.html", {
        "request": request,
        "by_game": by_game,
    })


@router.get("/api/captures/game/{title_id}", response_class=HTMLResponse)
async def captures_game_expand(request: Request, title_id: str):
    screenshots = await db.get_screenshots_for_game(title_id)
    return templates.TemplateResponse("captures_game_expand.html", {
        "request": request,
        "screenshots": screenshots,
    })


@router.get("/api/captures/download")
async def proxy_capture_download(url: str = Query(...), filename: str = Query("capture.png")):
    """Stream-proxy Xbox CDN image for same-origin download with a custom filename."""
    # SSRF guard: only proxy requests to Xbox CDN domains.
    # Check both hostname and userinfo — a URL like https://evil.com@gameclips.xboxlive.com/
    # has hostname "gameclips.xboxlive.com" but routes to evil.com.
    parsed = urlparse(url)
    host = parsed.hostname or ""
    if parsed.scheme not in ("http", "https"):
        return Response(status_code=403, content="Forbidden host")
    if parsed.username or parsed.password:
        return Response(status_code=403, content="Forbidden host")
    if not (host.endswith(".xboxlive.com") or host.endswith(".xbox.com")):
        return Response(status_code=403, content="Forbidden host")
    # Strip path traversal chars and shell-unsafe characters from the filename
    safe_filename = re.sub(r'[^\w\s\-\.]', '', filename).strip() or "capture.png"
    try:
        client = get_client()
        if client is None:
            return Response(status_code=503, content="HTTP client not initialized")
        resp = await client.get(url, timeout=30)
        resp.raise_for_status()
    except Exception as e:
        log.warning("Capture download failed: %s", e)
        return Response(status_code=502, content="Failed to fetch from Xbox CDN")
    return Response(
        content=resp.content,
        media_type=resp.headers.get("Content-Type", "image/png"),
        headers={
            "Content-Disposition": f'attachment; filename="{safe_filename}"',
            "Content-Length": resp.headers.get("Content-Length", ""),
        },
    )
