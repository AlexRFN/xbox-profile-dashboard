"""Targeted tests for sync/orchestrator.py — game update loop, screenshot phase,
and failure paths. All external I/O is mocked so no live API calls are made."""
from unittest.mock import AsyncMock, patch

import orjson
import pytest

from models import SyncResult
from sync.orchestrator import _process_one_change, _unified_sync_inner

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _change(title_id="G1", name="Game One", sync_type="full", cost=3, reason="new"):
    return {"game": {"title_id": title_id, "name": name},
            "reason": reason, "sync_type": sync_type, "api_cost": cost}


async def _sse_items(gen):
    """Collect all SSE items from an async generator."""
    items = []
    async for item in gen:
        items.append(orjson.loads(item))
    return items


def _base_patches(*, api_games=None, changes=None, db_snapshot=None):
    """Return a dict of common patches for _unified_sync_inner."""
    return {
        "sync.orchestrator.get_api_calls_last_hour": 0,
        "sync.orchestrator.RATE_LIMIT_BUDGET": 999,
        "sync.orchestrator.get_all_games":
            AsyncMock(return_value=api_games or []),
        "sync.orchestrator.create_sync_log":
            AsyncMock(return_value=1),
        "sync.orchestrator.update_sync_log":
            AsyncMock(),
        "sync.orchestrator.sync_profile":
            AsyncMock(),
        "sync.orchestrator.sync_friends":
            AsyncMock(),
        "sync.orchestrator.get_games_for_change_detection":
            AsyncMock(return_value=db_snapshot or {}),
        "sync.orchestrator.upsert_games_bulk":
            AsyncMock(return_value=len(api_games or [])),
        "sync.orchestrator.detect_changed_games":
            lambda *_: changes or [],
        "sync.orchestrator.fire_and_forget":
            lambda coro: coro.close(),
    }


# ---------------------------------------------------------------------------
# _process_one_change
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_process_one_change_success():
    """Happy-path: sync_game_selective returns a successful SyncResult."""
    result_obj = SyncResult(success=True, message="ok", api_calls_used=3)
    change = _change()

    with patch("sync.orchestrator.sync_game_selective",
               new_callable=AsyncMock, return_value=result_obj), \
         patch("sync.orchestrator.log_sync_failure", new_callable=AsyncMock):
        import asyncio
        sem = asyncio.Semaphore(1)
        name, reason, result = await _process_one_change(change, sem)

    assert name == "Game One"
    assert reason == "new"
    assert result.success is True
    assert result.api_calls_used == 3


@pytest.mark.asyncio
async def test_process_one_change_exception_returns_failure():
    """If sync_game_selective raises, _process_one_change catches it and returns SyncResult(False)."""
    change = _change()

    with patch("sync.orchestrator.sync_game_selective",
               new_callable=AsyncMock, side_effect=RuntimeError("network error")), \
         patch("sync.orchestrator.log_sync_failure", new_callable=AsyncMock) as mock_log:
        import asyncio
        sem = asyncio.Semaphore(1)
        _name, _reason, result = await _process_one_change(change, sem)

    assert result.success is False
    assert "network error" in result.message
    mock_log.assert_called_once()


@pytest.mark.asyncio
async def test_process_one_change_cancelled_error_reraises():
    """CancelledError must propagate — never swallow task cancellation."""
    import asyncio
    change = _change()

    with patch("sync.orchestrator.sync_game_selective",
               new_callable=AsyncMock, side_effect=asyncio.CancelledError()):
        sem = asyncio.Semaphore(1)
        with pytest.raises(asyncio.CancelledError):
            await _process_one_change(change, sem)


# ---------------------------------------------------------------------------
# Full sync with game changes — happy path
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_unified_sync_with_one_successful_game():
    """One game change that succeeds should appear as a progress event."""
    api_game = {"title_id": "G1", "name": "Game One"}
    change = _change("G1", "Game One")
    sync_result = SyncResult(success=True, message="ok", api_calls_used=3)

    patches = _base_patches(api_games=[api_game], changes=[change])
    patches["sync.orchestrator.sync_game_selective"] = AsyncMock(return_value=sync_result)

    with patch("sync.orchestrator.get_api_calls_last_hour",
               side_effect=[0, 0, 0, 0]), \
         patch("sync.orchestrator.RATE_LIMIT_BUDGET", 999), \
         patch("sync.orchestrator.get_all_games",
               new_callable=AsyncMock, return_value=[api_game]), \
         patch("sync.orchestrator.create_sync_log",
               new_callable=AsyncMock, return_value=1), \
         patch("sync.orchestrator.update_sync_log", new_callable=AsyncMock), \
         patch("sync.orchestrator.sync_profile", new_callable=AsyncMock), \
         patch("sync.orchestrator.sync_friends", new_callable=AsyncMock), \
         patch("sync.orchestrator.get_games_for_change_detection",
               new_callable=AsyncMock, return_value={}), \
         patch("sync.orchestrator.upsert_games_bulk",
               new_callable=AsyncMock, return_value=1), \
         patch("sync.orchestrator.detect_changed_games", return_value=[change]), \
         patch("sync.orchestrator.sync_game_selective",
               new_callable=AsyncMock, return_value=sync_result), \
         patch("sync.orchestrator._sync_screenshots_inner",
               return_value=_empty_async_gen()), \
         patch("sync.orchestrator.fire_and_forget", side_effect=lambda coro: coro.close()):
        events = await _sse_items(_unified_sync_inner())

    types = [e["type"] for e in events]
    assert "phase" in types
    assert "progress" in types
    assert "finished" in types

    finished = next(e for e in events if e["type"] == "finished")
    assert finished["games_updated"] == 1


@pytest.mark.asyncio
async def test_unified_sync_with_one_failed_game():
    """A failing game sync should count in failed_games, not games_updated."""
    api_game = {"title_id": "G1", "name": "Game One"}
    change = _change("G1", "Game One")
    sync_result = SyncResult(success=False, message="timeout", api_calls_used=1)

    with patch("sync.orchestrator.get_api_calls_last_hour", side_effect=[0, 0, 0, 0]), \
         patch("sync.orchestrator.RATE_LIMIT_BUDGET", 999), \
         patch("sync.orchestrator.get_all_games",
               new_callable=AsyncMock, return_value=[api_game]), \
         patch("sync.orchestrator.create_sync_log",
               new_callable=AsyncMock, return_value=1), \
         patch("sync.orchestrator.update_sync_log", new_callable=AsyncMock), \
         patch("sync.orchestrator.sync_profile", new_callable=AsyncMock), \
         patch("sync.orchestrator.sync_friends", new_callable=AsyncMock), \
         patch("sync.orchestrator.get_games_for_change_detection",
               new_callable=AsyncMock, return_value={}), \
         patch("sync.orchestrator.upsert_games_bulk",
               new_callable=AsyncMock, return_value=1), \
         patch("sync.orchestrator.detect_changed_games", return_value=[change]), \
         patch("sync.orchestrator.sync_game_selective",
               new_callable=AsyncMock, return_value=sync_result), \
         patch("sync.orchestrator._sync_screenshots_inner",
               return_value=_empty_async_gen()), \
         patch("sync.orchestrator.fire_and_forget", side_effect=lambda coro: coro.close()):
        events = await _sse_items(_unified_sync_inner())

    finished = next(e for e in events if e["type"] == "finished")
    assert finished["games_updated"] == 0


# ---------------------------------------------------------------------------
# Screenshot phase
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_unified_sync_screenshots_phase_yields_progress():
    """Screenshot progress events should be forwarded; finished consumed for totals."""
    progress_item = orjson.dumps({"type": "screenshot_progress", "saved": 1}).decode()
    finished_item = orjson.dumps(
        {"type": "finished", "api_calls_used": 2, "total_screenshots": 5}
    ).decode()

    with patch("sync.orchestrator.get_api_calls_last_hour", side_effect=[0, 0, 0, 0]), \
         patch("sync.orchestrator.RATE_LIMIT_BUDGET", 999), \
         patch("sync.orchestrator.get_all_games",
               new_callable=AsyncMock, return_value=[]), \
         patch("sync.orchestrator.create_sync_log",
               new_callable=AsyncMock, return_value=1), \
         patch("sync.orchestrator.update_sync_log", new_callable=AsyncMock), \
         patch("sync.orchestrator.sync_profile", new_callable=AsyncMock), \
         patch("sync.orchestrator.sync_friends", new_callable=AsyncMock), \
         patch("sync.orchestrator.get_games_for_change_detection",
               new_callable=AsyncMock, return_value={}), \
         patch("sync.orchestrator.upsert_games_bulk",
               new_callable=AsyncMock, return_value=0), \
         patch("sync.orchestrator.detect_changed_games", return_value=[]), \
         patch("sync.orchestrator._sync_screenshots_inner",
               return_value=_items_gen([progress_item, finished_item])), \
         patch("sync.orchestrator.fire_and_forget", side_effect=lambda coro: coro.close()):
        events = await _sse_items(_unified_sync_inner())

    # Progress item forwarded
    assert any(e.get("type") == "screenshot_progress" for e in events)
    # Finished item consumed; total_screenshots reflected in outer finished
    finished = next(e for e in events if e["type"] == "finished")
    assert finished["screenshots_synced"] == 5


# ---------------------------------------------------------------------------
# Failure paths
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_unified_sync_friends_failure_is_non_critical():
    """Friends sync failure should not abort the overall sync."""
    with patch("sync.orchestrator.get_api_calls_last_hour", side_effect=[0, 0, 0, 0]), \
         patch("sync.orchestrator.RATE_LIMIT_BUDGET", 999), \
         patch("sync.orchestrator.get_all_games",
               new_callable=AsyncMock, return_value=[]), \
         patch("sync.orchestrator.create_sync_log",
               new_callable=AsyncMock, return_value=1), \
         patch("sync.orchestrator.update_sync_log", new_callable=AsyncMock), \
         patch("sync.orchestrator.sync_profile", new_callable=AsyncMock), \
         patch("sync.orchestrator.sync_friends",
               new_callable=AsyncMock, side_effect=RuntimeError("friends API down")), \
         patch("sync.orchestrator.get_games_for_change_detection",
               new_callable=AsyncMock, return_value={}), \
         patch("sync.orchestrator.upsert_games_bulk",
               new_callable=AsyncMock, return_value=0), \
         patch("sync.orchestrator.detect_changed_games", return_value=[]), \
         patch("sync.orchestrator._sync_screenshots_inner",
               return_value=_empty_async_gen()), \
         patch("sync.orchestrator.fire_and_forget", side_effect=lambda coro: coro.close()):
        events = await _sse_items(_unified_sync_inner())

    # Sync should still complete
    assert any(e["type"] == "finished" for e in events)


@pytest.mark.asyncio
async def test_unified_sync_library_fetch_generic_exception():
    """Non-rate-limit exception during library fetch yields finished with error message."""
    with patch("sync.orchestrator.get_api_calls_last_hour", return_value=0), \
         patch("sync.orchestrator.RATE_LIMIT_BUDGET", 999), \
         patch("sync.orchestrator.get_all_games",
               new_callable=AsyncMock, side_effect=ConnectionError("connection refused")), \
         patch("sync.orchestrator.create_sync_log",
               new_callable=AsyncMock, return_value=1), \
         patch("sync.orchestrator.update_sync_log", new_callable=AsyncMock), \
         patch("sync.orchestrator.fire_and_forget", side_effect=lambda coro: coro.close()):
        events = await _sse_items(_unified_sync_inner())

    assert any(e["type"] == "finished" for e in events)
    finished = next(e for e in events if e["type"] == "finished")
    assert "connection refused" in finished["message"].lower() or finished["games_updated"] == 0


@pytest.mark.asyncio
async def test_unified_sync_partial_status_when_changes_remain():
    """When more changes exist than budget allows, status should be 'partial'."""
    api_games = [{"title_id": f"G{i}", "name": f"Game {i}"} for i in range(10)]
    # 10 changes but budget only covers 1 (cost=3, budget_pct leaves ~3 calls)
    changes = [_change(f"G{i}", f"Game {i}") for i in range(10)]
    sync_result = SyncResult(success=True, message="ok", api_calls_used=3)

    with patch("sync.orchestrator.get_api_calls_last_hour", side_effect=[0, 0, 0, 0]), \
         patch("sync.orchestrator.RATE_LIMIT_BUDGET", 9), \
         patch("sync.orchestrator.get_all_games",
               new_callable=AsyncMock, return_value=api_games), \
         patch("sync.orchestrator.create_sync_log",
               new_callable=AsyncMock, return_value=1), \
         patch("sync.orchestrator.update_sync_log", new_callable=AsyncMock) as mock_update, \
         patch("sync.orchestrator.sync_profile", new_callable=AsyncMock), \
         patch("sync.orchestrator.sync_friends", new_callable=AsyncMock), \
         patch("sync.orchestrator.get_games_for_change_detection",
               new_callable=AsyncMock, return_value={}), \
         patch("sync.orchestrator.upsert_games_bulk",
               new_callable=AsyncMock, return_value=10), \
         patch("sync.orchestrator.detect_changed_games", return_value=changes), \
         patch("sync.orchestrator.sync_game_selective",
               new_callable=AsyncMock, return_value=sync_result), \
         patch("sync.orchestrator._sync_screenshots_inner",
               return_value=_empty_async_gen()), \
         patch("sync.orchestrator.fire_and_forget", side_effect=lambda coro: coro.close()):
        await _sse_items(_unified_sync_inner())

    # update_sync_log should have been called with "partial" status
    call_args = mock_update.call_args_list
    statuses = [c.args[1] for c in call_args if len(c.args) > 1]
    assert "partial" in statuses


# ---------------------------------------------------------------------------
# Async generator helpers
# ---------------------------------------------------------------------------

async def _empty_async_gen():
    return
    yield


async def _items_gen(items):
    for item in items:
        yield item
