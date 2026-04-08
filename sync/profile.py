import asyncio
import logging

from config import SCHEDULED_SYNC_CONCURRENCY
from database import get_games_missing_blurhash, set_setting, update_game_blurhash, upsert_friends
from helpers import normalize_image_url
from xbox_api import get_friends as api_get_friends
from xbox_api import get_profile

log = logging.getLogger("xbox.sync")

async def backfill_blurhashes(max_count: int = 50):
    import httpx

    from blurhash_utils import encode_from_bytes

    games = await get_games_missing_blurhash(max_count)
    if not games:
        return
    log.info("Blurhash backfill: %d games to process", len(games))
    sem = asyncio.Semaphore(SCHEDULED_SYNC_CONCURRENCY)  # limit concurrent Xbox CDN downloads
    done = 0

    async with httpx.AsyncClient(timeout=15) as client:
        async def _process(game):
            nonlocal done
            url = game["display_image"]
            if not url:
                return
            async with sem:
                try:
                    resp = await client.get(url)
                    if resp.status_code == 200:
                        # encode_from_bytes is CPU-bound (Pillow + pure-Python hash);
                        # run it in a thread pool to avoid blocking the event loop.
                        bh = await asyncio.to_thread(encode_from_bytes, resp.content)
                        if bh:
                            await update_game_blurhash(game["title_id"], bh)
                            done += 1
                except Exception as e:
                    log.debug("Blurhash failed for %s: %s", game["title_id"], e)

        await asyncio.gather(*[_process(g) for g in games])
    log.info("Blurhash backfill complete: %d/%d encoded", done, len(games))

def _extract_gamerpic(data: dict) -> str:
    users = data.get("profileUsers", [])
    if not users:
        return ""
    for s in users[0].get("settings", []):
        if s.get("id") == "GameDisplayPicRaw":
            return normalize_image_url(s.get("value", ""))
    return ""


async def sync_profile():
    try:
        data = await get_profile()
        pic = _extract_gamerpic(data)
        if pic:
            await set_setting("gamerpic", pic)
            log.info("Stored gamerpic: %s", pic[:60])
    except Exception as e:
        log.warning("Profile sync failed (non-critical): %s", e)

async def sync_friends() -> int:
    friends = await api_get_friends()
    count = await upsert_friends(friends)
    log.info("Friends synced: %d loaded", count)
    return count
