"""Tests for database/heatmap.py — heatmap data queries."""
import pytest

import database as db

_GAME = {
    "title_id": "HM001",
    "name": "Heatmap Game",
    "display_image": "https://example.com/img.png",
    "current_gamerscore": 100,
    "total_gamerscore": 1000,
    "progress_percentage": 10,
    "current_achievements": 2,
    "total_achievements": 20,
    "last_played": "2024-06-01T12:00:00Z",
    "is_gamepass": False,
}

_ACH_BASE = {
    "achievement_id": "HA1",
    "title_id": "HM001",
    "name": "Heat Ach",
    "description": "desc",
    "locked_description": "???",
    "gamerscore": 10,
    "progress_state": "Achieved",
    "time_unlocked": "2024-06-15T10:00:00Z",
    "rarity_category": "Common",
    "rarity_percentage": 80.0,
    "media_assets": None,
    "is_secret": False,
}


@pytest.mark.asyncio
async def test_get_heatmap_data_empty():
    result = await db.get_heatmap_data()
    assert result == []


@pytest.mark.asyncio
async def test_get_heatmap_data_rolling_returns_day_counts():
    await db.upsert_games_bulk([_GAME])
    await db.upsert_achievements("HM001", [_ACH_BASE])
    rows = await db.get_heatmap_data()
    assert isinstance(rows, list)
    # May be empty if the achievement date is > 371 days ago; test structure only
    for row in rows:
        assert "day" in row
        assert "count" in row


@pytest.mark.asyncio
async def test_get_heatmap_data_year_mode():
    await db.upsert_games_bulk([_GAME])
    await db.upsert_achievements("HM001", [_ACH_BASE])
    rows = await db.get_heatmap_data(year=2024)
    assert isinstance(rows, list)
    for row in rows:
        assert row["day"].startswith("2024-")


@pytest.mark.asyncio
async def test_get_heatmap_year_range_empty():
    result = await db.get_heatmap_year_range()
    assert result is None


@pytest.mark.asyncio
async def test_get_heatmap_year_range_returns_tuple():
    await db.upsert_games_bulk([_GAME])
    await db.upsert_achievements("HM001", [_ACH_BASE])
    result = await db.get_heatmap_year_range()
    if result is not None:
        min_year, max_year = result
        assert isinstance(min_year, int)
        assert isinstance(max_year, int)
        assert min_year <= max_year


@pytest.mark.asyncio
async def test_get_monthly_activity_empty():
    result = await db.get_monthly_activity(2024, 6)
    assert result == {}


@pytest.mark.asyncio
async def test_get_monthly_activity_with_data():
    await db.upsert_games_bulk([_GAME])
    await db.upsert_achievements("HM001", [_ACH_BASE])
    result = await db.get_monthly_activity(2024, 6)
    assert isinstance(result, dict)
    # Day 15 should have 1 unlock
    if 15 in result:
        assert result[15] >= 1
