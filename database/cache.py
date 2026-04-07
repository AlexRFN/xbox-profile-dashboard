"""In-memory TTL cache for expensive database queries.

Single-dict implementation is safe because all callers run on the same asyncio
event loop thread — no locking required. monotonic() is used for TTL so system
clock adjustments (DST, NTP) don't cause spurious expiry.
"""

import time

_cache: dict[str, tuple] = {}
# Sentinel that is never equal to None, used by update_tracking() to distinguish
# "caller omitted the field" from "caller explicitly passed None".
_UNSET = object()

def _cache_get(key: str, ttl: float = 0):
    """Return cached value or None if missing/expired."""
    entry = _cache.get(key)
    if entry is None:
        return None
    value, ts = entry
    if ttl > 0 and (time.monotonic() - ts) > ttl:
        del _cache[key]
        return None
    return value

def _cache_set(key: str, value):
    _cache[key] = (value, time.monotonic())

def _cache_invalidate(*keys: str):
    for key in keys:
        _cache.pop(key, None)
