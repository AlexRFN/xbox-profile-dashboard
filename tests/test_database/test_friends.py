"""Tests for database/friends.py — friends upsert and query."""
import pytest

import database as db

_FRIEND_A = {
    "xuid": "1111111111111111",
    "gamertag": "FriendAlpha",
    "displayPicRaw": "https://example.com/a.png",
    "gamerScore": 5000,
    "presenceState": "Online",
    "presenceText": "Playing Halo",
    "isFavorite": True,
    "presenceDetails": [{"Device": "XboxSeriesX", "IsGame": True,
                          "PresenceText": "Halo", "RichPresenceText": "In a match"}],
}

_FRIEND_B = {
    "xuid": "2222222222222222",
    "gamertag": "FriendBeta",
    "displayPicRaw": "",
    "gamerScore": 1000,
    "presenceState": "Offline",
    "presenceText": "Last seen: yesterday",
    "isFavorite": False,
    "presenceDetails": [],
}


@pytest.mark.asyncio
async def test_get_friends_empty():
    result = await db.get_friends()
    assert result == []


@pytest.mark.asyncio
async def test_upsert_and_get_friends():
    count = await db.upsert_friends([_FRIEND_A, _FRIEND_B])
    assert count == 2
    friends = await db.get_friends()
    assert len(friends) == 2
    gamertags = {f["gamertag"] for f in friends}
    assert "FriendAlpha" in gamertags
    assert "FriendBeta" in gamertags


@pytest.mark.asyncio
async def test_upsert_replaces_full_list():
    await db.upsert_friends([_FRIEND_A, _FRIEND_B])
    # Second upsert with only A — B should be deleted (no longer a friend)
    await db.upsert_friends([_FRIEND_A])
    friends = await db.get_friends()
    assert len(friends) == 1
    assert friends[0]["gamertag"] == "FriendAlpha"


@pytest.mark.asyncio
async def test_online_friend_sorted_first():
    await db.upsert_friends([_FRIEND_B, _FRIEND_A])  # B first in input
    friends = await db.get_friends()
    assert friends[0]["presenceState"] == "Online"  # A should be first


@pytest.mark.asyncio
async def test_friend_presence_details_parsed():
    await db.upsert_friends([_FRIEND_A])
    friends = await db.get_friends()
    alpha = friends[0]
    assert alpha["presenceDevice"] == "XboxSeriesX"
    assert alpha["presenceGame"] == "Halo"
    assert alpha["richPresenceText"] == "In a match"


@pytest.mark.asyncio
async def test_friend_no_presence_details():
    await db.upsert_friends([_FRIEND_B])
    friends = await db.get_friends()
    beta = friends[0]
    assert beta["presenceDevice"] is None
    assert beta["presenceGame"] is None


@pytest.mark.asyncio
async def test_upsert_empty_list_removes_all():
    await db.upsert_friends([_FRIEND_A])
    await db.upsert_friends([])
    friends = await db.get_friends()
    assert friends == []


@pytest.mark.asyncio
async def test_upsert_updates_existing_friend():
    await db.upsert_friends([_FRIEND_A])
    updated = dict(_FRIEND_A, presenceState="Offline", gamerScore=9999)
    await db.upsert_friends([updated])
    friends = await db.get_friends()
    assert friends[0]["gamerScore"] == 9999
    assert friends[0]["presenceState"] == "Offline"
