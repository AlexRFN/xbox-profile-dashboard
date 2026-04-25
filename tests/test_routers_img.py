"""Tests for the /img proxy router — input validation and disk-cache hits.

A real upstream fetch is too brittle to test inline (network + binary decode),
so the cache-hit path is covered by pre-seeding `data/img_cache/` with a
known file and asserting the route serves it without a network call.
"""
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

from routers.img import _PLACEHOLDER, CACHE_DIR, _cache_key


def _seed_cache(url: str, width: int) -> Path:
    """Write a tiny valid WebP under the expected cache key so the route
    short-circuits and never hits the network."""
    key = _cache_key(url, width)
    out = CACHE_DIR / f"{key}.webp"
    out.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", (4, 4), (255, 0, 0))
    buf = BytesIO()
    img.save(buf, format="WEBP", quality=82)
    out.write_bytes(buf.getvalue())
    return out


@pytest.fixture
def seeded_image():
    url = "https://images-eds-ssl.xboxlive.com/image?url=TEST_FIXTURE"
    width = 96
    path = _seed_cache(url, width)
    yield url, width
    path.unlink(missing_ok=True)


class TestImageProxy:
    def test_serves_cached_webp(self, client, seeded_image):
        url, width = seeded_image
        resp = client.get("/img", params={"u": url, "w": width})
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "image/webp"
        assert "immutable" in resp.headers["cache-control"]
        assert len(resp.content) > 0

    def test_rejects_disallowed_host(self, client):
        resp = client.get("/img", params={
            "u": "https://evil.example.com/x.png",
            "w": 96,
        })
        assert resp.status_code == 400

    def test_rejects_http_scheme(self, client):
        resp = client.get("/img", params={
            "u": "http://images-eds-ssl.xboxlive.com/image?url=A",
            "w": 96,
        })
        assert resp.status_code == 400

    def test_rejects_oversize_width(self, client):
        resp = client.get("/img", params={
            "u": "https://images-eds-ssl.xboxlive.com/image?url=A",
            "w": 9999,
        })
        assert resp.status_code == 400

    def test_rejects_undersize_width(self, client):
        resp = client.get("/img", params={
            "u": "https://images-eds-ssl.xboxlive.com/image?url=A",
            "w": 1,
        })
        assert resp.status_code == 400

    def test_userinfo_host_evasion_blocked(self, client):
        # urlparse extracts hostname `images-eds-ssl.xboxlive.com` even with
        # userinfo prefixed, which IS allowed. With no seeded cache the upstream
        # fetch path runs; on failure the proxy now returns the inline
        # placeholder (status 200, image/webp) rather than a 302 redirect that
        # would re-route through CSP `connect-src` for service-worker callers.
        resp = client.get("/img", params={
            "u": "https://evil.example.com@images-eds-ssl.xboxlive.com/x",
            "w": 96,
        })
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "image/webp"

    def test_placeholder_served_on_upstream_failure(self, client, monkeypatch):
        """When upstream returns non-200, we serve the inline placeholder so
        the browser never sees a redirect to xboxlive.com (which would be
        blocked by CSP `connect-src` when initiated by the service worker)."""
        from unittest.mock import AsyncMock, MagicMock

        from routers import img as img_module

        mock_resp = MagicMock()
        mock_resp.status_code = 400
        mock_client = MagicMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        monkeypatch.setattr(img_module, "_get_client", AsyncMock(return_value=mock_client))
        # Isolate this test's negative-cache writes from other tests.
        monkeypatch.setattr(img_module, "_negative_cache", {})

        resp = client.get("/img", params={
            "u": "https://images-eds-ssl.xboxlive.com/image?url=NEVER_SEEN_BEFORE",
            "w": 96,
        })
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "image/webp"
        assert resp.content == _PLACEHOLDER
        # Short cache so we retry upstream when it heals — never `immutable`.
        assert "immutable" not in resp.headers.get("cache-control", "")
        assert "max-age=3600" in resp.headers["cache-control"]

    def test_negative_cache_skips_repeat_upstream_calls(self, client, monkeypatch, caplog):
        """A second hit on a known-broken URL must NOT refetch upstream and
        must NOT re-log — otherwise the broken Xbox gamerpic spams the log
        every time a user visits the friends page."""
        import logging
        from unittest.mock import AsyncMock, MagicMock

        from routers import img as img_module

        mock_resp = MagicMock()
        mock_resp.status_code = 400
        mock_client = MagicMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        monkeypatch.setattr(img_module, "_get_client", AsyncMock(return_value=mock_client))
        monkeypatch.setattr(img_module, "_negative_cache", {})

        params = {
            "u": "https://images-eds-ssl.xboxlive.com/image?url=BROKEN_GAMERPIC",
            "w": 96,
        }
        with caplog.at_level(logging.WARNING, logger="xbox.img"):
            r1 = client.get("/img", params=params)
            r2 = client.get("/img", params=params)
            r3 = client.get("/img", params=params)

        assert r1.status_code == r2.status_code == r3.status_code == 200
        assert r1.content == r2.content == r3.content == _PLACEHOLDER
        # Only ONE upstream call across three requests.
        assert mock_client.get.await_count == 1
        # Only ONE warning logged across three requests.
        warns = [rec for rec in caplog.records if rec.name == "xbox.img"]
        assert len(warns) == 1
        assert "caching as broken" in warns[0].getMessage()

    def test_screenshot_thumb_host_allowed(self, client):
        # Pre-seed cache so we don't hit the network in tests.
        url = "https://screenshotscontent-t5001.media.xboxlive.com/x/abc_Thumbnail.PNG"
        width = 754
        path = _seed_cache(url, width)
        try:
            resp = client.get("/img", params={"u": url, "w": width})
            assert resp.status_code == 200
            assert resp.headers["content-type"] == "image/webp"
        finally:
            path.unlink(missing_ok=True)
