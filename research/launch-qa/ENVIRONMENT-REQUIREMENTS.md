# Launch-acceptance QA — minimum environment requirements (precise)

To execute the 9 journeys (not unit/contract coverage — those do **not** count as journey execution). A frontend preview URL
**alone is insufficient**: the items below are each required, and the backend-isolation checks are mandatory.

## 1. Candidate (from NORMAL)
- The exact **candidate commit** to test.
- Confirmation of which areas are **known-in-repair** (recorded as NORMAL-owned, not filed as new defects).

## 2. Frontend preview — necessary but NOT sufficient
A reachable preview URL is only step one. Before any test user signs in, confirm **all** of:
- **Isolated backend.** The preview's Supabase project ref is **NOT** the production ref `bvyivmmfjejbmqoydezk` (the harness
  refuses it). It must be a **disposable/staging** project with its **own** database, storage and auth — not production, not
  shared with production.
- **Test users cannot reach production.** Synthetic accounts exist only on the isolated backend; no shared session, no
  production data, no cross-project auth. A seeded **synthetic-login method** (pre-seeded users or a signup path on the
  isolated backend) is provided.
- **Payments are sandbox/mock only.** The checkout path resolves to the existing sandbox/mock provider
  (`scripts/e2e/mockPaymentProviders.mjs`) — never a live charge.
- **Synthetic files only.** Trial balances are invented fixtures; no customer data.

## 3. Execution host for the browser driver
- The driver (`harness/cdpDriver.mjs`) is wired on the repo's dependency-free CDP tool (`scripts/browser-acceptance/cdp.mjs`,
  `--remote-debugging-pipe`). **It requires a host where headless Chrome automation runs** — i.e. the **Linux CI runner** the
  existing browser-acceptance suite already uses, or an equivalent Linux runner.
- **This research host cannot run it** (verified 2026-10-16): Chrome is installed, but headless automation does not work here
  — `cdp.mjs` fails at `Target.setDiscoverTargets` (the Windows pipe transport), and even a direct
  `chrome --headless=new --screenshot` produces no output. So the driver + synthetic smoke test are delivered **wired and
  code-verified**, to be run on the capable runner. (No edit to `cdp.mjs` is proposed from this lane; a WebSocket
  `--remote-debugging-port` transport would be a separate, coordinated change NORMAL owns.)

## 4. Prohibited (unchanged)
No production credentials, no hosted writes to production, no real purchases, no customer data, no paid model calls.

## Exact remaining dependency (blocking journey execution)
**(a)** candidate commit; **(b)** an **isolated, non-production** preview with a seeded synthetic-login method and
sandbox payments, with the §2 isolation confirmed; **(c)** a **Linux runner** (or CI job) able to launch headless Chrome for
the driver. With (a)+(b)+(c), the 9 journeys run via `harness/launchQaHarness.mjs` + a wired `cdpDriver` and the PENDING rows
in `REPORT.md` are replaced with real PASS/FAIL + screenshots. Everything not depending on these is already done (pure checks
+ driver wiring + synthetic smoke test).
