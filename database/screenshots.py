import logging

from config import CacheKey

from .cache import _cache_invalidate
from .connection import get_connection

log = logging.getLogger("xbox.db")

async def upsert_screenshots(screenshots: list[dict]) -> int:
    conn = await get_connection()
    rows = []
    for s in screenshots:
        download_uri = ""
        download_hdr_uri = ""
        thumb_small = ""
        thumb_large = ""
        file_size = 0
        # Xbox API URI type constants (undocumented): 2 = standard SDR download, 3 = HDR download
        for su in s.get("screenshotUris", []):
            uri = su.get("uri", "")
            if su.get("uriType") == 2:
                download_uri = uri
                file_size = su.get("fileSize") or 0
            elif su.get("uriType") == 3:
                download_hdr_uri = uri
        # Thumbnail type constants: 1 = small preview, 2 = large preview
        for th in s.get("thumbnails", []):
            uri = th.get("uri", "")
            if th.get("thumbnailType") == 1:
                thumb_small = uri
            elif th.get("thumbnailType") == 2:
                thumb_large = uri

        rows.append((
            s.get("screenshotId", ""),
            str(s.get("titleId", "")),
            s.get("titleName", ""),
            s.get("dateTaken", ""),
            s.get("resolutionWidth", 0),
            s.get("resolutionHeight", 0),
            download_uri,
            download_hdr_uri,
            thumb_small,
            thumb_large,
            file_size,
            0,
            s.get("views") or 0,
            "",
            s.get("deviceType") or "",
        ))

    await conn.executemany("""
        INSERT INTO screenshots (
            content_id, title_id, title_name, capture_date,
            resolution_width, resolution_height,
            download_uri, download_hdr_uri, thumbnail_small_uri, thumbnail_large_uri,
            file_size, like_count, view_count, creation_type, device_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(content_id) DO UPDATE SET
            title_name = excluded.title_name,
            capture_date = excluded.capture_date,
            resolution_width = excluded.resolution_width,
            resolution_height = excluded.resolution_height,
            download_uri = excluded.download_uri,
            download_hdr_uri = excluded.download_hdr_uri,
            thumbnail_small_uri = excluded.thumbnail_small_uri,
            thumbnail_large_uri = excluded.thumbnail_large_uri,
            file_size = excluded.file_size,
            like_count = excluded.like_count,
            view_count = excluded.view_count,
            creation_type = excluded.creation_type,
            device_type = excluded.device_type
    """, rows)
    await conn.commit()
    log.info("Upserted %d screenshots", len(rows))
    _cache_invalidate(CacheKey.DASHBOARD_STATS)
    return len(rows)

async def get_existing_screenshot_ids() -> set[str]:
    conn = await get_connection()
    cursor = await conn.execute("SELECT content_id FROM screenshots")
    rows = await cursor.fetchall()
    return {r["content_id"] for r in rows}

async def get_all_screenshots(page: int = 1, per_page: int = 50) -> tuple[list[dict], int, bool]:
    conn = await get_connection()
    cursor = await conn.execute("SELECT COUNT(*) as cnt FROM screenshots")
    total_row = await cursor.fetchone()
    total = total_row["cnt"]
    offset = (page - 1) * per_page
    cursor = await conn.execute("""
        SELECT s.*, g.display_image as game_image
        FROM screenshots s
        LEFT JOIN games g ON s.title_id = g.title_id
        ORDER BY s.capture_date DESC
        LIMIT ? OFFSET ?
    """, (per_page + 1, offset))
    rows = await cursor.fetchall()
    items = [dict(r) for r in rows[:per_page]]
    has_more = len(rows) > per_page
    return items, total, has_more

async def get_screenshots_by_game() -> list[dict]:
    conn = await get_connection()
    cursor = await conn.execute("""
        SELECT s.title_id, s.title_name, g.display_image as game_image,
               COUNT(*) as count, MAX(s.capture_date) as latest_date
        FROM screenshots s
        LEFT JOIN games g ON s.title_id = g.title_id
        GROUP BY s.title_id
        ORDER BY latest_date DESC
    """)
    groups = await cursor.fetchall()

    if not groups:
        return []

    title_ids = [g["title_id"] for g in groups]
    preview_rows = []
    # SQLite has a 999-parameter limit; chunk to stay safely under it
    for i in range(0, len(title_ids), 500):
        chunk = title_ids[i:i + 500]
        placeholders = ",".join("?" * len(chunk))
        # Window function: select the 6 most recent screenshots per game in one query
        cursor = await conn.execute(f"""
            SELECT * FROM (
                SELECT s.*,
                       ROW_NUMBER() OVER (PARTITION BY s.title_id ORDER BY s.capture_date DESC) as rn
                FROM screenshots s
                WHERE s.title_id IN ({placeholders})
            ) WHERE rn <= 6
        """, chunk)
        rows = await cursor.fetchall()
        preview_rows.extend(rows)

    previews_by_game: dict[str, list[dict]] = {}
    for row in preview_rows:
        rd = dict(row)
        previews_by_game.setdefault(rd["title_id"], []).append(rd)

    result = []
    for grp in groups:
        grp_dict = dict(grp)
        grp_dict["previews"] = previews_by_game.get(grp_dict["title_id"], [])
        result.append(grp_dict)
    return result

async def get_screenshots_for_game(title_id: str, limit: int = 0) -> list[dict]:
    conn = await get_connection()
    sql = "SELECT * FROM screenshots WHERE title_id = ? ORDER BY capture_date DESC"
    params: list = [title_id]
    if limit > 0:
        sql += " LIMIT ?"
        params.append(limit)
    cursor = await conn.execute(sql, params)
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]

async def get_screenshot_count(title_id: str | None = None) -> int:
    conn = await get_connection()
    if title_id:
        cursor = await conn.execute("SELECT COUNT(*) as cnt FROM screenshots WHERE title_id = ?", (title_id,))
        row = await cursor.fetchone()
    else:
        cursor = await conn.execute("SELECT COUNT(*) as cnt FROM screenshots")
        row = await cursor.fetchone()
    return row["cnt"]
