import logging
from pathlib import Path

import aiosqlite

log = logging.getLogger("xbox.db")

DB_PATH = Path(__file__).parent.parent / "data" / "xbox.db"

_conn: aiosqlite.Connection | None = None

async def get_connection() -> aiosqlite.Connection:
    global _conn
    if _conn is None:
        DB_PATH.parent.mkdir(exist_ok=True)
        _conn = await aiosqlite.connect(str(DB_PATH))
        _conn.row_factory = aiosqlite.Row
        await _conn.execute("PRAGMA journal_mode=WAL")       # WAL allows concurrent reads during writes
        await _conn.execute("PRAGMA synchronous=NORMAL")     # safe with WAL; fsync only at WAL checkpoints
        await _conn.execute("PRAGMA busy_timeout=5000")      # wait up to 5s if the file is locked (e.g. by litestream)
        await _conn.execute("PRAGMA foreign_keys=ON")
        await _conn.execute("PRAGMA cache_size=-32768")      # 32 MiB page cache (negative = KiB)
        await _conn.execute("PRAGMA mmap_size=268435456")    # 256 MiB memory-mapped I/O
        await _conn.execute("PRAGMA temp_store=MEMORY")      # keep temp tables in RAM, not disk
    return _conn

async def close_connection():
    """Close the global DB connection (call from app shutdown)."""
    global _conn
    if _conn is not None:
        try:
            await _conn.close()
        except Exception:
            log.warning("DB close error during shutdown", exc_info=True)
        _conn = None

async def run_optimize():
    """Run PRAGMA optimize to refresh query planner statistics."""
    conn = await get_connection()
    await conn.execute("PRAGMA optimize")
