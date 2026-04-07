"""Timeline query: combines three event types via UNION ALL.

The three branches are:
  1. achievement  — every individual unlock (one row per achievement)
  2. completion   — one row per 100%-complete game
  3. first_played — MIN(time_unlocked) per game as a proxy for "started playing",
                    since the API provides no actual start date

All branches filter locked-achievement timestamps with valid_ts_sql() to exclude
Xbox's sentinel value '0001-01-01T...' for unearned achievements.
"""

from .connection import get_connection
from .validators import valid_ts_sql

def _build_timeline_where(event_type: str, game_search: str,
                          date_from: str, date_to: str) -> tuple[str, list]:
    conditions = ["event_date IS NOT NULL"]
    params: list = []
    if event_type:
        conditions.append("event_type = ?")
        params.append(event_type)
    if game_search:
        conditions.append("game_name LIKE ?")
        params.append(f"%{game_search}%")
    if date_from and date_to and date_from != date_to:
        conditions.append("DATE(event_date, 'localtime') BETWEEN ? AND ?")
        params.extend([date_from, date_to])
    elif date_from:
        conditions.append("DATE(event_date, 'localtime') = ?")
        params.append(date_from)
    return "WHERE " + " AND ".join(conditions), params


async def get_timeline_events(page: int = 1, per_page: int = 50,
                        event_type: str = "", game_search: str = "",
                        date_from: str = "", date_to: str = "") -> tuple[list[dict], bool]:
    conn = await get_connection()
    offset = (page - 1) * per_page
    outer_where, params = _build_timeline_where(event_type, game_search, date_from, date_to)

    cursor = await conn.execute(f"""
        WITH max_unlock AS (
            -- Used to date the 'completion' event: the latest achievement unlock is the
            -- closest approximation to when the player actually finished the game.
            SELECT title_id, MAX(time_unlocked) as last_unlock
            FROM achievements
            WHERE progress_state = 'Achieved'
              AND {valid_ts_sql()}
            GROUP BY title_id
        )
        SELECT * FROM (
            SELECT
                'achievement' as event_type,
                a.time_unlocked as event_date,
                a.name as event_title,
                a.description as event_detail,
                a.gamerscore as event_value,
                a.rarity_category as rarity,
                a.rarity_percentage as rarity_pct,
                g.title_id,
                g.name as game_name,
                g.display_image as game_image,
                g.blurhash as game_blurhash,
                a.media_assets as achievement_media
            FROM achievements a
            JOIN games g ON a.title_id = g.title_id
            WHERE a.progress_state = 'Achieved'
              AND {valid_ts_sql('a')}

            UNION ALL

            SELECT
                'completion' as event_type,
                COALESCE(
                    mu.last_unlock,
                    g2.finished_date,
                    g2.last_played
                ) as event_date,
                g2.name as event_title,
                CAST(g2.current_gamerscore AS TEXT) || '/' || CAST(g2.total_gamerscore AS TEXT) || ' G' as event_detail,
                g2.current_gamerscore as event_value,
                NULL as rarity,
                NULL as rarity_pct,
                g2.title_id,
                g2.name as game_name,
                g2.display_image as game_image,
                g2.blurhash as game_blurhash,
                NULL as achievement_media
            FROM games g2
            LEFT JOIN max_unlock mu ON mu.title_id = g2.title_id
            WHERE g2.progress_percentage = 100

            UNION ALL

            SELECT
                'first_played' as event_type,
                MIN(a3.time_unlocked) as event_date,
                g3.name as event_title,
                'Started playing' as event_detail,
                NULL as event_value,
                NULL as rarity,
                NULL as rarity_pct,
                g3.title_id,
                g3.name as game_name,
                g3.display_image as game_image,
                g3.blurhash as game_blurhash,
                NULL as achievement_media
            FROM achievements a3
            JOIN games g3 ON a3.title_id = g3.title_id
            WHERE a3.progress_state = 'Achieved'
              AND {valid_ts_sql('a3')}
            GROUP BY g3.title_id
        )
        {outer_where}
        ORDER BY event_date DESC,
                 -- On equal timestamps, completions surface above individual achievements
                 -- so the milestone card isn't buried mid-achievement-streak.
                 CASE event_type WHEN 'completion' THEN 0 WHEN 'achievement' THEN 1 ELSE 2 END ASC
        LIMIT ? OFFSET ?
    """, params + [per_page + 1, offset])  # fetch +1 to detect whether another page exists
    rows = await cursor.fetchall()

    events = [dict(r) for r in rows[:per_page]]
    has_more = len(rows) > per_page  # if we got the +1 extra row, there's more to load
    return events, has_more


async def get_timeline_stats_and_months(event_type: str = "", game_search: str = "",
                                   date_from: str = "", date_to: str = "") -> tuple[dict, dict[str, dict]]:
    conn = await get_connection()
    outer_where, params = _build_timeline_where(event_type, game_search, date_from, date_to)

    cursor = await conn.execute(f"""
        SELECT
            STRFTIME('%Y-%m', event_date, 'localtime') as month_key,
            event_type,
            COUNT(*) as cnt,
            SUM(COALESCE(event_value, 0)) as gs
        FROM (
            WITH max_unlock AS (
                SELECT title_id, MAX(time_unlocked) as last_unlock
                FROM achievements
                WHERE progress_state = 'Achieved'
                  AND {valid_ts_sql()}
                GROUP BY title_id
            )
            SELECT * FROM (
                SELECT 'achievement' as event_type, a.time_unlocked as event_date,
                       a.gamerscore as event_value, g.name as game_name
                FROM achievements a JOIN games g ON a.title_id = g.title_id
                WHERE a.progress_state = 'Achieved' AND {valid_ts_sql('a')}
                UNION ALL
                SELECT 'completion' as event_type,
                       COALESCE(mu.last_unlock, g2.finished_date, g2.last_played) as event_date,
                       g2.current_gamerscore as event_value, g2.name as game_name
                FROM games g2 LEFT JOIN max_unlock mu ON mu.title_id = g2.title_id
                WHERE g2.progress_percentage = 100
                UNION ALL
                SELECT 'first_played' as event_type, MIN(a3.time_unlocked) as event_date,
                       NULL as event_value, g3.name as game_name
                FROM achievements a3 JOIN games g3 ON a3.title_id = g3.title_id
                WHERE a3.progress_state = 'Achieved' AND {valid_ts_sql('a3')}
                GROUP BY g3.title_id
            )
            {outer_where}
        )
        GROUP BY month_key, event_type
        ORDER BY month_key DESC
    """, params)
    rows = await cursor.fetchall()

    stats = {"achievement_count": 0, "completion_count": 0, "first_played_count": 0,
             "total_gamerscore": 0, "total_events": 0}
    months: dict[str, dict] = {}

    for r in rows:
        mk = r["month_key"]
        et = r["event_type"]
        cnt = r["cnt"]
        gs = r["gs"] or 0

        stats["total_events"] += cnt
        if et == "achievement":
            stats["achievement_count"] += cnt
            stats["total_gamerscore"] += gs
        elif et == "completion":
            stats["completion_count"] += cnt
        elif et == "first_played":
            stats["first_played_count"] += cnt

        if mk not in months:
            months[mk] = {"event_count": 0, "achievement_count": 0, "completion_count": 0,
                          "first_played_count": 0, "gamerscore": 0}
        m = months[mk]
        m["event_count"] += cnt
        if et == "achievement":
            m["achievement_count"] += cnt
            m["gamerscore"] += gs
        elif et == "completion":
            m["completion_count"] += cnt
        elif et == "first_played":
            m["first_played_count"] += cnt

    return stats, months
