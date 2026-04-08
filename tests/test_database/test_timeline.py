"""Tests for database/timeline.py — UNION ALL timeline query."""
import pytest

import database as db

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_GAME = {
    "title_id": "TL001",
    "name": "Timeline Game",
    "display_image": "https://example.com/img.png",
    "current_gamerscore": 200,
    "total_gamerscore": 1000,
    "progress_percentage": 20,
    "current_achievements": 4,
    "total_achievements": 20,
    "last_played": "2024-06-01T12:00:00Z",
    "is_gamepass": False,
}

_ACH = {
    "achievement_id": "A1",
    "title_id": "TL001",
    "name": "First Blood",
    "description": "Kill something",
    "locked_description": "???",
    "gamerscore": 10,
    "progress_state": "Achieved",
    "time_unlocked": "2024-05-15T10:00:00Z",
    "rarity_category": "Common",
    "rarity_percentage": 80.0,
    "media_assets": None,
    "is_secret": False,
}


async def _seed():
    await db.upsert_games_bulk([_GAME])
    await db.upsert_achievements("TL001", [_ACH])


# ---------------------------------------------------------------------------
# get_timeline_events
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_empty_db_returns_empty_events():
    events, has_more = await db.get_timeline_events()
    assert events == []
    assert has_more is False


@pytest.mark.asyncio
async def test_achievement_event_appears_in_timeline():
    await _seed()
    events, _has_more = await db.get_timeline_events()
    assert len(events) >= 1
    ach_events = [e for e in events if e["event_type"] == "achievement"]
    assert len(ach_events) >= 1
    assert ach_events[0]["event_title"] == "First Blood"
    assert ach_events[0]["game_name"] == "Timeline Game"


@pytest.mark.asyncio
async def test_first_played_event_generated():
    await _seed()
    events, _ = await db.get_timeline_events()
    fp_events = [e for e in events if e["event_type"] == "first_played"]
    assert len(fp_events) == 1


@pytest.mark.asyncio
async def test_completion_event_for_100pct_game():
    game = dict(_GAME, progress_percentage=100, current_achievements=20,
                title_id="TL002", name="Complete Game")
    ach = dict(_ACH, achievement_id="A2")
    await db.upsert_games_bulk([game])
    await db.upsert_achievements("TL002", [ach])
    events, _ = await db.get_timeline_events()
    comp_events = [e for e in events if e["event_type"] == "completion"]
    assert len(comp_events) >= 1


@pytest.mark.asyncio
async def test_event_type_filter():
    await _seed()
    events, _ = await db.get_timeline_events(event_type="achievement")
    assert all(e["event_type"] == "achievement" for e in events)


@pytest.mark.asyncio
async def test_game_search_filter():
    await _seed()
    events, _ = await db.get_timeline_events(game_search="Timeline")
    assert all("Timeline" in e["game_name"] for e in events)

    events_miss, _ = await db.get_timeline_events(game_search="NOMATCH_XYZ")
    assert events_miss == []


@pytest.mark.asyncio
async def test_date_range_filter_excludes_outside():
    await _seed()
    events_in, _ = await db.get_timeline_events(date_from="2024-05-15", date_to="2024-05-15")
    assert len(events_in) >= 1

    events_out, _ = await db.get_timeline_events(date_from="2023-01-01", date_to="2023-01-02")
    assert events_out == []


@pytest.mark.asyncio
async def test_pagination_has_more():
    # Seed 3 achievements — request page_size=2 so has_more=True
    await db.upsert_games_bulk([_GAME])
    achs = [
        dict(_ACH, achievement_id=f"AP{i}", name=f"Ach {i}",
             time_unlocked=f"2024-0{i+1}-01T10:00:00Z")
        for i in range(1, 4)
    ]
    await db.upsert_achievements("TL001", achs)
    events, has_more = await db.get_timeline_events(page=1, per_page=1)
    assert has_more is True
    assert len(events) == 1


# ---------------------------------------------------------------------------
# get_timeline_stats_and_months
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_stats_empty_db():
    stats, months = await db.get_timeline_stats_and_months()
    assert stats["achievement_count"] == 0
    assert stats["total_gamerscore"] == 0
    assert months == {}


@pytest.mark.asyncio
async def test_stats_counts_achievements():
    await _seed()
    stats, months = await db.get_timeline_stats_and_months()
    assert stats["achievement_count"] >= 1
    assert stats["total_gamerscore"] >= 10
    assert stats["total_events"] >= 1
    # month key should exist for the unlock date
    assert any("2024-05" in mk for mk in months)
