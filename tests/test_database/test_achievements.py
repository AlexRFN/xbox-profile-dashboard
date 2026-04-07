import pytest
from database.games import upsert_games_bulk
from database.achievements import (
    upsert_achievements, get_achievements, update_achievement_progress,
    get_achievements_page
)

@pytest.mark.asyncio
async def test_upsert_and_get_achievements():
    await upsert_games_bulk([{"title_id": "1", "name": "Game A"}])

    achievements = [
        {
            "achievement_id": "a1",
            "name": "First Blood",
            "gamerscore": 10,
            "progress_state": "Achieved",
            "time_unlocked": "2023-01-01T12:00:00Z"
        },
        {
            "achievement_id": "a2",
            "name": "Master",
            "gamerscore": 50,
            "progress_state": "NotStarted",
            "time_unlocked": None
        }
    ]

    upserted = await upsert_achievements("1", achievements)
    assert upserted == 2

    saved = await get_achievements("1")
    assert len(saved) == 2
    assert saved[0]["achievement_id"] == "a1"
    assert saved[0]["progress_state"] == "Achieved"

@pytest.mark.asyncio
async def test_update_achievement_progress():
    await upsert_games_bulk([{"title_id": "2", "name": "Game B"}])
    await upsert_achievements("2", [{
        "achievement_id": "a1", "name": "Test", "progress_state": "NotStarted"
    }])

    await update_achievement_progress("2", [{
        "achievement_id": "a1", "progress_state": "Achieved", "gamerscore": 20, "time_unlocked": "2023-01-02T00:00:00Z"
    }])

    saved = await get_achievements("2")
    assert saved[0]["progress_state"] == "Achieved"
    assert saved[0]["gamerscore"] == 20
    assert saved[0]["time_unlocked"] == "2023-01-02T00:00:00Z"

@pytest.mark.asyncio
async def test_get_achievements_page():
    await upsert_games_bulk([{"title_id": "3", "name": "Game C"}])
    await upsert_achievements("3", [
        {"achievement_id": "1", "name": "Find me", "description": "Hidden item", "progress_state": "Achieved", "gamerscore": 5},
        {"achievement_id": "2", "name": "Ignore me", "description": "Nothing", "progress_state": "NotStarted", "gamerscore": 10}
    ])

    results, total = await get_achievements_page(q="Find")
    assert total == 1
    assert results[0]["name"] == "Find me"

    results, total = await get_achievements_page(status="locked")
    assert total == 1
    assert results[0]["name"] == "Ignore me"
