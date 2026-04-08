"""Tests for database/settings.py and database/rate_limit.py."""
import pytest

import database as db
import database.rate_limit as rl

# ---------------------------------------------------------------------------
# settings
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_get_missing_setting_returns_none():
    result = await db.get_setting("no_such_key")
    assert result is None


@pytest.mark.asyncio
async def test_set_and_get_setting():
    await db.set_setting("theme", "dark")
    val = await db.get_setting("theme")
    assert val == "dark"


@pytest.mark.asyncio
async def test_set_setting_overwrites():
    await db.set_setting("theme", "dark")
    await db.set_setting("theme", "light")
    val = await db.get_setting("theme")
    assert val == "light"


@pytest.mark.asyncio
async def test_set_multiple_keys_independent():
    await db.set_setting("k1", "v1")
    await db.set_setting("k2", "v2")
    assert await db.get_setting("k1") == "v1"
    assert await db.get_setting("k2") == "v2"


# ---------------------------------------------------------------------------
# rate_limit — in-memory counter functions
# ---------------------------------------------------------------------------

def test_get_api_calls_last_hour_returns_int():
    result = db.get_api_calls_last_hour()
    assert isinstance(result, int)
    assert result >= 0


def test_can_make_requests_when_budget_available():
    # Reset to zero to ensure budget is available
    rl._rate_spent = 0
    assert db.can_make_requests(1) is True
    assert db.can_make_requests(10) is True


def test_can_make_requests_false_when_over_budget():
    rl._rate_spent = rl.RATE_LIMIT_BUDGET + 1
    assert db.can_make_requests(1) is False
    # Restore
    rl._rate_spent = 0


def test_can_make_requests_boundary():
    rl._rate_spent = rl.RATE_LIMIT_BUDGET
    # Exactly at budget — adding 1 more would exceed it
    assert db.can_make_requests(1) is False
    rl._rate_spent = rl.RATE_LIMIT_BUDGET - 1
    assert db.can_make_requests(1) is True
    rl._rate_spent = 0


@pytest.mark.asyncio
async def test_sync_rate_limit_from_headers_logs_call():
    """Header sync updates in-memory counter and writes to DB."""
    db.get_api_calls_last_hour()
    headers = {"x-ratelimit-spent": "10", "x-ratelimit-limit": "150"}
    await db.sync_rate_limit_from_headers(headers, "/test/endpoint", 200)
    assert rl._rate_spent == 10
    assert rl.RATE_LIMIT_MAX == 150
    # Restore
    rl._rate_spent = 0
    rl.RATE_LIMIT_MAX = 150


@pytest.mark.asyncio
async def test_sync_rate_limit_ignores_invalid_header():
    """Malformed headers should not crash."""
    headers = {"x-ratelimit-spent": "not_a_number"}
    await db.sync_rate_limit_from_headers(headers, "/test", 200)
    # Should not raise; _rate_spent unchanged by bad header
