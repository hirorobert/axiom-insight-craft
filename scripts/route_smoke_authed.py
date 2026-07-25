#!/usr/bin/env python3
"""
Authenticated Route Smoke Test — Playwright

Signed-in variant of scripts/route_smoke.py. Opens /command and every
/workspace/:companyId/:periodYear/<stage> route as an authenticated user
and asserts:

  - Final HTTP status 200 with no redirect loop (>5 same-origin 3xx hops)
  - Non-empty <title>
  - Rendered body content
  - Final URL is NOT /auth (i.e. session survived the guard)
  - companyId AND periodYear survive to the final URL on workspace routes
  - No uncaught page errors or console errors

Auth sources, in priority order:
  1. LOVABLE_BROWSER_AUTH_STATUS=injected  → restore Supabase session from
     LOVABLE_BROWSER_SUPABASE_* env vars (cookies + localStorage).
  2. TEST_USER + TEST_PASS                 → sign in through /auth using the
     email/password form, then reuse the resulting session for all routes.

If neither is available the script exits with code 2 (blocked, not failed) so
CI can distinguish "no credentials" from "real regression".

Env:
  BASE_URL           default http://localhost:8080
  SMOKE_COMPANY_ID   default 00000000-0000-0000-0000-000000000001
  SMOKE_PERIOD_YEAR  default 2025
  TEST_USER          optional email for password sign-in fallback
  TEST_PASS          optional password for password sign-in fallback
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
INJECTED = AUTH_STATUS == "injected"
TEST_USER = os.environ.get("TEST_USER")
TEST_PASS = os.environ.get("TEST_PASS")
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
    {"path": "/command", "check_params": False},
    *[
        {
            "path": f"/workspace/{COMPANY_ID}/{PERIOD_YEAR}"
            + (f"/{stage}" if stage else ""),
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


async def restore_injected_session(context, page) -> bool:
    storage_key = os.environ.get("LOVABLE_BROWSER_SUPABASE_STORAGE_KEY")
    session_json = os.environ.get("LOVABLE_BROWSER_SUPABASE_SESSION_JSON")
    cookies_json = os.environ.get("LOVABLE_BROWSER_SUPABASE_COOKIES_JSON")
    if not (storage_key and session_json):
        return False
    if cookies_json:
        cookies = json.loads(cookies_json)
        for c in cookies:
            c["url"] = BASE_URL
        await context.add_cookies(cookies)
    await page.goto(BASE_URL, wait_until="domcontentloaded")
    await page.evaluate(
        f"window.localStorage.setItem({json.dumps(storage_key)}, {json.dumps(session_json)})"
    )
    return True


async def sign_in_with_password(page) -> bool:
    """Sign in through /auth using the email/password form. Returns True on success."""
    if not (TEST_USER and TEST_PASS):
        return False
    await page.goto(f"{BASE_URL}/auth", wait_until="domcontentloaded")
    try:
        await page.get_by_label("Email", exact=False).first.fill(TEST_USER)
        await page.get_by_label("Password", exact=False).first.fill(TEST_PASS)
        # Click the primary submit — accept several likely labels.
        for label in ("Sign in", "Sign In", "Log in", "Login"):
            btn = page.get_by_role("button", name=label)
            if await btn.count() > 0:
                await btn.first.click()
                break
        else:
            await page.locator("button[type=submit]").first.click()
        # Wait for the auth guard to release: URL leaves /auth.
        await page.wait_for_url(lambda u: "/auth" not in urlparse(u).path, timeout=15000)
        return True
    except Exception as e:
        print(f"  sign-in error: {e}", file=sys.stderr)
        return False


async def establish_session(context, page) -> str:
    """Return one of: 'injected', 'password', 'none'."""
    if INJECTED and await restore_injected_session(context, page):
        return "injected"
    if await sign_in_with_password(page):
        return "password"
    return "none"


async def test_route(context, route):
    path = route["path"]
    url = f"{BASE_URL}{path}"
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
        if "/auth" in final_path:
            return {"path": path, "status": "FAIL", "detail": f"kicked to /auth → session lost"}

        if route["check_params"]:
            if COMPANY_ID not in final_path:
                return {"path": path, "status": "FAIL", "detail": f"companyId lost → {final_path}"}
            if f"/{PERIOD_YEAR}" not in final_path:
                return {"path": path, "status": "FAIL", "detail": f"periodYear lost → {final_path}"}

        has_content = await page.evaluate(
            "(document.body && (document.body.innerText || '').trim().length > 0)"
        )
        if not has_content:
            return {"path": path, "status": "FAIL", "detail": "no rendered content"}

        errs = page_errors + console_errors
        if errs:
            return {"path": path, "status": "FAIL", "detail": "errors: " + " | ".join(errs[:2])}

        return {"path": path, "status": "PASS", "detail": title[:60]}
    except Exception as e:
        return {"path": path, "status": "FAIL", "detail": str(e)[:200]}
    finally:
        await page.close()


async def main():
    print(f"\nAuthenticated route smoke → {BASE_URL}")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1280, "height": 900})
        page = await context.new_page()

        mode = await establish_session(context, page)
        await page.close()

        if mode == "none":
            print(
                f"{color('SKIP'):>18}  no session available "
                f"(LOVABLE_BROWSER_AUTH_STATUS={AUTH_STATUS}, TEST_USER {'set' if TEST_USER else 'unset'})",
                file=sys.stderr,
            )
            print("\nVERDICT: BLOCKED (no auth) — provide TEST_USER/TEST_PASS or run in an injected session.")
            await browser.close()
            sys.exit(2)

        print(f"Auth: {mode.upper()}\n")

        results = []
        for route in ROUTES:
            r = await test_route(context, route)
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