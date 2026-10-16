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
| **P2-4 (current)** | DONE in code: returning Home compact upload (outline, above the one next action); upload to an existing entity with the currency pre-filled from its confirmed period (source shown) and the following year as a suggestion only; purchase-required path (no plan: draft kept, 'Choose a plan', 'Continue with' the same draft and card afterwards); Orders → Settings › Billing (`/settings/billing`, `/billing/orders` redirects with query). Safe replacement from a draft (retire_trial_balance_upload; current kept if it fails; stale version refused). A locked stage's tab shows the state engine's own one-line blocker (e.g. Reconcile waiting for a certified trial balance) instead of a generic sentence; the locked tab still opens the stage's explanation with its link to the prerequisite (investigation stays reachable). NOT YET: entity list redesign (entity · latest period · service · status), the unresolved-payment notice | IMPLEMENTED — exact-head CI on `a8aa55d` / candidate `1eee1d9` running |
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
| #139 `1eee1d9` (combined candidate: main `00a2653` + #137 + #136 at `a8aa55d`) | 38871104237 | **Every required job green** (Staging RLS skipped, as on every PR), including P2-4 and the safe replacement. Earlier green heads do not cover later commits. |
| #137 `f12ebcf` (#132 + #133 on main `00a2653`) | 38853015089 | **Every job green** (Staging RLS skipped, as on every PR). |

Locally on PostgreSQL 16 (embedded): drafts proof 71/71; existing shared-source proof 44/44 and upload-lifecycle proof
207/207 unchanged with the redefined sweeper functions.

**Exercised vs simulated (local-stack journey).** Exercised for real: sign-in, RPCs as the user, the function's sign /
commit / cancel, signed upload, server copy + read-back + SHA-256, registration, Storage RLS, and the sweeper
orchestration deleting real objects. Simulated: a worker stopping between steps (the same RPCs and copy are performed,
then the real function resumes), a lost response (the same request again), time passing (expiry columns moved by the
service role), and the pg_cron/pg_net ticket (the sweeper orchestration is called directly).

## Upload policy (tb-upload-policy-3) — PROVISIONAL values, ENFORCED in code, NOT deployed

One module, `supabase/functions/_shared/uploadPolicy.ts`, mirrored for the browser (`src/lib/workspace/uploadPolicy.ts`) and
equal to the drafts migration's size CHECK (held equal by `uploadPolicy.test.ts`). Before this work the trial-balance path
enforced **no** resource limit at all.

**Enforcement (in code since `c532eda`/`fac0304`; deployed nowhere):** on the downloaded bytes, before any reader, at every
entry point (`process-trial-balance` — also before its audited-accounts workbook probe — and `trial-balance-layout`'s
`openUpload`, which serves `layout-assist`): (1) raw size; (2) for `.xlsx`/`.xlsm`, every entry inflated as a STREAM and its
REAL output counted, cut off at the limit (a package whose directory understates its sizes is caught; declared sizes are only
a first filter); (3) during the parse, at most limit + 1 rows per sheet (`sheetRows`) and per CSV (`parseCsvText` bound);
(4) rows and cells after reading. Every refusal is a named, blocking issue with no rows accepted and no totals — never a
truncation or a partial acceptance.

**Values (provisional, owner approval pending), set from measurement — on the REAL function, not only the parser.** A first
setting of 25,000 rows passed the bare Deno probe (45 MB heap, 0.45 s) but, in the real `process-trial-balance` on the local
Edge Runtime, a 25,000-line workbook exhausted the worker (HTTP 546 after 2.3 s; the upload left "processing" until the
attempt lease frees it). The values were therefore lowered, and the drafts journey now processes a workbook and a CSV EXACTLY
at the limit through the real function (must answer 200 with every account read) and one row over (must be refused by name):

| Limit | Value | Why |
|---|---|---|
| Raw upload / storage (draft and file) | 10 MB | separate from parse limits; a raw byte cap, not a memory guard |
| Workbook ACTUAL expansion | 2 MB | a 10,000-row workbook ≈ 1.6 MB expanded |
| Rows (lines, header included) | 10,000 | about twice a large trial balance (typical < 5,000) |
| Cells | 120,000 | 10,000 lines × 12 columns |
| Workbook parts | 2,000 | unchanged |
| **Accounts** (after reading; repair A) | **2,000** | one certification holds every certified account: `rows_snapshot` CHECK 1 MiB holds about 2,600 realistic accounts (≈400 bytes each, measured); four dependency keys per account fit the 20,000-key cap. Refused whole before any check (`TOO_MANY_ACCOUNTS`) |
| Certified-rows payload | 900,000 bytes (JSON) | under the 1,048,576-byte stored CHECK with margin; over it the attempt fails explicitly (`CERTIFIED_ROWS_TOO_LARGE`) |
| Simultaneous checks, across all workers (repair A) | 2 (two leased slots in `tb_processing_slots`); others wait ≤ 25 s, then 503 `PROCESSING_BUSY` before anything begins | measured on the local Edge Runtime: 2 at the account limit complete; 4 returned HTTP 546, also with a per-worker limit alone (requests are not all served by one worker) |

**Measurement (Deno 2.9.6 / V8 15.0, the Edge Runtime's engine, HARD 150 MB heap cap, one process per invented case, CI
run on `ba36380`):** CSV 10k/25k/50k/100k/150k rows fitted (heap 18/39/66/100/134 MB, 0.07–0.76 s); XLSX 5k/10k/25k/50k/75k
rows fitted (heap 18/21/54/100/115 MB, 0.13–1.5 s); **XLSX 100,000 rows (16.3 MB expanded) TERMINATED**, plain and deflated —
which the previous provisional limits (50 MB file, 200 MB expansion, 200,000 rows) would have admitted. The probe now
brackets the new limits (within, one over, far over, and a package declaring 10 bytes that inflates to 512 MB): results on
`fac0304`. Earlier Bun runs (local, not the hosted engine) showed the same shape (≈27 bytes of memory per expanded byte;
4 concurrent 100k-row workbooks ≈567 MB each — memory is per invocation, not shared).

**Demonstrated on the real function (local stack, drafts journey on `fac0304`):** a package that understates its expansion,
a CSV one row over and a workbook one row over are each refused by name by `process-trial-balance`, with no accounts and no
totals recorded; an ordinary file processed afterwards succeeds.

**Certification-layer capacity — REPAIRED in code (repair A, draft #141); VERIFIED END TO END on the local stack inside the
combined candidate #139; not integrated, not deployed.** The pre-existing defect: `tb_certifications.exceptions` CHECK
`pg_column_size <= 65536` (uncompressed) refused a first upload of roughly 340+ unclassified accounts (23514; 300 realistic
findings = 56,787 bytes, 400 = 75,706 — not a fixed threshold, it depends on names), and one 2,000-account run took 4,000
advisory locks in one transaction (20,000 exhaust the shared lock table, 53200). Repaired: every finding in
`tb_certification_findings` (append-only, under the attempt fence, traceable to upload / attempt / engine version); a bounded,
database-checked summary on the row; a database-computed SHA-256 of the complete findings; output_hash binding certified rows
and complete findings; every dependency key recorded, per-account locks only up to 1,000 keys; the account bound; controlled
admission. On the real function: 1,000 and 2,000 accounts as XLSX, CSV and XLS, multi-sheet, sparse (10,000 lines) and wide
(105,070 cells) processed in full with every finding stored; every over-limit file refused by name, nothing recorded.

**Remaining runtime limitations (stated, not solved):** (a) the hosted Edge Runtime's own memory/CPU limits have not been
measured on the hosted project (needs an authorised deployment); the 150 MB cap is a stand-in; (b) JavaScript cannot
preempt a synchronous parse, so time is bounded by the size limits, not by a timer — the runtime's wall-clock kill and the
processing attempt lease are the backstop; (c) `.xls` (BIFF) has no expansion step; it is bounded by raw size and the row
bound during the parse; (d) the draft commit reads the stored file whole to hash it (bounded by the 10 MB raw limit).

## Processing-integrity repairs (authorised 16 October: code, migrations, isolated tests only)

| Repair | PR (draft) | Status | Evidence |
|---|---|---|---|
| A — certification capacity: complete findings, bounded summary, account bound, bounded locks, controlled admission; migration `20261107100000` | #141, stacked on #136 | VERIFIED END TO END (local stack, in #139) | `certificationCapacity.mjs` 45/45 (reproduction first; concurrent mapping changes during finalisation; a decision through the real review RPC); real handler 36/36; drafts journey at every limit and 4-/8-way concurrency |
| B — same-name/different-code identity: codeless-only name uniqueness, candidate-counting name match (generation 6); migration `20261108100000` | #142, stacked on #141 | VERIFIED IN ISOLATION; #138's real-contract proof with B: 27/27 on PostgreSQL 17.11 (run 38888832644, evidence branch #140) | `accountIdentity.mjs` 22/22 through the real review RPC (reproduction first; history byte-identical; tenants; 12-way; impact queries read-only and finding a seeded reuse); matcher 8/8 |
| C — concurrent sealing: a failed seal never removes the canonical object; defined orphan retention and cleanup | #143, on `main` | VERIFIED IN ISOLATION | `billingSuspension.mjs` 61/61; deterministic interleaving fails without the repair (52/54) |
| Combined | #139 head `b24843e` = `main` `00a2653` + #137 + #142 + #143 | see the PR's final-head run | the integration vehicle (merge and release remain separate decisions) |

**Dependency invalidation outside the summary (A):** every key is recorded, so the summary's examples play no part in
invalidation. Proven: a change to an account not among the examples, before finalisation → DEPENDENCY_CHANGED; after it →
authority lost at once; a mapping transaction open across finalisation and committed after it → authority lost; 12 rounds of
finalisation racing a mapping write → never an authoritative result on a changed dependency; a review decision → same.

**Concurrency (A):** at most two checks run at once across every worker — each holds one of two leased database slots
(`tb_processing_slots`, claimed with SKIP LOCKED before anything is read; a killed worker's slot frees when its 60 s lease
expires) as well as a per-worker slot. A per-worker limit alone was measured insufficient (CI run 38889700399: 4-way still
546 twice). The rest wait (≤ 25 s) or are refused
BEFORE anything begins (503 `PROCESSING_BUSY`: no attempt, no lease, nothing recorded or consumed) and the browser's
existing retry path repeats the same request. Journey: 4- and 8-way at the account limit, each processed exactly once (one
attempt, one certification, complete findings) or refused as busy and then completed by a retry; nothing stranded.
Supported: 2 simultaneous 2,000-account checks (local Edge Runtime); hosted limits unmeasured (the slot count is one
table row per slot, adjustable by the owner after hosted measurement). A worker killed
for another reason still leaves its attempt leased for 600 s (retries answer "in progress"; the lease then frees it).

**C classification and orphan design:** CI's `object_missing` came from a fixture defect (the proof's storage double exposed
bytes before the `storage.objects` row); under it was a product race (a failed seal removed the object a concurrent seal
was committing). Unsealed canonical objects are now kept: the bucket is private with no client storage policy; they are
never official; a retry re-checks authority (a downgraded account cannot seal its orphan); `reportingPackOrphans.mjs` is the
only deletion rule — after the issuance's expiry plus one hour (an expired issuance can never be sealed), never a sealed
artefact, re-decided right before each deletion; failed deletions are retried by the next run. Not scheduled yet.
Contract change for the owner: a last-moment refusal no longer removes the canonical object (see #143).

**Impact detection (read-only, owner):** `scripts/db-preflight/processingIntegrityImpact.sql` — possible past wrong-code reuse
(accounts certified by name after a decision existed only under another code), attempts that never finished, uploads never
certified, certifications near the bound, same-name review conflicts, sealed packs without their object. Log absence alone
does not establish no impact; findings are resolved by new reviews and new linked versions, never by editing history.

**Rollout (owner; nothing here is applied or deployed):** 1. apply `20261106100000`, `20261107100000`, `20261108100000` in
order (each has a preflight; all additive); 2. deploy `process-trial-balance` (generation 6), `trial-balance-draft` and
`seal-reporting-pack`; 3. read back: a small and a 2,000-account synthetic upload (findings count = findings stored;
`findings_sha256` recomputed), a same-name pair reviewed, a sealed pack verifies intact; 4. run the impact queries;
5. raise `min_engine_generation` to 6. **Recovery:** generation 6 on a database without `20261107100000` refuses large
certifications explicitly (FINDINGS_STORE_UNAVAILABLE); lowering the floor and redeploying the previous function is safe
before any generation-5+ certification exists; `20261108100000` reverses only while no two coded accounts of a company share
a name (never merged to make it fit).

**Remaining blockers:** hosted runtime limits unmeasured (needs an authorised deployment); orphan cleanup not scheduled;
#136, #141 and #142 alone carry the payment baselines that #133 (in #137) fixes, and #136 alone is red at the limits — the
combined candidate is the vehicle, not any single PR.

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
5. **Replacement.** Built (P2-4): a draft replaces the period's active trial balance only by the user's choice, through
   `retire_trial_balance_upload` (the old upload superseded and kept, linked by `replaces_upload_id`). Phase 6 reuse
   (`STALE_IDENTITY`/`STALE_MEANING` on a repeat upload) can rely on that link.
6. **One status vocabulary.** Phase 6 readiness words must map onto `src/lib/workspace/resultStatus.ts` (Phase 1).
7. **No competing mapping mechanism** is built by Phase 2; mapping authority stays `resolve_account_review_batch`.

**Evidence check of #138 at `3349527` (16 October, run here on an isolated branch = combined candidate + #138's
`research/phase5/**`; #138's branch itself untouched):**

| Class | What | Result |
|---|---|---|
| Prototype | `tests/phase5.test.mjs`, `tests/coverage.test.mjs` | PASS |
| Static (reads SQL/source text; no database) | `tests/real_contract_static.mjs`, `proof/real_layout_contract.mjs` | PASS |
| Database (actual RPC on the replayed authoritative chain) | `proof/real_contract_proof.mjs` on embedded **PostgreSQL 16.14** (no 17 available locally; hosted is 17) | **FAILS before any RPC**: the chain replays (177 files), then the proof's own fixture stops with `SEAT_LIMIT_REACHED` — its licence (line 53) grants no additional seats and line 86 adds two members. Fix belongs to the #138 owner (grant seats as the other proofs do). |
| Authenticated runtime (local stack / hosted) | — | NONE |

Further findings for the #138 owner: (a) the proof's PASS line hard-codes "applied on PostgreSQL 17" whatever the server
is — it should print `SHOW server_version`; (b) `prototype/layer4_treatment.mjs` contains a literal NUL byte (an intended
`"\x00"` separator written as the raw byte at offset 3344), so Git treats the file as binary and review diffs are lost;
(c) `TB_INGESTION_VERSION` is cited as `tb-ingest-3.0.0` (current 3.2.0). A PostgreSQL 17 run is to follow in CI (a
`postgres:17` service) once the fixture is fixed — running it now would fail at the same step.

**#138 actual-RPC proof — reconciled with #138 `5a06e56` (evidence branch commit `2632348`, draft #140, never to be merged).**
The owner adopted two corrections (seats via the supported `NAMED_USER_SEATS` entitlement override; the real server version
printed). Two remain, labelled `EVIDENCE-BRANCH CORRECTION` for the owner to adopt: the `extensions` schema setup and the
next-period repeat upload. The `extensions.digest` setup exposes the SAME pgcrypto function hosted Supabase installs in
`extensions` (verified in the run: SHA-256 test vector for "abc", identical through both schemas) — it replaces no
application logic.

| Class | Result |
|---|---|
| Fixture setup failures (not evidence either way) | seats (fixed by the owner), `extensions` schema, two active uploads in one period — all corrected; none remain |
| Expected refusals (executed against the real RPC) | PASS: non-member, cross-tenant, viewer, empty batch, AUTO_MAPPED_RULE, invalid action, cash-flow classification, statement/classification mismatch, changed payload under one key, mixed manual batch (atomic) |
| Positive paths | PASS: idempotent replay, atomic abort with nothing persisted, company-scoped reuse on a repeat upload, the manual multi-account path (one attributable decision per account), conflict serialisation with both decisions in the ledger |
| **Genuine product incompatibility** | **FAIL: same name, different codes** (below) |

**PostgreSQL 17.11 (CI, isolated `postgres:17` container, run 38874699334 on `2632348`): 24/25** — the extensions setup and the
seat override pass; the only failure is the same-name finding. PostgreSQL 16.14 (local): 24/25, identical. Authenticated
runtime (local stack / hosted): none.

**Identity-model compatibility finding (not fixed; recommendation for owner approval).** The decision key is
`account_key = COALESCE(account_code, normalized_account_name)` (unique `(company_id, account_key)`; every review write is
`ON CONFLICT (company_id, account_key)`). The older index `uq_acct_map_company_norm_name (company_id,
normalized_account_name)` was kept "as belt-and-suspenders" and enforces a DIFFERENT identity — name per company — so two
coded accounts with the same name (`4000 Sales`, `4100 Sales`) cannot both be mapped, and the real RPC fails with a raw
constraint violation. This affects today's Account Review too, not only Phase 6. Affected: that index; the review RPC's
writes; `process-trial-balance`'s Tier 2 `companyByName` (a last-wins `Map`, deterministic today only because of that
index); the `account_review_decisions` key (`review_account_key` = `account_key`, already code-based — unaffected).
**Smallest compatible resolution:** (1) a forward migration that replaces the name index with
`UNIQUE (company_id, normalized_account_name) WHERE account_code IS NULL` — name identity only for codeless accounts, exactly
what `account_key` already means; code identity and `(company_id, account_key)` unchanged; `company_id` stays in every key
(tenant isolation unchanged); no identity is merged; (2) Tier 2 name matching in `process-trial-balance` reads only codeless
reviewed mappings, and a name shared by several coded mappings matches none (falls to review), never last-wins. A cleaner
error alone would not establish support; this needs its own migration, proof and owner approval.

**Phase 6 reuse rule (agreed constraint):** a reviewed decision is reused only where the context it was accepted in is
recorded and verified compatible (same company, the same account identity, a compatible chart/source and reporting context);
absent or unverifiable accepting context requires renewed confirmation — never silent reuse on `company_id + account_key`
alone. NOTE (existing behaviour, registered not changed): today `process-trial-balance` already applies a company's reviewed
mapping to any later upload by code (Tier 1) without such a context check; Phase 6 must not extend that, and its reuse
authority is where the context binding belongs.

**Evidence principles (owner, 16 October) — binding on Phase 2 output and on Phase 6:** two trial balances establish NET
movements per account, not their cash/non-cash composition (cash flow needs ledger evidence); a source imbalance stays
visible after balanced adjustments (adjustments never restate the source result); signed prior statements are identified
separately from later comparatives; amounts are exact minor units and display rounding is labelled as display (pinned:
`trialBalanceExactTotals`, `phase1Acceptance`); corrections create linked source versions and never overwrite history
(replacement: `replaces_upload_id`, old upload superseded and kept — proven); unexplained differences are described
neutrally, with amounts and no cause (pinned in `phase1Acceptance`).

**Contract points to agree before Phase 6 (beyond byte identity):** entity — mappings are company-scoped by `account_key`;
period — Phase 2 binds period year + dated period, but legacy uploads may have no `period_id`; currency — the dated period's
`reporting_currency` is the authority (the commit's confirmation is a record of what was confirmed); dimensions — #138
proposes none (no cost-centre/segment axis), so reuse is per company + account key only; permissions —
`resolve_account_review_batch`'s own capability check is the authority, and every group acceptance must expand to
per-account decisions each validated and attributed to the reviewing firm member (no inferred common treatment for accounts
that merely share an uncertainty flag); versions — reuse must be bound to the upload's `source_file_hash` and the parser
version read from code; reviewer semantics — `USER_ACCEPTED_SUGGESTION` per account, latest `sequence_no` wins, history
never rewritten.

**Proposed file ownership — NOT YET AGREED (posted on #138, no response from its owner yet; no shared production edit until
agreed):**
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

1. **Integration**: the combined candidate is draft #139 (current `main` + #137 [= #132 + #133] + #136). Merge only on an
   authorised decision with every required check green on its final head. No merge permission is assumed; #134 and #140
   are evidence-only and never merged.
2. **Draft size cap**: now part of the one upload policy — see decision 6.
3. **Hosted application** of `20261106100000` and deployment of `trial-balance-draft`: owner/Lovable only; not requested.
4. **Payments** stay disabled until Polar and Snippe both pass (decided 14 October; restated 15 October).
5. **Phase 6** scope and the file-ownership split above.
6. **Upload policy values (tb-upload-policy-2).** Approve, or change, the measured provisional values above (raw 10 MB; actual workbook expansion 6 MB; 25,000 rows; 300,000 cells) before they are shown to customers, and authorise one measured run in the hosted Edge Runtime.
7. **Identity model.** Approve the same-name/different-code resolution above (a forward migration and a Tier 2 matching change), as its own batch.

## Earlier notes (kept)

Ω2 sandbox GLOBAL offer creation (TEST data only)

- [x] Frontend-only onboarding and plan presentation: no-plan first-run, archive preservation, current plan, capacity-only Add entity boundary, public access-request removal, tests and private screenshots. No publication.
