import logging

from .connection import DB_PATH, get_connection
from .rate_limit import _init_rate_limit_from_db

log = logging.getLogger("xbox.db")

async def _create_schema(conn) -> None:
    """Create all tables and indexes idempotently."""
    await conn.executescript("""
            CREATE TABLE IF NOT EXISTS games (
                title_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                display_image TEXT,
                devices TEXT,
                current_gamerscore INTEGER DEFAULT 0,
                total_gamerscore INTEGER DEFAULT 0,
                progress_percentage INTEGER DEFAULT 0,
                current_achievements INTEGER DEFAULT 0,
                total_achievements INTEGER DEFAULT 0,
                last_played TEXT,
                minutes_played INTEGER,
                xbox_live_tier TEXT,
                pfn TEXT,
                is_gamepass INTEGER DEFAULT 0,
                status TEXT DEFAULT 'unset',
                notes TEXT DEFAULT '',
                finished_date TEXT,
                rating INTEGER,
                stats_last_fetched TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_games_name ON games(name);
            CREATE INDEX IF NOT EXISTS idx_games_status ON games(status);
            CREATE INDEX IF NOT EXISTS idx_games_last_played ON games(last_played);
            CREATE INDEX IF NOT EXISTS idx_games_progress ON games(progress_percentage);

            CREATE TABLE IF NOT EXISTS achievements (
                achievement_id TEXT NOT NULL,
                title_id TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                locked_description TEXT DEFAULT '',
                gamerscore INTEGER DEFAULT 0,
                progress_state TEXT,
                time_unlocked TEXT,
                is_secret INTEGER DEFAULT 0,
                rarity_category TEXT,
                rarity_percentage REAL,
                media_assets TEXT,
                last_fetched TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (achievement_id, title_id),
                FOREIGN KEY (title_id) REFERENCES games(title_id)
            );

            CREATE TABLE IF NOT EXISTS sync_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sync_type TEXT NOT NULL,
                title_id TEXT,
                games_updated INTEGER DEFAULT 0,
                started_at TEXT DEFAULT (datetime('now')),
                completed_at TEXT,
                status TEXT DEFAULT 'running',
                error_message TEXT,
                api_calls_used INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS rate_limit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT DEFAULT (datetime('now')),
                endpoint TEXT NOT NULL,
                status_code INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_achievements_time_unlocked
                ON achievements(time_unlocked);
            CREATE INDEX IF NOT EXISTS idx_achievements_title_id
                ON achievements(title_id);
            CREATE INDEX IF NOT EXISTS idx_achievements_title_progress
                ON achievements(title_id, progress_state);

            CREATE TABLE IF NOT EXISTS friends (
                xuid TEXT PRIMARY KEY,
                gamertag TEXT NOT NULL,
                display_pic TEXT,
                gamer_score INTEGER DEFAULT 0,
                presence_state TEXT,
                presence_text TEXT,
                is_favorite INTEGER DEFAULT 0,
                raw_json TEXT,
                updated_at TEXT DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS screenshots (
                content_id TEXT PRIMARY KEY,
                title_id TEXT NOT NULL,
                title_name TEXT NOT NULL,
                capture_date TEXT NOT NULL,
                resolution_width INTEGER,
                resolution_height INTEGER,
                download_uri TEXT,
                download_hdr_uri TEXT,
                thumbnail_small_uri TEXT,
                thumbnail_large_uri TEXT,
                file_size INTEGER DEFAULT 0,
                like_count INTEGER DEFAULT 0,
                view_count INTEGER DEFAULT 0,
                creation_type TEXT,
                device_type TEXT,
                created_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (title_id) REFERENCES games(title_id)
            );

            CREATE INDEX IF NOT EXISTS idx_screenshots_title_id ON screenshots(title_id);
            CREATE INDEX IF NOT EXISTS idx_screenshots_capture_date ON screenshots(capture_date);

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );

            -- New performance indexes
            CREATE INDEX IF NOT EXISTS idx_rate_limit_timestamp ON rate_limit_log(timestamp);
            CREATE INDEX IF NOT EXISTS idx_achievements_title_progress ON achievements(title_id, progress_state);
            CREATE INDEX IF NOT EXISTS idx_sync_log_type_started ON sync_log(sync_type, started_at DESC);
            CREATE INDEX IF NOT EXISTS idx_achievements_title_progress_time ON achievements(title_id, progress_state, time_unlocked);

            CREATE TABLE IF NOT EXISTS sync_failures (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title_id TEXT NOT NULL,
                game_name TEXT,
                sync_type TEXT NOT NULL,
                error_message TEXT,
                attempted_at TEXT DEFAULT (datetime('now')),
                FOREIGN KEY (title_id) REFERENCES games(title_id)
            );
            CREATE INDEX IF NOT EXISTS idx_sync_failures_title ON sync_failures(title_id);
            CREATE INDEX IF NOT EXISTS idx_sync_failures_attempted ON sync_failures(attempted_at DESC);
            CREATE INDEX IF NOT EXISTS idx_games_status_last_played ON games(status, last_played DESC);
            CREATE INDEX IF NOT EXISTS idx_games_gamepass_last_played ON games(is_gamepass, last_played DESC);
        """)
    # Lightweight versioned migration system. CREATE TABLE IF NOT EXISTS won't add new columns to
    # existing tables, so any schema change that adds columns must go through MIGRATIONS instead.
    await conn.execute("""
        CREATE TABLE IF NOT EXISTS schema_migrations (
            version INTEGER PRIMARY KEY,
            description TEXT,
            applied_at TEXT DEFAULT (datetime('now'))
        )
    """)
    await conn.commit()


async def _run_migrations(conn) -> None:
    """Apply any pending versioned schema migrations."""
    cursor = await conn.execute("SELECT version FROM schema_migrations")
    rows = await cursor.fetchall()
    applied = {r[0] for r in rows}

    MIGRATIONS = [
        (1, "Add is_gamepass column to games",
         "ALTER TABLE games ADD COLUMN is_gamepass INTEGER DEFAULT 0"),
        (2, "Add blurhash column to games",
         "ALTER TABLE games ADD COLUMN blurhash TEXT"),
        (3, "Add last_achievement_unlock column to games",
         "ALTER TABLE games ADD COLUMN last_achievement_unlock TEXT"),
        (4, "Add rare_unlocks column to games",
         "ALTER TABLE games ADD COLUMN rare_unlocks TEXT"),
    ]
    for version, description, sql in MIGRATIONS:
        if version not in applied:
            try:
                await conn.execute(sql)
                await conn.execute(
                    "INSERT INTO schema_migrations (version, description) VALUES (?, ?)",
                    (version, description),
                )
                await conn.commit()
                log.info("Applied migration %d: %s", version, description)
            except Exception as e:
                # Databases that existed before the migration table was introduced may already
                # have these columns. Mark them applied so they don't retry on every startup.
                if "duplicate column" in str(e).lower() or "already exists" in str(e).lower():
                    await conn.execute(
                        "INSERT OR IGNORE INTO schema_migrations (version, description) VALUES (?, ?)",
                        (version, description),
                    )
                    await conn.commit()
                    log.info("Migration %d already applied (marking): %s", version, description)
                else:
                    raise


async def _purge_stale_logs(conn) -> None:
    """Remove old log entries at startup to keep table sizes bounded."""
    # rate_limit_log only needs the last hour; keeping 2h gives a small safety margin.
    await conn.execute("DELETE FROM rate_limit_log WHERE timestamp < datetime('now', '-2 hours')")
    await conn.execute("DELETE FROM sync_log WHERE started_at < datetime('now', '-30 days')")
    await conn.commit()


async def init_db():
    log.info("Initializing database at %s", DB_PATH)
    conn = await get_connection()  # PRAGMAs already set in get_connection()
    try:
        await conn.execute("PRAGMA optimize")
        await _create_schema(conn)
        await _run_migrations(conn)
        await _purge_stale_logs(conn)
        await _init_rate_limit_from_db()
    except Exception:
        log.exception("Failed to initialize database")
        raise
