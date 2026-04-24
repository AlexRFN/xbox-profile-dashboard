import logging

import orjson

from config import CacheKey

from .cache import _UNSET, _cache_invalidate
from .connection import get_connection

log = logging.getLogger("xbox.db")

async def upsert_games_bulk(games: list[dict]) -> int:
    conn = await get_connection()
    rows = []
    for game in games:
        image = game.get("display_image", "")
        if image and image.startswith("http://"):  # Xbox CDN sends http, rewrite
            image = "https://" + image[7:]
        rows.append((
            game["title_id"],
            game["name"],
            image,
            orjson.dumps(game.get("devices", [])).decode(),
            game.get("current_gamerscore", 0),
            game.get("total_gamerscore", 0),
            game.get("progress_percentage", 0),
            game.get("current_achievements", 0),
            game.get("total_achievements", 0),
            game.get("last_played"),
            game.get("xbox_live_tier"),
            game.get("pfn"),
            1 if game.get("is_gamepass") else 0,
        ))

    await conn.executemany("""
        INSERT INTO games (
            title_id, name, display_image, devices,
            current_gamerscore, total_gamerscore, progress_percentage,
            current_achievements, total_achievements, last_played,
            xbox_live_tier, pfn, is_gamepass
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(title_id) DO UPDATE SET
            name = excluded.name,
            display_image = excluded.display_image,
            devices = excluded.devices,
            current_gamerscore = excluded.current_gamerscore,
            total_gamerscore = excluded.total_gamerscore,
            progress_percentage = excluded.progress_percentage,
            current_achievements = excluded.current_achievements,
            -- API quirk: totalAchievements can be 0 even when achievements exist.
            -- Keep the highest known value rather than overwriting with 0.
            total_achievements = CASE
                WHEN excluded.total_achievements > 0 THEN excluded.total_achievements
                ELSE MAX(games.total_achievements, excluded.total_achievements)
            END,
            last_played = excluded.last_played,
            xbox_live_tier = excluded.xbox_live_tier,
            pfn = excluded.pfn,
            is_gamepass = excluded.is_gamepass,
            updated_at = datetime('now')
            -- status, notes, finished_date, rating intentionally omitted — never overwritten by sync
    """, rows)
    await conn.commit()
    _cache_invalidate(CacheKey.DASHBOARD_STATS, CacheKey.ACHIEVEMENT_STATS, CacheKey.PAGE_CONTEXT)
    log.info("Upserted %d games", len(rows))
    return len(rows)


async def get_all_games(
    q: str = "",
    status: str = "",
    completion: str = "",
    platform: str = "",
    gamepass: str = "",
    sort_by: str = "last_played",
    sort_dir: str = "desc",
    page: int = 1,
    per_page: int = 50,
) -> tuple[list[dict], int]:
    conn = await get_connection()
    where_clauses = []
    params = []

    if q:
        where_clauses.append("name LIKE ?")
        params.append(f"%{q}%")

    if status:
        where_clauses.append("status = ?")
        params.append(status)

    if completion == "0":
        where_clauses.append("progress_percentage = 0")
    elif completion == "1-50":
        where_clauses.append("progress_percentage > 0 AND progress_percentage <= 50")
    elif completion == "51-99":
        where_clauses.append("progress_percentage > 50 AND progress_percentage < 100")
    elif completion == "100":
        where_clauses.append("progress_percentage = 100")

    if platform:
        where_clauses.append("EXISTS (SELECT 1 FROM json_each(devices) WHERE value = ?)")
        params.append(platform)

    if gamepass == "yes":
        where_clauses.append("is_gamepass = 1")
    elif gamepass == "no":
        where_clauses.append("is_gamepass = 0")

    where_sql = ""
    if where_clauses:
        where_sql = "WHERE " + " AND ".join(where_clauses)

    allowed_sorts = {
        "name": "name",
        "gamerscore": "current_gamerscore",
        "completion": "progress_percentage",
        "last_played": "last_played",
        "playtime": "minutes_played",
        "status": "status",
    }
    sort_col = allowed_sorts.get(sort_by, "last_played")
    direction = "ASC" if sort_dir == "asc" else "DESC"

    # SQLite sorts NULLs first on ASC and last on DESC. We want unplayed games at the
    # bottom either way, so DESC is already correct and ASC needs explicit NULLS LAST.
    # (Dropping the CASE-prefix sort lets idx_games_last_played / idx_games_name /
    # idx_games_status_last_played serve the ORDER BY directly — no temp b-tree.)
    order_sql = f"{sort_col} ASC NULLS LAST" if direction == "ASC" else f"{sort_col} DESC"

    cursor = await conn.execute(
        f"SELECT COUNT(*) as cnt FROM games {where_sql}", params
    )
    count_row = await cursor.fetchone()
    total = count_row["cnt"]

    offset = (page - 1) * per_page
    cursor = await conn.execute(
        f"""SELECT title_id, name, display_image, blurhash, devices,
                   current_gamerscore, total_gamerscore, progress_percentage,
                   status, last_played, minutes_played, is_gamepass,
                   stats_last_fetched, notes, rating
            FROM games {where_sql}
            ORDER BY {order_sql}
            LIMIT ? OFFSET ?""",
        [*params, per_page, offset],
    )
    rows = await cursor.fetchall()

    return [dict(row) for row in rows], total


async def get_game(title_id: str) -> dict | None:
    conn = await get_connection()
    cursor = await conn.execute("SELECT * FROM games WHERE title_id = ?", (title_id,))
    row = await cursor.fetchone()
    return dict(row) if row else None


async def update_game_stats(title_id: str, minutes_played: int | None):
    conn = await get_connection()
    if minutes_played is not None and minutes_played > 0:
        await conn.execute(
            """UPDATE games SET minutes_played = ?, stats_last_fetched = datetime('now'),
               updated_at = datetime('now') WHERE title_id = ?""",
            (minutes_played, title_id),
        )
    else:
        await conn.execute(
            """UPDATE games SET stats_last_fetched = datetime('now'),
               updated_at = datetime('now') WHERE title_id = ?""",
            (title_id,),
        )
    await conn.commit()
    _cache_invalidate(CacheKey.DASHBOARD_STATS)


async def mark_game_fetched(title_id: str):
    # Only sets stats_last_fetched when NULL — update_game_stats() handles the non-NULL case.
    # This guard prevents overwriting a more recent fetch timestamp.
    conn = await get_connection()
    await conn.execute(
        "UPDATE games SET stats_last_fetched = datetime('now') WHERE title_id = ? AND stats_last_fetched IS NULL",
        (title_id,),
    )
    await conn.commit()


async def recalc_game_from_achievements(title_id: str):
    conn = await get_connection()
    cursor = await conn.execute("""
        SELECT SUM(CASE WHEN progress_state = 'Achieved' THEN 1 ELSE 0 END) as current_ach,
               SUM(CASE WHEN progress_state = 'Achieved' THEN gamerscore ELSE 0 END) as current_gs,
               MAX(CASE WHEN progress_state = 'Achieved' AND time_unlocked IS NOT NULL
                        THEN time_unlocked END) as latest_unlock
        FROM achievements WHERE title_id = ?
    """, (title_id,))
    row = await cursor.fetchone()
    if not row or row["current_ach"] is None:
        return
    await conn.execute("""
        UPDATE games SET
            current_achievements = ?, current_gamerscore = ?,
            last_achievement_unlock = COALESCE(?, last_achievement_unlock),
            stats_last_fetched = datetime('now'),
            updated_at = datetime('now')
        WHERE title_id = ?
    """, (row["current_ach"], row["current_gs"] or 0, row["latest_unlock"], title_id))
    await conn.commit()
    _cache_invalidate(CacheKey.DASHBOARD_STATS)


async def recalc_all_games_from_achievements():
    conn = await get_connection()
    cursor = await conn.execute("""
        UPDATE games SET
            current_achievements = agg.current_ach,
            current_gamerscore = agg.current_gs,
            updated_at = datetime('now')
        FROM (
            SELECT title_id,
                   SUM(CASE WHEN progress_state = 'Achieved' THEN 1 ELSE 0 END) as current_ach,
                   SUM(CASE WHEN progress_state = 'Achieved' THEN gamerscore ELSE 0 END) as current_gs
            FROM achievements
            GROUP BY title_id
        ) agg
        WHERE games.title_id = agg.title_id
    """)
    updated = cursor.rowcount
    await conn.commit()
    _cache_invalidate(CacheKey.DASHBOARD_STATS, CacheKey.ACHIEVEMENT_STATS, CacheKey.PAGE_CONTEXT)
    log.info("Batch recalc: updated %d games from achievements table", updated)
    return updated


async def get_games_needing_details(limit: int = 0) -> list[dict]:
    conn = await get_connection()
    # SQLite sorts NULLs last on DESC, so unplayed games land at the bottom
    # naturally — the explicit CASE prefix isn't needed and blocks idx_games_last_played.
    sql = """
        SELECT title_id, name
        FROM games
        WHERE stats_last_fetched IS NULL
        ORDER BY last_played DESC
    """
    params: list = []
    if limit > 0:
        sql += " LIMIT ?"
        params.append(limit)
    cursor = await conn.execute(sql, params)
    rows = await cursor.fetchall()
    return [dict(row) for row in rows]


async def get_games_for_change_detection() -> dict:
    conn = await get_connection()
    cursor = await conn.execute("""
        SELECT title_id, last_played, current_gamerscore, total_gamerscore,
               current_achievements, total_achievements, progress_percentage,
               stats_last_fetched, last_achievement_unlock
        FROM games
    """)
    rows = await cursor.fetchall()
    return {row["title_id"]: dict(row) for row in rows}


async def update_tracking(title_id: str, status=_UNSET, notes=_UNSET,
                    finished_date=_UNSET, rating=_UNSET):
    # _UNSET sentinel (not None) lets callers explicitly pass None to clear a field
    # while still omitting fields they don't want to touch.
    conn = await get_connection()
    updates = []
    params = []
    if status is not _UNSET:
        updates.append("status = ?")
        params.append(status)
    if notes is not _UNSET:
        updates.append("notes = ?")
        params.append(notes)
    if finished_date is not _UNSET:
        updates.append("finished_date = ?")
        params.append(finished_date)
    if rating is not _UNSET:
        updates.append("rating = ?")
        params.append(rating)
    if updates:
        updates.append("updated_at = datetime('now')")
        params.append(title_id)
        await conn.execute(
            f"UPDATE games SET {', '.join(updates)} WHERE title_id = ?", params
        )
        await conn.commit()
        _cache_invalidate(CacheKey.DASHBOARD_STATS)

async def get_game_index() -> list[dict]:
    conn = await get_connection()
    cursor = await conn.execute(
        """SELECT title_id, name, display_image, progress_percentage, status
           FROM games ORDER BY name COLLATE NOCASE"""
    )
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]

async def get_games_missing_blurhash(limit: int = 50) -> list[dict]:
    conn = await get_connection()
    cursor = await conn.execute(
        """SELECT title_id, display_image FROM games
           WHERE blurhash IS NULL AND display_image != '' AND display_image IS NOT NULL
           LIMIT ?""",
        (limit,),
    )
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]

async def update_game_blurhash(title_id: str, bh: str):
    conn = await get_connection()
    await conn.execute("UPDATE games SET blurhash = ? WHERE title_id = ?", (bh, title_id))
    await conn.commit()

async def get_random_backlog_game() -> dict | None:
    conn = await get_connection()
    cursor = await conn.execute(
        """SELECT title_id, name, display_image
           FROM games WHERE status = 'backlog'
           ORDER BY RANDOM() LIMIT 1"""
    )
    row = await cursor.fetchone()
    return dict(row) if row else None
