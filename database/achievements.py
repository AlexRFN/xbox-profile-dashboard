import logging
from datetime import date

import orjson

from config import CacheKey

from .cache import _cache_invalidate
from .connection import get_connection
from .stats import get_achievement_stats, get_dashboard_stats

log = logging.getLogger("xbox.db")

async def get_achievements(title_id: str) -> list[dict]:
    conn = await get_connection()
    cursor = await conn.execute(
        """SELECT * FROM achievements WHERE title_id = ?
           ORDER BY CASE WHEN progress_state = 'Achieved' THEN 0 ELSE 1 END,
                    time_unlocked DESC""",
        (title_id,),
    )
    rows = await cursor.fetchall()
    return [dict(row) for row in rows]

async def get_achievement_ids(title_id: str) -> set[str]:
    conn = await get_connection()
    cursor = await conn.execute(
        "SELECT achievement_id FROM achievements WHERE title_id = ?", (title_id,)
    )
    rows = await cursor.fetchall()
    return {row["achievement_id"] for row in rows}

async def upsert_achievements(title_id: str, achievements: list[dict]) -> int:
    conn = await get_connection()
    rows = []
    for ach in achievements:
        rows.append((
            ach["achievement_id"],
            title_id,
            ach["name"],
            ach.get("description", ""),
            ach.get("locked_description", ""),
            ach.get("gamerscore", 0),
            ach.get("progress_state"),
            ach.get("time_unlocked"),
            1 if ach.get("is_secret") else 0,
            ach.get("rarity_category"),
            ach.get("rarity_percentage"),
            orjson.dumps(ach.get("media_assets", [])).decode(),
        ))

    await conn.executemany("""
        INSERT INTO achievements (
            achievement_id, title_id, name, description, locked_description,
            gamerscore, progress_state, time_unlocked, is_secret,
            rarity_category, rarity_percentage, media_assets
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(achievement_id, title_id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            locked_description = excluded.locked_description,
            gamerscore = excluded.gamerscore,
            progress_state = excluded.progress_state,
            time_unlocked = excluded.time_unlocked,
            is_secret = excluded.is_secret,
            rarity_category = excluded.rarity_category,
            rarity_percentage = excluded.rarity_percentage,
            media_assets = excluded.media_assets,
            last_fetched = datetime('now')
    """, rows)
    await conn.commit()
    # Achievement unlocks drive the heatmap and timeline, so invalidate both heatmap keys.
    # Only the current year's key needs clearing; historical years are immutable once past.
    _cache_invalidate(CacheKey.DASHBOARD_STATS, CacheKey.ACHIEVEMENT_STATS, CacheKey.HEATMAP_ROLLING, CacheKey.heatmap_year(date.today().year))
    log.info("Upserted %d achievements for title %s", len(rows), title_id)
    return len(rows)

async def update_achievement_progress(title_id: str, achievements: list[dict]) -> int:
    conn = await get_connection()
    rows = []
    for ach in achievements:
        rows.append((
            ach.get("progress_state"),
            ach.get("time_unlocked"),
            ach.get("gamerscore", 0),
            ach["achievement_id"],
            title_id,
        ))
    await conn.executemany("""
        UPDATE achievements
        SET progress_state = ?, time_unlocked = ?, gamerscore = ?, last_fetched = datetime('now')
        WHERE achievement_id = ? AND title_id = ?
    """, rows)
    await conn.commit()
    _cache_invalidate(CacheKey.DASHBOARD_STATS, CacheKey.ACHIEVEMENT_STATS, CacheKey.HEATMAP_ROLLING, CacheKey.heatmap_year(date.today().year))
    return len(rows)

async def get_achievements_page(page: int = 1, per_page: int = 60, q: str = "",
                          rarity: str = "", game: str = "", status: str = "",
                          sort: str = "date_desc", group: str = "") -> tuple:
    conn = await get_connection()
    where_clauses = []
    params: list = []

    if q:
        where_clauses.append("(a.name LIKE ? OR a.description LIKE ? OR g.name LIKE ?)")
        params.extend([f"%{q}%"] * 3)
    if rarity:
        where_clauses.append("LOWER(a.rarity_category) = ?")
        params.append(rarity.lower())
    if game:
        where_clauses.append("a.title_id = ?")
        params.append(game)
    if status == "unlocked":
        where_clauses.append("a.progress_state = 'Achieved'")
    elif status == "locked":
        where_clauses.append("a.progress_state != 'Achieved'")

    where_sql = " AND ".join(where_clauses) if where_clauses else "1=1"

    sort_map = {
        "date_desc": "a.time_unlocked DESC",
        "date_asc": "a.time_unlocked ASC",
        "gs_desc": "a.gamerscore DESC",
        "gs_asc": "a.gamerscore ASC",
        # COALESCE to 100 so achievements without rarity data sort last when ascending (rarest first)
        "rarity_asc": "COALESCE(a.rarity_percentage, 100) ASC",
        "rarity_desc": "COALESCE(a.rarity_percentage, 100) DESC",
        "name_asc": "a.name ASC",
    }
    order_sql = sort_map.get(sort, "a.time_unlocked DESC")

    group_order = ""
    if group == "game":
        group_order = "g.name ASC, "
    elif group == "rarity":
        group_order = """CASE COALESCE(a.rarity_category, 'Unknown')
                            WHEN 'Common' THEN 1
                            WHEN 'Rare' THEN 2
                            WHEN 'Epic' THEN 3
                            WHEN 'Legendary' THEN 4
                            ELSE 5
                         END,
                         COALESCE(a.rarity_category, 'Unknown') ASC, """

    full_order = f"{group_order}CASE WHEN a.progress_state = 'Achieved' THEN 0 ELSE 1 END, {order_sql}, a.name ASC"

    cursor = await conn.execute(
        f"SELECT COUNT(*) FROM achievements a JOIN games g ON a.title_id = g.title_id WHERE {where_sql}",
        params,
    )
    row = await cursor.fetchone()
    total = row[0]

    offset = (page - 1) * per_page
    cursor = await conn.execute(f"""
        SELECT a.*, g.name as game_name, g.display_image as game_image, g.title_id
        FROM achievements a
        JOIN games g ON a.title_id = g.title_id
        WHERE {where_sql}
        ORDER BY {full_order}
        LIMIT ? OFFSET ?
    """, [*params, per_page, offset])
    rows = await cursor.fetchall()

    return [dict(r) for r in rows], total

async def get_games_with_achievements() -> list:
    conn = await get_connection()
    cursor = await conn.execute("""
        SELECT g.title_id, g.name, COUNT(a.achievement_id) as ach_count
        FROM games g
        JOIN achievements a ON g.title_id = a.title_id
        GROUP BY g.title_id
        ORDER BY g.name
    """)
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]

async def get_near_completion_games(threshold: int = 80, limit: int = 10) -> list:
    conn = await get_connection()
    cursor = await conn.execute("""
        SELECT g.name, g.title_id, g.display_image, g.blurhash, g.progress_percentage,
               g.current_gamerscore, g.total_gamerscore,
               COALESCE(ac.achieved, 0) as current_achievements,
               COALESCE(ac.total, 0) as total_achievements
        FROM games g
        LEFT JOIN (
            SELECT title_id,
                   SUM(CASE WHEN progress_state = 'Achieved' THEN 1 ELSE 0 END) as achieved,
                   COUNT(*) as total
            FROM achievements
            GROUP BY title_id
        ) ac ON ac.title_id = g.title_id
        WHERE g.progress_percentage >= ? AND g.progress_percentage < 100
        ORDER BY g.progress_percentage DESC
        LIMIT ?
    """, (threshold, limit))
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]

async def warm_stats_cache() -> None:
    try:
        await get_dashboard_stats()
        await get_achievement_stats()
        log.debug("Stats cache warmed")
    except Exception:
        log.warning("Stats cache warming failed (non-critical)", exc_info=True)
