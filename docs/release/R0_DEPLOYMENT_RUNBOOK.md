# R0 integrity programme — coordinated deployment runbook

One runbook for H1, the treatment UI (FT), E1, F1b, S2/E2 and F2 (PRs #58 → #63). **This document authorizes nothing.**
Every merge, frontend publication, hosted migration apply and Edge Function deploy below remains a separate decision. They
are executed by the owner or Lovable, never by Claude Code: production is not reachable from here, and a merge is not a
publication, a function deploy or a migration apply.

S1 (hosted 0028) stays exactly as deployed. Nothing here edits an applied migration.

## 0. Before anything
- [ ] **CI green at the exact head of every PR.**
- [ ] **Merge in order** #58 → #59 → #60 → #61 → #62 → #63, **with merge commits**, as the repository has done for #55–#57.
  - Two engine commits are pinned by SHA in `scripts/db-proof/fixtures/h2-known-defects.json` and must stay reachable from `main`:
    - `9b0c2fd` (the engine before E1);
    - `602484d` (E1).
  - A squash merge would orphan them, and the proofs that load them would fail.
- [ ] **G0: confirm the hosted Edge wall-clock limit `L`** (plan limit, in seconds) and choose the drain bound `L + margin`. If `L` can't be confirmed, **stop**: the drain is never assumed.
- [ ] **Confirm one commercial administrator** can call `admin_set_processing_control` (H1). Every control change needs a reason and the current `version`.

Read-only checks used below (run as an administrator in the SQL editor):

```sql
SELECT * FROM public.processing_release_control;                                          -- hold, held_at, canary, floor, version
SELECT count(*) FROM public.engine_runs WHERE function_name='process-trial-balance' AND status='running';
SELECT count(*) FROM public.trial_balance_uploads WHERE status='validating';
SELECT engine_version, engine_generation, count(*) FROM public.engine_runs
 WHERE function_name='process-trial-balance' AND started_at > now() - interval '1 day' GROUP BY 1,2;
```

## 1. H1: apply `20261007100000_treatment_authority_and_processing_control.sql`
- [ ] **Apply** (hosted).
- [ ] **Hosted read:**
  - the control row is open (`hold=false`, no floor, `version=1`);
  - `engine_runs.engine_generation` exists;
  - `admin_set_processing_control`, `admin_drain_processing`, `get_confirmed_treatments` and `treatment_request_id` exist.
- [ ] **Record PR** with the hosted journal number, hash and applied timestamp.
- The running engine is unaffected: with no hold and no floor, its runs are allowed.

## 2. Publish FT (treatment UI)
- [ ] **Publish the frontend** at #59's merge.
- Dormant until E1: nothing offers "Keep as mapped" until the engine emits a treatment request.

## 3. C-E1 cut-over: deploy E1 (`process-trial-balance` only)
1. **Hold:** `admin_set_processing_control(true, '{}', NULL, 'E1 cut-over', <version>)`.
2. **Wait `L + margin`,** then `admin_drain_processing(<L + margin>, 'E1 cut-over drain')`.
   - Check: zero `process-trial-balance` runs `running` that started before `held_at`, and zero `validating` uploads without a live run.
3. **Publish the frontend at #60's merge.**
   - It moves the audited-accounts re-run and the engine-failure retry onto `requestReprocess`.
   - It must be live **before or with** step 4: E1 refuses a direct re-run of a certified upload (`409 REPROCESS_REQUIRED`).
4. **Deploy** `process-trial-balance` (E1: v2, generation 2).
5. **Canary:** `admin_set_processing_control(true, '{<demo company id>}', 2, 'E1 canary, floor 2', <version>)`.
   - The floor rises permanently to 2; runs below it can never certify again.
6. **I-8 on the demo workspace:**
   - a synthetic upload reaches **Reviewed**;
   - `processing_result.amounts.contract = 'tb-amounts/1'`;
   - its run has `engine_generation = 2`;
   - a closing-stock credit on a current asset raises "Keep as mapped or reclassify".
7. **Release:** `admin_set_processing_control(false, '{}', 2, 'E1 released', <version>)`. The floor stays at 2.

If step 6 fails, **stay held**, fix forward, and redeploy E1. Lowering the floor is refused by design.

## 4. Publish F1b
- [ ] **Publish the frontend** at #61's merge.
- Results recorded by E1 now read "holds exactly". Legacy results keep "Not exactly verified".

## 5. C-S2 window: apply S2, deploy E2 (one window; OD5 bounded interruption)
S2 and E2 can't be split. Once S2 is applied, **only** E2 can process: the previous engines are refused at their first write (proven, X8).

1. **Announce** the interruption window (OD5).
2. **Hold, wait `L + margin`, drain** (as in step 3). Check: zero running runs, zero `validating` uploads without a live run.
3. **Apply** `20261008100000_processing_attempt_authority.sql`. **Hosted read:**
   - `tb_begin_attempt`, `tb_snapshot_dependencies`, `tb_finalize_attempt`, `tb_expire_attempts`, `tb_upload_authority` and `tb_upload_attempts` exist;
   - `SELECT public.commit_tb_certification(...)` raises `PT410 ENGINE_COMMIT_RETIRED` (use any ids: it raises before reading them);
   - **OD1:** `get_authoritative_certification` returns nothing for periods certified before S2, because every existing result is now history. **Expected: customers will see "Needs re-check".**
4. **Deploy these Edge Functions in the same window:**

   | Function | Why |
   |---|---|
   | `process-trial-balance` | E2: v3, generation 3, on the attempt functions |
   | `kinga-tax-engine`, `kinga-findings-engine` | authority or refuse (W3) |
   | `generate-disclosure-notes`, `generate-management-letter` | authority or refuse; no longer write into `processing_result`, which S2 fences |
   | `comparative-assurance-engine`, `kinga-comparative-engine` | share `_shared/comparativeAssurance.ts`: both periods must be authoritative |
   | `maono-compute`, `maono-cashflow` | share `_shared/certifiedTbSource.ts`: exact `tb-row/1` fields validated |

5. **Canary with the floor at 3:** `admin_set_processing_control(true, '{<demo company id>}', 3, 'S2/E2 canary, floor 3', <version>)`. This retires E1's runs too.
6. **I-8 on the demo workspace:**
   - an existing result shows **Needs re-check**;
   - "Check again" runs one attempt (`engine_runs.attempt_no`, `engine_generation = 3`), which reaches **Reviewed**;
   - a mapping change on one of its accounts gives **Needs re-check** at once;
   - a second "Check again" while one is running preempts it, so there is one live attempt;
   - no historical result shows as reviewed.
7. **Release:** `admin_set_processing_control(false, '{}', 3, 'S2/E2 released', <version>)`.
8. **Record PR** with the hosted journal number, hash and applied timestamp.

**Failure inside the window:** S2 is forward-only and is **never rolled back**. If E2 can't be deployed, **stay held**: no engine can write, and nothing is corrupted. Fix forward and deploy E2. If the canary fails after E2, stay held and fix forward.

## 6. Publish F2
- [ ] **Publish the frontend** at #63's merge, **after step 5.3** (it reads `tb_upload_authority` / `tb_upload_attempts`).
- Published earlier, it shows "Status unknown" and offers nothing.
- It shows: "Needs re-check", "Processing stopped", "Checking", "New check requested", "Retry now", and the processing history.

## 7. After the release
- [ ] **I-8 again** on the demo workspace (steps 3.6 and 5.6), recorded.
- [ ] **Watch the expiry pass:** `SELECT public.tb_expire_attempts();` (service role) abandons attempts whose lease expired. Schedule it, or rely on the next authorized request, which abandons an expired attempt too.

## Known limits carried by this release
- **Pre-S2 certifications are history (OD1).** Each period needs one "Check again" before tax, notes, letters, comparatives or MAONO use it. Each of those refuses without authority (`AUTHORITY_REQUIRED`).
- **Generated disclosure notes and management letters are returned, not stored.** Storing them needs its own table and review.
- **Legacy uploads outside any workspace can't be processed** (`COMPANY_REQUIRED`). Upload again inside a workspace.
- **Registered defects untouched by R0:** `DEFECT-KINGA-MAPPING-TENANCY-001`, `DEFECT-MAONO-UNTRACKED-CLASSIFICATION-TABLES-001` (`maono-compute`), `DEFECT-SAFISHA-TRANSACTION-LEDGER-GAP-001`, and the residual of `DEFECT-MAONO-CASHFLOW-CLASS-LEVEL-CONTAMINATION-001`.
- **Out of scope:** hybrid imports, expanded findings, statement generation, and the quarantined reconciliation migrations.
