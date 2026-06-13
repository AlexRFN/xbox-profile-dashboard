"""Infinite-scroll sentinel contract.

Every list endpoint ends its response with a self-replacing sentinel
(.inf-sentinel, hx-swap="outerHTML", hx-trigger="inf-load once") pointing at
the next page — or no sentinel when the list is exhausted, which terminates
the cycle. Pagination markup and Load More buttons must not come back.
"""

import re

import pytest

import database as db
from database.connection import get_connection

# ── Seed helpers ──────────────────────────────────────────────────────────────


async def _seed_games(n: int):
    games = []
    for i in range(n):
        games.append(
            {
                "title_id": f"IS{i:04d}",
                "name": f"Scroll Game {i}",
                "display_image": f"https://store-images.s-microsoft.com/image/apps.{i}.png",
                "devices": ["XboxSeries"],
                "current_gamerscore": 100,
                "total_gamerscore": 1000,
                "progress_percentage": 10,
                "current_achievements": 1,
                "total_achievements": 10,
                "last_played": f"2024-{1 + i % 12:02d}-{1 + i % 28:02d}T12:00:00Z",
                "is_gamepass": False,
            }
        )
    await db.upsert_games_bulk(games)
    return games


async def _seed_achievements(title_id: str, n: int):
    rows = []
    for a in range(n):
        # Unique unlock dates so the timeline doesn't batch them into one event.
        month = 1 + a // 28
        day = 1 + a % 28
        rows.append(
            {
                "achievement_id": str(a + 1),
                "name": f"Ach {a}",
                "description": "desc",
                "locked_description": "???",
                "gamerscore": 10,
                "progress_state": "Achieved",
                "time_unlocked": f"2023-{month:02d}-{day:02d}T10:00:00Z",
                "is_secret": False,
                "rarity_category": "Common",
                "rarity_percentage": 40.0,
                "media_assets": [],
            }
        )
    await db.upsert_achievements(title_id, rows)


async def _seed_screenshots(title_id: str, n: int):
    conn = await get_connection()
    for i in range(n):
        await conn.execute(
            """INSERT INTO screenshots
               (content_id, title_id, title_name, capture_date, resolution_width,
                resolution_height, download_uri, thumbnail_large_uri)
               VALUES (?, ?, ?, ?, 1920, 1080, ?, ?)""",
            (
                f"cap-{i:04d}",
                title_id,
                "Scroll Game 0",
                f"2024-{1 + i % 12:02d}-{1 + i % 28:02d}T12:{i % 60:02d}:00Z",
                f"https://gameclips.xboxlive.com/full-{i}.png",
                f"https://gameclips.xboxlive.com/thumb-{i}.png",
            ),
        )
    await conn.commit()


def _sentinel(html: str, sentinel_id: str) -> str | None:
    m = re.search(rf'<\w+[^>]*id="{sentinel_id}"[^>]*>', html)
    return m.group(0) if m else None


def _assert_sentinel_contract(tag: str, next_page: int):
    assert 'class="inf-sentinel"' in tag, f"sentinel missing inf-sentinel class: {tag}"
    assert f"page={next_page}" in tag, f"sentinel doesn't point at page {next_page}: {tag}"
    assert 'hx-trigger="inf-load once"' in tag, f"sentinel lost its inf-load trigger: {tag}"
    assert 'hx-swap="outerHTML"' in tag, f"sentinel must self-replace (outerHTML): {tag}"


# ── Library table ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_library_table_emits_sentinel_then_terminates(client):
    await _seed_games(60)  # per_page=50 → 2 pages

    page1 = client.get("/api/library/table").text
    tag = _sentinel(page1, "library-table-sentinel")
    assert tag, "page 1 of 2 must end with a sentinel"
    _assert_sentinel_contract(tag, next_page=2)
    assert 'hx-include="#filters"' in tag
    assert 'data-total="60"' in page1, "page 1 must carry the result-count marker"

    page2 = client.get("/api/library/table?page=2").text
    assert _sentinel(page2, "library-table-sentinel") is None, "last page must not re-arm the sentinel"
    assert "data-total" not in page2, "appends must not stack duplicate result-count markers"


@pytest.mark.asyncio
async def test_library_grid_emits_sentinel_then_terminates(client):
    await _seed_games(60)  # per_page=48 → 2 pages

    page1 = client.get("/api/library/grid").text
    tag = _sentinel(page1, "library-grid-sentinel")
    assert tag, "page 1 of 2 must end with a sentinel"
    _assert_sentinel_contract(tag, next_page=2)

    page2 = client.get("/api/library/grid?page=2").text
    assert _sentinel(page2, "library-grid-sentinel") is None


@pytest.mark.asyncio
async def test_library_single_page_has_no_sentinel(client):
    await _seed_games(5)
    html = client.get("/api/library/table").text
    assert _sentinel(html, "library-table-sentinel") is None


# ── Achievements grid ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_achievements_grid_emits_sentinel_then_terminates(client):
    games = await _seed_games(1)
    await _seed_achievements(games[0]["title_id"], 70)  # per_page=60 → 2 pages

    page1 = client.get("/api/achievements/grid").text
    tag = _sentinel(page1, "ach-sentinel")
    assert tag, "page 1 of 2 must end with a sentinel"
    _assert_sentinel_contract(tag, next_page=2)
    assert 'hx-include="#ach-filters"' in tag

    page2 = client.get("/api/achievements/grid?page=2").text
    assert _sentinel(page2, "ach-sentinel") is None


@pytest.mark.asyncio
async def test_achievements_grouped_responses_carry_merge_keys(client):
    games = await _seed_games(1)
    await _seed_achievements(games[0]["title_id"], 5)
    html = client.get("/api/achievements/grid?group=game").text
    assert f'data-key="{games[0]["title_id"]}"' in html, (
        "grouped responses need data-key for page-boundary continuation merging"
    )


# ── Timeline ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_timeline_events_emits_sentinel_then_terminates(client):
    games = await _seed_games(1)
    await _seed_achievements(games[0]["title_id"], 70)  # >50 events → 2 pages

    page1 = client.get("/api/timeline/events?page=1").text
    tag = _sentinel(page1, "timeline-sentinel")
    assert tag, "page 1 must end with a sentinel when more events exist"
    _assert_sentinel_contract(tag, next_page=2)
    assert 'hx-include="#timeline-filters"' in tag

    # Walk to the last page — it must not re-arm.
    page = 2
    while True:
        html = client.get(f"/api/timeline/events?page={page}").text
        tag = _sentinel(html, "timeline-sentinel")
        if tag is None:
            break
        _assert_sentinel_contract(tag, next_page=page + 1)
        page += 1
        assert page < 10, "timeline sentinel never terminated"


# ── Captures ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_captures_grid_emits_sentinel_then_terminates(client):
    games = await _seed_games(1)
    await _seed_screenshots(games[0]["title_id"], 55)  # per_page=50 → 2 pages

    page1 = client.get("/api/captures/grid?page=1").text
    tag = _sentinel(page1, "captures-sentinel")
    assert tag, "page 1 of 2 must end with a sentinel"
    _assert_sentinel_contract(tag, next_page=2)

    page2 = client.get("/api/captures/grid?page=2").text
    assert _sentinel(page2, "captures-sentinel") is None
    assert "capture-card" in page2, "last page still carries its items"


# ── Pagination/Load More must stay gone ───────────────────────────────────────


@pytest.mark.asyncio
async def test_no_pagination_or_load_more_markup_anywhere(client):
    games = await _seed_games(60)
    await _seed_achievements(games[0]["title_id"], 70)
    await _seed_screenshots(games[0]["title_id"], 55)

    for path in ("/library", "/achievements", "/timeline", "/captures"):
        html = client.get(path).text
        assert 'class="pagination' not in html, f"{path} re-grew pagination markup"
        assert "Load More" not in html, f"{path} re-grew a Load More button"
