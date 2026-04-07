import os
import pytest
from pathlib import Path

# Override the database path BEFORE any application code is imported
test_db_path = Path(__file__).parent / "test_xbox.db"
os.environ["TEST_DB_PATH"] = str(test_db_path)

# These imports must come after DB_PATH is patched — noqa: E402 is intentional.
import database.connection  # noqa: E402
database.connection.DB_PATH = test_db_path

from database.setup import init_db  # noqa: E402
from database.connection import get_connection  # noqa: E402

@pytest.fixture(scope="session", autouse=True)
async def setup_test_db():
    # Setup
    if test_db_path.exists():
        test_db_path.unlink()
    await init_db()
    yield
    # Teardown
    conn = await get_connection()
    await conn.close()
    # Also need to clear the global connection so it reconnects if necessary or closes properly
    database.connection._conn = None
    if test_db_path.exists():
        try:
            test_db_path.unlink()
        except OSError:
            pass # Windows might still hold a lock briefly

@pytest.fixture(autouse=True)
async def clear_db():
    """Clear database tables before each test."""
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

from fastapi.testclient import TestClient  # noqa: E402
from main import app  # noqa: E402

@pytest.fixture
def client():
    return TestClient(app)
