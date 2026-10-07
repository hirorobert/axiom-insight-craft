# R0 integrity programme — coordinated deployment runbook

One runbook for H1, the treatment UI (FT), E1, F1b, S2/E2 and F2 (PRs #58 → #63). **This document authorizes nothing.**
Every merge, frontend publication, hosted migration apply and Edge Function deploy below remains a separate decision. They
are executed by the owner or Lovable, never by Claude Code: production is not reachable from here, and a merge is not a
publication, a function deploy or a migration apply.

S1 (hosted 0028) stays exactly as deployed. Nothing here edits an applied migration.

## Three corrections to the first draft
1. **One frontend publication.** Lovable publishes `main`, so after the ordered merge a single publication ships all four
   frontends at once (FT, E1's re-run path, F1b, F2). The first draft scheduled them one by one, which can't happen.
   - The combined frontend is now **compatible with every backend stage**: production today (S1), H1, E1 and S2/E2.
   - It is published **once, before any backend step** (§2).
   - Proven in `src/lib/workspace/releaseCompatibility.test.ts` (the stage matrix below). F2 is silent until S2 exists (it no longer shows "Status unknown" when the reads are missing).
2. **A tested engine × schema matrix** (§1). Every combination the rollout can produce, or produce by mistake, is proven. The two wrong orders (E1 before H1, E2 before S2) fail safe: no run, no certification, no status change.
3. **Server-side restrictions for the open downstream defects** (§5). `kinga-findings-engine` and `maono-compute` now refuse every request on the server, before authenticating or reading. The withheld-capability list only hid them in the product.

## 1. What is tested together

### Frontend (one bundle) × backend stage
`src/lib/workspace/releaseCompatibility.test.ts`, plus each feature's own suite.

| Feature | S1 (today) | + H1 | + E1 | + S2/E2 |
|---|---|---|---|---|
| FT: keep-as-mapped option | never offered | never offered | offered on flagged rows | offered on flagged rows |
| FT: no exclusion of a non-zero balance | enforced | enforced | enforced | enforced |
| E1: re-run through `tbu_request_reprocess` | accepted (S1 RPC) | accepted, or `PROCESSING_HELD` | accepted, or held | accepted, preempts a running check |
| F1b: exact amounts | legacy display | legacy display | exact, or "Result unavailable" | exact, or "Result unavailable" |
| F2: notice and history | silent (no RPC) | silent | silent | shown |

### Engine × schema
Real handlers on real PostgreSQL.

| Engine \ schema | S1 (today) | + H1 | + S2 |
|---|---|---|---|
| Before E1 (`9b0c2fd`, production) | production today | runs: no hold and no floor (H2 gate on the H1 chain); refused below floor 2 (H1 proof) | **refused at its first write, rows unchanged** (characterization X8) |
| E1 (`602484d`) | **fails safe: no run, no certification, status restored** (H1 proof, new) | runs, generation 2 (H1 proof; E1 gate) | **refused at its first write, rows unchanged** (X8) |
| E2 (#62/#63 head) | **fails safe** (H1 proof, new) | **fails safe** (H1 proof) | runs: characterization 33/33 |

The rollout uses only these cells: before-E1 on S1 → before-E1 on H1 → E1 on H1 → E2 on S2.

## 0. Before anything
- [ ] **CI green at the exact head of every PR.**
- [ ] **Merge in order** #58 → #59 → #60 → #61 → #62 → #63, **with merge commits**.
  - Two engine commits are pinned by SHA in `scripts/db-proof/fixtures/h2-known-defects.json` and must stay reachable from `main`: `9b0c2fd` (the engine before E1) and `602484d` (E1).
  - A squash merge would orphan them.
- [ ] **G0: confirm the hosted Edge wall-clock limit `L`** and choose the drain bound `L + margin`. If `L` can't be confirmed, **stop**.
- [ ] **Confirm one commercial administrator** for `admin_set_processing_control` (a reason and the current `version` on every change).

Read-only checks (SQL editor, as an administrator):

```sql
SELECT * FROM public.processing_release_control;
SELECT count(*) FROM public.engine_runs WHERE function_name='process-trial-balance' AND status='running';
SELECT count(*) FROM public.trial_balance_uploads WHERE status='validating';
SELECT engine_version, engine_generation, count(*) FROM public.engine_runs
 WHERE function_name='process-trial-balance' AND started_at > now() - interval '1 day' GROUP BY 1,2;
```

## 2. Publish the frontend once (after the merge, before any backend step)
- [ ] **Publish `main`** at #63's merge.
- At this point the backend is still S1 with the engine before E1:
  - keep-as-mapped never appears;
  - re-runs go through `tbu_request_reprocess`, which is already live;
  - F1b shows legacy results conservatively;
  - F2 is silent.
- This also satisfies E1's precondition: the frontend that routes every re-run through the reprocess request is live before E1 is deployed.

## 3. H1: apply `20261007100000_treatment_authority_and_processing_control.sql`
- [ ] **Apply** (hosted).
- [ ] **Hosted read:**
  - the control row is open (`hold=false`, no floor, `version=1`);
  - `engine_runs.engine_generation` exists;
  - `admin_set_processing_control`, `admin_drain_processing`, `get_confirmed_treatments` and `treatment_request_id` exist.
- [ ] **Record PR** with the journal number, hash and applied timestamp.
- The engine before E1 keeps running unchanged (no hold, no floor).

## 4. C-E1 cut-over: deploy E1 (`process-trial-balance` only)
1. **Hold:** `admin_set_processing_control(true, '{}', NULL, 'E1 cut-over', <version>)`.
2. **Wait `L + margin`,** then `admin_drain_processing(<L + margin>, 'E1 cut-over drain')`.
   - Check: zero running runs started before `held_at`, and zero `validating` uploads without a live run.
3. **Deploy** `process-trial-balance` **at E1's commit `602484d`** (generation 2). Not the final head: that is E2, which needs S2.
4. **Canary:** `admin_set_processing_control(true, '{<demo company id>}', 2, 'E1 canary, floor 2', <version>)`. The floor is permanent.
5. **I-8 on the demo workspace:**
   - a synthetic upload reaches **Reviewed**;
   - `processing_result.amounts.contract = 'tb-amounts/1'`;
   - `engine_generation = 2`;
   - a closing-stock credit on a current asset raises "Keep as mapped or reclassify".
6. **Release:** `admin_set_processing_control(false, '{}', 2, 'E1 released', <version>)`.

If step 5 fails, stay held and fix forward. The floor can't be lowered.

## 5. C-S2 window: apply S2, deploy E2 and the restricted and consumer functions (one window; OD5)
Once S2 is applied, **only** E2 can process. Both earlier engines are refused at their first write (X8).

1. **Announce** the interruption window.
2. **Hold, wait `L + margin`, drain** (as in §4). Check: zero running runs, zero `validating` uploads without a live run.
3. **Apply** `20261008100000_processing_attempt_authority.sql`. **Hosted read:**
   - the attempt functions, `tb_upload_authority` and `tb_upload_attempts` exist;
   - `commit_tb_certification` raises `PT410`;
   - **OD1:** `get_authoritative_certification` returns nothing for periods certified before S2. Expected: "Needs re-check".
4. **Deploy at #63's head, in this window:**

   | Function | Why |
   |---|---|
   | `process-trial-balance` | E2: v3, generation 3, on the attempt functions |
   | `kinga-tax-engine` | authority or refuse |
   | `kinga-findings-engine` | **restricted: refuses every request** while DEFECT-KINGA-MAPPING-TENANCY-001 is open (also authority or refuse once lifted) |
   | `maono-compute` | **restricted: refuses every request** while DEFECT-MAONO-UNTRACKED-CLASSIFICATION-TABLES-001 is open |
   | `maono-cashflow` | exact `tb-row/1` fields validated (shared reader) |
   | `generate-disclosure-notes`, `generate-management-letter` | authority or refuse; no longer write into `processing_result` (fenced since S2) |
   | `comparative-assurance-engine`, `kinga-comparative-engine` | both periods must be authoritative |

5. **Canary with the floor at 3:** `admin_set_processing_control(true, '{<demo company id>}', 3, 'S2/E2 canary, floor 3', <version>)`.
6. **I-8 on the demo workspace:**
   - an existing result shows **Needs re-check** (F2 now active);
   - "Check again" runs one attempt (generation 3), which reaches **Reviewed**;
   - a mapping change gives **Needs re-check** at once;
   - a second "Check again" while one runs preempts it;
   - `kinga-findings-engine` and `maono-compute` answer 503 `SERVICE_RESTRICTED`.
7. **Release:** `admin_set_processing_control(false, '{}', 3, 'S2/E2 released', <version>)`.
8. **Record PR.**

S2 is forward-only and is never rolled back. If E2 can't be deployed, **stay held** and fix forward.

## 6. After the release
- [ ] **I-8 again**, recorded.
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
