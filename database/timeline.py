"""Timeline events, served from a materialized table.

The source data (achievements + games) only changes when a sync writes, but
the timeline used to recompute a three-branch UNION ALL over every
achievement — plus a full sort — on every request: each timeline view, each
"Load More" page, and the dashboard preview. The union is now materialized
into the `timeline_events` table: writers call invalidate_timeline(), and the
next read rebuilds the table once (a single DELETE + INSERT...SELECT
transaction on the write connection). Every page, filter, and stats query is
then a plain indexed query against the table.

Event semantics (unchanged from the original union):
  1. achievement  — every individual unlock (one row per achievement)
  2. completion   — one row per 100%-complete game, dated by its latest
                    unlock (closest approximation to "finished the game"),
                    falling back to finished_date, then last_played
  3. first_played — MIN(time_unlocked) per game as a proxy for "started
                    playing", since the API provides no actual start date

All branches filter locked-achievement timestamps with valid_ts_sql() to
exclude Xbox's sentinel value '0001-01-01T...' for unearned achievements.

Two derived columns make the hot queries indexable:
  event_day  — DATE(event_date, 'localtime'); date filters become a plain
               equality/range instead of a per-row strftime, and month stats
               group on substr(event_day, 1, 7).
  type_rank  — completion=0 / achievement=1 / other=2, so the "completions
               surface above achievements on equal timestamps" ordering is
               served by the (event_date DESC, type_rank) index with no sort.
"""

from config import CacheKey

from .cache import _cache_get, _cache_invalidate_prefix, _cache_set
from .connection import get_connection, get_read_connection
from .validators import valid_ts_sql

# The unfiltered first page (dashboard preview + default timeline view) and
# unfiltered stats are additionally cached in memory; filtered variants are
# not, because game_search is free text and would grow the cache without
# bound. Writers invalidate via invalidate_timeline().
_TIMELINE_TTL = 300

# True whenever a writer has touched data the materialized table derives from.
# Process start counts as dirty: the table on disk may predate this process.
_dirty = True


def mark_timeline_dirty() -> None:
    global _dirty
    _dirty = True


def invalidate_timeline() -> None:
    """Single entry point for writers: flush the timeline caches and schedule
    a rebuild of the materialized table on the next timeline read."""
    _cache_invalidate_prefix(CacheKey.TIMELINE_PREFIX)
    mark_timeline_dirty()


_EVENT_COLUMNS = """event_type, event_date, event_title, event_detail, event_value,
                    rarity, rarity_pct, title_id, game_name, game_image,
                    game_blurhash, achievement_media"""

_REBUILD_SQL = f"""
    INSERT INTO timeline_events (
        event_type, event_date, event_day, type_rank, event_title, event_detail,
        event_value, rarity, rarity_pct, title_id, game_name, game_image,
        game_blurhash, achievement_media
    )
    SELECT event_type, event_date, DATE(event_date, 'localtime'),
           CASE event_type WHEN 'completion' THEN 0 WHEN 'achievement' THEN 1 ELSE 2 END,
           event_title, event_detail, event_value, rarity, rarity_pct,
           title_id, game_name, game_image, game_blurhash, achievement_media
    FROM (
        WITH max_unlock AS (
            SELECT title_id, MAX(time_unlocked) as last_unlock
            FROM achievements
            WHERE progress_state = 'Achieved'
              AND {valid_ts_sql()}
            GROUP BY title_id
        )
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
          AND {valid_ts_sql("a")}

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
          AND {valid_ts_sql("a3")}
        GROUP BY g3.title_id
    )
    WHERE event_date IS NOT NULL
"""


async def _ensure_materialized() -> None:
    """Rebuild timeline_events from source tables if a writer marked it dirty.

    The flag is cleared BEFORE the rebuild starts: a writer landing mid-rebuild
    re-marks it, so its change is never lost — at worst the next read rebuilds
    once more. (Clearing after the rebuild would swallow that mark.) Concurrent
    readers that arrive while a rebuild is in flight see the previous committed
    table state — briefly stale, never torn, since the swap is one transaction.
    """
    global _dirty
    if not _dirty:
        return
    _dirty = False
    conn = await get_connection()  # rebuild writes — must use the write connection
    try:
        await conn.execute("DELETE FROM timeline_events")
        await conn.execute(_REBUILD_SQL)
        await conn.commit()
    except BaseException:
        _dirty = True
        raise


def _build_timeline_where(event_type: str, game_search: str, date_from: str, date_to: str) -> tuple[str, list]:
    conditions = []
    params: list = []
    if event_type:
        conditions.append("event_type = ?")
        params.append(event_type)
    if game_search:
        conditions.append("game_name LIKE ?")
        params.append(f"%{game_search}%")
    if date_from and date_to and date_from != date_to:
        conditions.append("event_day BETWEEN ? AND ?")
        params.extend([date_from, date_to])
    elif date_from:
        conditions.append("event_day = ?")
        params.append(date_from)
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    return where, params


async def get_timeline_events(
    page: int = 1,
    per_page: int = 50,
    event_type: str = "",
    game_search: str = "",
    date_from: str = "",
    date_to: str = "",
) -> tuple[list[dict], bool]:
    cache_key = None
    if page == 1 and not (event_type or game_search or date_from or date_to):
        cache_key = CacheKey.timeline_events(per_page)
        cached = _cache_get(cache_key, ttl=_TIMELINE_TTL)
        if cached is not None:
            events, has_more = cached
            return list(events), has_more  # shallow copy: callers slice/extend the list

    await _ensure_materialized()
    conn = await get_read_connection()
    offset = (page - 1) * per_page
    where_sql, params = _build_timeline_where(event_type, game_search, date_from, date_to)

    cursor = await conn.execute(
        f"""
        SELECT {_EVENT_COLUMNS}
        FROM timeline_events
        {where_sql}
        ORDER BY event_date DESC, type_rank ASC
        LIMIT ? OFFSET ?
    """,
        [*params, per_page + 1, offset],
    )  # fetch +1 to detect whether another page exists
    rows = await cursor.fetchall()

    events = [dict(r) for r in rows[:per_page]]
    has_more = len(rows) > per_page  # if we got the +1 extra row, there's more to load
    if cache_key:
        _cache_set(cache_key, (events, has_more))
        # Same shallow copy as the hit path, so the cached list itself is never
        # handed to a caller. Event dicts inside are shared and read-only by
        # convention (the codebase never mutates rows it didn't build).
        return list(events), has_more
    return events, has_more


async def get_timeline_stats_and_months(
    event_type: str = "", game_search: str = "", date_from: str = "", date_to: str = ""
) -> tuple[dict, dict[str, dict]]:
    cache_key = None
    if not (event_type or game_search or date_from or date_to):
        cache_key = CacheKey.TIMELINE_STATS
        cached = _cache_get(cache_key, ttl=_TIMELINE_TTL)
        if cached is not None:
            stats, months = cached
            # Shallow top-level copies; per-month dicts are shared and
            # read-only by convention.
            return dict(stats), dict(months)

    await _ensure_materialized()
    conn = await get_read_connection()
    where_sql, params = _build_timeline_where(event_type, game_search, date_from, date_to)

    cursor = await conn.execute(
        f"""
        SELECT
            substr(event_day, 1, 7) as month_key,
            event_type,
            COUNT(*) as cnt,
            SUM(COALESCE(event_value, 0)) as gs
        FROM timeline_events
        {where_sql}
        GROUP BY month_key, event_type
        ORDER BY month_key DESC
    """,
        params,
    )
    rows = await cursor.fetchall()

    stats = {
        "achievement_count": 0,
        "completion_count": 0,
        "first_played_count": 0,
        "total_gamerscore": 0,
        "total_events": 0,
    }
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
            months[mk] = {
                "event_count": 0,
                "achievement_count": 0,
                "completion_count": 0,
                "first_played_count": 0,
                "gamerscore": 0,
            }
        m = months[mk]
        m["event_count"] += cnt
        if et == "achievement":
            m["achievement_count"] += cnt
            m["gamerscore"] += gs
        elif et == "completion":
            m["completion_count"] += cnt
        elif et == "first_played":
            m["first_played_count"] += cnt

    if cache_key:
        _cache_set(cache_key, (stats, months))
        return dict(stats), dict(months)
    return stats, months
