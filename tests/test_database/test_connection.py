import sqlite3

import pytest

import database.connection
from database.connection import snapshot_db
from database.games import upsert_games_bulk


@pytest.mark.asyncio
async def test_snapshot_db_writes_consistent_copy():
    """snapshot_db() should produce a standalone .bak file containing committed data."""
    await upsert_games_bulk([{"title_id": "snap1", "name": "Backup Me"}])

    backup_path = database.connection.DB_PATH.parent / (database.connection.DB_PATH.name + ".bak")
    try:
        result = await snapshot_db()
        assert result == backup_path
        assert backup_path.exists()

        # The backup is a real, openable SQLite DB carrying the committed row.
        conn = sqlite3.connect(str(backup_path))
        try:
            row = conn.execute("SELECT name FROM games WHERE title_id = 'snap1'").fetchone()
        finally:
            conn.close()
        assert row is not None
        assert row[0] == "Backup Me"
    finally:
        backup_path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_snapshot_db_overwrites_stale_backup():
    """A pre-existing .bak must not make VACUUM INTO fail — it is replaced."""
    backup_path = database.connection.DB_PATH.parent / (database.connection.DB_PATH.name + ".bak")
    backup_path.write_text("stale junk, not a database")
    try:
        result = await snapshot_db()
        assert result == backup_path
        # Opening as SQLite proves it was replaced with a real DB, not left as junk.
        conn = sqlite3.connect(str(backup_path))
        try:
            conn.execute("SELECT COUNT(*) FROM games").fetchone()
        finally:
            conn.close()
    finally:
        backup_path.unlink(missing_ok=True)
