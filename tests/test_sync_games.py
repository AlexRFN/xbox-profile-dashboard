"""Tests for sync/games.py — pure logic functions.

Covers detect_changed_games (no I/O) and sync_game_selective dispatch
with all external calls mocked.  These are contract-level tests: they
verify that the change-detection algorithm correctly maps OpenXBL API
payload shapes to sync decisions, and that sync_game_selective routes
to the right code path for each sync_type.
"""
from unittest.mock import AsyncMock, patch

import pytest

from sync.games import detect_changed_games, sync_game_selective

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _api_game(
    title_id="G1",
    gs=100,
    total_gs=200,
    ach=5,
    total_ach=10,
    last_played="2024-05-01T00:00:00Z",
    progress=50.0,
):
    return {
        "title_id": title_id,
        "name": f"Game {title_id}",
        "current_gamerscore": gs,
        "total_gamerscore": total_gs,
        "current_achievements": ach,
        "total_achievements": total_ach,
        "last_played": last_played,
        "progress_percentage": progress,
    }


def _db_row(
    title_id="G1",
    gs=100,
    total_gs=200,
    ach=5,
    total_ach=10,
    last_played="2024-05-01T00:00:00Z",
    stats_last_fetched: str | None = "2024-06-01T00:00:00Z",
):
    return {
        "title_id": title_id,
        "current_gamerscore": gs,
        "total_gamerscore": total_gs,
        "current_achievements": ach,
        "total_achievements": total_ach,
        "last_played": last_played,
        "stats_last_fetched": stats_last_fetched,
    }


# ---------------------------------------------------------------------------
# detect_changed_games — new / never-fetched
# ---------------------------------------------------------------------------

def test_new_game_not_in_db():
    """Game absent from snapshot → sync_type='full', reason='new game'."""
    changes = detect_changed_games([_api_game()], {})
    assert len(changes) == 1
    assert changes[0]["sync_type"] == "full"
    assert changes[0]["reason"] == "new game"
    assert changes[0]["api_cost"] == 3


def test_game_never_fetched():
    """Game in DB but stats_last_fetched is None → 'never fetched'."""
    db = {"G1": _db_row(stats_last_fetched=None)}
    changes = detect_changed_games([_api_game()], db)
    assert len(changes) == 1
    assert changes[0]["reason"] == "never fetched"
    assert changes[0]["sync_type"] == "full"


# ---------------------------------------------------------------------------
# detect_changed_games — no-change (skip)
# ---------------------------------------------------------------------------

def test_no_changes_skipped():
    """Identical API and DB data → no changes."""
    db = {"G1": _db_row()}
    changes = detect_changed_games([_api_game()], db)
    assert changes == []


def test_empty_api_list():
    assert detect_changed_games([], {}) == []


def test_empty_both():
    assert detect_changed_games([], {"G1": _db_row()}) == []


# ---------------------------------------------------------------------------
# detect_changed_games — score / achievement diffs
# ---------------------------------------------------------------------------

def test_gamerscore_increase_triggers_full_sync():
    db = {"G1": _db_row(gs=50)}
    changes = detect_changed_games([_api_game(gs=100)], db)
    assert len(changes) == 1
    assert changes[0]["sync_type"] == "full"
    assert "current_gamerscore" in changes[0]["reason"]
    assert "50->100" in changes[0]["reason"]


def test_total_gamerscore_change_triggers_full_sync():
    db = {"G1": _db_row(total_gs=100)}
    changes = detect_changed_games([_api_game(total_gs=200)], db)
    assert len(changes) == 1
    assert "total_gamerscore" in changes[0]["reason"]


def test_achievement_count_increase():
    db = {"G1": _db_row(ach=3)}
    changes = detect_changed_games([_api_game(ach=5)], db)
    assert len(changes) == 1
    assert "current_achievements" in changes[0]["reason"]


def test_multiple_diffs_all_listed_in_reason():
    """When several fields change the reason string lists all of them."""
    db = {"G1": _db_row(gs=50, ach=3)}
    changes = detect_changed_games([_api_game(gs=100, ach=5)], db)
    assert len(changes) == 1
    reason = changes[0]["reason"]
    assert "current_gamerscore" in reason
    assert "current_achievements" in reason


# ---------------------------------------------------------------------------
# detect_changed_games — API quirk: total_achievements == 0 is ignored
# ---------------------------------------------------------------------------

def test_total_achievements_zero_api_not_a_change():
    """API returns total_achievements=0 even when achievements exist — must be ignored."""
    db = {"G1": _db_row(total_ach=10)}
    # API reports 0 — this is the known Xbox API quirk
    changes = detect_changed_games([_api_game(total_ach=0)], db)
    assert changes == []


def test_total_achievements_real_increase_is_a_change():
    """Non-zero total_achievements change IS meaningful."""
    db = {"G1": _db_row(total_ach=10)}
    changes = detect_changed_games([_api_game(total_ach=20)], db)
    assert len(changes) == 1
    assert "total_achievements" in changes[0]["reason"]


# ---------------------------------------------------------------------------
# detect_changed_games — last_played → stats_only
# ---------------------------------------------------------------------------

def test_last_played_change_is_stats_only():
    """Changed last_played with no score diffs → stats_only sync (1 API call)."""
    db = {"G1": _db_row(last_played="2024-03-01T00:00:00Z")}
    changes = detect_changed_games(
        [_api_game(last_played="2024-05-01T00:00:00Z")], db
    )
    assert len(changes) == 1
    assert changes[0]["sync_type"] == "stats_only"
    assert changes[0]["api_cost"] == 1
    assert changes[0]["reason"] == "last_played changed"


# ---------------------------------------------------------------------------
# detect_changed_games — played-after-last-fetch heuristic
# ---------------------------------------------------------------------------

def test_played_after_last_detail_fetch_triggers_full():
    """Game was played more recently than last detail sync → full re-fetch."""
    db = {"G1": _db_row(
        last_played="2024-05-01",
        stats_last_fetched="2024-04-01T00:00:00Z",
    )}
    # same last_played in API (no delta), but db_played > db_fetched
    changes = detect_changed_games([_api_game(last_played="2024-05-01")], db)
    assert len(changes) == 1
    assert changes[0]["sync_type"] == "full"
    assert "played after last detail sync" in changes[0]["reason"]


def test_fetched_after_played_no_change():
    """When last detail fetch is newer than last_played, no re-sync needed."""
    db = {"G1": _db_row(
        last_played="2024-04-01",
        stats_last_fetched="2024-05-01T00:00:00Z",
    )}
    changes = detect_changed_games([_api_game(last_played="2024-04-01")], db)
    assert changes == []


# ---------------------------------------------------------------------------
# detect_changed_games — sort order
# ---------------------------------------------------------------------------

def test_changes_sorted_by_last_played_descending():
    """Most recently played games should be processed first."""
    api = [
        _api_game("G1", last_played="2024-01-01T00:00:00Z"),
        _api_game("G2", last_played="2024-03-01T00:00:00Z"),
        _api_game("G3", last_played="2024-02-01T00:00:00Z"),
    ]
    changes = detect_changed_games(api, {})  # all new
    ids = [c["game"]["title_id"] for c in changes]
    assert ids == ["G2", "G3", "G1"]


def test_multiple_games_mixed_states():
    """Smoke: new + changed + unchanged games in one batch."""
    api = [
        _api_game("NEW"),
        _api_game("CHANGED", gs=200),
        _api_game("SAME"),
    ]
    db = {
        "CHANGED": _db_row("CHANGED", gs=100),
        "SAME": _db_row("SAME"),
    }
    changes = detect_changed_games(api, db)
    ids = {c["game"]["title_id"] for c in changes}
    assert "NEW" in ids
    assert "CHANGED" in ids
    assert "SAME" not in ids


# ---------------------------------------------------------------------------
# sync_game_selective — routing
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_selective_full_delegates_to_sync_game_details():
    """sync_type='full' must call sync_game_details, not the stats path."""
    from models import SyncResult
    result = SyncResult(success=True, message="ok", api_calls_used=3)
    with patch("sync.games.sync_game_details", new_callable=AsyncMock, return_value=result) as mock:
        out = await sync_game_selective("G1", "full")
    mock.assert_called_once_with("G1")
    assert out.success is True
    assert out.api_calls_used == 3


@pytest.mark.asyncio
async def test_selective_stats_only_fetches_stats():
    """sync_type='stats_only' calls get_game_stats and update_game_stats."""
    with patch("sync.games.get_game_stats",
               new_callable=AsyncMock,
               return_value={"minutes_played": 120}) as mock_stats, \
         patch("sync.games.update_game_stats", new_callable=AsyncMock):
        result = await sync_game_selective("G1", "stats_only")
    mock_stats.assert_called_once_with("G1")
    assert result.success is True
    assert result.api_calls_used == 1


@pytest.mark.asyncio
async def test_selective_stats_only_error_returns_failure():
    """Stats fetch failure → SyncResult(success=False) with error in message."""
    with patch("sync.games.get_game_stats",
               new_callable=AsyncMock,
               side_effect=ConnectionError("timeout")), \
         patch("sync.games.update_game_stats", new_callable=AsyncMock):
        result = await sync_game_selective("G1", "stats_only")
    assert result.success is False
    assert "timeout" in result.message.lower() or "Stats" in result.message


@pytest.mark.asyncio
async def test_selective_player_achievements_calls_merge():
    """sync_type='player_achievements' calls stats + _merge_player_achievements_only."""
    with patch("sync.games.get_game_stats",
               new_callable=AsyncMock,
               return_value={"minutes_played": 60}), \
         patch("sync.games.update_game_stats", new_callable=AsyncMock), \
         patch("sync.games._merge_player_achievements_only",
               new_callable=AsyncMock,
               return_value=(5, 1)) as mock_merge:
        result = await sync_game_selective("G1", "player_achievements")
    mock_merge.assert_called_once_with("G1")
    assert result.success is True
    assert result.api_calls_used == 2  # 1 stats + 1 achievement
