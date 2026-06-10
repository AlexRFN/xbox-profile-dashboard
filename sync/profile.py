import asyncio
import logging

from config import IMG_WARM_WIDTHS, SCHEDULED_SYNC_CONCURRENCY, CacheKey
from database import (
    _cache_invalidate,
    get_games_with_art,
    invalidate_timeline,
    set_setting,
    update_game_blurhash,
    upsert_friends,
)
from helpers import normalize_image_url
from xbox_api import get_friends as api_get_friends
from xbox_api import get_profile

log = logging.getLogger("xbox.sync")


def _select_games_needing_art(games: list[dict], max_count: int) -> list[tuple[dict, bool, bool]]:
    """(game, needs_blurhash, needs_thumbs) for games with missing artifacts.

    Does per-game disk stats (thumb cache existence) — call via a thread.
    """
    from routers.img import missing_warm_widths

    todo = []
    for g in games:
        needs_blurhash = not g["blurhash"]
        needs_thumbs = bool(missing_warm_widths(g["display_image"], IMG_WARM_WIDTHS))
        if needs_blurhash or needs_thumbs:
            todo.append((g, needs_blurhash, needs_thumbs))
            if len(todo) >= max_count:
                break
    return todo


async def backfill_game_art(max_count: int = 50):
    """Pre-warm per-game image artifacts so first page views never pay for them:
    blurhash placeholders + /img thumb cache entries at the widths the UI uses.
    One upstream download per game covers both."""
    import httpx

    from blurhash_utils import encode_from_bytes
    from routers.img import warm_thumbs

    games = await get_games_with_art()
    todo = await asyncio.to_thread(_select_games_needing_art, games, max_count)
    if not todo:
        return
    log.info("Game art backfill: %d games to process", len(todo))
    sem = asyncio.Semaphore(SCHEDULED_SYNC_CONCURRENCY)  # limit concurrent Xbox CDN downloads
    done = 0
    blurhashes_written = 0

    async with httpx.AsyncClient(timeout=15) as client:

        async def _process(game, needs_blurhash, needs_thumbs):
            nonlocal done, blurhashes_written
            url = game["display_image"]
            async with sem:
                try:
                    resp = await client.get(url)
                    if resp.status_code != 200:
                        return
                    # Both encodes are CPU-bound (Pillow); run in the thread pool
                    # so the event loop stays responsive.
                    if needs_blurhash:
                        bh = await asyncio.to_thread(encode_from_bytes, resp.content)
                        if bh:
                            await update_game_blurhash(game["title_id"], bh)
                            blurhashes_written += 1
                    if needs_thumbs:
                        await asyncio.to_thread(warm_thumbs, url, resp.content, IMG_WARM_WIDTHS)
                    done += 1
                except Exception as e:
                    log.debug("Game art backfill failed for %s: %s", game["title_id"], e)

        await asyncio.gather(*[_process(g, nb, nt) for g, nb, nt in todo])
    if blurhashes_written:
        # Backfill runs after the post-sync cache flush/warm, so the freshly
        # written blurhashes would otherwise be missing from cached dashboard
        # and timeline renders until their TTLs expire. One flush at the end —
        # not per game — keeps the rebuild cost bounded.
        _cache_invalidate(CacheKey.DASHBOARD_STATS)
        invalidate_timeline()
    log.info("Game art backfill complete: %d/%d games", done, len(todo))


def _extract_gamerpic(data: dict) -> str:
    users = data.get("profileUsers", [])
    if not users:
        return ""
    for s in users[0].get("settings", []):
        if s.get("id") == "GameDisplayPicRaw":
            return normalize_image_url(s.get("value", ""))
    return ""


async def sync_profile() -> bool:
    """Refresh the stored gamerpic. Non-critical: failures are swallowed but
    reported via the return value so callers can mark the sync as partial."""
    try:
        data = await get_profile()
        pic = _extract_gamerpic(data)
        if pic:
            await set_setting("gamerpic", pic)
            log.info("Stored gamerpic: %s", pic[:60])
        return True
    except Exception as e:
        log.warning("Profile sync failed (non-critical): %s", e)
        return False


async def sync_friends() -> int:
    friends = await api_get_friends()
    count = await upsert_friends(friends)
    log.info("Friends synced: %d loaded", count)
    return count
