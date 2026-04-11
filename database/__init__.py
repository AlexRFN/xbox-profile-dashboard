from .achievements import (
    get_achievement_ids,
    get_achievements,
    get_achievements_page,
    get_games_with_achievements,
    get_near_completion_games,
    update_achievement_progress,
    upsert_achievements,
    warm_stats_cache,
)
from .cache import _cache_clear_all, _cache_get, _cache_invalidate, _cache_set
from .connection import close_connection, get_connection, run_optimize
from .friends import get_friends, upsert_friends
from .games import (
    get_all_games,
    get_game,
    get_game_index,
    get_games_for_change_detection,
    get_games_missing_blurhash,
    get_games_needing_details,
    get_random_backlog_game,
    mark_game_fetched,
    recalc_all_games_from_achievements,
    recalc_game_from_achievements,
    update_game_blurhash,
    update_game_stats,
    update_tracking,
    upsert_games_bulk,
)
from .heatmap import get_heatmap_data, get_heatmap_year_range, get_monthly_activity
from .rate_limit import (
    RATE_LIMIT_BUDGET,
    RATE_LIMIT_MAX,
    can_make_requests,
    get_api_calls_last_hour,
    sync_rate_limit_from_headers,
)
from .screenshots import (
    get_all_screenshots,
    get_existing_screenshot_ids,
    get_screenshot_count,
    get_screenshots_by_game,
    get_screenshots_for_game,
    upsert_screenshots,
)
from .settings import get_setting, set_setting
from .setup import init_db
from .stats import get_achievement_stats, get_dashboard_stats, get_page_context_data, get_status_counts
from .sync import clear_sync_failures, create_sync_log, get_sync_failures, log_sync_failure, update_sync_log
from .timeline import get_timeline_events, get_timeline_stats_and_months

__all__ = [
    "RATE_LIMIT_BUDGET",
    "RATE_LIMIT_MAX",
    # cache
    "_cache_clear_all",
    "_cache_get",
    "_cache_invalidate",
    "_cache_set",
    "can_make_requests",
    "clear_sync_failures",
    "close_connection",
    # sync
    "create_sync_log",
    "get_achievement_ids",
    "get_achievement_stats",
    # achievements
    "get_achievements",
    "get_achievements_page",
    "get_all_games",
    "get_all_screenshots",
    "get_api_calls_last_hour",
    # connection
    "get_connection",
    # stats
    "get_dashboard_stats",
    "get_existing_screenshot_ids",
    "get_friends",
    "get_game",
    "get_game_index",
    "get_games_for_change_detection",
    "get_games_missing_blurhash",
    "get_games_needing_details",
    "get_games_with_achievements",
    # heatmap
    "get_heatmap_data",
    "get_heatmap_year_range",
    "get_monthly_activity",
    "get_near_completion_games",
    "get_page_context_data",
    "get_random_backlog_game",
    "get_screenshot_count",
    "get_screenshots_by_game",
    "get_screenshots_for_game",
    # settings
    "get_setting",
    "get_status_counts",
    "get_sync_failures",
    # timeline
    "get_timeline_events",
    "get_timeline_stats_and_months",
    # setup
    "init_db",
    "log_sync_failure",
    "mark_game_fetched",
    "recalc_all_games_from_achievements",
    "recalc_game_from_achievements",
    "run_optimize",
    "set_setting",
    # rate_limit
    "sync_rate_limit_from_headers",
    "update_achievement_progress",
    "update_game_blurhash",
    "update_game_stats",
    "update_sync_log",
    "update_tracking",
    "upsert_achievements",
    # friends
    "upsert_friends",
    # games
    "upsert_games_bulk",
    # screenshots
    "upsert_screenshots",
    "warm_stats_cache",
]
