import logging

import orjson

from database import (
    get_achievement_ids,
    recalc_game_from_achievements,
    update_achievement_progress,
    upsert_achievements,
)
from xbox_api import get_player_achievements, get_title_achievements, get_x360_achievements

log = logging.getLogger("xbox.sync")

def _check_x360(devices) -> bool:
    if isinstance(devices, str):
        try:
            devices = orjson.loads(devices)
        except (orjson.JSONDecodeError, TypeError):
            return False
    return devices == ["Xbox360"]

def _parse_player_achievement(pa: dict) -> dict:
    pa_id = str(pa.get("id", ""))
    progress = pa.get("progressState", "NotStarted")
    progression = pa.get("progression", {})
    time_unlocked = None
    if progression and progression.get("timeUnlocked"):
        ts = progression["timeUnlocked"]
        if ts != "0001-01-01T00:00:00.0000000Z":
            time_unlocked = ts

    rewards = pa.get("rewards", [])
    gs = next((int(r.get("value", 0)) for r in rewards if r.get("type") == "Gamerscore"), 0)

    return {
        "achievement_id": pa_id,
        "progress_state": progress,
        "time_unlocked": time_unlocked,
        "gamerscore": gs,
    }

async def _save_achievements(title_id: str, data: list[dict], update_only: bool = False) -> int:
    fn = update_achievement_progress if update_only else upsert_achievements
    count = await fn(title_id, data)
    await recalc_game_from_achievements(title_id)
    return count

async def _merge_modern_achievements(title_id: str, player_achs: list[dict] | None = None) -> tuple[int, int]:
    # Modern Xbox achievements require two API calls: title achievements (definitions + rarity)
    # and player achievements (progress state + unlock time). Neither endpoint provides both.
    # The player_achs parameter allows the caller to pass already-fetched data to avoid a
    # redundant call (used by _merge_player_achievements_only when escalating to full merge).
    title_achs, title_api_calls = await get_title_achievements(title_id)
    api_calls = title_api_calls
    if player_achs is None:
        player_achs = await get_player_achievements(title_id)
        api_calls += 1
    log.debug("Merging achievements for %s: %d title, %d player", title_id, len(title_achs), len(player_achs))

    title_lookup = {str(ta.get("id", "")): ta for ta in title_achs}

    merged = []
    for pa in player_achs:
        parsed = _parse_player_achievement(pa)
        ta = title_lookup.get(parsed["achievement_id"], {})
        rarity = ta.get("rarity", {})

        merged.append({
            **parsed,
            "name": pa.get("name", ""),
            "description": pa.get("description", ""),
            "locked_description": pa.get("lockedDescription", ""),
            "is_secret": pa.get("isSecret", False),
            "rarity_category": rarity.get("currentCategory"),
            "rarity_percentage": rarity.get("currentPercentage"),
            "media_assets": pa.get("mediaAssets", []),
        })

    ach_count = await _save_achievements(title_id, merged)
    return ach_count, api_calls

async def _merge_x360_achievements(title_id: str) -> tuple[int, int]:
    achs = await get_x360_achievements(title_id)

    merged = []
    for a in achs:
        a_id = str(a.get("id", ""))
        time_unlocked = a.get("timeUnlocked")
        if time_unlocked and time_unlocked.startswith("0001"):
            time_unlocked = None

        rarity = a.get("rarity", {})

        merged.append({
            "achievement_id": a_id,
            "name": a.get("name", ""),
            "description": a.get("description", ""),
            "locked_description": a.get("lockedDescription", ""),
            "gamerscore": a.get("gamerscore", 0),
            "progress_state": "Achieved" if a.get("unlocked") else "NotStarted",
            "time_unlocked": time_unlocked,
            "is_secret": a.get("isSecret", False),
            "rarity_category": rarity.get("currentCategory"),
            "rarity_percentage": rarity.get("currentPercentage"),
            "media_assets": [],
        })

    ach_count = await _save_achievements(title_id, merged)
    return ach_count, 1

async def _merge_player_achievements_only(title_id: str) -> tuple[int, int]:
    # Cheap path (1 API call) for "stats_only" changes: just refresh progress state
    # and unlock times, skipping the title-achievement definition fetch.
    # If the API returns achievement IDs we don't have locally, the definitions are
    # missing and we must escalate to a full merge to get names, rarity, etc.
    player_achs = await get_player_achievements(title_id)

    api_ids = {str(pa.get("id", "")) for pa in player_achs}
    existing_ids = await get_achievement_ids(title_id)
    new_ids = api_ids - existing_ids
    if new_ids:
        log.info("%s: %d new achievement(s) not in DB — escalating to full merge", title_id, len(new_ids))
        return await _merge_modern_achievements(title_id, player_achs=player_achs)

    merged = [_parse_player_achievement(pa) for pa in player_achs]
    count = await _save_achievements(title_id, merged, update_only=True)
    return count, 1
