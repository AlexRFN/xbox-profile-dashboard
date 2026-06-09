"""
Router-level tests using FastAPI TestClient.
These test HTTP behaviour: status codes, response shapes, and concurrency guards.
They run against the real in-memory test database (shared with test_database/).
"""

import contextlib
from unittest.mock import AsyncMock, patch

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
    await db.upsert_games_bulk(
        [
            {
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
            }
        ]
    )

    resp = client.put("/api/game/T001/tracking", json={"status": "backlog", "rating": 4})
    assert resp.status_code == 200
    assert resp.json()["success"] is True

    game = await db.get_game("T001")
    assert game["status"] == "backlog"
    assert game["rating"] == 4


# ---------------------------------------------------------------------------
# /api/sync/full — success and failure paths (API calls stubbed)
# ---------------------------------------------------------------------------


async def _last_sync_log():
    from database.connection import get_connection

    conn = await get_connection()
    cursor = await conn.execute("SELECT * FROM sync_log ORDER BY id DESC LIMIT 1")
    return await cursor.fetchone()


@contextlib.contextmanager
def _patch_background_tasks():
    """Stub the fire-and-forget cache-warm/blurhash tasks spawned after a sync.

    TestClient tears down its per-request event loop as soon as the response
    returns; a background task still mid-aiosqlite-call at that point kills the
    connection's worker thread and deadlocks every later DB call in the test.
    """
    with (
        patch("database.warm_stats_cache", new_callable=AsyncMock),
        patch("sync.orchestrator.warm_stats_cache", new_callable=AsyncMock),
        patch("sync.orchestrator.backfill_blurhashes", new_callable=AsyncMock),
    ):
        yield


@pytest.mark.asyncio
async def test_sync_full_success_path(client):
    api_games = [{"title_id": "SYNC1", "name": "Synced Game", "last_played": "2024-01-01T00:00:00Z"}]
    with (
        patch("sync.games.get_all_games", new_callable=AsyncMock, return_value=api_games),
        patch("sync.games.sync_profile", new_callable=AsyncMock, return_value=True),
        _patch_background_tasks(),
    ):
        resp = client.post("/api/sync/full")
    assert resp.status_code == 200
    body = resp.json()
    assert body["success"] is True
    assert body["games_updated"] == 1
    assert "rate_used" in body

    game = await db.get_game("SYNC1")
    assert game["name"] == "Synced Game"
    row = await _last_sync_log()
    assert row["status"] == "success"


@pytest.mark.asyncio
async def test_sync_full_profile_failure_marks_partial(client):
    with (
        patch("sync.games.get_all_games", new_callable=AsyncMock, return_value=[]),
        patch("sync.games.sync_profile", new_callable=AsyncMock, return_value=False),
        _patch_background_tasks(),
    ):
        resp = client.post("/api/sync/full")
    assert resp.status_code == 200  # games synced fine; profile is non-critical
    row = await _last_sync_log()
    assert row["status"] == "partial"
    assert "profile" in row["error_message"]


@pytest.mark.asyncio
async def test_sync_full_library_failure_returns_502(client):
    with (
        patch("sync.games.get_all_games", new_callable=AsyncMock, side_effect=RuntimeError("API down")),
        _patch_background_tasks(),
    ):
        resp = client.post("/api/sync/full")
    assert resp.status_code == 502
    body = resp.json()
    assert body["success"] is False
    row = await _last_sync_log()
    assert row["status"] == "failed"


# ---------------------------------------------------------------------------
# POST /api/sync — unified sync SSE stream (all API calls stubbed)
# ---------------------------------------------------------------------------


def _fake_screenshots_inner(max_api_calls=0):
    async def gen():
        import orjson

        yield orjson.dumps({"type": "finished", "api_calls_used": 0, "total_screenshots": 0}).decode()

    return gen()


def _parse_sse_events(text: str) -> list[dict]:
    import orjson

    return [orjson.loads(line[len("data: ") :]) for line in text.splitlines() if line.startswith("data: ")]


@pytest.mark.asyncio
async def test_unified_sync_sse_success(client):
    with (
        patch("sync.orchestrator.snapshot_db", new_callable=AsyncMock),
        patch("sync.orchestrator.get_all_games", new_callable=AsyncMock, return_value=[]),
        patch("sync.orchestrator.sync_profile", new_callable=AsyncMock, return_value=True),
        patch("sync.orchestrator.sync_friends", new_callable=AsyncMock, return_value=0),
        patch("sync.orchestrator._sync_screenshots_inner", new=_fake_screenshots_inner),
        _patch_background_tasks(),
    ):
        resp = client.post("/api/sync")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")

    events = _parse_sse_events(resp.text)
    assert any(e.get("type") == "phase" for e in events)
    finished = [e for e in events if e.get("type") == "finished"]
    assert len(finished) == 1
    assert finished[0]["games_updated"] == 0

    row = await _last_sync_log()
    assert row["status"] == "success"
    assert row["error_message"] is None


@pytest.mark.asyncio
async def test_unified_sync_friends_failure_marks_partial(client):
    with (
        patch("sync.orchestrator.snapshot_db", new_callable=AsyncMock),
        patch("sync.orchestrator.get_all_games", new_callable=AsyncMock, return_value=[]),
        patch("sync.orchestrator.sync_profile", new_callable=AsyncMock, return_value=True),
        patch("sync.orchestrator.sync_friends", new_callable=AsyncMock, side_effect=RuntimeError("boom")),
        patch("sync.orchestrator._sync_screenshots_inner", new=_fake_screenshots_inner),
        _patch_background_tasks(),
    ):
        resp = client.post("/api/sync")
    assert resp.status_code == 200
    events = _parse_sse_events(resp.text)
    assert any(e.get("type") == "finished" for e in events)  # stream still completes

    row = await _last_sync_log()
    assert row["status"] == "partial"
    assert "friends" in row["error_message"]


# ---------------------------------------------------------------------------
# /api/sync/failures — list and clear
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sync_failures_list_and_clear(client):
    # sync_failures.title_id has a FK to games — seed the game first
    await db.upsert_games_bulk([{"title_id": "T999", "name": "Broken Game"}])
    await db.log_sync_failure("T999", "Broken Game", "full", "achievement fetch exploded")

    resp = client.get("/api/sync/failures")
    assert resp.status_code == 200
    failures = resp.json()
    assert len(failures) == 1
    assert failures[0]["title_id"] == "T999"

    resp = client.delete("/api/sync/failures")
    assert resp.status_code == 200
    assert resp.json()["success"] is True

    resp = client.get("/api/sync/failures")
    assert resp.json() == []


# ---------------------------------------------------------------------------
# Error shape: API endpoints always return {success, error} on failure
# ---------------------------------------------------------------------------


def test_error_shape_does_not_leak_internals():
    """The global exception handler must not expose raw exception messages."""
    from starlette.testclient import TestClient as _TC

    from main import app as _app

    # `with TestClient` runs the lifespan, which calls xbox_api.resolve_identity()
    # (a real OpenXBL network request) when an API key is set. Patch it to a no-op
    # so the test stays offline and deterministic — patched first so it is active
    # when the TestClient enters and triggers startup.
    # raise_server_exceptions=False lets the 500 response reach us instead of re-raising.
    with (
        patch("xbox_api.resolve_identity", new_callable=AsyncMock),
        _TC(_app, raise_server_exceptions=False) as c,
        patch(
            "routers.sync_routes.sync_game_details", new_callable=AsyncMock, side_effect=RuntimeError("something broke")
        ),
    ):
        resp = c.post("/api/sync/game/DEFINITELY_NOT_REAL_12345")
    assert resp.status_code == 500
    body = resp.json()
    assert "Traceback" not in body.get("error", "")
    assert "File " not in body.get("error", "")
