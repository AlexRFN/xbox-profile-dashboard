import pytest
from database.games import upsert_games_bulk
from database.achievements import upsert_achievements
from database.stats import get_dashboard_stats, get_achievement_stats
from database.cache import _cache_invalidate

@pytest.mark.asyncio
async def test_dashboard_stats():
    # Setup state
    from database.games import update_tracking, update_game_stats
    await upsert_games_bulk([
        {"title_id": "1", "name": "Completed Game", "progress_percentage": 100, "current_gamerscore": 1000},
        {"title_id": "2", "name": "Playing Game", "is_gamepass": True}
    ])
    await update_tracking("2", status="playing")
    await update_game_stats("2", minutes_played=120)

    _cache_invalidate("dashboard_stats")
    stats = await get_dashboard_stats()
    
    assert stats["total_games"] == 2
    assert stats["completed_games"] == 1
    assert stats["playing_count"] == 1
    assert stats["total_minutes"] == 120
    assert stats["gamepass_count"] == 1
    assert stats["total_gamerscore"] == 1000

@pytest.mark.asyncio
async def test_achievement_stats():
    await upsert_games_bulk([{"title_id": "1", "name": "Game"}])
    await upsert_achievements("1", [
        {"achievement_id": "1", "name": "A", "progress_state": "Achieved", "gamerscore": 10, "rarity_category": "Common", "rarity_percentage": 50.0},
        {"achievement_id": "2", "name": "B", "progress_state": "Achieved", "gamerscore": 50, "rarity_category": "Rare", "rarity_percentage": 5.0},
        {"achievement_id": "3", "name": "C", "progress_state": "NotStarted", "gamerscore": 20, "rarity_category": "Common", "rarity_percentage": 40.0}
    ])

    _cache_invalidate("achievement_stats")
    stats = await get_achievement_stats()

    assert stats["total_achievements"] == 3
    assert stats["unlocked"] == 2
    assert stats["locked"] == 1
    assert stats["unlocked_gamerscore"] == 60
    assert stats["total_gamerscore"] == 80

    assert len(stats["rarity_breakdown"]) == 2 # Only Common and Rare (for achieved ones)
    
    assert len(stats["rarest_unlocked"]) > 0
    assert stats["rarest_unlocked"][0]["name"] == "B" # 5% vs 50%
