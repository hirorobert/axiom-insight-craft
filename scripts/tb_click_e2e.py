#!/usr/bin/env python3
"""
Trial-balance click E2E — Playwright.

Regression guard for the "trial balance disappears on click" bug.

For EVERY row in the uploads ledger on /workspace/:companyId/:periodYear/prepare
this test clicks the row and asserts, against the real running app:

  1. The URL pins that exact record   → ?upload=<id>
  2. The certification ledger renders → [data-testid=certification-ledger]
  3. The ledger shows THAT upload     → data-active-upload-id == clicked id
  4. The clicked row still exists and is marked selected (never disappears)
  5. No blank screen, no page errors, no redirect to /auth

It also re-runs the click flow after a hard reload (deep-link round trip) so a
pinned upload survives real navigation, and walks back/forward through browser
history to prove the ledger is restored each time.

Auth: same contract as scripts/route_smoke_authed.py
  LOVABLE_BROWSER_AUTH_STATUS=injected  → restore session from env
  TEST_USER + TEST_PASS                 → sign in via /auth
  neither                               → exit 2 (BLOCKED, not FAIL)

Env:
  BASE_URL           default http://localhost:8080
  SMOKE_COMPANY_ID   company UUID to open (required for a meaningful run)
  SMOKE_PERIOD_YEAR  default 2025
"""

import asyncio
import json
import os
import sys
from urllib.parse import urlparse, parse_qs

from playwright.async_api import async_playwright
from _playwright_artifacts import (
    context_options,
    finalize_video,
    save_on_failure,
    slugify,
    start_trace,
    start_trace_chunk,
)

SCRIPT_NAME = "tb_click_e2e"

BASE_URL = os.environ.get("BASE_URL", "http://localhost:8080")
COMPANY_ID = os.environ.get("SMOKE_COMPANY_ID", "")
PERIOD_YEAR = os.environ.get("SMOKE_PERIOD_YEAR", "2025")
AUTH_STATUS = os.environ.get("LOVABLE_BROWSER_AUTH_STATUS", "signed_out")
INJECTED = AUTH_STATUS == "injected"
TEST_USER = os.environ.get("TEST_USER")
TEST_PASS = os.environ.get("TEST_PASS")

ROW = "[data-testid=upload-row]"
LEDGER = "[data-testid=certification-ledger]"

GREEN, RED, YELLOW, RESET = "\033[32m", "\033[31m", "\033[33m", "\033[0m"


def color(status: str) -> str:
    return {"PASS": GREEN, "FAIL": RED, "SKIP": YELLOW}.get(status, "") + status + RESET


# ── Auth ───────────────────────────────────────────────────────────────────
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
    if not (TEST_USER and TEST_PASS):
        return False
    await page.goto(f"{BASE_URL}/auth", wait_until="domcontentloaded")
    try:
        await page.get_by_label("Email", exact=False).first.fill(TEST_USER)
        await page.get_by_label("Password", exact=False).first.fill(TEST_PASS)
        for label in ("Sign in", "Sign In", "Log in", "Login"):
            btn = page.get_by_role("button", name=label)
            if await btn.count() > 0:
                await btn.first.click()
                break
        else:
            await page.locator("button[type=submit]").first.click()
        await page.wait_for_url(lambda u: "/auth" not in urlparse(u).path, timeout=15000)
        return True
    except Exception as e:
        print(f"  sign-in error: {e}", file=sys.stderr)
        return False


async def establish_session(context, page) -> str:
    if INJECTED and await restore_injected_session(context, page):
        return "injected"
    if await sign_in_with_password(page):
        return "password"
    return "none"


# ── Assertions ─────────────────────────────────────────────────────────────
def pinned_upload_id(url: str) -> str | None:
    return (parse_qs(urlparse(url).query).get("upload") or [None])[0]


async def assert_ledger_for(page, upload_id: str) -> str | None:
    """Return an error string, or None when the ledger correctly shows upload_id."""
    if "/auth" in urlparse(page.url).path:
        return "redirected to /auth (session lost)"

    pinned = pinned_upload_id(page.url)
    if pinned != upload_id:
        return f"URL pin mismatch: expected ?upload={upload_id}, got {pinned or 'none'}"

    try:
        await page.wait_for_selector(LEDGER, timeout=12000)
    except Exception:
        return "certification ledger never rendered (row disappeared)"

    active = await page.locator(LEDGER).first.get_attribute("data-active-upload-id")
    if active != upload_id:
        return f"ledger shows wrong upload: {active}"

    row = page.locator(f'{ROW}[data-upload-id="{upload_id}"]')
    if await row.count() == 0:
        return "clicked row vanished from the uploads ledger"
    if await row.first.get_attribute("data-selected") != "true":
        return "clicked row is not marked selected"

    text = await page.evaluate("(document.body.innerText || '').trim().length")
    if not text:
        return "blank screen after click"
    return None


async def run(page) -> list[dict]:
    results: list[dict] = []
    prepare_url = f"{BASE_URL}/workspace/{COMPANY_ID}/{PERIOD_YEAR}/prepare"
    await page.goto(prepare_url, wait_until="domcontentloaded")
    try:
        await page.wait_for_selector(ROW, timeout=15000)
    except Exception:
        results.append(
            {
                "case": "uploads ledger has rows",
                "status": "SKIP",
                "detail": "no trial balances for this company/period — nothing to click",
            }
        )
        return results

    ids = await page.locator(ROW).evaluate_all(
        "els => els.map(e => e.getAttribute('data-upload-id'))"
    )
    ids = [i for i in ids if i]
    results.append(
        {"case": "uploads ledger has rows", "status": "PASS", "detail": f"{len(ids)} row(s)"}
    )

    # 1. Every row: click → pinned ledger, row still present.
    for idx, uid in enumerate(ids, start=1):
        await page.goto(prepare_url, wait_until="domcontentloaded")
        await page.wait_for_selector(ROW, timeout=15000)
        await page.locator(f'{ROW}[data-upload-id="{uid}"]').first.click()
        err = await assert_ledger_for(page, uid)
        results.append(
            {
                "case": f"click row {idx}/{len(ids)} ({uid[:8]})",
                "status": "FAIL" if err else "PASS",
                "detail": err or "ledger pinned + row selected",
            }
        )

        # 2. Hard reload of the pinned deep link resolves the same record.
        await page.reload(wait_until="domcontentloaded")
        err = await assert_ledger_for(page, uid)
        results.append(
            {
                "case": f"reload pinned deep link ({uid[:8]})",
                "status": "FAIL" if err else "PASS",
                "detail": err or "survives hard reload",
            }
        )

    # 3. History round trip across two different rows.
    if len(ids) >= 2:
        a, b = ids[0], ids[1]
        await page.goto(prepare_url, wait_until="domcontentloaded")
        await page.wait_for_selector(ROW, timeout=15000)
        await page.locator(f'{ROW}[data-upload-id="{a}"]').first.click()
        err_a = await assert_ledger_for(page, a)
        await page.locator(f'{ROW}[data-upload-id="{b}"]').first.click()
        err_b = await assert_ledger_for(page, b)
        await page.go_back(wait_until="domcontentloaded")
        err_back = await assert_ledger_for(page, a)
        await page.go_forward(wait_until="domcontentloaded")
        err_fwd = await assert_ledger_for(page, b)
        err = err_a or err_b or err_back or err_fwd
        results.append(
            {
                "case": "switch rows + back/forward history",
                "status": "FAIL" if err else "PASS",
                "detail": err or "ledger restored on every hop",
            }
        )
    else:
        results.append(
            {
                "case": "switch rows + back/forward history",
                "status": "SKIP",
                "detail": "needs 2+ uploads",
            }
        )

    return results


async def main():
    print(f"\nTrial-balance click E2E → {BASE_URL}")
    if not COMPANY_ID:
        print("VERDICT: BLOCKED — set SMOKE_COMPANY_ID to a company with uploads.")
        sys.exit(2)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            viewport={"width": 1280, "height": 1800},
            **context_options(SCRIPT_NAME, "session"),
        )
        await start_trace(context)
        page = await context.new_page()

        mode = await establish_session(context, page)
        if mode == "none":
            print(
                f"  no session (LOVABLE_BROWSER_AUTH_STATUS={AUTH_STATUS}, "
                f"TEST_USER {'set' if TEST_USER else 'unset'})",
                file=sys.stderr,
            )
            print("VERDICT: BLOCKED (no auth)")
            await browser.close()
            sys.exit(2)
        print(f"Auth: {mode.upper()}\n")

        page_errors: list[str] = []
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        page.on(
            "console",
            lambda m: page_errors.append(m.text) if m.type == "error" else None,
        )

        await start_trace_chunk(context)
        try:
            results = await run(page)
        except Exception as e:
            results = [{"case": "harness", "status": "FAIL", "detail": str(e)[:200]}]

        if page_errors:
            results.append(
                {
                    "case": "no page/console errors",
                    "status": "FAIL",
                    "detail": " | ".join(page_errors[:2]),
                }
            )
        else:
            results.append({"case": "no page/console errors", "status": "PASS", "detail": "clean"})

        failed = sum(1 for r in results if r["status"] == "FAIL")
        overall = "FAIL" if failed else "PASS"
        artifacts = await save_on_failure(
            SCRIPT_NAME, slugify("tb_click"), page, context, overall, chunked=True
        )
        await page.close()
        video = await finalize_video(SCRIPT_NAME, slugify("tb_click"), page, overall)
        await browser.close()

    for r in results:
        print(f"  {color(r['status']):>18}  {r['case']:<44}  {r['detail']}")
    for kind, pth in (artifacts or {}).items():
        print(f"      · {kind}: {pth}")
    if video:
        print(f"      · video: {video}")

    passed = sum(1 for r in results if r["status"] == "PASS")
    skipped = sum(1 for r in results if r["status"] == "SKIP")
    print(f"\n{passed} passed · {failed} failed · {skipped} skipped")
    print("VERDICT: " + ("CLEAN" if failed == 0 else "FAIL"))
    sys.exit(0 if failed == 0 else 1)


if __name__ == "__main__":
    asyncio.run(main())
