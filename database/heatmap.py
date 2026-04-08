from config import CacheKey

from .cache import _cache_get, _cache_set
from .connection import get_connection
from .validators import valid_ts_sql

_YEAR_RANGE_NONE = object()  # sentinel: distinguishes "cached absence" from cache miss

async def get_heatmap_data(year: int | None = None) -> list[dict]:
    cache_key = CacheKey.heatmap_year(year) if year is not None else CacheKey.HEATMAP_ROLLING
    cached = _cache_get(cache_key, ttl=300)
    if cached is not None:
        return cached
    conn = await get_connection()
    if year is not None:
        # 'localtime' converts UTC timestamps to the local calendar day for display
        cursor = await conn.execute(f"""
            SELECT DATE(time_unlocked, 'localtime') as day, COUNT(*) as count
            FROM achievements
            WHERE progress_state = 'Achieved'
              AND {valid_ts_sql()}
              AND time_unlocked >= ? AND time_unlocked < ?
            GROUP BY day ORDER BY day
        """, (f"{year}-01-01", f"{year + 1}-01-01"))
        rows = await cursor.fetchall()
    else:
        # 371 days = 53 weeks + 2 days buffer — ensures the grid always has 53 full weeks
        cursor = await conn.execute(f"""
            SELECT DATE(time_unlocked, 'localtime') as day, COUNT(*) as count
            FROM achievements
            WHERE progress_state = 'Achieved'
              AND {valid_ts_sql()}
              AND time_unlocked >= date('now', '-371 days')
            GROUP BY day ORDER BY day
        """)
        rows = await cursor.fetchall()
    result = [dict(r) for r in rows]
    _cache_set(cache_key, result)
    return result

async def get_heatmap_year_range() -> tuple[int, int] | None:
    cached = _cache_get("heatmap_year_range", ttl=600)
    if cached is not None:
        return None if cached is _YEAR_RANGE_NONE else cached
    conn = await get_connection()
    cursor = await conn.execute(f"""
        SELECT
            MIN(CAST(strftime('%Y', time_unlocked, 'localtime') AS INTEGER)) as min_year,
            CAST(strftime('%Y', 'now', 'localtime') AS INTEGER) as current_year
        FROM achievements
        WHERE progress_state = 'Achieved'
          AND {valid_ts_sql()}
          AND time_unlocked >= '2005-01-01'  -- Xbox 360 launched Nov 2005; anything earlier is bad data
    """)
    row = await cursor.fetchone()
    if row["min_year"] is None:
        _cache_set("heatmap_year_range", _YEAR_RANGE_NONE)
        return None
    result = (row["min_year"], row["current_year"])
    _cache_set("heatmap_year_range", result)
    return result

async def get_monthly_activity(year: int, month: int) -> dict:
    cache_key = CacheKey.activity(year, month)
    cached = _cache_get(cache_key, ttl=300)
    if cached is not None:
        return cached
    conn = await get_connection()
    cursor = await conn.execute(f"""
        SELECT CAST(strftime('%d', time_unlocked, 'localtime') AS INTEGER) as day, COUNT(*) as count
        FROM achievements
        WHERE progress_state = 'Achieved'
          AND {valid_ts_sql()}
          AND strftime('%Y', time_unlocked, 'localtime') = ?
          AND strftime('%m', time_unlocked, 'localtime') = ?
        GROUP BY day
    """, (str(year), f"{month:02d}"))
    rows = await cursor.fetchall()
    result = {r["day"]: r["count"] for r in rows}
    _cache_set(cache_key, result)
    return result
