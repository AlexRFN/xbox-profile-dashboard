"""Performance regression guards.

Pins the load-bearing performance properties of the app so a future change
can't silently undo them. The guards are deliberately deterministic — SQL
shape captured via sqlite trace callbacks, EXPLAIN QUERY PLAN output, and
rendered-payload content — because latency assertions flake on shared CI.
The single timing test uses an order-of-magnitude budget as a catastrophe
net, not a benchmark.

Properties pinned here (and the commit that introduced each):
  1. Timeline request path reads the materialized timeline_events table via
     its indexes — never re-runs the UNION ALL over achievements per request.
  2. The unfiltered timeline page is served from the in-memory cache with
     zero SQL on a warm hit.
  3. Request-path reads run on the read pool, not the write connection.
  4. The dashboard inlines only the chart fields, not the full stats object.
  5. The completed-games grid requests 96px proxy thumbs, not 480px.
  6. The shell ships the provisional Lenis driver (scroll alive pre-GPU-init).
  7. Both glass renderers bail out on software rasterizers.
  8. HTML is no-store; versioned static assets are immutable.
"""

import re
from pathlib import Path

import pytest

import database as db

BASE_DIR = Path(__file__).parent.parent

# ── Seed helpers ──────────────────────────────────────────────────────────────

_N_GAMES = 40
_ACH_PER_GAME = 25


async def _seed():
    games = []
    for i in range(_N_GAMES):
        pct = 100 if i % 5 == 0 else (0 if i % 5 == 1 else 7 + (i * 13) % 90)
        games.append(
            {
                "title_id": f"PG{i:04d}",
                "name": f"Perf Game {i}",
                "display_image": f"https://store-images.s-microsoft.com/image/apps.{i}.png",
                "devices": ["XboxSeries"],
                "current_gamerscore": pct * 10,
                "total_gamerscore": 1000,
                "progress_percentage": pct,
                "current_achievements": pct * _ACH_PER_GAME // 100,
                "total_achievements": _ACH_PER_GAME,
                "last_played": f"20{10 + i % 16}-{1 + i % 12:02d}-15T12:00:00Z",
                "is_gamepass": i % 3 == 0,
            }
        )
    await db.upsert_games_bulk(games)
    for i, g in enumerate(games):
        unlocked = g["current_achievements"]
        rows = []
        for a in range(_ACH_PER_GAME):
            done = a < unlocked
            rows.append(
                {
                    "achievement_id": str(a + 1),
                    "name": f"Ach {a} g{i}",
                    "description": "desc",
                    "locked_description": "???",
                    "gamerscore": 10,
                    "progress_state": "Achieved" if done else "NotStarted",
                    "time_unlocked": f"20{10 + i % 16}-{1 + a % 12:02d}-10T08:00:00Z"
                    if done
                    else "0001-01-01T00:00:00.0000000Z",
                    "is_secret": False,
                    "rarity_category": "Common",
                    "rarity_percentage": 40.0,
                    "media_assets": [],
                }
            )
        await db.upsert_achievements(g["title_id"], rows)


async def _trace_sql(coro_factory):
    """Run a coroutine while capturing every SQL statement executed on the
    write connection and all read-pool connections. Returns (result, stmts)."""
    from database.connection import get_connection, get_read_connection

    conns = {await get_connection()}
    for _ in range(4):  # round-robin guarantees full pool coverage
        conns.add(await get_read_connection())
    stmts: list[str] = []
    for c in conns:
        await c.set_trace_callback(stmts.append)
    try:
        result = await coro_factory()
    finally:
        for c in conns:
            await c.set_trace_callback(None)
    return result, stmts


async def _explain(stmt: str) -> str:
    from database.connection import get_connection

    conn = await get_connection()
    params = [None] * stmt.count("?")
    cursor = await conn.execute("EXPLAIN QUERY PLAN " + stmt, params)
    rows = await cursor.fetchall()
    return " | ".join(r[3] for r in rows)


def _selects(stmts: list[str]) -> list[str]:
    return [s for s in stmts if s.lstrip().upper().startswith("SELECT")]


# ── 1+2: timeline request path — materialized, indexed, cached ────────────────


@pytest.mark.asyncio
async def test_timeline_request_path_never_runs_the_union():
    """Per-request timeline reads must hit timeline_events, not re-aggregate
    the achievements table (the pre-materialization design this replaced)."""
    await _seed()
    await db.get_timeline_events()  # triggers materialization

    # Page 2 is never cached — this is the steady-state "Load More" path.
    (_, _), stmts = await _trace_sql(lambda: db.get_timeline_events(page=2))
    selects = _selects(stmts)
    assert selects, "expected the page query to run"
    for s in selects:
        assert "timeline_events" in s, f"timeline read bypassed the materialized table: {s[:120]}"
        assert "UNION" not in s.upper(), "the UNION ALL is back on the request path"
        assert "FROM achievements" not in s, "timeline read re-aggregates achievements per request"

    # And the query must be index-served with no sort step.
    plan = await _explain(selects[0])
    assert "idx_timeline_events" in plan, f"timeline page not index-served: {plan}"
    assert "TEMP B-TREE" not in plan.upper(), f"timeline page pays a per-request sort: {plan}"


@pytest.mark.asyncio
async def test_timeline_warm_unfiltered_page_runs_zero_sql():
    await _seed()
    await db.get_timeline_events()  # populate cache
    (_, _), stmts = await _trace_sql(lambda: db.get_timeline_events())
    assert _selects(stmts) == [], f"warm unfiltered timeline page hit the DB: {stmts[:2]}"


@pytest.mark.asyncio
async def test_timeline_stats_grouping_reads_materialized_table():
    await _seed()
    await db.get_timeline_stats_and_months(event_type="achievement")  # uncached variant
    (_, _), stmts = await _trace_sql(lambda: db.get_timeline_stats_and_months(event_type="achievement"))
    selects = _selects(stmts)
    assert selects and all("timeline_events" in s for s in selects)


# ── 3: request-path reads stay off the write connection ──────────────────────


@pytest.mark.asyncio
async def test_request_path_reads_use_the_read_pool():
    """get_dashboard_stats (cache-miss) must not run SELECTs on the write
    connection — that serialization is what the read pool exists to remove."""
    from database.cache import _cache_clear_all
    from database.connection import get_connection, get_read_connection

    await _seed()
    await db.get_timeline_events()  # materialize first (that write is allowed)
    _cache_clear_all()

    write_conn = await get_connection()
    await get_read_connection()  # ensure pool exists before tracing
    stmts: list[str] = []
    await write_conn.set_trace_callback(stmts.append)
    try:
        await db.get_dashboard_stats()
    finally:
        await write_conn.set_trace_callback(None)
    assert _selects(stmts) == [], f"dashboard stats queried the WRITE connection: {_selects(stmts)[:1]}"


# ── 4+5+6: rendered payload guards ────────────────────────────────────────────

_ALLOWED_STATS_KEYS = {
    "total_games",
    "zero_progress",
    "low_progress",
    "high_progress",
    "completed_games",
    "monthly_stats",
    "most_played",
}


@pytest.mark.asyncio
async def test_dashboard_inline_stats_stays_pruned(client):
    await _seed()
    html = client.get("/").text
    m = re.search(r"_statsData = (\{.*?\});\n", html, re.DOTALL)
    assert m, "dashboard no longer inlines _statsData (charts broken?)"
    import json

    payload = json.loads(m.group(1))
    extra = set(payload) - _ALLOWED_STATS_KEYS
    assert not extra, f"_statsData regained fields the charts never read: {extra}"
    assert len(m.group(1)) < 16_384, f"_statsData payload ballooned to {len(m.group(1))} bytes"


@pytest.mark.asyncio
async def test_completed_grid_requests_small_thumbs(client):
    await _seed()
    html = client.get("/").text
    tags = re.findall(r"<img[^>]*completed-game-img[^>]*>", html)
    assert tags, "completed-games grid missing from seeded dashboard"
    for tag in tags:
        assert "w=96" in tag, f"completed-game thumb regressed from 96px proxy width: {tag[:160]}"
        assert 'width="48"' in tag and 'height="48"' in tag, "completed-game img lost its layout-reserving dims"


def test_shell_ships_provisional_scroll_driver(client):
    html = client.get("/").text
    assert "__glassDrivesLenis" in html, (
        "provisional Lenis driver missing — scroll would be dead until GPU init (or 3s without GPU)"
    )


# ── 7: glass software-rasterizer bail-outs ────────────────────────────────────


def test_glass_renderers_guard_against_software_rasterizers():
    webgl = (BASE_DIR / "static" / "js" / "glass.js").read_text(encoding="utf-8")
    assert re.search(r"swiftshader", webgl, re.IGNORECASE), (
        "glass.js lost its software-renderer bail-out — full blur pipeline would run on CPU"
    )
    webgpu = (BASE_DIR / "static" / "js" / "glass-webgpu.js").read_text(encoding="utf-8")
    assert "isFallbackAdapter" in webgpu, "glass-webgpu.js lost its software-adapter bail-out"


# ── 8: caching headers ────────────────────────────────────────────────────────


def test_html_is_no_store_and_versioned_static_is_immutable(client):
    page = client.get("/library")
    assert "no-store" in page.headers.get("cache-control", ""), "HTML lost no-store (stale pages after sync)"
    asset = client.get("/static/css/tokens.css?v=123")
    assert "immutable" in asset.headers.get("cache-control", ""), "versioned static lost immutable caching"


# ── Catastrophe net: order-of-magnitude latency budget ────────────────────────


@pytest.mark.asyncio
async def test_warm_pages_stay_under_catastrophe_budget(client):
    """NOT a benchmark — pages render in <25ms here. The 2s budget only trips
    on order-of-magnitude regressions (sync blocking a request, an accidental
    network call, a per-request full-table rebuild)."""
    import time

    await _seed()
    for path in ("/", "/library", "/timeline", "/achievements"):
        client.get(path)  # warm
        t0 = time.perf_counter()
        r = client.get(path)
        elapsed = time.perf_counter() - t0
        assert r.status_code == 200
        assert elapsed < 2.0, f"{path} took {elapsed:.2f}s warm — catastrophic regression"
