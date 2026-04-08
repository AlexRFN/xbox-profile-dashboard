#!/usr/bin/env python3
"""Post-deploy smoke test — runs against a live server.

Usage:
    python scripts/smoke_test.py                  # defaults to http://localhost:8000
    python scripts/smoke_test.py https://myhost   # against a remote host

Exits 0 on pass, 1 on any failure. Safe to run in CI after deploy.
"""
import sys
import urllib.error
import urllib.request

BASE_URL = sys.argv[1].rstrip("/") if len(sys.argv) > 1 else "http://localhost:8000"

CHECKS = [
    # (method, path, expected_status, description)
    ("GET",  "/",                    200, "Profile page renders"),
    ("GET",  "/library",             200, "Library page renders"),
    ("GET",  "/timeline",            200, "Timeline page renders"),
    ("GET",  "/achievements",        200, "Achievements page renders"),
    ("GET",  "/captures",            200, "Captures page renders"),
    ("GET",  "/friends",             200, "Friends page renders"),
    ("GET",  "/api/stats",           200, "Stats API responds"),
    ("GET",  "/api/rate-limit",      200, "Rate limit API responds"),
    ("GET",  "/api/sync/status",     200, "Sync status API responds"),
    ("GET",  "/api/games/index",     200, "Games index API responds"),
    ("GET",  "/game/NONEXISTENT",    404, "Unknown game returns 404"),
]

GREEN = "\033[92m"
RED   = "\033[91m"
RESET = "\033[0m"

passed = 0
failed = 0

for method, path, expected, desc in CHECKS:
    url = BASE_URL + path
    try:
        req = urllib.request.Request(url, method=method)
        with urllib.request.urlopen(req, timeout=10) as resp:
            status = resp.status
    except urllib.error.HTTPError as e:
        status = e.code
    except Exception as e:
        print(f"{RED}FAIL{RESET}  {desc}  ({url}) — {e}")
        failed += 1
        continue

    if status == expected:
        print(f"{GREEN}PASS{RESET}  {desc}  ({status})")
        passed += 1
    else:
        print(f"{RED}FAIL{RESET}  {desc}  — expected {expected}, got {status}")
        failed += 1

print(f"\n{passed}/{passed + failed} checks passed", end="")

if failed:
    print(f"  {RED}({failed} failed){RESET}")
    sys.exit(1)
else:
    print(f"  {GREEN}all good{RESET}")
