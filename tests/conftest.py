import contextlib
import os
from pathlib import Path

import pytest

# Override the database path BEFORE any application code is imported
test_db_path = Path(__file__).parent / "test_xbox.db"
os.environ["TEST_DB_PATH"] = str(test_db_path)

# These imports must come after DB_PATH is patched — noqa: E402 is intentional.
import database.connection  # noqa: E402

database.connection.DB_PATH = test_db_path

from database.connection import close_connection, get_connection  # noqa: E402
from database.setup import init_db  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
async def setup_test_db():
    # Setup — also drop WAL sidecars a killed previous run may have left behind.
    for suffix in ("", "-wal", "-shm"):
        p = test_db_path.with_name(test_db_path.name + suffix)
        if p.exists():
            p.unlink()
    await init_db()
    yield
    # Teardown: close the writer AND the read pool — aiosqlite worker threads
    # are non-daemon, so any unclosed connection blocks interpreter exit.
    await close_connection()
    if test_db_path.exists():
        with contextlib.suppress(OSError):  # Windows might still hold a lock briefly
            test_db_path.unlink()


@pytest.fixture(autouse=True)
async def clear_db():
    """Clear database tables and the in-memory TTL cache before each test.

    Without the cache flush, a value cached by one test (e.g. heatmap year
    range, dashboard stats) leaks into the next test's empty-DB assertions.
    """
    from database.cache import _cache_clear_all

    _cache_clear_all()
    conn = await get_connection()
    await conn.execute("DELETE FROM achievements")
    await conn.execute("DELETE FROM screenshots")
    await conn.execute("DELETE FROM sync_log")
    await conn.execute("DELETE FROM rate_limit_log")
    await conn.execute("DELETE FROM friends")
    await conn.execute("DELETE FROM sync_failures")
    await conn.execute("DELETE FROM settings")
    await conn.execute("DELETE FROM games")
    await conn.commit()


from sync.core import reset_sync_gate as _reset_sync_gate  # noqa: E402


@pytest.fixture(autouse=True)
def reset_sync_gate():
    """Reset the lazy sync gate so each test gets a lock on its own event loop."""
    _reset_sync_gate()
    yield
    _reset_sync_gate()


from fastapi.testclient import TestClient  # noqa: E402

from main import app  # noqa: E402


@pytest.fixture
def client():
    return TestClient(app)
