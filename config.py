"""Central configuration — all policy constants live here.

Import from this module instead of hardcoding values throughout the codebase.
To tune sync behaviour, rate limits, or cache lifetimes, change only this file.
"""

# ── Rate Limiting ──────────────────────────────────────────────────────────────
RATE_LIMIT_MAX = 150        # OpenXBL hard cap per hour
RATE_LIMIT_BUDGET = 145     # Conservative budget (5-call safety buffer)

# ── Sync Policy ────────────────────────────────────────────────────────────────
UNIFIED_SYNC_CONCURRENCY = 5        # Parallel game syncs during user-triggered sync
SCHEDULED_SYNC_CONCURRENCY = 3      # Parallel game syncs during background scheduled sync
UNIFIED_GAME_BUDGET_PCT = 0.85      # Fraction of remaining budget for game details phase
SCHEDULED_GAME_BUDGET_PCT = 0.50    # Fraction of remaining budget for scheduled detail sync
SCHEDULED_GAME_BUDGET_CAP = 30      # Hard cap on API calls per scheduled detail sync run
MIN_SYNC_BUDGET = 5                 # Minimum remaining calls required to start any sync

# ── Pagination ─────────────────────────────────────────────────────────────────
LIBRARY_PAGE_SIZE = 50
ACHIEVEMENTS_PAGE_SIZE = 60
CAPTURES_PAGE_SIZE = 50
TIMELINE_PAGE_SIZE = 50
LIBRARY_EXPORT_LIMIT = 10_000


class CacheKey:
    """String constants for in-memory cache keys.

    Use these instead of bare string literals so typos are caught at import
    time and all invalidation sites stay in sync automatically.
    """
    DASHBOARD_STATS  = "dashboard_stats"
    ACHIEVEMENT_STATS = "achievement_stats"
    PAGE_CONTEXT     = "page_context"
    HEATMAP_ROLLING  = "heatmap_rolling"
    FRIENDS          = "friends"

    @staticmethod
    def heatmap_year(year: int) -> str:
        return f"heatmap_{year}"

    @staticmethod
    def activity(year: int, month: int) -> str:
        return f"activity_{year}_{month}"
