# Financial statements — first slice: deployment handoff (release candidate)

Candidate: PR #176 (`feat/fs-first-slice-20261018`). Record of decisions and evidence: `RECORD.md` (this folder).
Everything below is **for the owner to run**, in this order, when the candidate is accepted. Nothing in this document has
been run against the hosted project: the branch is not merged, no wrapper is applied, no function is deployed, no company
is activated, Publish is held. Each step names what to run, what must be true before, and what must be true after.

Evidence labels used: CI-PROVEN (the pushed head's CI run), EXECUTED-LOCAL (embedded PostgreSQL on the developer
machine), HOSTED-VERIFIED (none yet — every hosted step below produces its own), UNKNOWN (stated where it applies).

## 0. What ships

| Piece | Where | Applied how | Changes the live behaviour of |
|---|---|---|---|
| Publication controls — batch `fs-controls-r1` | `release/wrappers/20261111100000_fs_publication_controls.wrapper.sql` (source `supabase/migrations/20261111100000_fs_publication_controls.sql`) | self-checking wrapper, SQL editor, by the owner | the reporting sign-off path only (`fs_publication_blockers` v3, `fs_set_publication_state` v2, `fs_bind_publication` v4, pack 1.2.0 rows, new read-only functions). Companies without the FS rollout are untouched |
| Reviewed reporting journey — batch `fs-journey-r1` | `release/wrappers/20261112100000_fs_review_workflow_and_rollforward.wrapper.sql` | same | four new append-only tables, the reviewer-comment, roll-forward and acceptance functions, blockers v4, `fs_prior_final_reconciliation` v2 |
| Work bounds — batch `fs-bounds-r1` | `release/wrappers/20261113100000_fs_work_bounds.wrapper.sql` | same | `fs_work_bounds()` and four BEFORE INSERT triggers on `financial_evidence_batches`, `financial_statement_reports`, `fs_review_comments`, `fs_review_comment_events`: NEW rows over a bound are refused by name; existing rows are never touched |
| Edge Function `seal-reporting-pack` | `supabase/functions/seal-reporting-pack` (+ `_shared/reportingPackSeal.mjs`) | `supabase functions deploy seal-reporting-pack` | adds the `retrieve` action; `issue` and `verify` are unchanged in behaviour (same module, same gates) |
| Frontend (the reporting pages, the review/roll-forward/official-pack panels) | the merged `main` | Lovable Publish | only companies with `fs_set_company_rollout(..., true)` can write; everyone else keeps today's pages |

Not shipped, not changed: `FINANCIAL_STATEMENTS_WORKSPACE_ENABLED` (a separate, older gate; stays `false`), the company
rollout allow-list (empty of new companies until step 5), the kill switch (released), every other Edge Function.

## 1. Preconditions (verify, do not assume)

1. The PR's final head has a green `Release Gate`, `Golden Fixture Tests`, `Disposable-DB Contract Tests` and `Real
   application end to end` run, and BLACK's acceptance of that head is posted on the PR. Record the head SHA here: `……`.
2. The hosted project has drizzle entries 0001–0063 applied and nothing after (`SELECT max(id) FROM drizzle.__drizzle_migrations` → 63; the migration-authority guard on the branch says the same: 60 mirrored, three PENDING).
3. A fresh hosted backup/point-in-time mark exists (the wrappers are atomic and forward-only; there is no down migration — recovery is "stop writes, then forward-fix", see §7).
4. The SQL editor session is the owner's (postgres role). Never paste the source `.sql`; only the wrapper file, whole.

## 2. Apply `fs-controls-r1` (first)

| Step | Run | Must hold |
|---|---|---|
| 2.1 preflight | `docs/release/fs-controls-r1/preflight.sql` (read-only) | ends with `PREFLIGHT OK`; copy the sign-off listing it prints |
| 2.2 apply | the whole of `release/wrappers/20261111100000_fs_publication_controls.wrapper.sql` | one statement; it recomputes 93,290 bytes / SHA-256 `b8b8bef6…` before executing and refuses anything else; either everything applies or nothing does |
| 2.3 postcondition | `docs/release/fs-controls-r1/postcondition.sql` (read-only) | ends with `POSTCONDITION OK`; the sign-off listing is byte-identical to 2.1 |
| 2.4 journal | the apply tool writes the drizzle row (0064 expected); then `scripts/ci/releaseJournal.mjs` on `main` must show the source as applied in one of its registered forms | the branch's `migrationAuthority.test.ts` pending list shrinks by one when the journal is mirrored |

## 3. Apply `fs-journey-r1` (second — its preflight requires 2)

Same shape: `docs/release/fs-journey-r1/preflight.sql` → `release/wrappers/20261112100000_fs_review_workflow_and_rollforward.wrapper.sql`
(71,537 B / `e499ef69…` enclosed) → `docs/release/fs-journey-r1/postcondition.sql` → journal row (0065 expected).

## 4. Apply `fs-bounds-r1` (third — its preflight requires 3)

`docs/release/fs-bounds-r1/preflight.sql` → `release/wrappers/20261113100000_fs_work_bounds.wrapper.sql` (12,720 B /
`8b337b22…` enclosed) → `docs/release/fs-bounds-r1/postcondition.sql` → journal row (0066 expected).

The preflight lists six counts of existing rows that already exceed a bound; **every count must be 0**. If any is not,
stop: the triggers only judge new rows, but a lineage already at 1,000 versions or a version already at 500 comments
would refuse its next legitimate write — that case needs the owner's decision, not a silent apply.

## 5. Deploy the Edge Function, then verify it

```bash
supabase functions deploy seal-reporting-pack
```

Then, as a workspace member of a company that already has an issued official pack (or after step 6's smoke issuance):

| Check | How | Must hold |
|---|---|---|
| `verify` unchanged | Exports → an existing issuance → **Verify** | `Verified: … matches the seal recorded at issue`, no WARNING |
| `retrieve` live | the same issuance → **Retrieve** | the file downloads; the page reports the same digest as sealed |
| `issue` unchanged | only on the canary company of step 6 | a new sealed issuance appears; the earlier one keeps its digest and still verifies |

If the function deploy fails or `retrieve` answers `unavailable`, the pages still work: `retrieve` is the only new path and
the panel words its absence; `issue`/`verify` come from the previously deployed module until the deploy succeeds.

## 6. Restricted activation (one canary company) and the smoke run

1. Activate ONE company — the owner's own synthetic/demo company, never a client's — with `docs/release/sql/03_activate_company.sql`
   (service role, mandatory reason, written to `financial_statements_rollout_audit`).
2. Smoke run on that company, in the product, with invented data (the sequence of `scripts/e2e/localStackJourney.mjs`):
   upload FY(n−1) and FY(n) trial balances → review → presentation → notes → comparatives approval → evidence files → save
   → readiness `ready` → REVIEWED (reviewer) → FINAL (owner) → Exports: issue → verify → retrieve. Expected refusals to
   try on purpose: a preparer approving (no control, server refuses), a save with a 20,001-row ledger (the intake refuses
   it at 20,000 before the server sees it; the server would refuse it too: `EVIDENCE_ROWS_LIMIT`).
3. Record HOSTED-VERIFIED outcomes in `RECORD.md` §7.6 (a new table: step, who, outcome, time).
4. Only then widen the rollout, company by company, each with its reason. Publish (frontend) can precede or follow step
   6.1 — until a company is activated the new pages refuse every write (`feature_disabled`), so Publish alone changes
   nothing for clients.

## 7. Recovery

| Situation | Action | Effect |
|---|---|---|
| A wrapper refuses (byte/hash mismatch, preflight) | nothing was applied; fix the input (wrong file, wrong order), re-run | none |
| A wrapper fails mid-way | impossible by construction to leave a partial state: the wrapper is one transaction; the drizzle row is not written | none |
| A postcondition fails after a successful apply | stop; do not continue to the next batch; engage the kill switch (`docs/release/sql/05_kill_switch.sql`) if any company is active; investigate on a hosted clone | writes stop (`FEATURE_DISABLED`), reads of saved history continue |
| A bound refuses a legitimate write for a real company | `docs/release/sql/04_deactivate_company.sql` for that company while the case is decided; raising a bound is a new forward migration redefining `fs_work_bounds()` (one function, no table change), never an ALTER of the triggers | that company's writes stop; everyone else unaffected |
| The `retrieve` deploy misbehaves | redeploy the previous `seal-reporting-pack` revision (Supabase keeps function versions); the pages degrade to issue/verify only | no data impact: `retrieve` reads only |
| Any incident | kill switch (every company, instantly), then deactivate companies individually, then forward-fix | reads continue; nothing is deleted — the schema is append-only and forward-only |

There is no roll-back migration: `financial_evidence_batches`, `financial_statement_reports`, the comment and carry tables
are append-only by trigger, and the controls refuse rather than delete. Forward-fix is the only path, which is why each
batch is small, self-checking and preceded by a read-only preflight.

## 8. What this handoff does NOT cover (stated, not hidden)

- CPU cost on the hosted Edge runtime: the CI measurement records HTTP outcomes and wall time only (`RECORD.md` §7.5); the
  completed TB CPU investigation is not repeated here.
- Two measured limits, OPEN (`RECORD.md` §7.5): companies with more than 1,000 reviewed accounts do not certify through
  the deployed processing function (`DEFECT-PTB-MAPPINGS-API-ROW-CAP-001`: the mapping load is capped by PostgREST's
  1,000-row default); a 20,000-row ledger at 1,000 accounts does not save within the API statement timeout (fails closed,
  nothing stored). The scale this handoff is verified for is the representative one (tens of accounts, ledgers of a few
  hundred rows); say so to the first activated companies.
- Hosted browser acceptance (owner-run; `docs/release/sql/07_acceptance_preflight.sql` decides the path).
- The legal review of `/terms` and `/privacy`, SMTP configuration and the other commercial go-live gates in `CLAUDE.md` §9.2.
