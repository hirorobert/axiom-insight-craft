# R0 integrity programme — coordinated deployment runbook

One runbook for H1, the treatment UI (FT), E1, F1b, S2/E2 and F2 (PRs #58 → #63). **This document authorizes nothing.**
Every merge, frontend publication, hosted migration apply and Edge Function deploy below remains a separate decision. They
are executed by the owner or Lovable, never by Claude Code: production is not reachable from here, and a merge is not a
publication, a function deploy or a migration apply.

S1 (hosted 0028) stays exactly as deployed. Nothing here edits an applied migration.

## Corrections to the first draft
1. **One frontend publication.** Lovable publishes `main`, so after the ordered merge a single publication ships all four
   frontends at once (FT, the re-run path, F1b, F2). The first draft scheduled them one by one, which can't happen.
   - The combined frontend is **compatible with every backend stage** it will meet: production today (S1), H1, and S2/E2.
   - It is published **once, before any backend step** (§2).
   - Proven in `src/lib/workspace/releaseCompatibility.test.ts` (the stage matrix below). F2 is silent until S2 exists (it no longer shows "Status unknown" when the reads are missing).
2. **A tested engine × schema matrix** (§1). Every combination the rollout can produce, or produce by mistake, is proven. The wrong orders (E1 or E2 before H1, E2 before S2) fail safe: no run, no certification, no status change.
3. **Server-side restrictions for the open downstream defects** (§4). `kinga-findings-engine` and `maono-compute` refuse every request on the server, before authenticating or reading. The withheld-capability list only hid them in the product.
4. **No separate E1 production deployment (owner decision, Option 1).** Production Edge Functions are deployed only by
   Lovable, from the tree it syncs from `main`; after the ordered merge that tree is E2, so E1's pinned commit cannot be
   deployed. The engine goes straight from the engine before E1 (on H1) to E2 (on S2), in one held window, using only
   tested cells. E2 contains every E1 change, so E1's acceptance cases are run on the E2 canary instead (§4, step 6).
   - E1's commit `602484d` stays pinned (`scripts/db-proof/fixtures/h2-known-defects.json`) for the compatibility proofs: the H1 proof runs it on the pre-S2 chain, and the characterization proves it is refused once S2 is applied (X8).
   - E1's fixes reach production in the S2/E2 window, not before; until then production keeps today's engine, unchanged.

## 1. What is tested together

### Frontend (one bundle) × backend stage
`src/lib/workspace/releaseCompatibility.test.ts`, plus each feature's own suite. Production passes through S1 → H1 → S2/E2;
the E1 column is still tested (the bundle is compatible with it) but is no longer a production stage.

| Feature | S1 (today) | + H1 | (+ E1, not deployed) | + S2/E2 |
|---|---|---|---|---|
| FT: keep-as-mapped option | never offered | never offered | offered on flagged rows | offered on flagged rows |
| FT: no exclusion of a non-zero balance | enforced | enforced | enforced | enforced |
| Re-run through `tbu_request_reprocess` | accepted (S1 RPC) | accepted, or `PROCESSING_HELD` | accepted, or held | accepted, preempts a running check |
| F1b: exact amounts | legacy display | legacy display | exact, or "Result unavailable" | exact, or "Result unavailable" |
| F2: notice and history | silent (no RPC) | silent | silent | shown |

### Engine × schema
Real handlers on real PostgreSQL. **Production cells:** before-E1 on S1 (today) → before-E1 on H1 → E2 on S2.

| Engine \ schema | S1 (today) | + H1 | + S2 |
|---|---|---|---|
| Before E1 (`9b0c2fd`, production) | production today | runs: no hold and no floor (H2 gate on the H1 chain); refused below a floor (H1 proof) | **refused at its first write, rows unchanged** (characterization X8) |
| E1 (`602484d`, pinned for proofs only) | **fails safe: no run, no certification, status restored** (H1 proof) | runs, generation 2 (H1 proof; E1 gate) | **refused at its first write, rows unchanged** (X8) |
| E2 (#62/#63 head) | **fails safe** (H1 proof) | **fails safe** (H1 proof) | runs: characterization (all requirements) |

An accidental early deploy of E2 (before S2) therefore processes nothing and changes nothing; the fix is to deploy it in §4.

## 0. Before anything
- [ ] **CI green at the exact head of every PR.**
- [ ] **Merge in order** #58 → #59 → #60 → #61 → #62 → #63, **with merge commits**.
  - Two engine commits are pinned by SHA in `scripts/db-proof/fixtures/h2-known-defects.json` and must stay reachable from `main`: `9b0c2fd` (the engine before E1) and `602484d` (E1).
  - A squash merge would orphan them.
- [ ] **G0: confirm the hosted Edge wall-clock limit `L`** and choose the drain bound `L + margin`. If `L` can't be confirmed, **stop**.
- [ ] **Confirm one commercial administrator** for `admin_set_processing_control` (a reason and the current `version` on every change).
- [ ] **Choose the canary workspace** (a demo company with synthetic data only) and prepare the synthetic files listed in §4 step 6.

Read-only checks (SQL editor, as an administrator):

```sql
SELECT * FROM public.processing_release_control;
SELECT count(*) FROM public.engine_runs WHERE function_name='process-trial-balance' AND status='running';
SELECT count(*) FROM public.trial_balance_uploads WHERE status='validating';
SELECT engine_version, engine_generation, count(*) FROM public.engine_runs
 WHERE function_name='process-trial-balance' AND started_at > now() - interval '1 day' GROUP BY 1,2;
```

## 2. Publish the verified compatible frontend once (after the merge, before any backend step)
- [ ] **Publish `main`** at #63's merge. **Do not deploy any Edge Function** at this point.
- The backend is still S1 with the engine before E1:
  - keep-as-mapped never appears;
  - re-runs go through `tbu_request_reprocess`, which is already live;
  - F1b shows legacy results conservatively;
  - F2 is silent.
- [ ] **Check:** the published workspace loads, a re-run request is accepted, and no "Status unknown" notice appears.

## 3. H1: apply and verify `20261007100000_treatment_authority_and_processing_control.sql`
- [ ] **Apply** (hosted). File SHA-256 must equal the journal hash: `0010ec531f3924e3a63031a0f42185c94414ab72a15396b4a3d43499468092c6`.
- [ ] **Hosted read:**
  - the control row is open (`hold=false`, no floor, `version=1`);
  - `engine_runs.engine_generation` exists;
  - `admin_set_processing_control`, `admin_drain_processing`, `get_confirmed_treatments` and `treatment_request_id` exist.
- [ ] **Check:** the engine before E1 keeps processing unchanged (one synthetic re-run on the canary workspace completes).
- [ ] **Record PR** with the journal number, hash and applied timestamp.

## 4. S2/E2 window: hold, drain, apply S2, deploy E2, canary, release (one window; OD5)
Once S2 is applied, **only** E2 can process. The engine before E1 is refused at its first write (X8).

1. **Announce** the interruption window.
2. **Database-enforced hold:** `admin_set_processing_control(true, '{}', NULL, 'S2/E2 cut-over', <version>)`.
   From here every new processing request is refused by the database (`PROCESSING_HELD`), not by the frontend.
3. **Wait `L + margin`, then drain:** `admin_drain_processing(<L + margin>, 'S2/E2 cut-over drain')`.
   - Check: zero `process-trial-balance` runs `running`, and zero `validating` uploads without a live run.
   - If either is non-zero, **stop**; do not apply S2.
4. **Apply** `20261008100000_processing_attempt_authority.sql`. File SHA-256 must equal the journal hash:
   `6ad6ac7d6aac244950a0e69bd1c278bea1eee5ac9e12c98e541ca9c961c9c25d`. **Hosted read:**
   - `tb_begin_attempt`, `tb_snapshot_dependencies`, `tb_finalize_attempt`, `tb_expire_attempts`, `tb_upload_authority` and `tb_upload_attempts` exist;
   - `commit_tb_certification` raises `PT410`;
   - the hold is still on (`processing_release_control.hold = true`);
   - **OD1:** `get_authoritative_certification` returns nothing for periods certified before S2. Expected: "Needs re-check".
5. **Deploy the complete E2 function set from `main`, in this window** (every file's SHA-256 must match the deployment
   manifest `r0-deployment-manifests-d0d2e27.txt`, generated from #63's head):

   | Function | Why |
   |---|---|
   | `process-trial-balance` | E2: v3, generation 3, on the attempt functions |
   | `kinga-tax-engine` | authority or refuse |
   | `kinga-findings-engine` | **restricted: refuses every request** while DEFECT-KINGA-MAPPING-TENANCY-001 is open (also authority or refuse once lifted) |
   | `maono-compute` | **restricted: refuses every request** while DEFECT-MAONO-UNTRACKED-CLASSIFICATION-TABLES-001 is open |
   | `maono-cashflow` | exact `tb-row/1` fields validated (shared reader) |
   | `generate-disclosure-notes`, `generate-management-letter` | authority or refuse; no longer write into `processing_result` (fenced since S2) |
   | `comparative-assurance-engine`, `kinga-comparative-engine` | both periods must be authoritative |

   All nine are deployed before the canary. A partial set does not proceed to step 6.
6. **Generation-3 canary:** `admin_set_processing_control(true, '{<demo company id>}', 3, 'S2/E2 canary, floor 3', <version>)`.
   The floor goes straight from none to 3 and is permanent. Every check below runs on the canary workspace, with
   synthetic data, and is recorded with its upload id and result. **All must pass before step 7.**

   **E1 acceptance cases, carried onto E2:**
   - **Arithmetic:** a balanced file with thousands separators and two decimals reaches **Reviewed**;
     `processing_result.amounts.contract = 'tb-amounts/1'`, totals exact to the minor unit, `engine_generation = 3`.
     A three-decimal-currency period keeps amounts exact to 0.001 (exponent 3). An imbalance of one minor unit is blocked, not rounded.
   - **Cash:** a reviewed cash account is reported with cash marked as not checked against evidence; a cash flag on an
     account that is neither an asset nor a liability goes to review.
   - **Treatment:** a credit balance on a current asset named closing stock raises "Keep as mapped or reclassify" and moves
     no figures; confirming keep-as-mapped for that request completes it (a negative current asset); a debit closing-stock
     balance raises no question. A non-zero balance cannot be excluded.
   - **Equation:** a contra asset (accumulated depreciation, credit-normal) reduces assets and balances; a genuine
     balance-sheet equation failure cannot become authoritative; a legacy cash-flow-class mapping and a suppressed
     non-zero non-reporting account go to review.

   **S2/E2 cases:**
   - **History:** an existing pre-S2 result shows **Needs re-check** (F2 active); the processing history lists each attempt, newest first, with how it ended.
   - **Dependency staleness:** after a certified check, a mapping or review-decision change on an account it used turns it to **Needs re-check** at once (the certification itself is unchanged); a change to an account it did not use leaves it current.
   - **Retry and preemption:** repeating the same request replays the recorded outcome (no second run); a second "Check again" while one runs preempts it (the first records nothing; history shows `PREEMPTED`); "Retry now" appears only for an attempt whose lease expired.
   - **Restricted endpoints:** `kinga-findings-engine` and `maono-compute` answer 503 `SERVICE_RESTRICTED` with neutral copy, and write nothing.
   - **Consumers:** tax, notes, letters and comparatives refuse (`AUTHORITY_REQUIRED`) a period until its check is current, then work.
   - **Hold boundary:** a workspace outside the canary is still refused (`PROCESSING_HELD`).

   If any check fails: **stay held**, fix forward (a new reviewed change, redeployed in this window), and repeat step 6.
7. **Release processing** only after every step-6 check passed and is recorded:
   `admin_set_processing_control(false, '{}', 3, 'S2/E2 released', <version>)`.
8. **Record PR** (journal number, hash, applied and released timestamps, the step-6 record).

S2 is forward-only and is never rolled back. If E2 can't be deployed or a canary check fails, **stay held** and fix forward.

## 5. After the release
- [ ] **The step-6 checks again** on the canary workspace, recorded.
- [ ] **Expiry pass:** schedule `SELECT public.tb_expire_attempts();` (service role), or rely on the next authorized request, which also abandons an expired attempt.

## Known limits carried by this release
- **Pre-S2 certifications are history (OD1).** Each period needs one "Check again" before tax, notes, letters, comparatives or MAONO use it (`AUTHORITY_REQUIRED` otherwise).
- **Generated notes and letters are returned, not stored.** Storage needs its own table and review.
- **Legacy uploads outside any workspace can't be processed** (`COMPANY_REQUIRED`).
- **Restricted on the server until fixed** (`_shared/openDefectRestriction.ts`; lifted only by the fix's own reviewed change):
  - `kinga-findings-engine` (DEFECT-KINGA-MAPPING-TENANCY-001);
  - `maono-compute` (DEFECT-MAONO-UNTRACKED-CLASSIFICATION-TABLES-001).
- **Not restricted, disclosed instead:**
  - `maono-cashflow`'s class-level limitation (DEFECT-MAONO-CASHFLOW-CLASS-LEVEL-CONTAMINATION-001 residual). Every response states it in `balance_authority`, and its balances come only from the authoritative certification.
  - DEFECT-SAFISHA-TRANSACTION-LEDGER-GAP-001 is a missing capability with no live defective path.
- **Out of scope:** hybrid imports, expanded findings, statement generation, the quarantined reconciliation migrations.
