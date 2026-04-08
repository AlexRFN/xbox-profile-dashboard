import logging

from config import RATE_LIMIT_MAX as _DEFAULT_RATE_LIMIT_MAX

from .connection import get_connection

log = logging.getLogger("xbox.db")

# Authoritative rate limit counter — only accessed from the event loop thread,
# so no lock is needed after the aiosqlite migration.
_rate_spent: int = 0

# Dynamic rate limit — updated from X-RateLimit-Limit headers on each API call.
# Falls back to config default until the first response comes in.
RATE_LIMIT_MAX: int = _DEFAULT_RATE_LIMIT_MAX
RATE_LIMIT_BUDGET: int = _DEFAULT_RATE_LIMIT_MAX - 5

async def _init_rate_limit_from_db() -> None:
    """Warm in-memory rate counter from DB at startup."""
    global _rate_spent
    conn = await get_connection()
    cursor = await conn.execute(
        "SELECT COUNT(*) as c FROM rate_limit_log WHERE timestamp > datetime('now', '-1 hour')"
    )
    row = await cursor.fetchone()
    _rate_spent = row["c"] if row else 0
    log.info("Rate limit initialized from DB: %d calls in last hour", _rate_spent)

async def sync_rate_limit_from_headers(headers, endpoint: str, status_code: int) -> None:
    """Update rate counter from API response headers and log the call.

    X-RateLimit-Spent is the authoritative source — it reflects the server's actual
    count, which may differ from our local row count if calls were made outside this
    process (e.g., another client using the same key). We prefer the header when
    present and fall back to the DB row count on startup.
    """
    global _rate_spent, RATE_LIMIT_MAX, RATE_LIMIT_BUDGET
    limit = headers.get("x-ratelimit-limit")
    if limit is not None:
        try:
            new_max = int(limit)
            if new_max != RATE_LIMIT_MAX:
                log.info("Rate limit updated from API headers: %d → %d calls/hour", RATE_LIMIT_MAX, new_max)
            RATE_LIMIT_MAX = new_max
            RATE_LIMIT_BUDGET = new_max - 5
        except (ValueError, TypeError):
            log.warning("Unexpected X-RateLimit-Limit header value: %r", limit)
    spent = headers.get("x-ratelimit-spent")
    if spent is not None:
        try:
            _rate_spent = int(spent)
        except (ValueError, TypeError):
            log.warning("Unexpected X-RateLimit-Spent header value: %r", spent)
    conn = await get_connection()
    await conn.execute("INSERT INTO rate_limit_log (endpoint, status_code) VALUES (?, ?)",
                 (endpoint, status_code))
    await conn.commit()
    log.debug("API call logged: %s -> %d (spent: %s)", endpoint, status_code, spent)

def get_api_calls_last_hour() -> int:
    return _rate_spent

def can_make_requests(count: int = 1) -> bool:
    return (_rate_spent + count) <= RATE_LIMIT_BUDGET


