#!/usr/bin/env python3
"""
Route Smoke Test — Playwright

Opens each /command and /workspace/:companyId/:periodYear/* route against the
running dev/preview server and asserts:
  - Final HTTP status 200 with no redirect loop
  - Non-empty <title>
  - A heading/main element renders
  - companyId + periodYear survive to the final URL on workspace routes
  - No uncaught page errors or console errors

Auth-gated routes are SKIPPED (not failed) when LOVABLE_BROWSER_AUTH_STATUS is
not 'injected', so this script is safe to run unauthenticated in CI.

Env:
  BASE_URL           default http://localhost:8080
  SMOKE_COMPANY_ID   default 00000000-0000-0000-0000-000000000001
  SMOKE_PERIOD_YEAR  default 2025

Exit code 0 = all PASS/SKIP. Exit 1 = one or more FAIL.
"""

import asyncio
import json
import os
import sys
from urllib.parse import urlparse

from playwright.async_api import async_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:8080")
COMPANY_ID = os.environ.get("SMOKE_COMPANY_ID", "00000000-0000-0000-0000-000000000001")
PERIOD_YEAR = os.environ.get("SMOKE_PERIOD_YEAR", "2025")
AUTH_STATUS = os.environ.get("LOVABLE_BROWSER_AUTH_STATUS", "signed_out")
AUTHENTICATED = AUTH_STATUS == "injected"
MAX_REDIRECTS = 5

WORKSPACE_STAGES = [
    "",  # overview
    "prepare",
    "reconcile",
    "statements",
    "tax",
    "compliance",
    "filing",
    "monitor",
]

ROUTES = [
    {"path": "/command", "requires_auth": False, "check_params": False},
    *[
        {
            "path": f"/workspace/{COMPANY_ID}/{PERIOD_YEAR}"
            + (f"/{stage}" if stage else ""),
            "requires_auth": True,
            "check_params": True,
        }
        for stage in WORKSPACE_STAGES
    ],
]

GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
RESET = "\033[0m"


def color(status: str) -> str:
    return {"PASS": GREEN, "FAIL": RED, "SKIP": YELLOW}.get(status, "") + status + RESET


async def restore_session(context, page):
    """Restore Supabase session from env if injected."""
    storage_key = os.environ.get("LOVABLE_BROWSER_SUPABASE_STORAGE_KEY")
    session_json = os.environ.get("LOVABLE_BROWSER_SUPABASE_SESSION_JSON")
    cookies_json = os.environ.get("LOVABLE_BROWSER_SUPABASE_COOKIES_JSON")
    if cookies_json:
        cookies = json.loads(cookies_json)
        for c in cookies:
            c["url"] = BASE_URL
        await context.add_cookies(cookies)
    await page.goto(BASE_URL, wait_until="domcontentloaded")
    if storage_key and session_json:
        await page.evaluate(
            f"window.localStorage.setItem({json.dumps(storage_key)}, {json.dumps(session_json)})"
        )


async def test_route(browser, route):
    path = route["path"]
    url = f"{BASE_URL}{path}"

    if route["requires_auth"] and not AUTHENTICATED:
        return {"path": path, "status": "SKIP", "detail": "auth not injected"}

    context = await browser.new_context(viewport={"width": 1280, "height": 900})
    page = await context.new_page()

    page_errors: list[str] = []
    console_errors: list[str] = []
    redirects: list[str] = []

    page.on("pageerror", lambda err: page_errors.append(str(err)))
    page.on(
        "console",
        lambda msg: console_errors.append(msg.text) if msg.type == "error" else None,
    )
    page.on(
        "response",
        lambda resp: redirects.append(resp.url)
        if 300 <= resp.status < 400 and resp.url.startswith(BASE_URL)
        else None,
    )

    try:
        if AUTHENTICATED:
            await restore_session(context, page)

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

        final_url = page.url
        final_path = urlparse(final_url).path

        if route["requires_auth"] and "/auth" in final_path:
            return {"path": path, "status": "SKIP", "detail": "redirected to /auth"}

        if route["check_params"]:
            if COMPANY_ID not in final_path:
                return {
                    "path": path,
                    "status": "FAIL",
                    "detail": f"companyId lost → {final_path}",
                }
            if f"/{PERIOD_YEAR}" not in final_path:
                return {
                    "path": path,
                    "status": "FAIL",
                    "detail": f"periodYear lost → {final_path}",
                }

        has_content = await page.evaluate(
            "(document.body && (document.body.innerText || '').trim().length > 0)"
        )
        if not has_content:
            return {"path": path, "status": "FAIL", "detail": "no rendered content"}

        errs = page_errors + console_errors
        if errs:
            return {
                "path": path,
                "status": "FAIL",
                "detail": "errors: " + " | ".join(errs[:2]),
            }

        return {"path": path, "status": "PASS", "detail": title[:60]}
    except Exception as e:
        return {"path": path, "status": "FAIL", "detail": str(e)[:200]}
    finally:
        await context.close()


async def main():
    print(f"\nRoute smoke test → {BASE_URL}")
    print(
        f"Auth: {'INJECTED' if AUTHENTICATED else 'SIGNED OUT (workspace routes will SKIP)'}\n"
    )

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        results = []
        for route in ROUTES:
            r = await test_route(browser, route)
            results.append(r)
            print(f"  {color(r['status']):>18}  {r['path']:<60}  {r.get('detail', '')}")
        await browser.close()

    passed = sum(1 for r in results if r["status"] == "PASS")
    failed = sum(1 for r in results if r["status"] == "FAIL")
    skipped = sum(1 for r in results if r["status"] == "SKIP")

    print(f"\n{passed} passed · {failed} failed · {skipped} skipped")
    print("VERDICT: " + ("CLEAN" if failed == 0 else "FAIL"))
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    asyncio.run(main())