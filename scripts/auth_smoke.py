#!/usr/bin/env python3
"""
Auth Route Smoke Test — Playwright

Verifies the /auth surface and sign-in related paths:
  - Final HTTP 200 with no redirect loop
  - Non-empty <title>
  - Sign-in form heading / expected content renders
  - Query-mode variants (?mode=signup, ?mode=forgot) do not loop
  - Protected routes redirect to /auth when signed out (single hop, no loop)
  - No uncaught page errors

Env:
  BASE_URL   default http://localhost:8080

Exit 0 = all PASS. Exit 1 = one or more FAIL.
"""

import asyncio
import os
import sys
from urllib.parse import urlparse

from playwright.async_api import async_playwright
from _playwright_artifacts import (
    context_options,
    finalize_video,
    save_on_failure,
    slugify,
    start_trace,
)

SCRIPT_NAME = "auth_smoke"

BASE_URL = os.environ.get("BASE_URL", "http://localhost:8080")
MAX_REDIRECTS = 3

# (path, expected_final_path_contains, expected_body_substring)
ROUTES = [
    {"path": "/auth", "final_contains": "/auth", "body": "Sign"},
    {"path": "/auth?mode=signup", "final_contains": "/auth", "body": "Sign"},
    {"path": "/auth?mode=forgot", "final_contains": "/auth", "body": None},
    {"path": "/auth?mode=reset", "final_contains": "/auth", "body": None},
    # Protected routes should bounce to /auth (one hop, no loop) when signed out.
    {"path": "/settings", "final_contains": "/auth", "body": "Sign"},
    # /uploads/status renders its own auth gate rather than redirecting;
    # assert no loop and a real title, not a specific final path.
    {"path": "/uploads/status", "final_contains": "/uploads/status", "body": None},
]

GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
RESET = "\033[0m"


def color(status: str) -> str:
    c = {"PASS": GREEN, "FAIL": RED, "SKIP": YELLOW}.get(status, "")
    return f"{c}{status}{RESET}"


async def test_route(browser, route):
    path = route["path"]
    url = f"{BASE_URL}{path}"
    slug = slugify(path)

    context = await browser.new_context(
        viewport={"width": 1280, "height": 900},
        **context_options(SCRIPT_NAME, slug),
    )
    await start_trace(context)
    page = await context.new_page()

    page_errors: list[str] = []
    redirects: list[str] = []

    page.on("pageerror", lambda err: page_errors.append(str(err)))
    page.on(
        "response",
        lambda resp: redirects.append(resp.url)
        if 300 <= resp.status < 400 and resp.url.startswith(BASE_URL)
        else None,
    )

    result: dict = {}
    try:
        resp = await page.goto(url, wait_until="domcontentloaded", timeout=15000)
        if resp is None:
            result = {"path": path, "status": "FAIL", "detail": "no response"}
            return result
        if resp.status != 200:
            result = {"path": path, "status": "FAIL", "detail": f"HTTP {resp.status}"}
            return result
        if len(redirects) > MAX_REDIRECTS:
            result = {
                "path": path,
                "status": "FAIL",
                "detail": f"redirect loop ({len(redirects)})",
            }
            return result

        try:
            await page.wait_for_load_state("networkidle", timeout=6000)
        except Exception:
            pass

        title = (await page.title()).strip()
        if not title:
            result = {"path": path, "status": "FAIL", "detail": "empty <title>"}
            return result

        final_path = urlparse(page.url).path
        if route["final_contains"] not in final_path:
            result = {
                "path": path,
                "status": "FAIL",
                "detail": f"unexpected final path {final_path}",
            }
            return result

        if route.get("body"):
            body_text = await page.evaluate(
                "(document.body && document.body.innerText) || ''"
            )
            if route["body"] not in body_text:
                result = {
                    "path": path,
                    "status": "FAIL",
                    "detail": f"expected body substring {route['body']!r} not found",
                }
                return result

        if page_errors:
            result = {
                "path": path,
                "status": "FAIL",
                "detail": "pageerror: " + " | ".join(page_errors[:2]),
            }
            return result

        result = {"path": path, "status": "PASS", "detail": title[:60]}
        return result
    except Exception as e:
        result = {"path": path, "status": "FAIL", "detail": str(e)[:200]}
        return result
    finally:
        status = result.get("status", "FAIL")
        artifacts = await save_on_failure(SCRIPT_NAME, slug, page, context, status)
        await context.close()
        video_path = await finalize_video(SCRIPT_NAME, slug, page, status)
        if video_path:
            artifacts["video"] = video_path
        if artifacts and status == "FAIL":
            result["artifacts"] = artifacts


async def main():
    print(f"\nAuth smoke test → {BASE_URL}\n")
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        results = []
        for route in ROUTES:
            r = await test_route(browser, route)
            results.append(r)
            print(f"  {color(r['status']):>18}  {r['path']:<32}  {r.get('detail', '')}")
            for kind, p in (r.get("artifacts") or {}).items():
                print(f"      · {kind}: {p}")
        await browser.close()

    passed = sum(1 for r in results if r["status"] == "PASS")
    failed = sum(1 for r in results if r["status"] == "FAIL")
    print(f"\n{passed} passed · {failed} failed")
    print("VERDICT: " + ("CLEAN" if failed == 0 else "FAIL"))
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    asyncio.run(main())