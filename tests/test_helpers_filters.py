"""Tests for Jinja2 filter functions and event grouping helpers in helpers.py."""
from helpers import (
    _batch_events,
    format_date,
    format_playtime,
    format_timeago,
    from_json,
    group_events_by_month,
    normalize_image_url,
    thumb,
)

# ---------------------------------------------------------------------------
# format_playtime
# ---------------------------------------------------------------------------

class TestFormatPlaytime:
    def test_none_returns_none(self):
        assert format_playtime(None) is None

    def test_zero_returns_none(self):
        assert format_playtime(0) is None

    def test_minutes_only(self):
        assert format_playtime(45) == "45m"

    def test_hours_and_minutes(self):
        assert format_playtime(90) == "1h 30m"

    def test_exact_hours(self):
        assert format_playtime(120) == "2h 0m"

    def test_large_value(self):
        result = format_playtime(10000)
        assert result is not None and "h" in result


# ---------------------------------------------------------------------------
# format_date
# ---------------------------------------------------------------------------

class TestFormatDate:
    def test_none_returns_none(self):
        assert format_date(None) is None

    def test_empty_returns_none(self):
        assert format_date("") is None

    def test_iso_datetime(self):
        result = format_date("2024-05-15T10:00:00Z")
        assert isinstance(result, str)
        assert "2024" in result
        assert "May" in result

    def test_date_only_string(self):
        result = format_date("2024-05-15")
        # Pure date strings parse as datetime and get formatted
        assert result is not None
        assert "2024" in result

    def test_invalid_string_returned_as_is(self):
        result = format_date("not-a-date")
        # 10 chars, so len >= 10 → returns str[:10] = "not-a-date"
        assert result == "not-a-date"


# ---------------------------------------------------------------------------
# format_timeago
# ---------------------------------------------------------------------------

class TestFormatTimeago:
    def test_none_returns_never(self):
        assert format_timeago(None) == "Never"

    def test_empty_returns_never(self):
        assert format_timeago("") == "Never"

    def test_recent_timestamp_returns_ago_string(self):
        from datetime import UTC, datetime, timedelta
        recent = (datetime.now(UTC) - timedelta(minutes=5)).isoformat()
        result = format_timeago(recent)
        assert "ago" in result or "just now" in result

    def test_very_recent_returns_just_now(self):
        from datetime import UTC, datetime, timedelta
        recent = (datetime.now(UTC) - timedelta(seconds=10)).isoformat()
        assert format_timeago(recent) == "just now"

    def test_old_date_returns_formatted(self):
        result = format_timeago("2020-01-01T00:00:00Z")
        assert "2020" in result

    def test_invalid_string_returned_as_is(self):
        assert format_timeago("garbage") == "garbage"


# ---------------------------------------------------------------------------
# from_json
# ---------------------------------------------------------------------------

class TestFromJson:
    def test_valid_json_string(self):
        assert from_json('["a", "b"]') == ["a", "b"]

    def test_invalid_json_returns_empty_list(self):
        assert from_json("not json") == []

    def test_none_returns_empty_list(self):
        assert from_json(None) == []

    def test_already_list_passthrough(self):
        assert from_json(["x"]) == ["x"]

    def test_empty_string_returns_empty_list(self):
        assert from_json("") == []


# ---------------------------------------------------------------------------
# thumb
# ---------------------------------------------------------------------------

class TestThumb:
    def test_microsoft_url_gets_size_params(self):
        url = "https://store-images.s-microsoft.com/image/abc123"
        result = thumb(url, 120)
        assert "?w=120&h=120" in result

    def test_non_microsoft_url_unchanged(self):
        url = "https://example.com/img.png"
        assert thumb(url) == url

    def test_none_returns_empty_string(self):
        assert thumb(None) == ""

    def test_url_with_query_params_unchanged(self):
        url = "https://store-images.s-microsoft.com/image/abc?existing=1"
        assert thumb(url) == url

    def test_xboxlive_image_routes_through_proxy(self):
        url = "https://images-eds-ssl.xboxlive.com/image?url=ABC"
        result = thumb(url, 48)
        assert result.startswith("/img?u=")
        assert "w=96" in result  # 2x retina

    def test_screenshot_thumb_routes_through_proxy(self):
        url = "https://screenshotscontent-t5001.media.xboxlive.com/xuid-1/abc_Thumbnail.PNG"
        result = thumb(url, 754)
        assert result.startswith("/img?u=")
        assert "w=1508" in result


# ---------------------------------------------------------------------------
# normalize_image_url
# ---------------------------------------------------------------------------

class TestNormalizeImageUrl:
    def test_http_rewritten_to_https(self):
        assert normalize_image_url("http://example.com/img.png") == "https://example.com/img.png"

    def test_https_unchanged(self):
        assert normalize_image_url("https://example.com/img.png") == "https://example.com/img.png"

    def test_empty_returns_empty(self):
        assert normalize_image_url("") == ""

    def test_relative_url_unchanged(self):
        assert normalize_image_url("/static/img.png") == "/static/img.png"

    def test_bare_domain_gets_https(self):
        result = normalize_image_url("example.com/img.png")
        assert result.startswith("https://")


# ---------------------------------------------------------------------------
# _batch_events
# ---------------------------------------------------------------------------

class TestBatchEvents:
    def _ach(self, name, date="2024-05-15T10:00:00Z", title_id="G1", gs=10):
        return {"event_type": "achievement", "event_date": date,
                "event_title": name, "game_name": "Game", "title_id": title_id,
                "event_value": gs}

    def test_empty_returns_empty(self):
        assert _batch_events([]) == []

    def test_non_achievement_events_pass_through(self):
        ev = {"event_type": "completion", "event_date": "2024-05-15T10:00:00Z",
              "event_title": "Done", "title_id": "G1"}
        result = _batch_events([ev])
        assert result == [ev]

    def test_less_than_threshold_not_batched(self):
        evs = [self._ach(f"A{i}") for i in range(2)]
        result = _batch_events(evs)
        assert len(result) == 2
        assert all(e["event_type"] == "achievement" for e in result)

    def test_three_or_more_same_game_same_day_batched(self):
        evs = [self._ach(f"A{i}") for i in range(3)]
        result = _batch_events(evs)
        assert len(result) == 1
        assert result[0]["event_type"] == "achievement_batch"
        assert result[0]["batch_count"] == 3

    def test_different_games_not_batched_together(self):
        evs = [self._ach("A1", title_id="G1"),
               self._ach("A2", title_id="G2"),
               self._ach("A3", title_id="G1")]
        result = _batch_events(evs)
        # G1/A1 alone, G2, then G1/A3 alone — no run of 3 same-game consecutive
        assert all(e["event_type"] == "achievement" for e in result)

    def test_batch_gamerscore_summed(self):
        evs = [self._ach(f"A{i}", gs=10) for i in range(4)]
        result = _batch_events(evs)
        assert result[0]["batch_gamerscore"] == 40


# ---------------------------------------------------------------------------
# group_events_by_month
# ---------------------------------------------------------------------------

class TestGroupEventsByMonth:
    def _ach_event(self, date="2024-05-15T10:00:00Z", gs=10):
        return {"event_type": "achievement", "event_date": date,
                "event_value": gs, "game_name": "Game", "title_id": "G1",
                "event_title": "An achievement"}

    def test_empty_returns_empty(self):
        assert group_events_by_month([]) == []

    def test_single_event_one_group(self):
        groups = group_events_by_month([self._ach_event()])
        assert len(groups) == 1
        assert "May 2024" in groups[0]["label"]

    def test_two_months_two_groups(self):
        events = [
            self._ach_event("2024-05-15T10:00:00Z"),
            self._ach_event("2024-04-10T10:00:00Z"),
        ]
        groups = group_events_by_month(events)
        assert len(groups) == 2

    def test_group_has_required_keys(self):
        groups = group_events_by_month([self._ach_event()])
        g = groups[0]
        assert "label" in g
        assert "month_key" in g
        assert "events" in g
        assert "achievement_count" in g
        assert "gamerscore" in g
        assert "event_count" in g

    def test_achievement_count_computed(self):
        events = [self._ach_event() for _ in range(3)]
        groups = group_events_by_month(events)
        assert groups[0]["achievement_count"] == 3

    def test_month_counts_override_computed(self):
        events = [self._ach_event()]
        month_counts = {"2024-05": {
            "achievement_count": 99, "completion_count": 1,
            "first_played_count": 0, "gamerscore": 500, "event_count": 100,
        }}
        groups = group_events_by_month(events, month_counts)
        assert groups[0]["achievement_count"] == 99
        assert groups[0]["gamerscore"] == 500
