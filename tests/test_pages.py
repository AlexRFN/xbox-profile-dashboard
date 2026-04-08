"""Integration tests for page routes (HTML responses via TestClient).

These tests verify that each page renders without crashing given a clean or
seeded database. They check status codes and basic HTML structure, not the
visual output.
"""
import pytest

import database as db

# ---------------------------------------------------------------------------
# Shared game/achievement seed data
# ---------------------------------------------------------------------------

_GAME = {
    "title_id": "PG001",
    "name": "Page Test Game",
    "display_image": "https://example.com/img.png",
    "current_gamerscore": 100,
    "total_gamerscore": 1000,
    "progress_percentage": 10,
    "current_achievements": 2,
    "total_achievements": 20,
    "last_played": "2024-06-01T12:00:00Z",
    "is_gamepass": True,
}

_ACH = {
    "achievement_id": "PA1",
    "title_id": "PG001",
    "name": "Page Ach",
    "description": "A description",
    "locked_description": "???",
    "gamerscore": 10,
    "progress_state": "Achieved",
    "time_unlocked": "2024-06-15T10:00:00Z",
    "rarity_category": "Common",
    "rarity_percentage": 80.0,
    "media_assets": None,
    "is_secret": False,
}


# ---------------------------------------------------------------------------
# / — Profile/dashboard page
# ---------------------------------------------------------------------------

def test_dashboard_empty_db(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert "text/html" in resp.headers["content-type"]


@pytest.mark.asyncio
async def test_dashboard_with_data(client):
    await db.upsert_games_bulk([_GAME])
    await db.upsert_achievements("PG001", [_ACH])
    resp = client.get("/")
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# /library
# ---------------------------------------------------------------------------

def test_library_empty(client):
    resp = client.get("/library")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_library_with_games(client):
    await db.upsert_games_bulk([_GAME])
    resp = client.get("/library")
    assert resp.status_code == 200


def test_library_with_filters(client):
    resp = client.get("/library?q=halo&status=playing&sort_by=name&sort_dir=asc")
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# /game/{title_id}
# ---------------------------------------------------------------------------

def test_game_detail_404_for_unknown(client):
    resp = client.get("/game/UNKNOWN_TITLE_99999")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_game_detail_with_seeded_game(client):
    await db.upsert_games_bulk([_GAME])
    resp = client.get("/game/PG001")
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# /timeline
# ---------------------------------------------------------------------------

def test_timeline_empty(client):
    resp = client.get("/timeline")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_timeline_with_events(client):
    await db.upsert_games_bulk([_GAME])
    await db.upsert_achievements("PG001", [_ACH])
    resp = client.get("/timeline")
    assert resp.status_code == 200


def test_timeline_with_filters(client):
    resp = client.get("/timeline?event_type=achievement&game_search=Halo")
    assert resp.status_code == 200


def test_timeline_date_param_compat(client):
    """Single ?date= param should be converted to date_from/date_to."""
    resp = client.get("/timeline?date=2024-05-15")
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# /achievements
# ---------------------------------------------------------------------------

def test_achievements_empty(client):
    resp = client.get("/achievements")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_achievements_with_data(client):
    await db.upsert_games_bulk([_GAME])
    await db.upsert_achievements("PG001", [_ACH])
    resp = client.get("/achievements")
    assert resp.status_code == 200


def test_achievements_with_filters(client):
    resp = client.get("/achievements?q=kill&rarity=Common&sort=date_desc")
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# /captures
# ---------------------------------------------------------------------------

def test_captures_empty(client):
    resp = client.get("/captures")
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# /friends
# ---------------------------------------------------------------------------

def test_friends_empty_triggers_auto_fetch(client):
    resp = client.get("/friends")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_friends_with_data(client):
    await db.upsert_friends([{
        "xuid": "9876543210",
        "gamertag": "TestFriend",
        "displayPicRaw": "",
        "gamerScore": 1000,
        "presenceState": "Online",
        "presenceText": "Playing",
        "isFavorite": False,
    }])
    resp = client.get("/friends")
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# htmx partial routes
# ---------------------------------------------------------------------------

def test_library_table_partial(client):
    resp = client.get("/api/library/table")
    assert resp.status_code == 200


def test_library_grid_partial(client):
    resp = client.get("/api/library/grid")
    assert resp.status_code == 200


def test_achievements_grid_partial(client):
    resp = client.get("/api/achievements/grid")
    assert resp.status_code == 200


def test_timeline_events_partial(client):
    resp = client.get("/api/timeline/events")
    assert resp.status_code == 200


def test_heatmap_partial_rolling(client):
    resp = client.get("/api/heatmap?year=rolling")
    assert resp.status_code == 200


def test_heatmap_partial_invalid_year(client):
    resp = client.get("/api/heatmap?year=badvalue")
    assert resp.status_code == 400


def test_captures_grid_partial(client):
    resp = client.get("/api/captures/grid")
    assert resp.status_code == 200


def test_captures_by_game_partial(client):
    resp = client.get("/api/captures/by-game")
    assert resp.status_code == 200


def test_captures_game_expand_partial(client):
    resp = client.get("/api/captures/game/PG001")
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# Export routes
# ---------------------------------------------------------------------------

def test_export_csv_empty(client):
    resp = client.get("/api/export/csv")
    assert resp.status_code == 200
    assert "text/csv" in resp.headers["content-type"]


@pytest.mark.asyncio
async def test_export_csv_with_data(client):
    await db.upsert_games_bulk([_GAME])
    resp = client.get("/api/export/csv")
    assert resp.status_code == 200
    text = resp.text
    assert "Page Test Game" in text


def test_export_json_empty(client):
    resp = client.get("/api/export/json")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_export_json_with_data(client):
    await db.upsert_games_bulk([_GAME])
    resp = client.get("/api/export/json")
    assert resp.status_code == 200
    data = resp.json()
    assert any(g["name"] == "Page Test Game" for g in data)


# ---------------------------------------------------------------------------
# Stats / misc API routes
# ---------------------------------------------------------------------------

def test_monthly_activity_api(client):
    resp = client.get("/api/activity/month?year=2024&month=6")
    assert resp.status_code == 200


def test_games_index_api(client):
    resp = client.get("/api/games/index")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


def test_random_backlog_no_games(client):
    resp = client.get("/api/random-backlog")
    assert resp.status_code == 200
    assert resp.json()["found"] is False


@pytest.mark.asyncio
async def test_random_backlog_with_backlog_game(client):
    game = dict(_GAME, title_id="BL001", name="Backlog Game")
    await db.upsert_games_bulk([game])
    await db.update_tracking("BL001", status="backlog")
    resp = client.get("/api/random-backlog")
    assert resp.status_code == 200
    body = resp.json()
    assert body["found"] is True
    assert body["title_id"] == "BL001"


# ---------------------------------------------------------------------------
# Capture download SSRF guard
# ---------------------------------------------------------------------------

def test_capture_download_rejects_non_xbox_domain(client):
    resp = client.get("/api/captures/download?url=https://evil.com/file.png&filename=test.png")
    assert resp.status_code == 403


def test_capture_download_rejects_non_https(client):
    resp = client.get("/api/captures/download?url=ftp://gameclips.xboxlive.com/file.png")
    assert resp.status_code == 403


def test_capture_download_rejects_userinfo_ssrf(client):
    resp = client.get("/api/captures/download?url=https://evil.com@gameclips.xboxlive.com/f.png")
    assert resp.status_code == 403
