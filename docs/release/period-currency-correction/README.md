# Period-currency correction (batch `currency-c1`, migration `20261113100000`)

Status: **authored, proven locally and in CI — PENDING owner review and hosted application.** Nothing here has been
applied to any hosted database, merged, activated or published.

## The defect

A trial balance whose amount columns are labelled in another currency than the period's (for example `Debit TZS`
under a USD period) is refused by the check (`CURRENCY_MISMATCH`, blocking). Refusing is right. Before this repair,
that refusal **locked the period's currency for good**:

* `fiscal_periods_processing_lock` (20261009100000) refuses any currency or date change once
  `_period_has_processing` is true. That predicate counts **any** processing attempt, so a refused check counts too.
* `open_engagement_with_period` refuses a different currency for an existing period (`CURRENCY_DIFFERS_FROM_EXISTING`).
* Replace keeps the period's currency, and Intake's set-up was refused.

The person could not correct a wrong currency choice. The proof reproduces this on the chain without the repair
(group *Reproduction*).

## The precise eligibility rule

A period's currency may be corrected **only** when every one of the following holds, evaluated by the server with
the period's uploads and the period row locked:

The period's uploads are its own (`period_id`), plus legacy rows with no `period_id` that have the same company and
the period's year. Retired uploads are included.

| # | Refused when | Code returned | Why |
|---|---|---|---|
| 1 | the period is `locked` | `PERIOD_LOCKED` | a locked period never changes |
| 2 | **any** certification of the period's uploads has `is_blocking = false`, **including one that still requires review** | `ACCEPTED_CERTIFICATION` (with `requires_review`, `certified_at`, record id) | an accepted certification recorded amounts in that currency. A screen label (`complete`, `blocked`, `requires_review`) is never consulted |
| 3 | a `process-trial-balance` run on those uploads is still running within its lease | `PROCESSING_IN_PROGRESS` | it read the current currency |
| 4 | any row exists in a table outside the bookkeeping list that references those uploads, the period or their certifications by foreign key, **or** is keyed by the period's company and year (`company_id` + `period_year`, or `company_id` + `reporting_period_id = 'FY'‖year`) | `DOWNSTREAM_RECORD` (with relation and column) | something was built on the period's amounts |

The scan in rule 4 reads the catalogue at call time. A table added later is therefore covered automatically and
blocks by default. The **bookkeeping list** is the only exception: tables that carry no amount and no currency
judgement, or that rule 2 considers explicitly:

`trial_balance_uploads`, `fiscal_periods`, `fiscal_period_events`, `engagements`, `tb_certifications` (rule 2),
`tb_certification_findings`, `tb_certification_invalidations`, `layout_confirmations`, `engine_runs`,
`trial_balance_draft_commits`, `trial_balance_upload_lifecycle_events`, `trial_balance_upload_operations`,
`onboarding_progress`, `upload_integrity_findings` (flags from the scheduled identity sweep).

The proof prints the complete classification on the real chain: every foreign key, and every company+period table,
each marked bookkeeping or BLOCKS. Blocking tables include account review decisions and batches, adjusting journal
entries, close-review findings and adjustments, statement sign-offs, tax computations, closing balances, bank
reconciliations, financial-statement evidence, documents and reports, Reporting Pack issuances and XBRL documents.

Retired uploads count on purpose. If an accepted trial balance was later replaced, the currency it was accepted in
stays fixed.

## The one authorised operation

`correct_period_currency(period, new, expected, reason, request_id)` is granted to `authenticated` only:

* **Actor:** an accepted member with active named-user access and `prepare_close`. Otherwise `not_found`, so another
  tenant learns nothing.
* **Order:** it locks the period's uploads `FOR UPDATE` (ordered by id), then the period `FOR UPDATE`. This is the
  global order `tb_finalize_attempt` already uses. Eligibility is evaluated after both locks are held.
* **Version check:** `expected` must equal the current currency, otherwise `stale` with the current one. `unchanged`
  is returned when nothing would change.
* **Idempotency:** a `request_id` applies once. A retry answers `already_corrected` with the same event. The same id
  with a different change is a `request_conflict`.
* **Record:** the `fiscal_period_events` row holds `currency_corrected` and
  `{from, to, reason, request_id, rechecks}`, plus `actor_member_id`, `actor_user_id` and `occurred_at`.
* **What changes:** only `fiscal_periods.reporting_currency`. No amount is converted. Source bytes, uploads,
  certifications and history are untouched (the proof compares them byte for byte).
* **Processing lock:** it admits this change only under the operation's transaction-scoped marker. Every other path
  is refused exactly as before.
* **Dependency revision:** the change bumps the `'#currency'` dependency revision. A check that read the old currency
  can no longer certify (`DEPENDENCY_CHANGED`).
* **Re-checks:** the answer names a deterministic re-check id per active upload (derived from the event and the
  upload). The browser re-checks through the normal path (`tbu_request_reprocess`, then `process-trial-balance`) with
  that id, so retries are idempotent.

`get_period_currency_correction(period)` is the read. It returns `eligible` or `not_eligible` with the exact record,
plus the latest correction with its re-check ids (never the reason), so a reloaded page can retry a re-check that did
not start.

## Concurrency (one lock protocol)

| Race | Result (proven) |
|---|---|
| finalize holds the upload, then correction | correction waits, then sees the accepted certification and refuses |
| a check is running | refused outright (`PROCESSING_IN_PROGRESS`) |
| correction open, then a re-check starts | the re-check waits, then records the new currency revision |
| correction open, then a downstream write referencing the upload | waits (KEY SHARE vs FOR UPDATE) |
| two different requests | one corrected, one stale |
| 12 duplicate clicks (one id) | one correction, 11 `already_corrected`, one event |

Known limit: tables keyed only by company and period (no foreign key) take no row lock on the upload or the period.
A write to one of those concurrent with a correction is not serialised by the lock. Such rows (for example
financial-statement evidence) carry their own declared currency and are matched by currency, so a race leaves them
unmatched (fail-closed), never mislabelled. The next correction attempt sees them and refuses.

## Browser

* **Before processing:** the first upload and Replace read the file's explicit currency labels in the browser with
  the server's own reader (`supabase/functions/_shared/tbCurrencyLabels.ts` → `tbSource` → `tbIngestion`; loaded
  lazily, in its own chunk). The browser warns about exactly the labels the server would refuse (15/15 combinations
  tested).
  * A conflict shows both currencies and the label location.
  * The first upload offers an explicit **Use TZS**. Replace offers **Replace anyway** only when the server says a
    correction is possible; otherwise it shows the server's reason.
  * Mixed labels must be corrected in the file.
  * Nothing changes silently.
* **After a refusal:** the blocked card shows the correction when the server says it is eligible. It asks for an
  explicit confirmation with a reason, uses one request id per confirmation, then re-checks.
  * If the re-check did not start, the card shows the saved currency and **Re-check now**.
  * Where correction is unsafe, the card names the record that prevents it and the route that still works. It never
    shows a control the server would refuse.
* **Intake:** an existing period's currency is read-only, with the server's rule in words.

## Evidence

| Proof | Where | Result |
|---|---|---|
| `scripts/db-proof/periodCurrencyCorrection.mjs` | local PG16; CI step *Period currency correction proof* | 39/39 |
| `scripts/db-proof/selfCheckingWrappers.mjs` with `RELEASE_BATCH=currency-c1` | local PG16; CI step *Period currency correction wrapper proof* | 32/32 |
| `src/lib/ingestion/fileCurrencyCheck.test.ts` (browser and server read parity) | unit tests | 24 |
| `src/lib/workspace/periodCurrency.test.ts` (rules and real panel: duplicate clicks, failure recovery) | unit tests | 11 |
| Browser journey, group *Currency…* in `scripts/e2e/localStackJourney.mjs` (headless Chrome, real local Supabase stack, invented data) | CI job *Real application end to end*; screenshots 22–26 in its artifact | see PR |

## Packaging and deployment sequence (owner, through Lovable; nothing here does it)

1. Review this PR, including BLACK's bounded review.
2. Merge (the frontend refuses nothing until the migration is applied):
   * The new read and operation calls fail closed. The panel shows nothing and the card keeps Replace.
   * The pre-upload label warning works without the migration.
3. Apply the wrapper `release/wrappers/20261113100000_period_currency_correction.wrapper.sql` through the hosted
   journal (identical or final-LF-removed form; all four forms are registered in `SUBMISSION_FORMS`).
4. Run `docs/release/period-currency-correction/postcondition.sql` in `BEGIN TRANSACTION READ ONLY; … ROLLBACK;` and
   expect `POSTCONDITION OK.`
5. Register the hosted journal entry and drizzle mirror (a follow-up PR, as for pricing-p1).
6. Publish the frontend.

No edge function changes. `tbCurrencyLabels.ts` is not imported by any function.

Coordination: the FS branch (#176) adds `20261111100000` and `20261112100000`; this migration sorts after both and
touches none of their objects. The registry files (`ci.yml`, `releaseJournal.mjs`, `selfCheckingWrapper.mjs`, the
wrapper proof and the registry tests) are edited by both. Whichever lands second rebases and keeps both entries.
