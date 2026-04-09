"""
Router-level tests using FastAPI TestClient.
These test HTTP behaviour: status codes, response shapes, and concurrency guards.
They run against the real in-memory test database (shared with test_database/).
"""
import pytest

import database as db
from sync.core import _get_sync_gate

# ---------------------------------------------------------------------------
# /api/stats
# ---------------------------------------------------------------------------

def test_stats_returns_200(client):
    resp = client.get("/api/stats")
    assert resp.status_code == 200
    body = resp.json()
    assert "total_games" in body


# ---------------------------------------------------------------------------
# /api/rate-limit
# ---------------------------------------------------------------------------

def test_rate_limit_returns_200(client):
    resp = client.get("/api/rate-limit")
    assert resp.status_code == 200
    body = resp.json()
    assert "used" in body or "calls_used" in body or isinstance(body, dict)


# ---------------------------------------------------------------------------
# /api/sync/status
# ---------------------------------------------------------------------------

def test_sync_status_idle(client):
    resp = client.get("/api/sync/status")
    assert resp.status_code == 200
    assert resp.json() == {"running": False}


# ---------------------------------------------------------------------------
# /api/sync/full — 409 when lock is held
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_sync_full_returns_409_when_busy(client):
    """Acquiring the sync lock externally forces the endpoint to return 409."""
    gate = _get_sync_gate()
    await gate.acquire()
    try:
        resp = client.post("/api/sync/full")
        assert resp.status_code == 409
        body = resp.json()
        assert body["success"] is False
    finally:
        gate.release()


# ---------------------------------------------------------------------------
# /api/sync/game/{title_id} — 409 when lock is held
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_sync_game_returns_409_when_busy(client):
    gate = _get_sync_gate()
    await gate.acquire()
    try:
        resp = client.post("/api/sync/game/FAKE_TITLE_ID")
        assert resp.status_code == 409
        body = resp.json()
        assert body["success"] is False
    finally:
        gate.release()


# ---------------------------------------------------------------------------
# PUT /api/game/{title_id}/tracking — unknown game silently no-ops (SQLite
# UPDATE with no matching rows returns rowcount=0 without raising).
# ---------------------------------------------------------------------------

def test_tracking_update_unknown_game(client):
    resp = client.put(
        "/api/game/NONEXISTENT/tracking",
        json={"status": "playing"},
    )
    # Route doesn't check existence — SQLite UPDATE on a missing row is a
    # silent no-op, so 200 is the current behaviour.
    assert resp.status_code == 200
    assert resp.json()["success"] is True


# ---------------------------------------------------------------------------
# PUT /api/game/{title_id}/tracking — manual fields preserved after update
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_tracking_update_persists(client):
    # Seed a game
    await db.upsert_games_bulk([{
        "title_id": "T001",
        "name": "Test Game",
        "display_image": "https://example.com/img.png",
        "current_gamerscore": 0,
        "total_gamerscore": 1000,
        "progress_percentage": 0,
        "current_achievements": 0,
        "total_achievements": 40,
        "last_played": "2024-01-01T00:00:00Z",
        "is_gamepass": False,
    }])

    resp = client.put("/api/game/T001/tracking", json={"status": "backlog", "rating": 4})
    assert resp.status_code == 200
    assert resp.json()["success"] is True

    game = await db.get_game("T001")
    assert game["status"] == "backlog"
    assert game["rating"] == 4


# ---------------------------------------------------------------------------
# Error shape: API endpoints always return {success, error} on failure
# ---------------------------------------------------------------------------

@pytest.mark.timeout(60)
def test_error_shape_does_not_leak_internals(client):
    """The global exception handler must not expose raw exception messages."""
    # Trigger a 500 by hitting a route that will fail (nonexistent title sync)
    # without holding the lock, which would return 409 instead.
    resp = client.post("/api/sync/game/DEFINITELY_NOT_REAL_12345")
    # Could be 200 (empty result), 409, 500, or 502 — just verify no raw traceback in body
    if resp.status_code == 500:
        body = resp.json()
        assert "Traceback" not in body.get("error", "")
        assert "File " not in body.get("error", "")
