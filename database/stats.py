from config import CacheKey

from .cache import _cache_get, _cache_set
from .connection import get_connection
from .rate_limit import get_api_calls_last_hour
from .validators import valid_ts_sql


async def get_dashboard_stats() -> dict:
    cached = _cache_get(CacheKey.DASHBOARD_STATS, ttl=60)
    if cached is not None:
        return cached
    conn = await get_connection()
    cursor = await conn.execute("""
        SELECT
            COUNT(*) as total_games,
            SUM(current_gamerscore) as total_gamerscore,
            COUNT(CASE WHEN progress_percentage = 100 THEN 1 END) as completed_games,
            COUNT(CASE WHEN progress_percentage = 0 THEN 1 END) as zero_progress,
            COUNT(CASE WHEN progress_percentage > 0 AND progress_percentage <= 50 THEN 1 END) as low_progress,
            COUNT(CASE WHEN progress_percentage > 50 AND progress_percentage < 100 THEN 1 END) as high_progress,
            COUNT(CASE WHEN status = 'playing' THEN 1 END) as playing_count,
            COUNT(CASE WHEN status = 'finished' THEN 1 END) as finished_count,
            COUNT(CASE WHEN status = 'backlog' THEN 1 END) as backlog_count,
            COUNT(CASE WHEN status = 'dropped' THEN 1 END) as dropped_count,
            COUNT(CASE WHEN status = 'unset' THEN 1 END) as unset_count,
            SUM(COALESCE(minutes_played, 0)) as total_minutes,
            COUNT(CASE WHEN is_gamepass = 1 THEN 1 END) as gamepass_count
        FROM games
    """)
    row = await cursor.fetchone()
    stats = dict(row)

    cursor = await conn.execute("SELECT COUNT(*) as cnt FROM screenshots")
    cap_row = await cursor.fetchone()
    stats["total_captures"] = cap_row["cnt"] if cap_row else 0

    cursor = await conn.execute(
        """SELECT title_id, name, display_image, blurhash, progress_percentage,
                  current_gamerscore, total_gamerscore, last_played, status
           FROM games WHERE last_played IS NOT NULL
           ORDER BY last_played DESC LIMIT 10"""
    )
    recent = await cursor.fetchall()
    stats["recently_played"] = [dict(r) for r in recent]

    cursor = await conn.execute(
        """SELECT title_id, name, display_image, minutes_played
           FROM games WHERE minutes_played IS NOT NULL AND minutes_played > 0
           ORDER BY minutes_played DESC LIMIT 10"""
    )
    most_played = await cursor.fetchall()
    stats["most_played"] = [dict(r) for r in most_played]

    cursor = await conn.execute(
        """SELECT title_id, name, display_image, blurhash, current_gamerscore,
                  total_gamerscore, progress_percentage, last_played, minutes_played, status
           FROM games WHERE progress_percentage = 100
           ORDER BY last_played DESC LIMIT 100"""
    )
    completed = await cursor.fetchall()
    stats["completed_list"] = [dict(r) for r in completed]

    # 'localtime' groups achievements by the local calendar month, not UTC
    cursor = await conn.execute(f"""
        SELECT
            strftime('%Y-%m', time_unlocked, 'localtime') as month,
            COUNT(*) as achievement_count,
            SUM(gamerscore) as gamerscore_earned
        FROM achievements
        WHERE progress_state = 'Achieved'
          AND {valid_ts_sql()}
          AND time_unlocked >= datetime('now', '-12 months')
        GROUP BY month
        ORDER BY month ASC
    """)
    monthly = await cursor.fetchall()
    stats["monthly_stats"] = [dict(r) for r in monthly]

    cursor = await conn.execute(
        """SELECT title_id, name, display_image, blurhash, progress_percentage,
                  current_gamerscore, total_gamerscore, last_played, minutes_played
           FROM games WHERE status = 'playing'
           ORDER BY last_played DESC"""
    )
    playing = await cursor.fetchall()
    stats["playing_list"] = [dict(r) for r in playing]

    _cache_set(CacheKey.DASHBOARD_STATS, stats)
    return stats

async def get_status_counts() -> dict:
    conn = await get_connection()
    cursor = await conn.execute(
        "SELECT status, COUNT(*) as cnt FROM games GROUP BY status"
    )
    rows = await cursor.fetchall()
    return {r["status"]: r["cnt"] for r in rows}

async def get_achievement_stats() -> dict:
    cached = _cache_get(CacheKey.ACHIEVEMENT_STATS, ttl=60)
    if cached is not None:
        return cached
    conn = await get_connection()
    cursor = await conn.execute("""
        SELECT
            COUNT(*) as total_achievements,
            COUNT(CASE WHEN progress_state = 'Achieved' THEN 1 END) as unlocked,
            COUNT(CASE WHEN progress_state != 'Achieved' THEN 1 END) as locked,
            SUM(CASE WHEN progress_state = 'Achieved' THEN gamerscore ELSE 0 END) as unlocked_gamerscore,
            SUM(gamerscore) as total_gamerscore
        FROM achievements
    """)
    row = await cursor.fetchone()
    stats = dict(row)

    cursor = await conn.execute("""
        SELECT
            COALESCE(rarity_category, 'Unknown') as category,
            COUNT(*) as count,
            SUM(gamerscore) as gamerscore
        FROM achievements
        WHERE progress_state = 'Achieved'
        GROUP BY rarity_category
        -- Manual CASE sort: SQLite has no enum type, so rarity order must be explicit
        ORDER BY CASE rarity_category
            WHEN 'Common' THEN 1
            WHEN 'Rare' THEN 2
            WHEN 'Epic' THEN 3
            WHEN 'Legendary' THEN 4
            ELSE 5
        END
    """)
    rarity_rows = await cursor.fetchall()
    stats["rarity_breakdown"] = [dict(r) for r in rarity_rows]

    cursor = await conn.execute("""
        SELECT a.*, g.name as game_name, g.display_image as game_image, g.title_id
        FROM achievements a
        JOIN games g ON a.title_id = g.title_id
        WHERE a.progress_state = 'Achieved'
          AND a.rarity_percentage IS NOT NULL
          AND a.rarity_percentage > 0
        ORDER BY a.rarity_percentage ASC
        LIMIT 20
    """)
    rarest = await cursor.fetchall()
    stats["rarest_unlocked"] = [dict(r) for r in rarest]

    cursor = await conn.execute(f"""
        SELECT a.*, g.name as game_name, g.display_image as game_image, g.title_id
        FROM achievements a
        JOIN games g ON a.title_id = g.title_id
        WHERE a.progress_state = 'Achieved'
          AND {valid_ts_sql('a')}
        ORDER BY a.time_unlocked DESC
        LIMIT 20
    """)
    recent = await cursor.fetchall()
    stats["recent_unlocks"] = [dict(r) for r in recent]

    cursor = await conn.execute("""
        SELECT a.*, g.name as game_name, g.display_image as game_image, g.title_id
        FROM achievements a
        JOIN games g ON a.title_id = g.title_id
        WHERE a.progress_state = 'Achieved'
          AND a.gamerscore > 0
        ORDER BY a.gamerscore DESC
        LIMIT 10
    """)
    highest_gs = await cursor.fetchall()
    stats["highest_gamerscore"] = [dict(r) for r in highest_gs]

    stats["showcase_rarest"] = stats["rarest_unlocked"][0] if stats["rarest_unlocked"] else None
    stats["showcase_highest_gs"] = stats["highest_gamerscore"][0] if stats["highest_gamerscore"] else None
    stats["showcase_latest"] = stats["recent_unlocks"][0] if stats["recent_unlocks"] else None

    rarity_total = sum(r["count"] for r in stats["rarity_breakdown"])
    for r in stats["rarity_breakdown"]:
        r["percentage"] = round(r["count"] / rarity_total * 100, 1) if rarity_total else 0

    _cache_set(CacheKey.ACHIEVEMENT_STATS, stats)
    return stats

async def get_page_context_data() -> dict:
    cached = _cache_get(CacheKey.PAGE_CONTEXT, ttl=30)
    if cached is not None:
        return cached
    conn = await get_connection()
    cursor = await conn.execute(
        """SELECT * FROM sync_log WHERE sync_type IN ('full_library', 'smart_sync', 'unified_sync')
           ORDER BY started_at DESC LIMIT 1"""
    )
    sync_row = await cursor.fetchone()
    cursor = await conn.execute(
        "SELECT value FROM settings WHERE key = 'gamerpic'"
    )
    pic_row = await cursor.fetchone()
    result = {
        "rate_used": get_api_calls_last_hour(),
        "last_sync": dict(sync_row) if sync_row else None,
        "gamerpic": pic_row["value"] if pic_row else None,
    }
    _cache_set(CacheKey.PAGE_CONTEXT, result)
    return result
