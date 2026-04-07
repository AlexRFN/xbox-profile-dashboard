import csv
import io

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse

import database as db
from config import LIBRARY_EXPORT_LIMIT
from helpers import templates, LibraryFilters, get_filters, format_date

router = APIRouter()


@router.get("/api/library/table", response_class=HTMLResponse)
async def library_table(
    request: Request,
    f: LibraryFilters = Depends(get_filters),
    page: int = 1,
    per_page: int = 50,
):
    games, total = await db.get_all_games(
        f.q, f.status, f.completion, f.platform,
        f.gamepass, f.sort_by, f.sort_dir, page, per_page)
    return templates.TemplateResponse("library_table.html", {
        "request": request,
        "games": games,
        "total": total,
        "page": page,
        "per_page": per_page,
        "q": f.q,
        "status_filter": f.status,
        "completion": f.completion,
        "platform": f.platform,
        "gamepass": f.gamepass,
        "sort_by": f.sort_by,
        "sort_dir": f.sort_dir,
        # oob_pagination=True tells the template to emit the pagination block with
        # hx-swap-oob="true" so htmx can update it outside the main swap target.
        "oob_pagination": True,
    })


@router.get("/api/library/grid", response_class=HTMLResponse)
async def library_grid(
    request: Request,
    f: LibraryFilters = Depends(get_filters),
    page: int = 1,
    per_page: int = 48,
):
    games, total = await db.get_all_games(
        f.q, f.status, f.completion, f.platform,
        f.gamepass, f.sort_by, f.sort_dir, page, per_page)
    return templates.TemplateResponse("library_grid.html", {
        "request": request,
        "games": games,
        "total": total,
        "page": page,
        "per_page": per_page,
        "view": "grid",
    })


@router.get("/api/export/csv")
async def export_csv(f: LibraryFilters = Depends(get_filters)):
    games, _ = await db.get_all_games(
        f.q, f.status, f.completion, f.platform,
        f.gamepass, f.sort_by, f.sort_dir, 1, LIBRARY_EXPORT_LIMIT)
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Title ID", "Name", "Current Gamerscore", "Total Gamerscore",
        "Progress %", "Status", "Last Played", "Minutes Played", "Notes", "Rating",
    ])
    for g in games:
        writer.writerow([
            g["title_id"], g["name"], g["current_gamerscore"], g["total_gamerscore"],
            g["progress_percentage"], g["status"],
            format_date(g["last_played"]) or "", g["minutes_played"] or "",
            g["notes"] or "", g["rating"] or "",
        ])
    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=xbox_library.csv"},
    )


@router.get("/api/export/json")
async def export_json(f: LibraryFilters = Depends(get_filters)):
    games, _ = await db.get_all_games(
        f.q, f.status, f.completion, f.platform,
        f.gamepass, f.sort_by, f.sort_dir, 1, LIBRARY_EXPORT_LIMIT)
    return JSONResponse(
        content=games,
        headers={"Content-Disposition": "attachment; filename=xbox_library.json"},
    )
