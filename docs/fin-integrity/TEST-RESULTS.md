# WS-A TEST RESULTS — EXECUTED on PostgreSQL 17 (CI)

**Branch:** `fix/signoff-authorization-20261014` · **head:** `9dec395` · **target:** legacy `statement_sign_offs` authorization.
**Runtime:** no Docker/PG locally (embedded-PG fails on this Windows host), so per the directive the proof was run as a **disposable CI database job** against a **PostgreSQL 17.11** service container (GitHub Actions, `.github/workflows/signoff-proof.yml`). Synthetic fixtures only; loopback-only; the production project ref is refused; no production credentials or data.

**CI run:** `signoff-authorization-proof` #38530479479 — **success** (1m04s). Re-runnable via `workflow_dispatch` or any push to the branch.

## Proof tiers (distinguished per the directive)
- **Focused fixture proof (EXECUTED):** `scripts/db-proof/signoff_fixture_proof.mjs` — stands up the REAL `statement_sign_offs` table, the REAL trigger function bodies (`hesabu_block_signoff`, `enforce_sso_distinct_signers`, `cascade_period_lock`, `statement_sign_off_certification_wall`), the REAL final capability-split RLS policies (as read back from production 2026-10-14), and capability/entitlement-backed stubs; drives each defect as a simulated PostgREST `authenticated` caller (`SET ROLE` + `request.jwt.claim.*`). Runs BEFORE (no repair) then AFTER (applies the actual candidate migration file).
- **Full migration replay + application integration (NOT YET RUN):** `scripts/db-proof/signoff_authorization_proof.mjs` replays the entire migration chain; it needs the capability/entitlement seed completed against the real schema. Deferred — the focused fixture already proves the trigger/RLS/privilege layer end-to-end on PG17.

## Executed results

### BEFORE — no repair (defects demonstrated): **9/9 as expected**
| Scenario | Outcome (insecure = defect present) |
|---|---|
| A · INSERT locked+approved bypasses HESABU gate & approver tier | write SUCCEEDED → **defect** |
| D · draft INSERT then signed UPDATE accepts sign-off with NO passing validation | SUCCEEDED → **defect** (the report's "unresolved architectural nuance") |
| D · sign accepted against a stale pass / newer failing validation | SUCCEEDED → **defect** |
| B · signer identity not bound to auth.uid() (one actor signs as others) | SUCCEEDED → **defect** |
| E · status jumps to 'locked' without the tier sequence | SUCCEEDED → **defect** |
| C · locked sign-off row mutated post-lock | SUCCEEDED → **defect** |
| TENANT · company-B actor cannot INSERT a company-A sign-off (RLS) | refused (secure in both modes) ✓ |
| PRIV · (pre-repair) authenticated holds TRUNCATE (over-grant) | present ✓ (matches production read-back) |
| HISTORY · pre-existing locked sign-off preserved | intact ✓ |

### AFTER — candidate repair applied: **12/12 as expected**
| Scenario | Outcome |
|---|---|
| A / D / D-stale / B / E / C | **all REFUSED** ✓ (every defect closed) |
| TENANT isolation | refused ✓ |
| PRIV · authenticated no longer holds TRUNCATE | ✓ |
| PRIV · authenticated no longer holds DELETE | ✓ |
| PRIV · service_role retains TRUNCATE | ✓ |
| HISTORY · pre-existing locked sign-off preserved (count & lock intact) | ✓ |
| POSITIVE · valid preparer sign-off (self id + latest pass) still succeeds | ✓ (repair is not a blanket block) |

**Interpretation:** on PostgreSQL 17, the five defects reproduce exactly as the production read-back describes, and the candidate repair closes all five, contains the over-broad grants, preserves historical records, and does not reopen or block a legitimate, correctly-sequenced, validated sign-off.

## Bug caught by the proof (fixed)
The first AFTER run failed — the repair migration had an invalid `RAISE … USING ERRCODE=…, NEW.upload_id` (format arg after `USING`). Fixed to `RAISE … , NEW.upload_id USING ERRCODE=…` (commit `9dec395`); re-run green. (A harness cross-run isolation bug — `auth` schema not cleared between runs — was also fixed.)

## Not covered here (honest scope)
- **Full migration-replay + app integration tests** (route/journey) — deferred; the focused fixture is explicitly a trigger/RLS/privilege proof, not an end-to-end application proof.
- **Concurrency/replay at scale** — the legacy table's `UNIQUE(company_id,period_year)` makes a double-INSERT deterministically fail; true advisory-lock concurrency is the `fs_*` path's design, not this legacy table. A dedicated concurrency harness is a follow-up.
- **Deployment** — the repair migration remains **unapplied**; applying it to hosted is out of scope for this batch (release review only).

## Re-run instructions
```
# CI: push to the branch or `gh workflow run signoff-authorization-proof`
# Local (where a loopback PG17 exists):
DB_PROOF_CONN=postgres://postgres:postgres@127.0.0.1:5432/signoff_proof \
  SIGNOFF_PROOF_WITHOUT_REPAIR=1 node scripts/db-proof/signoff_fixture_proof.mjs   # demonstrate
DB_PROOF_CONN=postgres://postgres:postgres@127.0.0.1:5432/signoff_proof \
  node scripts/db-proof/signoff_fixture_proof.mjs                                  # verify repair
```
