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
    {"path": "/uploads/status", "final_contains": "/auth", "body": "Sign"},
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

    context = await browser.new_context(viewport={"width": 1280, "height": 900})
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

    try:
        resp = await page.goto(url, wait_until="domcontentloaded", timeout=15000)
        if resp is None:
            return {"path": path, "status": "FAIL", "detail": "no response"}
        if resp.status != 200:
            return {"path": path, "status": "FAIL", "detail": f"HTTP {resp.status}"}
        if len(redirects) > MAX_REDIRECTS:
            return {
                "path": path,
                "status": "FAIL",
                "detail": f"redirect loop ({len(redirects)})",
            }

        try:
            await page.wait_for_load_state("networkidle", timeout=6000)
        except Exception:
            pass

        title = (await page.title()).strip()
        if not title:
            return {"path": path, "status": "FAIL", "detail": "empty <title>"}

        final_path = urlparse(page.url).path
        if route["final_contains"] not in final_path:
            return {
                "path": path,
                "status": "FAIL",
                "detail": f"unexpected final path {final_path}",
            }

        if route.get("body"):
            body_text = await page.evaluate(
                "(document.body && document.body.innerText) || ''"
            )
            if route["body"] not in body_text:
                return {
                    "path": path,
                    "status": "FAIL",
                    "detail": f"expected body substring {route['body']!r} not found",
                }

        if page_errors:
            return {
                "path": path,
                "status": "FAIL",
                "detail": "pageerror: " + " | ".join(page_errors[:2]),
            }

        return {"path": path, "status": "PASS", "detail": title[:60]}
    except Exception as e:
        return {"path": path, "status": "FAIL", "detail": str(e)[:200]}
    finally:
        await context.close()


async def main():
    print(f"\nAuth smoke test → {BASE_URL}\n")
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        results = []
        for route in ROUTES:
            r = await test_route(browser, route)
            results.append(r)
            print(f"  {color(r['status']):>18}  {r['path']:<32}  {r.get('detail', '')}")
        await browser.close()

    passed = sum(1 for r in results if r["status"] == "PASS")
    failed = sum(1 for r in results if r["status"] == "FAIL")
    print(f"\n{passed} passed · {failed} failed")
    print("VERDICT: " + ("CLEAN" if failed == 0 else "FAIL"))
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    asyncio.run(main())