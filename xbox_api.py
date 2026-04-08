import logging
import os
from urllib.parse import urlencode

import httpx
from dotenv import load_dotenv

from database import can_make_requests, sync_rate_limit_from_headers

load_dotenv()

log = logging.getLogger("xbox.api")

API_KEY = os.getenv("OPENXBL_API_KEY")
XUID = os.getenv("XBOX_XUID")
GAMERTAG = os.getenv("XBOX_GAMERTAG")
BASE_URL = "https://xbl.io/api/v2"
HEADERS: dict[str, str] = {"Accept": "application/json"}
if API_KEY:
    HEADERS["X-Authorization"] = API_KEY

_client: httpx.AsyncClient | None = None


class RateLimitExceeded(Exception):
    pass


def init_client():
    global _client
    if _client is not None:
        log.warning("HTTP client already initialized — skipping")
        return
    _client = httpx.AsyncClient(headers=HEADERS, timeout=30)


def get_client() -> httpx.AsyncClient | None:
    """Return the shared HTTP client for reuse (e.g., CDN proxy downloads)."""
    return _client


async def close_client():
    global _client
    if _client:
        await _client.aclose()
        _client = None


async def _get(endpoint: str) -> dict:
    if _client is None:
        raise RuntimeError("HTTP client not initialized — call init_client() first")
    if not can_make_requests():
        log.warning("Rate limit budget exhausted — blocking request to %s", endpoint)
        raise RateLimitExceeded("Rate limit budget exhausted (145/150). Try again later.")
    url = f"{BASE_URL}{endpoint}"
    log.debug("GET %s", url)
    resp = await _client.get(url)
    # Update rate limit from API headers (authoritative source)
    await sync_rate_limit_from_headers(resp.headers, endpoint, resp.status_code)
    if resp.status_code != 200:
        log.error("API %s returned %d: %s", endpoint, resp.status_code, resp.text[:200])
    resp.raise_for_status()
    data = resp.json()
    # API wraps all responses in {"content": {...}, "code": ...} envelope
    if isinstance(data, dict) and "content" in data and isinstance(data["content"], dict):
        return data["content"]
    return data


async def get_profile() -> dict:
    return await _get("/account")


async def resolve_identity() -> tuple[str, str]:
    """Fetch XUID and gamertag from /account and populate module globals.

    Called at startup when XBOX_XUID or XBOX_GAMERTAG are not set in .env.
    Returns (xuid, gamertag).
    """
    global XUID, GAMERTAG
    data = await get_profile()
    users = data.get("profileUsers", [])
    if not users:
        raise ValueError("No profileUsers in /account response")
    user = users[0]
    xuid = str(user.get("id", ""))
    gamertag = ""
    for s in user.get("settings", []):
        if s.get("id") == "Gamertag":
            gamertag = s.get("value", "")
            break
    if not xuid:
        raise ValueError("Could not extract XUID from /account response")
    XUID = xuid
    GAMERTAG = gamertag or GAMERTAG
    log.info("Identity resolved: gamertag=%s xuid=%s", GAMERTAG, XUID)
    return XUID, GAMERTAG  # type: ignore[return-value]


async def get_all_games() -> list[dict]:
    data = await _get(f"/titles/{XUID}")
    titles = data.get("titles", [])
    log.info("Title history returned %d titles (pre-filter)", len(titles))
    games = []
    for t in titles:
        devices = t.get("devices", [])
        # Skip PC-only titles (Win32 with no Xbox device) — they appear in title history
        # but have no Xbox achievements and no meaningful gamerscore data.
        if devices == ["Win32"]:
            continue
        ach = t.get("achievement", {})
        hist = t.get("titleHistory", {})
        gp = t.get("gamePass", {})
        games.append({
            "title_id": str(t["titleId"]),
            "name": t["name"],
            "display_image": t.get("displayImage", ""),
            "devices": t.get("devices", []),
            "current_gamerscore": ach.get("currentGamerscore", 0),
            "total_gamerscore": ach.get("totalGamerscore", 0),
            "progress_percentage": ach.get("progressPercentage", 0),
            "current_achievements": ach.get("currentAchievements", 0),
            "total_achievements": ach.get("totalAchievements", 0),
            "last_played": hist.get("lastTimePlayed"),
            "xbox_live_tier": t.get("xboxLiveTier"),
            "pfn": t.get("pfn"),
            "is_gamepass": gp.get("isGamePass", False),
        })
    log.info("Returning %d games (Win32-only filtered out)", len(games))
    return games


async def get_game_stats(title_id: str) -> dict:
    data = await _get(f"/achievements/stats/{title_id}")
    minutes = None
    for stat_list in data.get("statlistscollection", []):
        for stat in stat_list.get("stats", []):
            if stat.get("name") == "MinutesPlayed":
                minutes = int(stat.get("value", 0))
    return {"minutes_played": minutes}


async def get_title_achievements(title_id: str) -> tuple[list[dict], int]:
    """Fetch all title achievements, paginating if >150. Returns (achievements, api_calls)."""
    all_achs = []
    api_calls = 0
    continuation = None

    while True:
        url = f"/achievements/title/{title_id}"
        if continuation:
            url += "?" + urlencode({"continuationToken": continuation})
        data = await _get(url)
        api_calls += 1
        page_achs = data.get("achievements", [])
        all_achs.extend(page_achs)

        paging = data.get("pagingInfo", {})
        continuation = paging.get("continuationToken")
        if not continuation:
            break

        log.debug("Title %s: paginating (%d so far, continuation=%s)", title_id, len(all_achs), continuation[:20] if continuation else "")
        if not can_make_requests():
            log.warning("Title %s: stopping pagination — budget exhausted (%d achievements so far)", title_id, len(all_achs))
            break

    log.info("Title achievements for %s: %d achievements in %d API call(s)", title_id, len(all_achs), api_calls)
    return all_achs, api_calls


async def get_player_achievements(title_id: str) -> list[dict]:
    """Fetch player's achievement progress for a title, paginating if needed."""
    all_achs = []
    continuation = None

    while True:
        url = f"/achievements/player/{XUID}/{title_id}"
        if continuation:
            url += "?" + urlencode({"continuationToken": continuation})
        data = await _get(url)
        all_achs.extend(data.get("achievements", []))

        paging = data.get("pagingInfo", {})
        continuation = paging.get("continuationToken")
        if not continuation:
            break

        log.debug("Player achs %s: paginating (%d so far)", title_id, len(all_achs))
        if not can_make_requests():
            log.warning("Player achs %s: stopping pagination — budget exhausted (%d so far)", title_id, len(all_achs))
            break

    return all_achs


async def get_x360_achievements(title_id: str) -> list[dict]:
    """Fetch Xbox 360 achievements (uses legacy endpoint). Returns only unlocked achievements."""
    data = await _get(f"/achievements/x360/{XUID}/title/{title_id}")
    achs = data.get("achievements", [])
    log.info("X360 achievements for %s: %d returned (unlocked only)", title_id, len(achs))
    return achs


async def get_friends() -> list[dict]:
    data = await _get("/friends")
    return data.get("people", [])


async def get_screenshots(continuation_token: str | None = None) -> tuple[list[dict], str | None]:
    """Fetch one page of DVR screenshots (100/page). Returns (screenshots, next_token)."""
    endpoint = "/dvr/screenshots"
    if continuation_token:
        endpoint += "?" + urlencode({"continuationToken": continuation_token})
    data = await _get(endpoint)
    values = data.get("screenshots", data.get("values", []))
    next_token = data.get("continuationToken") or data.get("pagingInfo", {}).get("continuationToken")
    log.info("Screenshots page: %d items, has_next=%s", len(values), bool(next_token))
    return values, next_token
