import pytest

from database.games import get_all_games, get_game, update_game_stats, update_tracking, upsert_games_bulk


@pytest.mark.asyncio
async def test_upsert_and_get_games():
    # Insert new game
    games = [
        {
            "title_id": "123",
            "name": "Halo Infinite",
            "display_image": "http://example.com/halo.png",
            "current_gamerscore": 500,
            "total_gamerscore": 1000,
            "progress_percentage": 50,
            "current_achievements": 20,
            "total_achievements": 50,
            "last_played": "2023-10-27T10:00:00Z",
            "is_gamepass": True,
        }
    ]
    upserted = await upsert_games_bulk(games)
    assert upserted == 1

    # Verify game can be retrieved
    game = await get_game("123")
    assert game is not None
    assert game["name"] == "Halo Infinite"
    assert game["is_gamepass"] == 1
    assert game["display_image"] == "https://example.com/halo.png"  # Verify http rewrite

    # Update game
    games[0]["name"] = "Halo Infinite (Updated)"
    upserted = await upsert_games_bulk(games)
    assert upserted == 1

    game = await get_game("123")
    assert game["name"] == "Halo Infinite (Updated)"


@pytest.mark.asyncio
async def test_get_all_games():
    games = [
        {
            "title_id": "1",
            "name": "Game A",
            "progress_percentage": 10,
            "is_gamepass": True,
            "last_played": "2023-01-01",
        },
        {
            "title_id": "2",
            "name": "Game B",
            "progress_percentage": 100,
            "is_gamepass": False,
            "last_played": "2023-02-01",
        },
    ]
    await upsert_games_bulk(games)

    # Test no filters
    results, total = await get_all_games()
    assert total == 2
    assert len(results) == 2

    # Test search filter
    results, total = await get_all_games(q="Game A")
    assert total == 1
    assert results[0]["title_id"] == "1"

    # Test completion filter
    results, total = await get_all_games(completion="100")
    assert total == 1
    assert results[0]["title_id"] == "2"

    # Test gamepass filter
    results, total = await get_all_games(gamepass="yes")
    assert total == 1
    assert results[0]["title_id"] == "1"


@pytest.mark.asyncio
async def test_sync_never_clobbers_manual_tracking():
    """The load-bearing invariant: a library sync must NEVER overwrite the four
    user-owned columns (status, notes, rating, finished_date). These are the only
    fields that can't be refetched from the API — losing them loses real user data.
    Guards against anyone adding them to upsert_games_bulk's ON CONFLICT clause."""
    # A game already in the library with API-provided data.
    await upsert_games_bulk(
        [
            {
                "title_id": "999",
                "name": "Elden Ring",
                "current_gamerscore": 100,
                "progress_percentage": 20,
                "last_played": "2024-01-01T00:00:00Z",
            }
        ]
    )

    # The user manually tracks it.
    await update_tracking(
        "999", status="finished", notes="GOTY, no notes app needed", rating=10, finished_date="2024-02-14"
    )

    # A later sync brings fresh API data — different stats, and (correctly) no tracking fields.
    await upsert_games_bulk(
        [
            {
                "title_id": "999",
                "name": "Elden Ring: Shadow of the Erdtree",
                "current_gamerscore": 500,
                "progress_percentage": 75,
                "last_played": "2024-06-21T00:00:00Z",
            }
        ]
    )

    game = await get_game("999")
    # API-owned fields updated as expected.
    assert game["name"] == "Elden Ring: Shadow of the Erdtree"
    assert game["current_gamerscore"] == 500
    assert game["progress_percentage"] == 75
    # User-owned fields untouched.
    assert game["status"] == "finished"
    assert game["notes"] == "GOTY, no notes app needed"
    assert game["rating"] == 10
    assert game["finished_date"] == "2024-02-14"


@pytest.mark.asyncio
async def test_update_game_stats():
    await upsert_games_bulk([{"title_id": "3", "name": "Stat Game"}])
    await update_game_stats("3", 120)

    game = await get_game("3")
    assert game["minutes_played"] == 120
    assert game["stats_last_fetched"] is not None
