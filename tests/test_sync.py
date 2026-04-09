"""Tests for sync layer: core utilities, orchestrator pure functions,
budget logic, and orchestrator early-exit paths (insufficient budget, rate limit)."""
from unittest.mock import AsyncMock, patch

import pytest

from sync.core import (
    _json,
    _get_sync_gate,
    fit_changes_to_budget,
    is_sync_running,
    sync_guard,
)
from sync.orchestrator import _build_sync_message

# ---------------------------------------------------------------------------
# _json
# ---------------------------------------------------------------------------

def test_json_encodes_dict():
    result = _json({"type": "progress", "done": 1})
    assert '"type"' in result
    assert '"progress"' in result


def test_json_encodes_nested():
    result = _json({"a": [1, 2, 3]})
    assert "1" in result


# ---------------------------------------------------------------------------
# fit_changes_to_budget
# ---------------------------------------------------------------------------

def _change(name: str, cost: int = 3) -> dict:
    return {"game": {"title_id": name, "name": name}, "reason": "new",
            "sync_type": "full", "api_cost": cost}


def test_fit_empty_changes():
    batch, cost = fit_changes_to_budget([], 100)
    assert batch == []
    assert cost == 0


def test_fit_all_fit_within_budget():
    changes = [_change("A"), _change("B"), _change("C")]
    batch, cost = fit_changes_to_budget(changes, 12)
    assert len(batch) == 3
    assert cost == 9


def test_fit_stops_when_budget_exceeded():
    changes = [_change(f"G{i}") for i in range(10)]  # 10 * 3 = 30 calls
    batch, cost = fit_changes_to_budget(changes, 10)
    assert len(batch) == 3  # 3 * 3 = 9 fits, 4th would be 12 > 10
    assert cost == 9


def test_fit_zero_budget():
    changes = [_change("A")]
    batch, cost = fit_changes_to_budget(changes, 0)
    assert batch == []
    assert cost == 0


def test_fit_stats_only_changes_cost_one():
    changes = [_change("A", cost=1) for _ in range(5)]
    batch, cost = fit_changes_to_budget(changes, 3)
    assert len(batch) == 3
    assert cost == 3


# ---------------------------------------------------------------------------
# is_sync_running / sync_guard
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_is_sync_running_false_initially():
    assert is_sync_running() is False


@pytest.mark.asyncio
async def test_sync_guard_acquired_yields_true():
    async with sync_guard("test") as acquired:
        assert acquired is True
        assert is_sync_running() is True
    assert is_sync_running() is False


@pytest.mark.asyncio
async def test_sync_guard_busy_yields_false():
    gate = _get_sync_gate()
    await gate.acquire()
    try:
        async with sync_guard("test") as acquired:
            assert acquired is False
    finally:
        gate.release()


@pytest.mark.asyncio
async def test_sync_guard_releases_on_exception():
    try:
        async with sync_guard("test") as acquired:
            assert acquired is True
            raise ValueError("oops")
    except ValueError:
        pass
    assert is_sync_running() is False


# ---------------------------------------------------------------------------
# _build_sync_message
# ---------------------------------------------------------------------------

def test_build_message_all_updated():
    msg = _build_sync_message(5, 0, 0, 0, 10)
    assert "5 games updated" in msg
    assert "10 API calls" in msg


def test_build_message_with_failures():
    msg = _build_sync_message(3, 2, 0, 0, 8)
    assert "3 games updated" in msg
    assert "2 games failed" in msg


def test_build_message_with_screenshots():
    msg = _build_sync_message(0, 0, 12, 0, 5)
    assert "12 new screenshots" in msg


def test_build_message_nothing_to_do():
    msg = _build_sync_message(0, 0, 0, 0, 2)
    assert "up to date" in msg.lower()


def test_build_message_with_remaining():
    msg = _build_sync_message(5, 0, 0, 10, 15)
    assert "10 games remaining" in msg


# ---------------------------------------------------------------------------
# Orchestrator early-exit: not enough budget
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_unified_sync_exits_when_no_budget():
    """When rate limit budget is exhausted, the sync yields a 'finished' event immediately."""
    from sync.orchestrator import _unified_sync_inner

    with patch("sync.orchestrator.get_api_calls_last_hour", return_value=999), \
         patch("sync.orchestrator.RATE_LIMIT_BUDGET", 10):
        events = []
        async for item in _unified_sync_inner():
            events.append(item)
            break  # only need the first event

    import orjson
    data = orjson.loads(events[0])
    assert data["type"] == "finished"
    assert "budget" in data["message"].lower() or "remaining" in data["message"].lower()


# ---------------------------------------------------------------------------
# Orchestrator early-exit: rate limit exceeded on library fetch
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_unified_sync_exits_on_rate_limit_exception():
    """RateLimitExceeded during library fetch should yield a 'finished' event."""
    from sync.orchestrator import _unified_sync_inner
    from xbox_api import RateLimitExceeded

    with patch("sync.orchestrator.get_api_calls_last_hour", return_value=0), \
         patch("sync.orchestrator.RATE_LIMIT_BUDGET", 999), \
         patch("sync.orchestrator.get_all_games",
               new_callable=AsyncMock, side_effect=RateLimitExceeded("limit")), \
         patch("sync.orchestrator.create_sync_log",
               new_callable=AsyncMock, return_value=1), \
         patch("sync.orchestrator.update_sync_log", new_callable=AsyncMock):
        events = []
        async for item in _unified_sync_inner():
            events.append(item)

    import orjson
    # First item should be the phase event, last should be finished
    finished = [e for e in events if orjson.loads(e).get("type") == "finished"]
    assert len(finished) >= 1


# ---------------------------------------------------------------------------
# Orchestrator: empty library sync (no games, no changes)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_unified_sync_empty_library():
    """Sync with an empty API response should complete with 0 games updated."""
    from sync.orchestrator import _unified_sync_inner

    with patch("sync.orchestrator.get_api_calls_last_hour", return_value=0), \
         patch("sync.orchestrator.RATE_LIMIT_BUDGET", 999), \
         patch("sync.orchestrator.get_all_games",
               new_callable=AsyncMock, return_value=[]), \
         patch("sync.orchestrator.create_sync_log",
               new_callable=AsyncMock, return_value=1), \
         patch("sync.orchestrator.update_sync_log", new_callable=AsyncMock), \
         patch("sync.orchestrator.sync_profile", new_callable=AsyncMock), \
         patch("sync.orchestrator.sync_friends", new_callable=AsyncMock), \
         patch("sync.orchestrator._sync_screenshots_inner",
               return_value=async_empty_gen()), \
         patch("sync.orchestrator.fire_and_forget", side_effect=lambda coro: coro.close()):
        events = []
        async for item in _unified_sync_inner():
            events.append(item)

    import orjson
    finished = [orjson.loads(e) for e in events if orjson.loads(e).get("type") == "finished"]
    assert len(finished) == 1
    assert finished[0]["games_updated"] == 0


async def async_empty_gen():
    return
    yield  # makes this an async generator
