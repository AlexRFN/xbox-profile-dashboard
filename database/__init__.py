from .connection import get_connection, close_connection, run_optimize
from .cache import _cache_get, _cache_set, _cache_invalidate
from .rate_limit import sync_rate_limit_from_headers, get_api_calls_last_hour, can_make_requests, RATE_LIMIT_MAX, RATE_LIMIT_BUDGET
from .setup import init_db

from .games import (
    upsert_games_bulk, get_all_games, get_game, update_game_stats, mark_game_fetched,
    recalc_game_from_achievements, recalc_all_games_from_achievements,
    get_games_needing_details, get_games_for_change_detection, update_tracking,
    get_game_index, get_games_missing_blurhash, update_game_blurhash, get_random_backlog_game
)

from .achievements import (
    get_achievements, get_achievement_ids, upsert_achievements, update_achievement_progress,
    get_achievements_page, get_games_with_achievements, get_near_completion_games, warm_stats_cache
)

from .stats import get_dashboard_stats, get_status_counts, get_achievement_stats, get_page_context_data

from .timeline import get_timeline_events, get_timeline_stats_and_months

from .heatmap import get_heatmap_data, get_heatmap_year_range, get_monthly_activity

from .sync import create_sync_log, update_sync_log, log_sync_failure, get_sync_failures, clear_sync_failures

from .friends import upsert_friends, get_friends

from .settings import get_setting, set_setting

from .screenshots import (
    upsert_screenshots, get_existing_screenshot_ids, get_all_screenshots,
    get_screenshots_by_game, get_screenshots_for_game, get_screenshot_count
)

__all__ = [
    # connection
    "get_connection", "close_connection", "run_optimize",
    # cache
    "_cache_get", "_cache_set", "_cache_invalidate",
    # rate_limit
    "sync_rate_limit_from_headers", "get_api_calls_last_hour", "can_make_requests",
    "RATE_LIMIT_MAX", "RATE_LIMIT_BUDGET",
    # setup
    "init_db",
    # games
    "upsert_games_bulk", "get_all_games", "get_game", "update_game_stats", "mark_game_fetched",
    "recalc_game_from_achievements", "recalc_all_games_from_achievements",
    "get_games_needing_details", "get_games_for_change_detection", "update_tracking",
    "get_game_index", "get_games_missing_blurhash", "update_game_blurhash", "get_random_backlog_game",
    # achievements
    "get_achievements", "get_achievement_ids", "upsert_achievements", "update_achievement_progress",
    "get_achievements_page", "get_games_with_achievements", "get_near_completion_games", "warm_stats_cache",
    # stats
    "get_dashboard_stats", "get_status_counts", "get_achievement_stats", "get_page_context_data",
    # timeline
    "get_timeline_events", "get_timeline_stats_and_months",
    # heatmap
    "get_heatmap_data", "get_heatmap_year_range", "get_monthly_activity",
    # sync
    "create_sync_log", "update_sync_log", "log_sync_failure", "get_sync_failures", "clear_sync_failures",
    # friends
    "upsert_friends", "get_friends",
    # settings
    "get_setting", "set_setting",
    # screenshots
    "upsert_screenshots", "get_existing_screenshot_ids", "get_all_screenshots",
    "get_screenshots_by_game", "get_screenshots_for_game", "get_screenshot_count",
]
