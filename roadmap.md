# CFOClose roadmap and status — trial balance programme (directive of 15 October 2026)

This is the ONE status file for this programme. It is updated in place; earlier notes are kept at the bottom.
`docs/redesign-preview/RELEASE-CANDIDATE-STATUS.md` remains the status of the separate release candidate (#127) only.

**Status words used here, and nothing stronger:**
- **IMPLEMENTED — UNVERIFIED**: code exists; no passing evidence yet.
- **VERIFIED IN ISOLATION**: passing unit tests and/or real-PostgreSQL proofs, without the full stack.
- **VERIFIED END TO END**: passing on the local Supabase stack (real Auth, PostgREST, RLS, Storage, Edge Functions) in CI.
- **INTEGRATED**: merged to `main` with every required check green on the merged head.
- **DEPLOYED AND READ BACK**: live on the hosted project, with installed versions and a synthetic check read back.

Nothing in this programme is INTEGRATED or DEPLOYED yet. Payments: public payments remain **disabled** until both Polar and
Snippe pass (owner decision 14 October); no payment state is changed by this work.

## Customer flow

**Today (main):** sign in → first run creates an entity (name, year end) → "What would you like to complete?" → "Add
financial data" → upload a trial balance inside the entity → checks → review. An entity must exist before any file.

**Intended (Phase 2):** sign in → one page: drop the file (stored privately as a draft, not yet in any entity) → stages File
read → Columns confirmed → Checks completed → confirmation card (entity, period, currency) under the results → "Start trial
balance check" → the draft is committed to the entity and processed. Returning users get a compact drop zone above their
entity list. The two removed screens never appear while only one service exists.

## Phases

| Phase | Scope | Status | Depends on |
|---|---|---|---|
| 0 | §1 apply the ingestion repair (PR #132) | VERIFIED IN ISOLATION; green only when combined with #133 (draft #134, old base; draft #137, current base) | #133 |
| 1 | §3 engine correctness: footers, earlier-version results, entity/period/currency evidence, review rules, one status vocabulary (PR #135, draft) | VERIFIED IN ISOLATION (all PR checks green except the payment proofs #133 fixes) | 0 |
| 2 | §5 the one-page journey (PR #136, draft) | IN PROGRESS — see batches below | 1 |
| 3 | Source-to-result review report with check-coverage matrix | NOT STARTED (not to start until Phase 2 is accepted) | 2 |
| 4 | Gated records-to-draft-TB assistance | NOT STARTED (same) | 2, 3 |
| 5 | Accounting interpretation and controlled reuse — RESEARCH / PROOF ONLY (draft PR #138, separate session; `research/phase5/**`, 29 synthetic checks, no production code) | RESEARCH — not approved, not integrated, not deployed | — |
| 6 | Deterministic grouped TB review + controlled reuse over the unchanged `resolve_account_review_batch` — PROPOSED IMPLEMENTATION (#138 HANDOFF.md) | PROPOSED — needs owner approval and the ownership agreement below before any production edit | 1, 2 (committed uploads), 5 |

## Phase 2 batches

| Batch | Content | Status |
|---|---|---|
| P2-1 | One way in while one service exists (entry card); header status; entity wording | VERIFIED IN ISOLATION (PR #136 at `578ac97`: every job green except the payment proofs #133 fixes) |
| P2-2 | Draft upload authority: owner-scoped drafts, commit to an entity, recovery protocol, 7-day retention | VERIFIED END TO END on the local stack (`d2e2bad`, run 38856014011); not integrated, not deployed |
| P2-3 | First-visit drop zone; confirmation card (new entity, period presets with derived start or custom dates, currency from the registry); one primary "Start trial balance check" through create_entity → open_engagement_with_period → draft commit → process-trial-balance (resumable, no duplicates); stages File read → Columns confirmed → Checks completed from the server's milestones; draft message | VERIFIED END TO END on the local stack (`8de0eec`, run 38860710080) for a new customer WITH a plan and entity capacity; existing-entity and purchase-required paths not built |
| **P2-4 (current)** | DONE in code: returning Home compact upload (outline, above the one next action); upload to an existing entity with the currency pre-filled from its confirmed period (source shown) and the following year as a suggestion only; purchase-required path (no plan: draft kept, 'Choose a plan', 'Continue with' the same draft and card afterwards); Orders → Settings › Billing (`/settings/billing`, `/billing/orders` redirects with query). NOT YET: entity list redesign (entity · latest period · service · status), payment notice, Reconcile locked with reason, replace-from-draft, investigation access while finalisation is blocked | IMPLEMENTED — awaiting exact-head CI |
| P2-5 | Integrity across entity creation → commit → job → usage; acceptance journeys 1–14; desktop/mobile screenshots | NOT STARTED |

### P2-2 — what exists and what it proves

Files: `supabase/migrations/20261106100000_trial_balance_drafts.sql`, `supabase/functions/trial-balance-draft/`,
`supabase/functions/_shared/draftUpload.ts`, `src/lib/workspace/trialBalanceDraft.ts`, the sweeper kind `draft`.

- **Idempotency, per operation.** *Reserve* binds the authorised owner and the file's identity (name, size, SHA-256 of
  the bytes); no entity is needed. *Commit* is its own record, binding the draft and its content hash, the target entity,
  the period (year, period, engagement) and the confirmed context (entity, period, currency). Same key + same inputs →
  the existing outcome; same key + changed inputs → conflict; a new key with the same file → a new, legitimate draft. A
  draft is committed at most once. Every commit call, a replay included, re-checks the caller's CURRENT authority.
- **Recovery protocol (not a distributed transaction).** begin → read the draft back (size + SHA-256) → workspace
  reservation as the user, recorded → service-role copy, read back and verified, recorded → registration as the user (the
  single-use reservation is consumed with the upload row in one database transaction, so registration happens at most
  once) → finish. A stop or lost response at any step leaves a recorded state the next call resumes from. Between Storage
  and the database there is no atomicity: a copy can exist without a registration (an unconsumed reservation's object,
  reclaimed by the existing reservation sweep), never a registration without a verified copy.
- **Retention.** Unconfirmed drafts expire after 7 days (owner approval 15 October: "approved at 7 days for unconfirmed
  draft uploads only"). The scheduled sweeper removes expired, deleted, rejected and committed drafts' own `drafts/`
  objects. Committed evidence is the separate workspace copy the upload is bound to; a `drafts/` path can never be a bound
  source. Not shown to users until implemented, tested and deployed (P2-3 shows it only then).
- **Constraint changes.** Only the two new tables carry new constraints. No existing table, constraint, policy or grant
  is altered; the three sweeper functions are redefined with marked additive blocks. The drafts tables deliberately hold
  NO foreign key to `trial_balance_uploads`: `tbu_upload_evidence()` reads any such key as processing evidence and would
  have made an unprocessed upload from a draft undeletable (caught by the comparison proof and fixed).
- **Rollout compatibility.** Order: migration → function → frontend. Old frontend + new backend: the entity-first path is
  unchanged (the existing real-app journey runs it on the new backend). New frontend + old backend, or an interrupted
  rollout (function before migration, or migration without function): every draft step refuses with
  `drafts_unavailable` and the message "Uploading before choosing an entity isn't available yet. Add the entity first,
  then upload your trial balance." — never a false success; committed evidence is untouched.

### Evidence for the tested commit

| Head | Run | Result |
|---|---|---|
| #136 `b65769b` (P2-2) | 38853987539 | Drafts PostgreSQL proof **ALL PASSED** (CI container); local-stack draft journey **25/25** (real Auth, PostgREST, RLS, Storage, function); Release Gate, lint/build/typecheck, golden, migration audit **green**. Failing: payment proofs (fixed by #133, known) and the new Deno check of `trial-balance-draft` (it used `npm:` imports that the Deno job cannot resolve → switched to the `esm.sh` pattern of the other checked functions in the next commit). |
| #136 `d2e2bad` (P2-2 + Deno fixes) | 38856014011 | **All P2-2 evidence green on this exact head:** drafts PostgreSQL proof 71/71 (CI container); local-stack draft journey 25/25 (real Storage); the existing real-app journey (entity-first flow, i.e. old frontend path on the new backend) ALL PASSED; Deno check of `trial-balance-draft` green; Release Gate, lint/build/typecheck, golden, migration audit green; every other database proof green (upload lifecycle 207/207, shared source, wrappers, …). **Only failing steps:** the payment proofs #133 fixes (`paymentJourney` 49/54, verified-charge proof 19/26). So #136 is NOT green as a tree; it becomes mergeable only on a base that includes #133. |
| #136 `8de0eec` (P2-3) | 38860710080 | Real-app journey **ALL PASSED** including the first upload through the real UI: draft stored (no entity yet), empty card refused with a problem list, card → entity "Kilima Invented Traders Ltd", period 1 Jul 2025 – 30 Jun 2026 TZS, upload bound to that period, draft committed to that exact upload, stages File read Done / Columns confirmed Done / Checks completed Needs review, result page opened; 1280/375 px layout checks on every new screen. Drafts journey 25/25; drafts proof 71/71; all other jobs green except the payment proofs #133 fixes (5 payment-journey checks, verified-charge proof). |
| #137 `f12ebcf` (#132 + #133 on main `00a2653`) | 38853015089 | **Every job green** (Staging RLS skipped, as on every PR). |

Locally on PostgreSQL 16 (embedded): drafts proof 71/71; existing shared-source proof 44/44 and upload-lifecycle proof
207/207 unchanged with the redefined sweeper functions.

**Exercised vs simulated (local-stack journey).** Exercised for real: sign-in, RPCs as the user, the function's sign /
commit / cancel, signed upload, server copy + read-back + SHA-256, registration, Storage RLS, and the sweeper
orchestration deleting real objects. Simulated: a worker stopping between steps (the same RPCs and copy are performed,
then the real function resumes), a lost response (the same request again), time passing (expiry columns moved by the
service role), and the pg_cron/pg_net ticket (the sweeper orchestration is called directly).

## Upload policy (tb-upload-policy-1) — PROVISIONAL, enforced

One module, `supabase/functions/_shared/uploadPolicy.ts`, enforced by the shared reader before any parse (so by
`process-trial-balance`, `trial-balance-layout` and `layout-assist`), mirrored for the browser (`src/lib/workspace/uploadPolicy.ts`)
and equal to the drafts migration's size CHECK (all held equal by `uploadPolicy.test.ts`). Current values: file 50 MB;
`.xlsx` expanded (declared, from the ZIP central directory, nothing inflated) 200 MB and 2,000 parts; 200,000 rows;
4,000,000 cells. Before this, the trial-balance path enforced **no** resource limit at all.

**Measured** (`scripts/bench/tbUploadPolicyBench.mjs`, invented balanced TBs, real shared reader + ingestion, one fresh process
per case; Bun 1.3.14 on Windows — NOT the hosted Deno Edge Runtime, so absolute numbers differ there; process baseline ≈130 MB):

| Input | File | Expanded | Read + ingest | Peak RSS |
|---|---|---|---|---|
| CSV 10k rows | 0.4 MB | — | 0.14 s | 165 MB |
| CSV 100k rows | 4.0 MB | — | 1.6 s | 290 MB |
| XLSX 10k rows | 1.6 MB | 1.6 MB | 0.4 s | 205 MB |
| XLSX 50k rows | 8.1 MB | 8.1 MB | 1.7 s | 347 MB |
| XLSX 100k rows | 16.3 MB | 16.3 MB | 3.0 s | 570 MB |
| XLSX (deflated) 100k rows | 6.1 MB | 16.3 MB | 5.7 s | 548 MB |
| XLSX 200k rows (refused: rows) | 33.3 MB | 33.3 MB | 5.8 s | 790 MB |
| 4 concurrent XLSX 100k (separate processes) | | | 7.8 s wall | ≈567 MB each |

Findings: (1) workbook memory grows ≈27 bytes per expanded byte; (2) the row/cell limits apply only AFTER the spreadsheet
library has parsed the workbook, so for `.xlsx` the expanded-size limit is the real memory guard; (3) at today's values a
single accepted workbook can exceed any plausible single-invocation memory budget; (4) the declared-size check stops ordinary
compression bombs but trusts the archive's own directory (a forged directory could understate sizes) — a streaming,
capped inflate is the stronger guard and is not built; (5) not yet measured in the hosted Edge Runtime (needs a deployment).

## Phase 5/6 compatibility with Phase 2 (assessed 16 October against #138 `403b312`)

Compatible, with these points to settle before Phase 6:
1. **Input is a committed upload only.** Drafts are never review input; a draft becomes a `trial_balance_uploads` row only
   through commit. `ReviewInputIdentity` (upload, `source_file_hash`, layout profile, period, currency) applies unchanged.
2. **One content identity.** `source_file_hash` is SHA-256 of the exact raw bytes (process-trial-balance), which is what a
   draft commit verifies its workspace copy against (`content_sha256`), so a committed draft and its processed upload carry
   the same hash. Phase 6 should read this, not add a second file identity.
3. **Parser version.** #138 cites `tb-ingest-3.0.0`; current is `tb-ingest-3.2.0` (#135). Read `TB_INGESTION_VERSION`, never a
   literal.
4. **Period and currency authority.** `ReviewInputIdentity.periodId` is required, but a commit's `period_id` may be null
   (legacy year-only uploads), and the commit's `confirmation.currency` is a record of what the user saw, not the currency
   authority (`fiscal_periods.reporting_currency`). P2-3 must persist the confirmed period and currency through the existing
   period authority before commit; Phase 6 must treat a null period as a context gap, not assume one.
5. **Replacement.** Draft commit registers initial uploads only; a period with an active trial balance answers
   `active_upload_exists`. Replace-from-draft (via `retire_trial_balance_upload`) is not built; Phase 6 reuse
   (`STALE_IDENTITY`/`STALE_MEANING` on a repeat upload) depends on it or on the existing replace path.
6. **One status vocabulary.** Phase 6 readiness words must map onto `src/lib/workspace/resultStatus.ts` (Phase 1).
7. **No competing mapping mechanism** is built by Phase 2; mapping authority stays `resolve_account_review_batch`.

**Proposed file ownership (to agree before any shared production edit):**
- Core journey/integration (this session): `supabase/migrations/20261106100000_*`, `supabase/functions/trial-balance-draft/`,
  `_shared/draftUpload.ts`, `_shared/sourceSweeper.ts`, `_shared/tbIngestion.ts`, `_shared/printedReportMetadata.ts`,
  `src/lib/workspace/**` (incl. `resultStatus.ts`, `trialBalanceDraft.ts`, `onboardingState.ts`), `src/pages/workspace/**`,
  `src/components/workspace/**`, `roadmap.md`, the CLAUDE.md file map, `.github/workflows/ci.yml`, migration-order registries.
- Phase 6 (proposed, separate session): new files under an agreed `src/lib/accounting/interpretation/**` (pure), one read-only
  summary projection, its contract tests.
- Shared, edit only by agreement per change: `AccountReviewPanel.tsx`, `buildReviewDecisions.ts`,
  `resolve_account_review_batch`, `ci.yml`, CLAUDE.md, registries. UI wiring of Phase 6 into the review step goes through the
  core journey owner.

## Outstanding owner decisions

1. **#132/#133 integration**: recommended arrangement is the combined candidate draft #137 (current `main` + #132 + #133,
   no file overlap); merge only with every required check green on its final head. No merge permission is assumed.
2. **Draft size cap**: now part of the one upload policy — see decision 6.
3. **Hosted application** of `20261106100000` and deployment of `trial-balance-draft`: owner/Lovable only; not requested.
4. **Payments** stay disabled until Polar and Snippe both pass (decided 14 October; restated 15 October).
5. **Phase 6** scope and the file-ownership split above.
6. **Upload policy values.** Recommendation from the measurements: file 15 MB, `.xlsx` expanded 16 MB, 100,000 rows, 2,000,000 cells (typical trial balances are well under 5,000 rows), then confirm with one measured run in the hosted Edge Runtime before publishing the limits to customers.

## Earlier notes (kept)

Ω2 sandbox GLOBAL offer creation (TEST data only)

- [x] Frontend-only onboarding and plan presentation: no-plan first-run, archive preservation, current plan, capacity-only Add entity boundary, public access-request removal, tests and private screenshots. No publication.
