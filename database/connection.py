import logging
from pathlib import Path

import aiosqlite

log = logging.getLogger("xbox.db")

DB_PATH = Path(__file__).parent.parent / "data" / "xbox.db"

_conn: aiosqlite.Connection | None = None

# WAL lets many readers run alongside the single writer, but only across
# *separate* connections — aiosqlite funnels everything on one connection
# through one worker thread, so on a shared connection page reads queue behind
# sync-time writes and behind each other. Request-path SELECTs round-robin
# over this small pool instead; writes (and sync-path reads that must stay
# ordered with them) keep using get_connection().
_READ_POOL_SIZE = 3
_read_pool: list[aiosqlite.Connection] = []
_read_idx = 0


async def _open_reader() -> aiosqlite.Connection:
    # isolation_level=None (autocommit): readers must never hold an implicit
    # BEGIN open — a lingering deferred transaction pins the WAL snapshot and
    # the connection would serve stale data forever after.
    conn = await aiosqlite.connect(str(DB_PATH), isolation_level=None)
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA query_only=ON")
    await conn.execute("PRAGMA busy_timeout=5000")
    await conn.execute("PRAGMA cache_size=-16384")  # 16 MiB page cache per reader
    await conn.execute("PRAGMA mmap_size=268435456")
    await conn.execute("PRAGMA temp_store=MEMORY")
    return conn


async def get_read_connection() -> aiosqlite.Connection:
    """Return a read-only connection from the pool (round-robin).

    For request-path SELECTs only. Sync/write paths must use get_connection()
    so their reads stay ordered with the writes they interleave with.
    """
    global _read_idx
    if not _read_pool:
        await get_connection()  # ensure the DB file exists before readers attach
        conns = [await _open_reader() for _ in range(_READ_POOL_SIZE)]
        if _read_pool:
            # Another task initialized the pool while we awaited — keep theirs.
            # (No lock: an asyncio.Lock would pin the pool to the first event
            # loop that built it, which breaks tests that cycle loops.)
            for c in conns:
                await c.close()
        else:
            _read_pool.extend(conns)
            log.info("Read connection pool initialized (%d connections)", len(_read_pool))
    _read_idx = (_read_idx + 1) % len(_read_pool)
    return _read_pool[_read_idx]


async def get_connection() -> aiosqlite.Connection:
    global _conn
    if _conn is None:
        DB_PATH.parent.mkdir(exist_ok=True)
        _conn = await aiosqlite.connect(str(DB_PATH))
        _conn.row_factory = aiosqlite.Row
        await _conn.execute("PRAGMA journal_mode=WAL")  # WAL allows concurrent reads during writes
        await _conn.execute("PRAGMA synchronous=NORMAL")  # safe with WAL; fsync only at WAL checkpoints
        await _conn.execute("PRAGMA busy_timeout=5000")  # wait up to 5s if the file is locked (e.g. by litestream)
        await _conn.execute("PRAGMA foreign_keys=ON")
        await _conn.execute("PRAGMA cache_size=-32768")  # 32 MiB page cache (negative = KiB)
        await _conn.execute("PRAGMA mmap_size=268435456")  # 256 MiB memory-mapped I/O
        await _conn.execute("PRAGMA temp_store=MEMORY")  # keep temp tables in RAM, not disk
    return _conn


async def snapshot_db() -> Path | None:
    """Write a consistent backup of the live DB next to it as ``<name>.bak``.

    Uses ``VACUUM INTO`` rather than a raw file copy: it produces a fully
    checkpointed, internally-consistent single-file copy even under WAL, where
    the latest committed rows may still live in the -wal sidecar.

    Best-effort by design — a backup must never block or fail a sync. Errors are
    logged and swallowed. Returns the backup path on success, None on failure.
    """
    backup_path = DB_PATH.parent / (DB_PATH.name + ".bak")
    try:
        if backup_path.exists():  # VACUUM INTO refuses to overwrite an existing file
            backup_path.unlink()
        # Dedicated short-lived connection: VACUUM INTO rewrites the entire DB
        # file and can run for seconds. On the shared write connection every
        # queued query would stall behind it (one worker thread per connection).
        async with aiosqlite.connect(str(DB_PATH)) as conn:
            # Close the PRAGMA cursor before VACUUM — an open statement on the
            # connection raises "cannot VACUUM - SQL statements in progress".
            cur = await conn.execute("PRAGMA busy_timeout=5000")
            await cur.close()
            await conn.execute("VACUUM INTO ?", (str(backup_path),))
        log.info("DB snapshot written to %s", backup_path.name)
        return backup_path
    except Exception:
        log.warning("DB snapshot failed (continuing without backup)", exc_info=True)
        return None


async def close_connection():
    """Close the global DB connection and the read pool (call from app shutdown)."""
    global _conn, _read_idx
    if _conn is not None:
        try:
            await _conn.close()
        except Exception:
            log.warning("DB close error during shutdown", exc_info=True)
        _conn = None
    while _read_pool:
        try:
            await _read_pool.pop().close()
        except Exception:
            log.warning("Read pool close error during shutdown", exc_info=True)
    _read_idx = 0


async def run_optimize():
    """Run PRAGMA optimize to refresh query planner statistics."""
    conn = await get_connection()
    await conn.execute("PRAGMA optimize")
