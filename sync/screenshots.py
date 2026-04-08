import logging

from database import (
    can_make_requests,
    create_sync_log,
    get_api_calls_last_hour,
    get_existing_screenshot_ids,
    update_sync_log,
    upsert_screenshots,
)
from xbox_api import RateLimitExceeded, get_screenshots

from .core import _guarded_sync, _json

log = logging.getLogger("xbox.sync")

def sync_screenshots():
    """SSE stream for screenshot sync."""
    return _guarded_sync(_sync_screenshots_inner(), {
        "message": "A sync is already in progress. Please wait.",
        "total_screenshots": 0, "api_calls_used": 0,
    })

async def _sync_screenshots_inner(max_api_calls: int = 0):
    """Inner screenshot sync logic. max_api_calls=0 means unlimited (rate-limit only)."""
    log.info("Screenshot sync started (budget=%s)", max_api_calls or "unlimited")
    sync_id = await create_sync_log("screenshots")
    api_calls = 0
    new_screenshots = []

    existing_ids = await get_existing_screenshot_ids()
    log.info("Screenshot sync: %d existing screenshots in DB", len(existing_ids))

    yield _json({"type": "phase", "phase": "captures", "message": "Fetching screenshots..."})

    try:
        continuation = None
        page_num = 0
        caught_up = False
        while True:
            if not can_make_requests():
                log.warning("Screenshot sync: rate limit reached after %d pages", page_num)
                break

            if max_api_calls > 0 and api_calls >= max_api_calls:
                log.info("Screenshot sync: budget exhausted (%d calls)", api_calls)
                break

            values, next_token = await get_screenshots(continuation)
            api_calls += 1
            page_num += 1

            page_new = [v for v in values if v.get("screenshotId") not in existing_ids]
            new_screenshots.extend(page_new)

            if page_num == 1 and len(values) > 0 and len(page_new) == len(values) and existing_ids:
                sample_api_id = values[0].get("screenshotId", "<missing>")
                sample_db_id = next(iter(existing_ids))
                log.warning("Screenshot sync: page 1 had 0 matches against %d existing IDs — "
                            "possible field mismatch (API id=%s, DB sample=%s)",
                            len(existing_ids), sample_api_id, sample_db_id)

            yield _json({
                "type": "progress",
                "phase": "captures",
                "page": page_num,
                "fetched": len(new_screenshots),
                "new": len(page_new),
                "api_calls": api_calls,
            })

            # API returns newest screenshots first. If an entire page contains no new items,
            # everything older is also already synced — stop paginating.
            if len(page_new) == 0 and len(values) > 0:
                log.info("Screenshot sync: caught up at page %d (all %d items already synced)", page_num, len(values))
                caught_up = True
                break

            if not next_token or len(values) == 0:
                break
            continuation = next_token

    except RateLimitExceeded as e:
        log.warning("Screenshot sync blocked by rate limit: %s", e)
        await update_sync_log(sync_id, "failed",
                                error_message=str(e), api_calls_used=api_calls)
        yield _json({"type": "finished", "phase": "captures", "message": str(e),
                          "total_screenshots": 0, "api_calls_used": api_calls})
        return
    except Exception as e:
        log.error("Screenshot sync failed: %s", e, exc_info=True)
        await update_sync_log(sync_id, "failed",
                                error_message=str(e), api_calls_used=api_calls)
        yield _json({"type": "finished", "phase": "captures", "message": f"Failed: {e}",
                          "total_screenshots": 0, "api_calls_used": api_calls})
        return

    count = 0
    if new_screenshots:
        count = await upsert_screenshots(new_screenshots)

    if count > 0:
        msg = f"Synced {count} new screenshots ({api_calls} API calls)."
    elif caught_up:
        msg = f"Already up to date ({api_calls} API call)."
    else:
        msg = f"No new screenshots found ({api_calls} API calls)."

    await update_sync_log(sync_id, "success",
                            games_updated=count, api_calls_used=api_calls)
    log.info("Screenshot sync complete: %d new screenshots, %d API calls", count, api_calls)

    rate_used = get_api_calls_last_hour()
    yield _json({
        "type": "finished",
        "phase": "captures",
        "message": msg,
        "total_screenshots": count,
        "api_calls_used": api_calls,
        "rate_used": rate_used,
    })
