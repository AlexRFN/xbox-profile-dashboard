import logging

import orjson

from config import TIMELINE_PAGE_SIZE, CacheKey

from .cache import _cache_get, _cache_invalidate, _cache_invalidate_prefix, _cache_set
from .connection import get_connection, get_read_connection
from .stats import get_achievement_stats, get_dashboard_stats
from .timeline import get_timeline_events, get_timeline_stats_and_months, invalidate_timeline

log = logging.getLogger("xbox.db")


def _invalidate_achievement_caches() -> None:
    """Invalidate every cache slice derived from achievement rows.

    Unlocks drive the dashboard stats, the heatmap grids (rolling + per-year),
    the year-range selector, the per-month activity popovers, the timeline
    (events + stats), and the games-with-achievements filter list. Several are
    dynamically keyed (heatmap_{year}, activity_{year}_{month}, timeline event
    pages), and a first sync of a legacy title can insert unlocks in any past
    year/month, so clear by prefix rather than enumerating keys.
    """
    _cache_invalidate(CacheKey.DASHBOARD_STATS, CacheKey.ACHIEVEMENT_STATS, CacheKey.GAMES_WITH_ACHIEVEMENTS)
    _cache_invalidate_prefix(CacheKey.HEATMAP_PREFIX, CacheKey.ACTIVITY_PREFIX)
    invalidate_timeline()


async def get_achievements(title_id: str) -> list[dict]:
    conn = await get_read_connection()
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
    cursor = await conn.execute("SELECT achievement_id FROM achievements WHERE title_id = ?", (title_id,))
    rows = await cursor.fetchall()
    return {row["achievement_id"] for row in rows}


async def upsert_achievements(title_id: str, achievements: list[dict]) -> int:
    conn = await get_connection()
    rows = []
    for ach in achievements:
        rows.append(
            (
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
            )
        )

    await conn.executemany(
        """
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
    """,
        rows,
    )
    await conn.commit()
    _invalidate_achievement_caches()
    log.info("Upserted %d achievements for title %s", len(rows), title_id)
    return len(rows)


async def update_achievement_progress(title_id: str, achievements: list[dict]) -> int:
    conn = await get_connection()
    rows = []
    for ach in achievements:
        rows.append(
            (
                ach.get("progress_state"),
                ach.get("time_unlocked"),
                ach.get("gamerscore", 0),
                ach["achievement_id"],
                title_id,
            )
        )
    await conn.executemany(
        """
        UPDATE achievements
        SET progress_state = ?, time_unlocked = ?, gamerscore = ?, last_fetched = datetime('now')
        WHERE achievement_id = ? AND title_id = ?
    """,
        rows,
    )
    await conn.commit()
    _invalidate_achievement_caches()
    return len(rows)


async def get_achievements_page(
    page: int = 1,
    per_page: int = 60,
    q: str = "",
    rarity: str = "",
    game: str = "",
    status: str = "",
    sort: str = "date_desc",
    group: str = "",
) -> tuple:
    conn = await get_read_connection()
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

    # Only the q filter references g.* — skip the join for every other count.
    count_from = "achievements a JOIN games g ON a.title_id = g.title_id" if q else "achievements a"
    cursor = await conn.execute(
        f"SELECT COUNT(*) FROM {count_from} WHERE {where_sql}",
        params,
    )
    row = await cursor.fetchone()
    total = row[0]

    offset = (page - 1) * per_page
    cursor = await conn.execute(
        f"""
        SELECT a.*, g.name as game_name, g.display_image as game_image, g.title_id
        FROM achievements a
        JOIN games g ON a.title_id = g.title_id
        WHERE {where_sql}
        ORDER BY {full_order}
        LIMIT ? OFFSET ?
    """,
        [*params, per_page, offset],
    )
    rows = await cursor.fetchall()

    return [dict(r) for r in rows], total


async def get_games_with_achievements() -> list:
    # Full-table join + group-by that only changes when a sync writes — cached
    # and invalidated alongside the other achievement-derived slices.
    cached = _cache_get(CacheKey.GAMES_WITH_ACHIEVEMENTS, ttl=300)
    if cached is not None:
        return list(cached)
    conn = await get_read_connection()
    cursor = await conn.execute("""
        SELECT g.title_id, g.name, COUNT(a.achievement_id) as ach_count
        FROM games g
        JOIN achievements a ON g.title_id = a.title_id
        GROUP BY g.title_id
        ORDER BY g.name
    """)
    rows = await cursor.fetchall()
    result = [dict(r) for r in rows]
    _cache_set(CacheKey.GAMES_WITH_ACHIEVEMENTS, result)
    return result


async def get_near_completion_games(threshold: int = 80, limit: int = 10) -> list:
    # current/total achievements come straight off the games row (kept fresh by
    # the title-history upsert and recalc_*_from_achievements) — no need to
    # re-aggregate the whole achievements table per request.
    conn = await get_read_connection()
    cursor = await conn.execute(
        """
        SELECT name, title_id, display_image, blurhash, progress_percentage,
               current_gamerscore, total_gamerscore,
               current_achievements, total_achievements
        FROM games
        WHERE progress_percentage >= ? AND progress_percentage < 100
        ORDER BY progress_percentage DESC
        LIMIT ?
    """,
        (threshold, limit),
    )
    rows = await cursor.fetchall()
    return [dict(r) for r in rows]


async def warm_stats_cache() -> None:
    try:
        await get_dashboard_stats()
        await get_achievement_stats()
        # Rebuilds the materialized timeline table (marked dirty by the sync's
        # writes) and caches the exact entries the dashboard preview and the
        # timeline page read, so the first post-sync view is warm.
        await get_timeline_events(1, TIMELINE_PAGE_SIZE)
        await get_timeline_stats_and_months()
        log.debug("Stats cache warmed")
    except Exception:
        log.warning("Stats cache warming failed (non-critical)", exc_info=True)
