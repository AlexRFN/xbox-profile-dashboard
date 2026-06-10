"""Tests for sync-time thumb warming — `warm_thumbs` / `missing_warm_widths`
in routers/img.py and the selection logic in sync/profile.py.

CACHE_DIR is monkeypatched to a tmp dir so these tests never touch the real
disk cache and need no cleanup.
"""

from io import BytesIO

import pytest
from PIL import Image, UnidentifiedImageError

from routers import img as img_module
from routers.img import _cache_key, is_proxied_url, missing_warm_widths, warm_thumbs
from sync.profile import _select_games_needing_art

PROXIED_URL = "https://images-eds-ssl.xboxlive.com/image?url=WARM_TEST"
STORE_URL = "https://store-images.s-microsoft.com/image/apps.123"
UNPROXIED_URL = "https://example.com/img.png"
WIDTHS = (96, 320)


def _png_bytes(size=(640, 360)) -> bytes:
    buf = BytesIO()
    Image.new("RGB", size, (0, 128, 255)).save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture
def cache_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(img_module, "CACHE_DIR", tmp_path)
    return tmp_path


def _thumb_path(cache_dir, url, width):
    return cache_dir / f"{_cache_key(url, width)}.webp"


class TestIsProxiedUrl:
    def test_xbox_cdn_hosts_proxied(self):
        assert is_proxied_url(PROXIED_URL)
        assert is_proxied_url(STORE_URL)
        assert is_proxied_url("https://screenshotscontent-t5001.media.xboxlive.com/x/a.png")

    def test_foreign_hosts_and_junk_not_proxied(self):
        assert not is_proxied_url(UNPROXIED_URL)
        assert not is_proxied_url("http://images-eds-ssl.xboxlive.com/insecure")
        assert not is_proxied_url("not a url")


class TestMissingWarmWidths:
    def test_all_missing_when_cache_empty(self, cache_dir):
        assert missing_warm_widths(PROXIED_URL, WIDTHS) == list(WIDTHS)

    def test_partial_when_one_width_cached(self, cache_dir):
        _thumb_path(cache_dir, PROXIED_URL, 96).write_bytes(b"x")
        assert missing_warm_widths(PROXIED_URL, WIDTHS) == [320]

    def test_empty_for_unproxied_host(self, cache_dir):
        assert missing_warm_widths(UNPROXIED_URL, WIDTHS) == []


class TestWarmThumbs:
    def test_writes_all_missing_widths(self, cache_dir):
        written = warm_thumbs(PROXIED_URL, _png_bytes(), WIDTHS)
        assert written == 2
        for w in WIDTHS:
            path = _thumb_path(cache_dir, PROXIED_URL, w)
            assert path.exists()
            img = Image.open(path)
            assert img.format == "WEBP"
            assert img.width <= w

    def test_skips_existing_widths(self, cache_dir):
        _thumb_path(cache_dir, PROXIED_URL, 96).write_bytes(b"existing")
        written = warm_thumbs(PROXIED_URL, _png_bytes(), WIDTHS)
        assert written == 1
        # Pre-existing file untouched.
        assert _thumb_path(cache_dir, PROXIED_URL, 96).read_bytes() == b"existing"

    def test_noop_for_unproxied_host(self, cache_dir):
        assert warm_thumbs(UNPROXIED_URL, _png_bytes(), WIDTHS) == 0
        assert list(cache_dir.iterdir()) == []

    def test_store_images_host_warmable(self, cache_dir):
        assert warm_thumbs(STORE_URL, _png_bytes(), WIDTHS) == 2

    def test_raises_on_corrupt_bytes(self, cache_dir):
        with pytest.raises(UnidentifiedImageError):
            warm_thumbs(PROXIED_URL, b"not an image", WIDTHS)

    def test_idempotent_second_call_writes_nothing(self, cache_dir):
        assert warm_thumbs(PROXIED_URL, _png_bytes(), WIDTHS) == 2
        assert warm_thumbs(PROXIED_URL, _png_bytes(), WIDTHS) == 0


class TestSelectGamesNeedingArt:
    def _warm_all(self, url, monkeypatch_widths):
        warm_thumbs(url, _png_bytes(), monkeypatch_widths)

    def test_fully_warm_game_not_selected(self, cache_dir, monkeypatch):
        monkeypatch.setattr("sync.profile.IMG_WARM_WIDTHS", WIDTHS)
        self._warm_all(PROXIED_URL, WIDTHS)
        games = [{"title_id": "1", "display_image": PROXIED_URL, "blurhash": "LKO2?U%2Tw=w"}]
        assert _select_games_needing_art(games, 50) == []

    def test_missing_blurhash_selected(self, cache_dir, monkeypatch):
        monkeypatch.setattr("sync.profile.IMG_WARM_WIDTHS", WIDTHS)
        self._warm_all(PROXIED_URL, WIDTHS)
        games = [{"title_id": "1", "display_image": PROXIED_URL, "blurhash": None}]
        todo = _select_games_needing_art(games, 50)
        assert len(todo) == 1
        _game, needs_blurhash, needs_thumbs = todo[0]
        assert needs_blurhash and not needs_thumbs

    def test_missing_thumbs_selected(self, cache_dir, monkeypatch):
        monkeypatch.setattr("sync.profile.IMG_WARM_WIDTHS", WIDTHS)
        games = [{"title_id": "1", "display_image": PROXIED_URL, "blurhash": "LKO2?U%2Tw=w"}]
        todo = _select_games_needing_art(games, 50)
        assert len(todo) == 1
        _game, needs_blurhash, needs_thumbs = todo[0]
        assert needs_thumbs and not needs_blurhash

    def test_unproxied_host_only_triggers_on_blurhash(self, cache_dir, monkeypatch):
        monkeypatch.setattr("sync.profile.IMG_WARM_WIDTHS", WIDTHS)
        games = [
            {"title_id": "1", "display_image": UNPROXIED_URL, "blurhash": "LKO2?U%2Tw=w"},
            {"title_id": "2", "display_image": UNPROXIED_URL, "blurhash": None},
        ]
        todo = _select_games_needing_art(games, 50)
        assert [g["title_id"] for g, _, _ in todo] == ["2"]

    def test_max_count_respected(self, cache_dir, monkeypatch):
        monkeypatch.setattr("sync.profile.IMG_WARM_WIDTHS", WIDTHS)
        games = [{"title_id": str(i), "display_image": PROXIED_URL, "blurhash": None} for i in range(10)]
        assert len(_select_games_needing_art(games, 3)) == 3
