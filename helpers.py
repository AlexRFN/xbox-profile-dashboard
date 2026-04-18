import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import orjson
from fastapi import Request
from fastapi.responses import StreamingResponse
from fastapi.templating import Jinja2Templates
from jinja2 import FileSystemBytecodeCache

import database as db
import xbox_api

log = logging.getLogger("xbox.helpers")
BASE_DIR = Path(__file__).parent

_bytecode_dir = BASE_DIR / "data" / "jinja_cache"
_bytecode_dir.mkdir(parents=True, exist_ok=True)
_bytecode_cache = FileSystemBytecodeCache(str(_bytecode_dir))

templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
templates.env.bytecode_cache = _bytecode_cache
templates.env.auto_reload = True


# --- Asset bundling ---

def _build_bundle(files: list[str], out_path: Path, file_header: str) -> str:
    """Concatenate source files into a bundle and return a versioned URL."""
    static_dir = BASE_DIR / "static"
    parts, max_mtime = [], 0
    for f in files:
        p = static_dir / f
        if p.exists():
            parts.append(file_header.format(f) + "\n" + p.read_text(encoding="utf-8"))
            max_mtime = max(max_mtime, int(p.stat().st_mtime))
    out_path.write_text("\n".join(parts), encoding="utf-8")
    url = f"/static/{out_path.relative_to(static_dir).as_posix()}?v={max_mtime}"
    log.info("Bundle built: %s (%d files, %d bytes)", url, len(parts), out_path.stat().st_size)
    return url


_CSS_FILES = [
    "css/tokens.css", "css/base.css", "css/layout.css", "css/animations.css",
    "css/library.css", "css/profile.css", "css/game-detail.css", "css/achievements.css",
    "css/timeline.css", "css/friends.css", "css/captures.css", "css/heatmap.css",
    "css/toast.css", "css/palette.css", "css/responsive.css", "css/overhaul.css",
    "css/vendor/lenis.css",
]
_bundle_url: str | None = None


def build_css_bundle() -> None:
    global _bundle_url
    _bundle_url = _build_bundle(_CSS_FILES, BASE_DIR / "static" / "css" / "bundle.css", "/* {} */")


def get_bundle_url() -> str | None:
    return _bundle_url


_JS_SRC_FILES = [
    "js/src/utils.js", "js/src/theme.js", "js/src/toast.js",
    "js/src/reveal.js", "js/src/animations.js", "js/src/nav.js",
    "js/src/preload.js",
    "js/src/charts.js", "js/src/blurhash.js", "js/src/library.js",
    "js/src/tracking.js", "js/src/sync.js", "js/src/timeline.js",
    "js/src/heatmap.js", "js/src/captures.js", "js/src/lightbox.js",
    "js/src/cmd-palette.js", "js/src/init.js",
]
_js_bundle_url: str | None = None


def build_js_bundle() -> None:
    global _js_bundle_url
    _js_bundle_url = _build_bundle(_JS_SRC_FILES, BASE_DIR / "static" / "js" / "app.js", "// === {} ===")


def get_js_bundle_url() -> str | None:
    return _js_bundle_url


def static_url(path: str) -> str:
    """Return a versioned static URL using file mtime for cache-busting.
    e.g. static_url('css/base.css') → '/static/css/base.css?v=1708345600'
    Combined with the cache middleware this allows immutable caching with automatic invalidation.
    """
    try:
        mtime = int((BASE_DIR / "static" / path).stat().st_mtime)
        return f"/static/{path}?v={mtime}"
    except OSError:
        return f"/static/{path}"


# --- Jinja2 filters ---

# Captured once at startup — local timezone is stable for the lifetime of the process
_LOCAL_TZ = datetime.now(UTC).astimezone().tzinfo


def _parse_iso(iso_str: str) -> datetime | None:
    """Parse ISO datetime string, handling Z suffix. Returns local-time datetime."""
    if not iso_str:
        return None
    try:
        dt = datetime.fromisoformat(iso_str.replace("Z", "+00:00"))
        if not dt.tzinfo:
            dt = dt.replace(tzinfo=UTC)
        return dt.astimezone(_LOCAL_TZ)
    except (ValueError, TypeError):
        return None


def format_playtime(minutes):
    if not minutes:
        return None
    hours = minutes // 60
    mins = minutes % 60
    if hours > 0:
        return f"{hours}h {mins}m"
    return f"{mins}m"


def format_date(iso_str):
    dt = _parse_iso(iso_str)
    if dt:
        return dt.strftime("%b %d, %Y")
    if iso_str and len(iso_str) >= 10:
        return iso_str[:10]
    return iso_str if iso_str else None


def format_timeago(iso_str):
    if not iso_str:
        return "Never"
    dt = _parse_iso(iso_str)
    if not dt:
        return iso_str
    diff = datetime.now(UTC) - dt
    seconds = int(diff.total_seconds())
    if seconds < 60:
        return "just now"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes}m ago"
    hours = minutes // 60
    if hours < 24:
        return f"{hours}h ago"
    days = hours // 24
    if days < 7:
        return f"{days}d ago"
    return dt.strftime("%b %d, %Y")


def from_json(value):
    if isinstance(value, str):
        try:
            return orjson.loads(value)
        except (orjson.JSONDecodeError, TypeError):
            return []
    return value if value else []


def thumb(url, size=240):
    """Append resize params to Microsoft Store image URLs for smaller downloads."""
    if url and "store-images.s-microsoft.com" in url and "?" not in url:
        return f"{url}?w={size}&h={size}"
    return url or ""


def register_filters() -> None:
    """Attach Jinja2 filters and globals to the templates environment."""
    templates.env.filters["playtime"] = format_playtime
    templates.env.filters["shortdate"] = format_date
    templates.env.filters["fromjson"] = from_json
    templates.env.filters["timeago"] = format_timeago
    templates.env.filters["thumb"] = thumb
    templates.env.globals["static_url"] = static_url
    templates.env.globals["css_bundle_url"] = get_bundle_url


# --- Shared helpers ---

def normalize_image_url(url: str) -> str:
    """Ensure Xbox image URLs use https://."""
    if not url:
        return ""
    if url.startswith("http://"):
        return "https://" + url[7:]
    if not url.startswith("https://") and not url.startswith("/"):
        return "https://" + url
    return url


async def page_ctx(request: Request) -> dict:
    """Common template context for all full-page routes."""
    ctx = await db.get_page_context_data()
    ctx["gamertag"] = xbox_api.GAMERTAG
    # True when htmx is doing a tab switch (targets <main>) — templates skip full re-renders.
    # Also true on history-restore XHR (back/forward cache miss): htmx's Gt() sends
    # HX-History-Restore-Request but no HX-Target, and still needs the SPA partial.
    ctx["is_spa_nav"] = request.headers.get("hx-request") == "true" and (
        request.headers.get("hx-target") == "main"
        or request.headers.get("hx-history-restore-request") == "true"
    )
    return ctx



@dataclass
class LibraryFilters:
    """Shared filter params for library table, grid, and export routes."""
    q: str = ""
    status: str = ""
    completion: str = ""
    platform: str = ""
    gamepass: str = ""
    sort_by: str = "last_played"
    sort_dir: str = "desc"


def get_filters(
    q: str = "",
    status: str = "",
    completion: str = "",
    platform: str = "",
    gamepass: str = "",
    sort_by: str = "last_played",
    sort_dir: str = "desc",
) -> LibraryFilters:
    return LibraryFilters(q=q, status=status, completion=completion,
                          platform=platform, gamepass=gamepass,
                          sort_by=sort_by, sort_dir=sort_dir)


def _batch_events(events: list[dict], threshold: int = 3) -> list[dict]:
    """Batch consecutive same-game same-day achievements into batch events.
    Achievements from the same game on the same calendar day with 3+ entries
    get collapsed into a single 'achievement_batch' event."""
    result = []
    i = 0
    while i < len(events):
        ev = events[i]
        if ev.get("event_type") != "achievement":
            result.append(ev)
            i += 1
            continue

        # Collect consecutive achievements from same game on same day
        dt = _parse_iso(ev.get("event_date", ""))
        day_str = dt.strftime("%Y-%m-%d") if dt else ""
        title_id = ev.get("title_id", "")
        batch = [ev]
        j = i + 1
        while j < len(events):
            nxt = events[j]
            if nxt.get("event_type") != "achievement" or nxt.get("title_id") != title_id:
                break
            ndt = _parse_iso(nxt.get("event_date", ""))
            nday = ndt.strftime("%Y-%m-%d") if ndt else ""
            if nday != day_str:
                break
            batch.append(nxt)
            j += 1

        if len(batch) >= threshold:
            batch_gs = sum(b.get("event_value") or 0 for b in batch)
            result.append({
                "event_type": "achievement_batch",
                "event_date": ev.get("event_date"),
                "game_name": ev.get("game_name", ""),
                "game_image": ev.get("game_image", ""),
                "title_id": title_id,
                "batch_count": len(batch),
                "batch_gamerscore": batch_gs,
                "batch_events": batch,
            })
            i = j
        else:
            for b in batch:
                result.append(b)
            i = j
    return result


def group_events_by_month(events: list[dict], month_counts: dict | None = None) -> list[dict]:
    """Group timeline events by month/year with per-month stats and achievement batching.
    If month_counts is provided (from db.get_timeline_stats_and_months()), use real totals
    instead of page-subset counts.
    Returns [{label, month_key, events, event_count, achievement_count, completion_count,
              first_played_count, gamerscore}, ...]."""
    groups = []
    current_label = None
    current_key = None
    current_events = []
    for ev in events:
        dt = _parse_iso(ev.get("event_date", ""))
        label = dt.strftime("%B %Y") if dt else "Unknown"
        key = dt.strftime("%Y-%m") if dt else "unknown"
        if label != current_label:
            if current_events:
                groups.append({"label": current_label, "month_key": current_key, "events": current_events})
            current_label = label
            current_key = key
            current_events = []
        current_events.append(ev)
    if current_events:
        groups.append({"label": current_label, "month_key": current_key, "events": current_events})

    # Compute per-month stats and batch achievements
    for group in groups:
        evts = group["events"]
        key = group["month_key"]
        if month_counts and key in month_counts:
            mc = month_counts[key]
            group["achievement_count"] = mc["achievement_count"]
            group["completion_count"] = mc["completion_count"]
            group["first_played_count"] = mc["first_played_count"]
            group["gamerscore"] = mc["gamerscore"]
            group["event_count"] = mc["event_count"]
        else:
            group["achievement_count"] = sum(1 for e in evts if e.get("event_type") == "achievement")
            group["completion_count"] = sum(1 for e in evts if e.get("event_type") == "completion")
            group["first_played_count"] = sum(1 for e in evts if e.get("event_type") == "first_played")
            group["gamerscore"] = sum(e.get("event_value") or 0 for e in evts if e.get("event_type") == "achievement")
            group["event_count"] = len(evts)
        group["events"] = _batch_events(evts)

    return groups


def sse_response(async_gen):
    """Wrap an async generator as an SSE StreamingResponse."""
    async def generate():
        async for item in async_gen:
            yield f"data: {item}\n\n"
    return StreamingResponse(generate(), media_type="text/event-stream")


# --- Heatmap grid builder ---

def _heatmap_date_range(year: int | None, today: "date") -> tuple["date", "date", "date", "date"]:
    """Return (grid_start, grid_end, range_start, range_end) for the heatmap window."""
    if year is not None:
        jan1 = date(year, 1, 1)
        dec31 = date(year, 12, 31)
        start = jan1 - timedelta(days=(jan1.weekday() + 1) % 7)
        end = dec31 + timedelta(days=(5 - dec31.weekday()) % 7)
        return start, end, jan1, dec31
    current_sun = today - timedelta(days=(today.weekday() + 1) % 7)
    start = current_sun - timedelta(weeks=52)
    end = current_sun + timedelta(days=6)
    return start, end, start, today


def _quartile_level_fn(counts: dict) -> Callable[[int], int]:
    """Return a function mapping an achievement count to intensity level 0-4."""
    nonzero = sorted(c for c in counts.values() if c > 0)
    if nonzero:
        n = len(nonzero)
        q1 = nonzero[n // 4] if n >= 4 else nonzero[0]
        q2 = nonzero[n // 2]
        q3 = nonzero[3 * n // 4]
    else:
        q1 = q2 = q3 = 1

    def _level(c: int) -> int:
        if c == 0:
            return 0
        if c <= q1:
            return 1
        if c <= q2:
            return 2
        if c <= q3:
            return 3
        return 4

    return _level


def _compute_streaks(all_counts: list[int]) -> tuple[int, int]:
    """Return (current_streak, longest_streak) from an ordered list of daily counts."""
    longest = _running = 0
    for c in all_counts:
        if c > 0:
            _running += 1
            longest = max(longest, _running)
        else:
            _running = 0

    # Current streak: if today has no achievements yet, skip it (day is still in progress)
    reversed_counts = list(reversed(all_counts))
    if reversed_counts and reversed_counts[0] == 0:
        reversed_counts = reversed_counts[1:]
    current = 0
    for c in reversed_counts:
        if c > 0:
            current += 1
        else:
            break

    return current, longest


def build_heatmap_grid(heatmap_rows: list[dict], year: int | None = None) -> dict:
    """Build a week x 7-day grid from daily achievement counts.
    year=None: rolling 53 weeks ending at current week.
    year=int: calendar year Jan 1 - Dec 31."""
    today_date = date.today()
    start, end, range_start, range_end = _heatmap_date_range(year, today_date)
    num_weeks = (end - start).days // 7 + 1
    counts = {r["day"]: r["count"] for r in heatmap_rows}
    level = _quartile_level_fn(counts)

    grid = []
    months = []
    seen_months: set[tuple[int, int]] = set()
    total = 0
    all_counts = []

    for week_idx in range(num_weeks):
        week = []
        for dow in range(7):
            d = start + timedelta(weeks=week_idx, days=dow)
            ds = d.isoformat()
            c = counts.get(ds, 0)
            hidden = not (range_start <= d <= range_end) or d > today_date

            if hidden:
                week.append({"date": ds, "count": 0, "level": 0, "hidden": True})
            else:
                total += c
                week.append({"date": ds, "count": c, "level": level(c), "hidden": False})
                all_counts.append(c)
                month_key = (d.year, d.month)
                if month_key not in seen_months:
                    seen_months.add(month_key)
                    months.append({"label": d.strftime("%b"), "col": week_idx})
        grid.append(week)

    streak_current, streak_longest = _compute_streaks(all_counts)
    return {
        "grid": grid,
        "months": months,
        "num_weeks": num_weeks,
        "total_achievements": total,
        "streak_current": streak_current,
        "streak_longest": streak_longest,
    }
