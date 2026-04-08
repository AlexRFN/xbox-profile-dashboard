import logging

import orjson

from config import CacheKey

from .cache import _cache_get, _cache_invalidate, _cache_set
from .connection import get_connection

log = logging.getLogger("xbox.db")

async def upsert_friends(friends: list[dict]) -> int:
    conn = await get_connection()
    rows = []
    for f in friends:
        rows.append((
            str(f.get("xuid", "")),
            f.get("gamertag", ""),
            f.get("displayPicRaw", ""),
            int(f.get("gamerScore", 0)),
            f.get("presenceState", "Offline"),
            f.get("presenceText", ""),
            1 if f.get("isFavorite") else 0,
            orjson.dumps(f).decode(),
        ))

    await conn.executemany("""
        INSERT INTO friends (xuid, gamertag, display_pic, gamer_score,
                             presence_state, presence_text, is_favorite, raw_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(xuid) DO UPDATE SET
            gamertag = excluded.gamertag,
            display_pic = excluded.display_pic,
            gamer_score = excluded.gamer_score,
            presence_state = excluded.presence_state,
            presence_text = excluded.presence_text,
            is_favorite = excluded.is_favorite,
            raw_json = excluded.raw_json,
            updated_at = datetime('now')
    """, rows)

    # Full replace: the API returns the complete friends list, so anyone missing from
    # this batch is no longer a friend and should be removed.
    xuids = [row[0] for row in rows if row[0]]
    if xuids:
        placeholders = ",".join("?" * len(xuids))
        await conn.execute(f"DELETE FROM friends WHERE xuid NOT IN ({placeholders})", xuids)
    else:
        await conn.execute("DELETE FROM friends")

    await conn.commit()
    _cache_invalidate(CacheKey.FRIENDS)
    return len(rows)

async def get_friends() -> list[dict]:
    cached = _cache_get(CacheKey.FRIENDS, ttl=300)
    if cached is not None:
        return cached
    conn = await get_connection()
    cursor = await conn.execute("""
        SELECT xuid, gamertag, display_pic, gamer_score,
               presence_state, presence_text, is_favorite, raw_json
        FROM friends
        ORDER BY CASE WHEN presence_state = 'Online' THEN 0 ELSE 1 END,
                 gamer_score DESC
    """)
    rows = await cursor.fetchall()
    result = []
    for r in rows:
        friend = {
            "xuid": r["xuid"],
            "gamertag": r["gamertag"],
            "displayPicRaw": r["display_pic"] or "",
            "gamerScore": r["gamer_score"] or 0,
            "presenceState": r["presence_state"] or "Offline",
            "presenceText": r["presence_text"] or "",
            "isFavorite": bool(r["is_favorite"]),
            "presenceDevice": None,
            "presenceGame": None,
            "richPresenceText": None,
        }
        # presenceDetails can list multiple devices; index 0 is the primary/active one
        raw = r["raw_json"]
        if raw:
            try:
                data = orjson.loads(raw)
                details = data.get("presenceDetails") or []
                if details:
                    primary = details[0]
                    friend["presenceDevice"] = primary.get("Device")
                    if primary.get("IsGame"):
                        friend["presenceGame"] = primary.get("PresenceText")
                    friend["richPresenceText"] = primary.get("RichPresenceText")
            except Exception:
                log.debug("Failed to parse presence details for %s", r["xuid"], exc_info=True)
        result.append(friend)
    _cache_set(CacheKey.FRIENDS, result)
    return result
