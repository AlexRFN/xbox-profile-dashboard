from .connection import get_connection

async def get_setting(key: str) -> str | None:
    conn = await get_connection()
    cursor = await conn.execute("SELECT value FROM settings WHERE key = ?", (key,))
    row = await cursor.fetchone()
    return row["value"] if row else None

async def set_setting(key: str, value: str):
    conn = await get_connection()
    await conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    await conn.commit()
