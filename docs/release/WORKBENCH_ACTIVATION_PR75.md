# Workbench activation — PR #75 release record (PREVIEW; not published)

- **What:** `WORKBENCH_NAVIGATION_ENABLED = true` — five-group workbench navigation; Trial Balance › Intake and
  Trial Balance › Account review reachable; withheld and unreleased modules absent (`UNPROVEN_MODULES_CUSTOMER_VISIBLE = false`,
  withheld services and open-defect restrictions unchanged). Reverting the one constant restores today's routes exactly.
- **Journey (approved, unchanged):** three steps — 1. Upload and validate trial balance · 2. Review and confirm account
  classifications · 3. Trial balance ready for statement preparation (`TRIAL_BALANCE_REVIEW.workflow`). The header shows
  only this count; the technical ledger counts "processing checks", not steps.

## 1. State of `main` (applied by Lovable in preview mode)

| Commit | What |
|---|---|
| `9602c30` | "Applied PR #75 in preview mode" — the gate-on change (tree = PR head `d123f9d`) |
| `983f419` | The activation-finding fixes (tree = PR head `2310e00`) |
| `b9753b0` | "Deployed trial-balance-layout" |

- `trial-balance-layout` closure at `main`: `f05414437014cfed626141805f58e4ed531bd36f52a080181b0b83a3b156450a` (13 files;
  the only changed file `_shared/trialBalanceLayout.ts`, SHA-256 `b93df3dc0e7bccf62c0e2650357814ef14523f711c7d06ee94722230d1e5b89c`).
  The deployed digest is as reported by Lovable; this repository cannot observe the hosted deployment.
- `process-trial-balance` unchanged: `1135d63f5684d652f15b7f80b6e03d237fca167dec310bb7fdf00e734ae10b10`. No migration.
- **Not published.** `main` carries the gate on; publishing `main` publishes the workbench.

## 2. Preview findings and their fixes (reconciled)

| # | Finding in the preview | Fix (`2310e00`) | Regression test |
|---|---|---|---|
| 1 | Missing prior-year comparison shown as **Passed** | Shown as **Not evaluated**; an available prior year is stated neutrally (no pass claimed) | `activationFindings.test.ts`, `trialBalanceVerdict.test.ts` |
| 2 | Header said "The file is being checked" while nothing ran (stale result after a confirmed layout); a second "N of 7" step count | Status `needs_recheck`; the header follows the actual processing state; the ledger counts processing checks | `activationFindings.test.ts` |
| 3 | Number format silently pre-selected when the automatic reading found no amount columns (BHD `500,000` → 500000.000) | Evidence from the whole file; ambiguity shown with each reading; explicit choice required (`NUMBER_FORMAT_AMBIGUOUS` server-side); the entire file is still validated deterministically | `layoutNumberFormat.test.ts`, `intakeUi.test.ts`, `intake.test.ts` |

## 3. Verification limits (preserved exactly)

- **Live processing message not observed.** The header's "being checked" text while a check is actually running was not
  seen in the preview; it is covered only by automated tests (`activationFindings.test.ts`: only a running check says
  "being checked"; no other state does).
- **Cross-workspace refusal not run.** The hosted check that a user of another workspace is refused by
  `trial-balance-layout` was not performed on production.

## 4. Automated coverage — cross-workspace layout access

| Action by a user of another workspace | Refused | Same body as an unknown upload | Nothing read past authorization | Nothing written |
|---|---|---|---|---|
| inspect | 403 — unit + real PostgreSQL | yes (unit) | call log: upload lookup + authority resolver only (unit); Storage never read (real PostgreSQL) | no layout records, runs or upload change (real PostgreSQL) |
| validate | 403 — unit + real PostgreSQL | yes (unit) | same | same |
| confirm | 403 — unit + real PostgreSQL | yes (unit) | same | same |

- Unit: `src/lib/ingestion/layoutCrossWorkspace.test.ts` — exact call log (no entitlement/source-binding RPC, no Storage read,
  no period/currency read, no layout read, no writer RPC); an actor named in the body is ignored.
- Real handler on real PostgreSQL: `scripts/db-proof/layoutAuthority.mjs` — "another workspace's owner: inspect, validate
  and confirm are each refused 403 with the same body; the stored file is never read; nothing is recorded or changed"
  (38/38), alongside the existing anonymous/tenant, RLS read and writer-grant checks.
- **Gap found:** confirm by another workspace, the no-read assertion and the same-body assertion were not covered before
  this record; they are now. **No product defect:** the handler already refused before any read — the added tests pass
  unchanged against it.
