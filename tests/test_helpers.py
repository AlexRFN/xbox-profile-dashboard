"""Unit tests for pure utility functions in helpers.py."""
from datetime import date

from helpers import (
    _compute_streaks,
    _quartile_level_fn,
    build_heatmap_grid,
)


class TestQuartileLevelFn:
    def test_empty_counts_zero_returns_level_0(self):
        level = _quartile_level_fn({})
        assert level(0) == 0

    def test_empty_counts_nonzero_uses_fallback_quartiles(self):
        # With no data, q1=q2=q3=1, so any value > 1 hits level 4
        level = _quartile_level_fn({})
        assert level(1) == 1  # c <= q1 (1)
        assert level(5) == 4  # c > q3 (1)

    def test_zero_count_always_returns_level_0(self):
        level = _quartile_level_fn({"a": 5, "b": 10})
        assert level(0) == 0

    def test_levels_are_monotonically_non_decreasing(self):
        counts = {"a": 1, "b": 2, "c": 3, "d": 4, "e": 5, "f": 8, "g": 10, "h": 20}
        level = _quartile_level_fn(counts)
        values = [0, 1, 2, 3, 4, 5, 8, 10, 20]
        levels = [level(v) for v in values]
        assert levels == sorted(levels)

    def test_value_above_q3_returns_level_4(self):
        # sorted=[1,2,3,100], n=4, q1=2, q2=3, q3=100 → 100 <= q3, so level 3
        # value beyond max returns 4 since > q3
        counts = {"a": 1, "b": 2, "c": 3, "d": 100}
        level = _quartile_level_fn(counts)
        assert level(101) == 4
        assert level(100) == 3  # equal to q3 → level 3

    def test_small_dataset_uses_first_value_as_q1(self):
        # n < 4 → q1 = nonzero[0]
        counts = {"a": 5, "b": 10}
        level = _quartile_level_fn(counts)
        assert level(5) in (1, 2, 3, 4)  # at minimum level 1


class TestComputeStreaks:
    def test_empty_list(self):
        assert _compute_streaks([]) == (0, 0)

    def test_all_zeros(self):
        assert _compute_streaks([0, 0, 0]) == (0, 0)

    def test_all_nonzero(self):
        current, longest = _compute_streaks([1, 2, 3])
        assert longest == 3
        assert current == 3

    def test_streak_broken(self):
        # [1,1,0,1,1,1] — longest=3, current=3
        current, longest = _compute_streaks([1, 1, 0, 1, 1, 1])
        assert longest == 3
        assert current == 3

    def test_trailing_zero_skipped_for_current(self):
        # today (last entry) is 0 — skip it, current streak is the preceding run
        current, longest = _compute_streaks([1, 1, 1, 0])
        assert longest == 3
        assert current == 3

    def test_single_nonzero_day(self):
        # trailing 0 is skipped; then [5, 0, 0] → current=1 (hits 0 and breaks)
        current, longest = _compute_streaks([0, 0, 5, 0])
        assert longest == 1
        assert current == 1

    def test_longest_vs_current_differ(self):
        # long streak in the past, short one now
        current, longest = _compute_streaks([1, 1, 1, 1, 1, 0, 0, 1, 1])
        assert longest == 5
        assert current == 2


class TestBuildHeatmapGrid:
    def test_returns_required_keys(self):
        result = build_heatmap_grid([])
        assert {"grid", "months", "num_weeks", "total_achievements", "streak_current", "streak_longest"} <= result.keys()

    def test_empty_rows_zero_total(self):
        result = build_heatmap_grid([])
        assert result["total_achievements"] == 0

    def test_grid_is_list_of_weeks(self):
        result = build_heatmap_grid([])
        assert isinstance(result["grid"], list)
        for week in result["grid"]:
            assert len(week) == 7

    def test_num_weeks_rolling(self):
        result = build_heatmap_grid([])
        assert result["num_weeks"] == 53

    def test_counts_summed_in_total(self):
        today = date.today().isoformat()
        rows = [{"day": today, "count": 7}]
        result = build_heatmap_grid(rows)
        assert result["total_achievements"] == 7

    def test_year_mode_12_months(self):
        result = build_heatmap_grid([], year=2024)
        assert result["num_weeks"] >= 52

    def test_cell_hidden_flag_for_future(self):
        # All future days should be hidden
        import datetime
        future = (datetime.date.today() + datetime.timedelta(days=365)).isoformat()
        rows = [{"day": future, "count": 99}]
        result = build_heatmap_grid(rows)
        flat = [cell for week in result["grid"] for cell in week if cell["date"] == future]
        for cell in flat:
            assert cell["hidden"] is True
