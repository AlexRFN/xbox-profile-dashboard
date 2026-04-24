import asyncio
import logging
import mimetypes
import os
from contextlib import asynccontextmanager
from pathlib import Path

import sentry_sdk
from brotli_asgi import BrotliMiddleware
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, ORJSONResponse
from fastapi.staticfiles import StaticFiles
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.logging import LoggingIntegration
from starlette.datastructures import Headers
from starlette.responses import Response
from starlette.staticfiles import NotModifiedResponse

import database as db
import xbox_api
from helpers import build_css_bundle, build_js_bundle, register_filters, templates
from logging_config import configure_logging
from models import ApiError
from xbox_api import API_KEY, close_client, init_client

configure_logging()
log = logging.getLogger("xbox.app")

_SENTRY_DSN = os.getenv("SENTRY_DSN")
if _SENTRY_DSN:
    sentry_sdk.init(
        dsn=_SENTRY_DSN,
        integrations=[
            FastApiIntegration(),
            LoggingIntegration(level=logging.INFO, event_level=logging.ERROR),
        ],
        traces_sample_rate=0.05,
        send_default_pii=False,
    )
    log.info("Sentry enabled")
BASE_DIR = Path(__file__).parent


def _startup_check() -> None:
    """Validate essential configuration. Logs warnings/errors; raises only on fatal issues."""
    if not API_KEY:
        log.warning("OPENXBL_API_KEY not set in .env — API calls will fail until configured")

    db_dir = BASE_DIR / "data"
    if not db_dir.exists():
        try:
            db_dir.mkdir(parents=True)
            log.info("Created data directory: %s", db_dir)
        except OSError as e:
            log.critical("Cannot create data directory %s: %s", db_dir, e)
            raise RuntimeError(f"Cannot create data dir: {e}") from e
    else:
        probe = db_dir / ".write_probe"
        try:
            probe.write_text("ok")
            probe.unlink()
        except OSError as e:
            log.critical("Data directory is not writable: %s", e)
            raise RuntimeError(f"Data dir not writable: {e}") from e

    log.info("Startup checks passed")


def _start_asset_watcher():
    """In dev mode (uvicorn --reload), watch CSS/JS source files and rebuild bundles on change."""
    if not os.environ.get("XBOX_DEV"):
        return None
    css_dir = BASE_DIR / "static" / "css"
    js_src_dir = BASE_DIR / "static" / "js" / "src"

    def _get_mtimes():
        css = {p: p.stat().st_mtime for p in css_dir.rglob("*.css") if p.name != "bundle.css"}
        js = {p: p.stat().st_mtime for p in js_src_dir.rglob("*.js")} if js_src_dir.exists() else {}
        return {**css, **js}

    _last_mtimes = _get_mtimes()

    async def _poll():
        nonlocal _last_mtimes
        while True:
            await asyncio.sleep(2)
            try:
                current = _get_mtimes()
                if current != _last_mtimes:
                    changed = {p for p in current if current[p] != _last_mtimes.get(p)}
                    _last_mtimes = current
                    if any(str(p).endswith(".css") for p in changed):
                        build_css_bundle()
                        log.info("CSS bundle auto-rebuilt")
                    if any(str(p).endswith(".js") for p in changed):
                        build_js_bundle()
                        log.info("JS bundle auto-rebuilt")
            except Exception:
                log.warning("Asset bundle auto-rebuild failed", exc_info=True)

    return asyncio.create_task(_poll())


@asynccontextmanager
async def lifespan(app: FastAPI):
    from scheduler import register_jobs, scheduler

    log.info("Starting Xbox Profile Dashboard")
    _startup_check()
    build_css_bundle()
    build_js_bundle()
    _css_watcher = _start_asset_watcher()
    await db.init_db()
    init_client()
    if API_KEY and (not xbox_api.XUID or not xbox_api.GAMERTAG):
        try:
            await xbox_api.resolve_identity()
        except Exception as e:
            log.warning("Could not auto-resolve identity from /account: %s", e)
            if not xbox_api.XUID:
                log.warning("XBOX_XUID not set — add it to .env to skip auto-resolve")
    register_jobs()
    scheduler.start()
    log.info("Scheduler started with %d jobs", len(scheduler.get_jobs()))
    yield
    if _css_watcher:
        _css_watcher.cancel()
    scheduler.shutdown(wait=False)
    await close_client()
    await db.close_connection()
    log.info("Shutting down")


_CSP = (
    "default-src 'self'; "
    "img-src 'self' https://*.xboxlive.com https://store-images.s-microsoft.com data:; "
    "style-src 'self' 'unsafe-inline'; "
    "script-src 'self' 'unsafe-inline'; "
    "connect-src 'self'; "
    "worker-src 'self' blob:; "
    "font-src 'self'"
)

class PrecompressedStaticFiles(StaticFiles):
    """Serve a pre-generated `<path>.br` companion when the client advertises
    `Accept-Encoding: br`, otherwise fall back to the uncompressed file.

    BrotliMiddleware already skips responses whose headers carry a
    Content-Encoding, so the `.br` body flows through untouched and we save
    the per-request Brotli CPU on the two largest static assets
    (bundle.css + app.js). The companions are produced at startup by
    helpers._build_bundle at quality 11.
    """

    def file_response(self, full_path, stat_result, scope, status_code=200):
        request_headers = Headers(scope=scope)
        if "br" in request_headers.get("accept-encoding", "").lower():
            br_path = f"{full_path}.br"
            try:
                br_stat = os.stat(br_path)
            except OSError:
                br_stat = None
            if br_stat is not None:
                content_type, _ = mimetypes.guess_type(str(full_path))
                response = FileResponse(
                    br_path,
                    status_code=status_code,
                    stat_result=br_stat,
                    media_type=content_type,
                )
                response.headers["Content-Encoding"] = "br"
                response.headers["Vary"] = "Accept-Encoding"
                if self.is_not_modified(response.headers, request_headers):
                    return NotModifiedResponse(response.headers)
                return response
        return super().file_response(full_path, stat_result, scope, status_code)


app = FastAPI(lifespan=lifespan, default_response_class=ORJSONResponse)
app.add_middleware(BrotliMiddleware, minimum_size=500)  # skip tiny responses where header overhead > savings
app.mount("/static", PrecompressedStaticFiles(directory=str(BASE_DIR / "static")), name="static")
register_filters()


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    log.error("Unhandled exception on %s %s: %s", request.method, request.url.path, exc, exc_info=True)
    if request.url.path.startswith("/api/"):
        return JSONResponse(ApiError(error="Internal server error").model_dump(), status_code=500)
    try:
        return templates.TemplateResponse(
            "error.html", {"request": request, "error": "Something went wrong."}, status_code=500
        )
    except Exception:
        return Response("Internal server error", status_code=500, media_type="text/plain")


@app.middleware("http")
async def security_and_cache_headers(request: Request, call_next):
    response: Response = await call_next(request)
    # Security headers
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Content-Security-Policy"] = _CSP
    # Tell caches that HTML responses vary by htmx headers (full page vs SPA partial).
    # no-store prevents the browser HTTP cache from serving stale HTML on htmx hx-get
    # cross-page nav after a sync — pages re-render from DB on every request.
    if "text/html" in response.headers.get("content-type", ""):
        response.headers.setdefault("Vary", "HX-Request, HX-Target, HX-History-Restore-Request")
        response.headers.setdefault("Cache-Control", "no-store")
    # Static files with ?v=<hash> are immutable (1 year); without it, revalidate every request.
    # The hash is injected at startup by helpers.static_url(), ensuring cache busting on deploy.
    if request.url.path.startswith("/static/"):
        if request.query_params.get("v"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/sw.js", include_in_schema=False)
async def service_worker():
    # Service workers must be served from the root scope they control.
    # StaticFiles serves from /static/, so we need a dedicated route at /.
    # no-cache ensures the browser always checks for updates.
    return FileResponse(BASE_DIR / "static" / "sw.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})


# Routers imported after app creation to avoid circular import (routers → helpers → app)
from routers import captures, friends, game, library, pages, stats, sync_routes  # noqa: E402

app.include_router(pages.router)
app.include_router(library.router)
app.include_router(game.router)
app.include_router(sync_routes.router)
app.include_router(stats.router)
app.include_router(captures.router)
app.include_router(friends.router)
