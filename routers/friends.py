import logging

from fastapi import APIRouter
from fastapi.responses import ORJSONResponse

import database as db
from xbox_api import get_friends as api_get_friends, RateLimitExceeded

log = logging.getLogger("xbox.friends")
router = APIRouter()


@router.post("/api/friends/refresh")
async def api_friends_refresh():
    try:
        friends = await api_get_friends()
        await db.upsert_friends(friends)
        log.info("Friends refreshed: %d loaded", len(friends))
        rate_used = db.get_api_calls_last_hour()
        return {"success": True, "message": f"Loaded {len(friends)} friends.", "rate_used": rate_used}
    except RateLimitExceeded as e:
        log.warning("Friends refresh blocked by rate limit: %s", e)
        return ORJSONResponse({"success": False, "message": str(e)}, status_code=429)
    except Exception as e:
        log.error("Friends refresh failed: %s", e, exc_info=True)
        return ORJSONResponse({"success": False, "message": f"Failed: {e}"}, status_code=502)
