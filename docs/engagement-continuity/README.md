# DIVINE engagement continuity

Based on merged PR #187 (`d807d0fb`). Its route-backed practice window, field locks, portfolio and database commands remain authoritative. Prior uncommitted work is preserved separately at `recovery/divine-before-pr187` (`0ab9bbf1`); only changes still needed after #187 were integrated.

## Behaviour

- The engagement shell keeps company, reporting period, currency, framework and **All engagements** visible. Opening company or period settings preserves the mounted task. Confirmed saves invalidate reads and return to that task, including its query/hash; cancellation discards only explicitly confirmed edits.
- The same edit registry protects local company creation and selected uploads on navigation, Back and unload. While settings are open its single blocker owns both settings and background task protection. In-flight work cannot be dismissed as cancelled. Successful commands release their own guard before navigating.
- Starting trial-balance review is one explicit service choice for a company without an engagement. An existing trial-balance engagement opens its actual workspace. Intake remains available for layout correction but is no longer a second primary navigation destination or a duplicate reporting-period form. Empty Intake redirects to review; legacy aliases preserve query/hash.
- Continue reads the authorised portfolio's persisted status and destination, ordered by server `opened_at`. It does not claim last-visited ordering or derive progress from browser storage. Failed reads offer retry rather than invented progress. The destination rechecks permissions and readiness.
- Company/period changes remount the scoped workspace. Superseded reads cannot overwrite a newer snapshot. No SQL, pricing, scope grant command, financial validator, accepted currency protection or request-identity algorithm was replaced. Period settings refuse an unconfirmed mandate and submit the existing granted scope.

## Verification

Focused tests cover same-tick duplicate save, failed/uncertain response retention, busy Escape/Back, exact task restoration, unread-period fail-closed, end-year isolation, unsaved task switching, portfolio read failure/retry, and out-of-order/unmounted read isolation.

`dev-harness/divine/browser.mjs` drives actual application pages on desktop (1440×960) and mobile (390×844) against a development-only simulated transport and the real ingestion parser. It blocks non-loopback browser requests. Install Playwright outside this repository and run with `DIVINE_PLAYWRIGHT_MODULE` (module path), optionally `CHROME_BIN`; output goes to `/tmp/divine-browser` by default. No customer session, data, credentials or Lovable is used. The harness is excluded from the production build.

The simulated classification backend creates historical-generation accepted certifications; the UI must label these **Checked by an earlier version**, never claim they passed today's rules. This browser exercise demonstrates UI continuity and persisted simulated state, not live database transactions or current financial certification. The existing real-local-stack browser journey remains the backend acceptance authority; its period setup step now uses the in-place window and still checks the persisted row and prior-period link.

No production payments, hosted financial writes, merge or publication are part of this change. No absolute or regulatory certification is asserted.
