import asyncio
import logging
import orjson
from contextlib import asynccontextmanager

log = logging.getLogger("xbox.sync")

def _json(obj) -> str:
    """Fast JSON encode to string (orjson returns bytes)."""
    return orjson.dumps(obj).decode()

# Shared async gate for every foreground and scheduled sync entrypoint.
# A single lock prevents concurrent syncs from racing on API budget and DB state.
# Both user-triggered SSE streams and APScheduler jobs acquire this before any work.
_sync_gate = asyncio.Lock()
_active_sync_name: str | None = None

def log_task_err(fut: asyncio.Future) -> None:
    """Done-callback that logs exceptions from fire-and-forget tasks."""
    if not fut.cancelled() and (exc := fut.exception()):
        log.error("Background task failed: %s", exc)

def fire_and_forget(coro) -> asyncio.Task:
    """Schedule a coroutine as a background task with error logging."""
    task = asyncio.create_task(coro)
    task.add_done_callback(log_task_err)
    return task

def is_sync_running() -> bool:
    return _sync_gate.locked()

@asynccontextmanager
async def sync_guard(sync_name: str = ""):
    """Try to claim the global sync slot. Yields True when acquired, else False.

    Non-blocking by design: callers check the yielded bool and return immediately
    rather than queuing up. This prevents request pile-up when many users click
    "Sync" simultaneously — only one proceeds, the rest get a 409 / skip message.
    """
    global _active_sync_name
    if _sync_gate.locked():
        yield False
        return

    await _sync_gate.acquire()
    _active_sync_name = sync_name or None
    try:
        yield True
    finally:
        _active_sync_name = None
        _sync_gate.release()

def fit_changes_to_budget(changes: list[dict], budget: int) -> tuple[list[dict], int]:
    """Select as many changes as fit within an API call budget.

    Changes are expected to be pre-sorted by priority (most recently played first).
    The greedy first-fit approach works well here because all items have the same
    cost (3 calls for full sync, 1 for stats-only), so no bin-packing needed.
    """
    batch = []
    cost = 0
    for change in changes:
        c = change["api_cost"]
        if cost + c <= budget:
            batch.append(change)
            cost += c
        else:
            break
    return batch, cost

async def _guarded_sync(inner_gen, busy_payload: dict):
    """Wrap an SSE async generator with the sync-active mutex."""
    async with sync_guard("stream") as acquired:
        if not acquired:
            yield _json({"type": "finished", **busy_payload})
            return
        async for item in inner_gen:
            yield item
