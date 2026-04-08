import logging

from config import CacheKey

from .cache import _cache_invalidate
from .connection import get_connection

log = logging.getLogger("xbox.db")

async def create_sync_log(sync_type: str, title_id: str | None = None) -> int:
    conn = await get_connection()
    cursor = await conn.execute(
        "INSERT INTO sync_log (sync_type, title_id) VALUES (?, ?)",
        (sync_type, title_id),
    )
    sync_id = cursor.lastrowid
    await conn.commit()
    return sync_id or 0

async def update_sync_log(sync_id: int, status: str, games_updated: int = 0,
                    api_calls_used: int = 0, error_message: str | None = None):
    conn = await get_connection()
    await conn.execute(
        """UPDATE sync_log SET status = ?, games_updated = ?, api_calls_used = ?,
           error_message = ?, completed_at = datetime('now') WHERE id = ?""",
        (status, games_updated, api_calls_used, error_message, sync_id),
    )
    await conn.commit()
    _cache_invalidate(CacheKey.PAGE_CONTEXT)  # Nav bar shows last sync time — must refresh

async def log_sync_failure(title_id: str, game_name: str, sync_type: str, error_message: str) -> None:
    conn = await get_connection()
    await conn.execute(
        "INSERT INTO sync_failures (title_id, game_name, sync_type, error_message) VALUES (?, ?, ?, ?)",
        (title_id, game_name or "", sync_type, error_message),
    )
    await conn.commit()
    log.warning("Sync failure: %s (%s): %s", title_id, sync_type, error_message[:120])

async def get_sync_failures(limit: int = 50) -> list[dict]:
    conn = await get_connection()
    cursor = await conn.execute("""
        SELECT sf.*, g.display_image
        FROM sync_failures sf
        LEFT JOIN games g ON sf.title_id = g.title_id
        ORDER BY sf.attempted_at DESC LIMIT ?""", (limit,))
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]

async def clear_sync_failures() -> None:
    conn = await get_connection()
    await conn.execute("DELETE FROM sync_failures")
    await conn.commit()
