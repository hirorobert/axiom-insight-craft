# Release procedure: IFRS for SMEs reporting (batch `reporting-r1`)

**Status: PREPARED, NOT APPLIED.** Nothing in this document has been done to the hosted project. Each step that
changes hosted state needs its own explicit owner authorization:
- merging;
- applying the wrappers;
- deploying functions;
- publishing the frontend;
- changing a gate or the rollout.

Production project: `bvyivmmfjejbmqoydezk`.

## 0. What is released, and what stays withheld

| Area | Source | Customer-visible after this release? |
|---|---|---|
| Statement composition, notes and schedules, comparatives, sign-off binding, closure (comprehensive income; the authenticated approver) | PRs #89–#94 | **No.** The six reporting pages are not in `RELEASED_WORKBENCH_PAGES`. The Statements stage stays withheld (`moduleAvailability.ts`). Every RPC also requires `fs_rollout_allows(company)`. |

The release adds server functions and tables only. It changes no data and enables no gate. AI providers, XBRL and tax
endpoints are untouched.

## 1. Preconditions

- Merge #87 → #94 in order. Lock each merge commit to its head; reconfirm CI first.
- Hosted journal head = entry **40** (mirror `0039_i1b_w7_signoff_completion_requirements`). Hosted application
  happens only after that is confirmed.
- **Source:** the committed bytes at `902a05763be23ef9b3ee762ae92401c0e32ddd84`. The identity that matters is the byte
  identity below, not the commit SHA.

## 2. Hosted preflight (read-only)

Run `docs/release/reporting-r1/preflight.sql` in a `READ ONLY` transaction. It checks three things and raises on the
first failure:
- no object of this release exists yet;
- every prerequisite table, function and role exists;
- the rollout state row exists.

It then prints a `BASELINE …` line per count, followed by `PREFLIGHT OK.` Record every line.

## 3. Apply the five self-checking wrappers, in this order, one statement each

Submit each wrapper file **byte for byte** (the registered `wrapper` form) or with exactly its single final LF removed.
No other text is accepted: no CRLF, no BOM, no trimming, no re-render. Each wrapper is one `DO` statement that does
two things:
- it re-verifies the enclosed migration's byte count and SHA-256 in PostgreSQL first, and refuses with SQLSTATE 55000,
  changing nothing, on any difference;
- it is atomic on its own.

| # | Wrapper (`release/wrappers/`) | Wrapper: bytes · SHA-256 | Final LF removed: bytes · SHA-256 | Encloses: bytes · SHA-256 |
|---|---|---|---|---|
| 1 | `20261018100000_fs_statement_composition.wrapper.sql` | 40776 · `57ef68a28c4df8750aa89901caf26d34b0f8f31f058bbebf934761c821944ca7` | 40775 · `401e09cb8f73238a09ca442f2b6c578d9d1e3bcb008551ba8a61aab9e3cc1b08` | 39206 · `18b239b602796b0f7071b4cd56c69611cca3e244f88af3c1c797ce79b461f7ca` |
| 2 | `20261019100000_fs_notes_and_schedules.wrapper.sql` | 45477 · `554d29c672bc9604ee8f95b137c23ecaa1799771a8bb86879ee1abf6c3624127` | 45476 · `e41c8364c71fb60254edb4223f4921e1a5c17dedc6123a85170f133028e4c9b0` | 43911 · `b89c83bbc3bb9e93cbdd7532b8149aa15d776bee033fab9ae03f632f669087fa` |
| 3 | `20261020100000_fs_comparatives.wrapper.sql` | 49493 · `28ff6bdbe6197273358cb219083fbd84824b5f0456b25fc7b1a53e4d85dd513a` | 49492 · `66618f831ae2378d807c3a41c5309ac2f940b858616c33a019df608cd74f150d` | 47941 · `74119824182913d6f35068bb7a0a87409688d5009feba3d230540badae66b6b4` |
| 4 | `20261021100000_fs_signoff_binding.wrapper.sql` | 25151 · `e6379644bfd4ea032cab9a17cf9db22be1bdc9821157992ef7cb487037f31305` | 25150 · `16b306bc4bc37f129d4b7eaf1ea93ffac463595872ab25a6f51f3a7acfe526fc` | 23593 · `9f69a03e69141fe954d4e63e95643077cabe8a1f8ab9fc18e328d2dab12d9d12` |
| 5 | `20261022100000_fs_reporting_closure.wrapper.sql` | 28704 · `74e459e8198c98a37964b16d673285f24a6cba9d5813a1c75bbadb53398bd4a6` | 28703 · `27ffb7e7515c5d0a48b1b5f56afb83d16b0cadb3f9887871fa8591bf89427fc3` | 27142 · `307f3114af9433473ee31cb674ab8ac730b832852ded9793cc69ce8ea647f3aa` |

These forms are registered in `SUBMISSION_FORMS` (`scripts/ci/releaseJournal.mjs`) before application.
`node scripts/release/selfCheckingWrapper.mjs --check` re-verifies the files.

Expected journal entries are hosted 41–45, mirrors `0040`–`0044`. Mirror them afterwards from the hosted export only;
never hand-edit them.

## 4. Hosted postcondition (read-only)

Run `docs/release/reporting-r1/postcondition.sql` in a `READ ONLY` transaction. It checks:
- every table exists with RLS on;
- the append-only and binding triggers are enabled;
- the approver columns and the `chk_fspb_approver` constraint exist;
- the comprehensive-income evaluation and the approver check are in force;
- nothing is executable by `anon`, and the internal helper is not executable by `authenticated`;
- the requirements are loaded.

Compare its `AFTER …` counts with the baseline. Nothing of the baseline may be gone, and the rollout count must be
unchanged.

## 5. Mixed versions, partial releases and failures

All four situations below are proven on real PostgreSQL with the real `process-trial-balance` handler, in
`scripts/db-proof/reportingRelease.mjs` (18/18) and `selfCheckingWrappers.mjs` with `RELEASE_BATCH=reporting-r1`
(132/132):

| Situation | Behaviour |
|---|---|
| Old app, new schema (any stage) | Everything main's released app uses keeps working after every wrapper: trial-balance certification, Close Review, the reporting input, workspace capabilities. Pre-release certifications stay authoritative, and pre-release data composes after the release. |
| New app, old schema | The reporting pages are not released. If called anyway, a missing function is an error (42883), never data. |
| Stopped after any wrapper | The database is consistent. Continue with the next wrapper. |
| A wrapper fails (anything inside it) | It rolls back completely, with no partial object and no journal row. **Forward recovery:** fix the cause and re-submit the same wrapper. There are no rollback scripts and no manual repair. A wrapper already applied is refused by its own preflight (`PREFLIGHT_REFUSED`, nothing changed). |

## 6. After the release (each step separately authorized)

1. **Publish the frontend.** The pages remain unreleased.
2. **Storage cleanup (two-year intake only, not this release).** Follow `docs/release/STORAGE_CLEANUP_RECONCILIATION.md`:
   run the read-only identity check, then reuse or redeploy accordingly.
3. **Activation:**
   - stop withholding the Statements stage, together with its route segments;
   - add the six pages to `RELEASED_WORKBENCH_PAGES` and set `REPORTING_PAGES_SHIPPED = true` (`src/lib/workbench/routes.ts`), in one
     commit; a test requires the two to agree, and until then the pages are not in the build at all;
   - allow-list each company with `fs_set_company_rollout`.
4. **Independent accounting validation.** It stays **outstanding** until a qualified accountant completes
   `docs/reporting/review-package/`.
