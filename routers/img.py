"""Image proxy with disk cache + WebP re-encode.

Xbox CDNs (`images-eds-ssl.xboxlive.com`, `screenshotscontent-*.media.xboxlive.com`)
serve raw PNGs at native resolution with no URL-based resize support — a 48-px
achievement icon arrives as a 1.47 MB PNG, a 754x424 capture thumbnail as a
490 KB PNG. This router fetches once, resizes with Pillow, encodes to WebP, and
serves from disk on every subsequent request with `immutable` cache headers.

Security: hostname allowlist prevents this from acting as an open image proxy.
Concurrency: per-key asyncio lock dedupes simultaneous first-fetches for the
same image so we don't pay the upstream + encode cost twice.
"""
import asyncio
import hashlib
import logging
import time
from io import BytesIO
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, Response
from PIL import Image

log = logging.getLogger("xbox.img")
router = APIRouter()

CACHE_DIR = Path("data/img_cache")
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _build_placeholder() -> bytes:
    """Tiny transparent WebP served on upstream errors. Inline so the response
    never redirects — a 302 to xboxlive.com would re-route through CSP's
    `connect-src` when the service worker is the initiator, which our policy
    blocks. Inline placeholder keeps everything same-origin."""
    img = Image.new("RGBA", (8, 8), (0, 0, 0, 0))
    buf = BytesIO()
    img.save(buf, format="WEBP", quality=82)
    return buf.getvalue()


_PLACEHOLDER = _build_placeholder()


def _placeholder_response() -> Response:
    # Short cache so a transient upstream 5xx doesn't pin the placeholder for a
    # year. One hour is long enough to keep traffic off Xbox if its CDN is
    # genuinely down for that image, short enough to recover automatically.
    return Response(
        content=_PLACEHOLDER,
        media_type="image/webp",
        headers={"Cache-Control": "public, max-age=3600"},
    )

# Min/max sanity bounds — stops abuse via huge widths.
_MIN_WIDTH = 16
_MAX_WIDTH = 2048

# Per-key locks dedupe concurrent fetches for the same image.
_locks: dict[str, asyncio.Lock] = {}

# Module-level client reused across requests so connections stay warm.
_http_client: httpx.AsyncClient | None = None

# Negative cache for URLs we've already learned are broken upstream
# (returns 4xx/5xx, network error, or undecodable bytes). Each browser visit
# would otherwise refetch upstream every hour once the placeholder's HTTP
# cache expires, generating both upstream traffic and a server log line.
# Bounded so a flood of unique broken URLs can't grow this without limit.
_NEGATIVE_TTL = 3600  # seconds — matches the placeholder's max-age
_NEGATIVE_MAX = 1024
_negative_cache: dict[str, float] = {}


def _negative_cache_hit(key: str) -> bool:
    expiry = _negative_cache.get(key)
    if expiry is None:
        return False
    if time.monotonic() > expiry:
        _negative_cache.pop(key, None)
        return False
    return True


def _negative_cache_add(key: str) -> None:
    if len(_negative_cache) >= _NEGATIVE_MAX:
        # dict iteration is insertion order — pop the oldest entry.
        _negative_cache.pop(next(iter(_negative_cache)), None)
    _negative_cache[key] = time.monotonic() + _NEGATIVE_TTL


def _allowed(host: str) -> bool:
    """Hostname allowlist. Anything else is rejected before fetch."""
    h = host.lower()
    return h == "images-eds-ssl.xboxlive.com" or h.endswith(".media.xboxlive.com")


def _cache_key(url: str, width: int) -> str:
    return hashlib.sha1(f"{url}|{width}".encode()).hexdigest()


async def _get_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None:
        _http_client = httpx.AsyncClient(timeout=15.0, follow_redirects=True)
    return _http_client


async def close_http_client() -> None:
    global _http_client
    if _http_client is not None:
        await _http_client.aclose()
        _http_client = None


def _encode(data: bytes, width: int, out_path: Path) -> None:
    """Resize to max-width `width` (preserving aspect) and write WebP atomically."""
    img = Image.open(BytesIO(data))
    if img.mode == "P":
        img = img.convert("RGBA" if "transparency" in img.info else "RGB")
    elif img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGB")
    if img.width > width:
        new_h = max(1, round(img.height * (width / img.width)))
        img = img.resize((width, new_h), Image.Resampling.LANCZOS)
    tmp = out_path.with_suffix(".webp.tmp")
    img.save(tmp, format="WEBP", quality=82, method=4)
    tmp.replace(out_path)


def _serve_cached(out_path: Path) -> FileResponse:
    return FileResponse(
        out_path,
        media_type="image/webp",
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.get("/img")
async def image_proxy(u: str = Query(..., description="upstream image URL"),
                      w: int = Query(96, description="target max width")):
    if w < _MIN_WIDTH or w > _MAX_WIDTH:
        raise HTTPException(400, "invalid width")
    parsed = urlparse(u)
    if parsed.scheme != "https" or not _allowed(parsed.hostname or ""):
        raise HTTPException(400, "host not allowed")

    key = _cache_key(u, w)
    out_path = CACHE_DIR / f"{key}.webp"

    # Fast paths — no lock, no upstream call.
    if out_path.exists():
        return _serve_cached(out_path)
    if _negative_cache_hit(key):
        return _placeholder_response()

    # Slow path — dedupe concurrent first-fetches under a per-key lock.
    lock = _locks.setdefault(key, asyncio.Lock())
    try:
        async with lock:
            # Re-check both caches after acquiring; another request may have
            # populated either while we waited for the lock.
            if out_path.exists():
                return _serve_cached(out_path)
            if _negative_cache_hit(key):
                return _placeholder_response()

            try:
                client = await _get_client()
                r = await client.get(u)
            except httpx.HTTPError as e:
                log.warning("img fetch failed for %s: %s — caching as broken for %ds", u, e, _NEGATIVE_TTL)
                _negative_cache_add(key)
                return _placeholder_response()
            if r.status_code != 200:
                log.warning("img upstream %s for %s — caching as broken for %ds", r.status_code, u, _NEGATIVE_TTL)
                _negative_cache_add(key)
                return _placeholder_response()
            try:
                await asyncio.to_thread(_encode, r.content, w, out_path)
            except Exception as e:
                log.warning("img encode failed for %s: %s — caching as broken for %ds", u, e, _NEGATIVE_TTL)
                _negative_cache_add(key)
                return _placeholder_response()
    finally:
        _locks.pop(key, None)

    return _serve_cached(out_path)
