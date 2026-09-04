# AXIOM Insight Craft — Claude Code Institutional Memory

This file is read automatically by Claude Code at the start of every session.
It contains every architectural decision, constraint, and invariant established
across the full development history of this project. Do not skip it.

---

## 1. What This Project Is

**AXIOM Insight Craft** (also called SAFF ERP internally) is a Tanzania-focused
professional accounting ERP for audit and tax firms. It is not a generic SaaS app.
Every design decision is governed by Tanzania law (ITA Cap.332, Finance Acts,
TRA compliance, IPSAS/IFRS for SMEs) and the Iron Dome Ω∞ architecture.

**Stack:** React + TypeScript + Vite · Supabase (Postgres + Auth + Storage + Edge Functions) · Tailwind CSS + shadcn/ui · Lucide icons

**Repo root:** `C:\Users\user\axiom-insight-craft`

---

## 2. Architecture v3.1 — The 7-Stage Accounting Lifecycle

Every client engagement moves through exactly these stages in order:

| # | Slug | Label | Engine |
|---|------|-------|--------|
| 1 | `prepare` | Prepare Data | process-trial-balance |
| 2 | `reconcile` | Reconcile | SAFISHA (bank + EFDMS) |
| 3 | `statements` | Prepare Statements | HESABU |
| 4 | `tax` | Compute Tax | KINGA |
| 5 | `compliance` | Compliance Review | KINGA findings |
| 6 | `filing` | Prepare Filing | generate-xbrl / filing pack |
| 7 | `monitor` | Monitor | MAONO |

**Canonical source for stage metadata:** `src/lib/workspace/stageMetadata.ts`
This is the single source of truth for slugs, labels, tab labels, short labels,
icons, descriptions, and sequence. Never duplicate this data elsewhere.

**Workspace routing:** `/workspace/:companyId/:periodYear/:stage`
- `companyId` = UUID from `companies` table
- `periodYear` = 4-digit integer (e.g. 2025) — NEVER a DB timestamp or upload ID
- Routing gateway: `src/pages/Dashboard.tsx` (thin gateway only — no panels here)
- Layout shell: `src/pages/workspace/WorkspaceLayout.tsx`
- Command center: `src/pages/workspace/WorkspaceOverview.tsx`

**Workspace state engine:** `src/lib/workspace/deriveWorkspaceState.ts`
Pure deterministic function. Takes DB data, returns `WorkspaceState`.
No side effects. No async. Tested in `deriveWorkspaceState.test.ts`.

---

## 3. Engine Names — Exposure Rules

The four internal engine names are **never** exposed as primary user-facing
navigation labels. They exist in code and DB but not in nav tabs or headings.

| Internal Name | What It Does | Where It Lives |
|---------------|-------------|----------------|
| SAFISHA | Bank reconciliation + EFDMS matching | `supabase/functions/safisha-*` |
| HESABU | Financial statement validation | `supabase/functions/hesabu-validate` |
| KINGA | Tax computation engine (ITA Cap.332) | `supabase/functions/kinga-tax-engine` |
| MAONO | Variance analysis + forecasting | `supabase/functions/maono-*` |

**MAONO is live — corrected 2026-09-04 (Ω∞ Phase 9 reconnaissance).** The
`PHASE_B_LOCKED` / `MAONO_ENABLED` 503 guard this section previously
described does not exist anywhere in the live code — grepped across every
`maono-*` edge function, `safisha-pdf-extract`, and the entire `src/`
tree; `MAONO_ENABLED` appears only in documentation, never in code.
`MonitorWorkspace.tsx` (Stage 7) says so itself: "Always available — no
lock gate." MAONO's UI (`MaonoDashboard` and friends under
`src/components/maono/`) is gated only by a genuine data-readiness check
(a completed, valid upload with a `company_id`), never by a feature flag.
Financial Twin firewall confirmed by reading every write site: every
`maono-*` `.insert`/`.update`/`.rpc` call and RPC definition
(`maono_write_alert`, etc.) targets only MAONO-namespaced tables
(`variance_runs`, `variance_analyses`, `variance_alerts`,
`cashflow_forecasts`, `maono_insights`, `maono_monitor_runs`) — never
`account_mappings`, `account_review_decisions`, `tax_computations`, or any
HESABU/financial-statement authority table. `maono-risk` is deterministic
(`ai_model_used: "deterministic_zscore"`, no LLM). `maono-decide` and
`maono-root-cause` do call Claude, but store the narrative as an
append-only `maono_insights` row alongside `numeric_validation_passed` /
`numeric_validation_detail` — the LLM's claims are checked against real
numbers before being stored as advisory, never as the metric itself. If a
future session finds MAONO genuinely inaccessible, the barrier is
elsewhere (RLS, a company/upload data-readiness edge case, or a live
deploy issue) — not a code-level lock to "unlock."

**MAONO authority status — repair-forward, 2026-09-04.** MAONO is
advisory and non-authoritative; treat every figure it shows as MAONO's
own analysis, not an accounting fact, unless independently proven
otherwise (`src/lib/accounting/maonoAnalyticalContract.ts`'s
`hasAuthoritativeAccountingProvenance()`/`assessMaonoInputTrust()` encode
this: a result type alone — including "observed" — never proves
authority; only an explicitly-confirmed, currently-certified upstream
source does). Do **not** claim "SAFISHA → HESABU → MAONO" is a proven,
enforced authority chain in production — `maono-compute` reads
`period_closing_balances` (a genuine KINGA/HESABU-authoritative,
persisted closing-balance table also consumed by `hesabu-validate` and
`generate-xbrl`) but ALSO reads `account_classifications` and
`account_pl_mapping`, two tables with **no migration file anywhere in
this repository** and read by no function other than `maono-*` — their
relationship to the certified `account_mappings`/`account_review_decisions`
chain (Phases 6/8) cannot be verified from this repo; see
`DEFECT-MAONO-UNTRACKED-CLASSIFICATION-TABLES-001` (§9.1, still OPEN,
non-blocking — HESABU boundary and certification freshness remain
LIMITED_NONBLOCKING, not PASS). `MaonoDashboard` binds every displayed
run to the exact workspace `companyId` + `periodYear` (previously
company-only, which could surface a different fiscal year's analytics —
fixed), and `variance_alerts` is scoped by `run_id`, not `company_id`
alone, in both `MaonoDashboard.tsx` and `maono-decide` (previously a
different fiscal period's alerts could contaminate the current run's
view/decision narrative — fixed; `variance_alerts.run_id` references
`variance_runs(id)` directly, migration `20260711163133`). `tax_computations`
reads in `maono-risk`/`maono-cashflow` use the canonical `computation_detail`
column, scoped to the exact variance run's own uploads
(`.in("upload_id", run.tb_upload_ids)` — the correct column is `upload_id`;
`tb_upload_id` does not exist on this table, verified against
`20260628100000_tax_engine_schema.sql`'s `UNIQUE (company_id, upload_id)`).
PAYE/VAT/SDL/WHT are read via `readOptionalTaxAmount()`
(`supabase/functions/_shared/maonoAnalyticalContract.ts`), which returns
`null` — never a fabricated `0` — for an absent or non-finite key; the
three TRA risk signals that consume them (`sdl_base_erosion`, `vat_gap`,
`paye_zero_with_personnel_costs`) explicitly refuse to fire when the
underlying figure is `null`, and the cash-flow forecast's
`statutory_this_month` response field preserves `null` rather than
reporting a false zero obligation. Confirmed, not merely suspected:
`kinga-tax-engine/index.ts` never computes `sdl_liability`/`vat_liability`/
`paye_total`/`wht_total` anywhere (the sole "sdl" hit is a static rate
constant, not a computed liability) — so today these four fields will
always correctly resolve to unavailable; if a future `kinga-tax-engine`
version starts populating them, `readOptionalTaxAmount()` picks them up
without further changes. KINGA absence never blocks core MAONO
variance/cashflow/risk computation — confirmed unchanged.

---

## 4. Iron Dome Ω∞ — Core Invariants

These are non-negotiable. Every edge function, migration, and UI component must
honour all of them. No exceptions, no workarounds.

### 4.1 NULL-means-NOT-COMPUTED
A null value in any computed column means the engine has not run yet.
It does NOT mean zero. It does NOT mean "not applicable".
Never default a computed column to 0, false, or any sentinel.
Never show a computed result unless the engine has explicitly written it.

### 4.2 Sole Write Authority via Edge Functions
Financial data is written only by Supabase Edge Functions.
React components and hooks are READ-ONLY with respect to financial tables.
No `supabase.from('tax_computations').insert(...)` from the frontend.
No `supabase.from('engine_runs').insert(...)` from the frontend.
The only exception: audit log writes by `useAuditLog` hook.

### 4.3 firmMemberId is the Canonical Actor Identity (v2.3)
`firm_members.id` is the actor identity used in ALL financial writes.
`auth.users.id` (Supabase auth UID) is used only for auth lookups.
Every edge function that writes financial data must:
  1. Call `validateAuth(req)` from `_shared/auth.ts`
  2. Call `assertCompanyMembership(supabase, firmMemberId, companyId)`
  3. Use `firmMemberId` in every DB insert (not `userId`)

Never pass `userId` (auth UID) to an edge function as a substitute for
`firmMemberId`. Never accept `firmMemberId` in the request body — derive it
from the auth JWT server-side.

### 4.4 No Silent Defaults
No default fiscal year. No default tax rate. No default exchange rate.
If a required input is missing, the engine must return an error — not a guess.

### 4.5 Stale-Validation Gate
A stage cannot be marked complete if the underlying data has changed since
the last engine run. The `engine_runs` table records the input hash.
If the current input hash differs from the stored hash, the stage reverts
to `in_progress` and must be re-run.

### 4.6 Sign-Off Role Enforcement
Financial sign-offs require `role = 'partner'` or `role = 'manager'` in
`firm_members`. Junior staff cannot sign off. This is enforced by the
`hesabu_gate_before_signoff` trigger on `statement_sign_offs`.

---

## 5. Shared Auth Utilities (`_shared/auth.ts`)

All edge functions import from `supabase/functions/_shared/auth.ts`.
These are the only approved auth utilities:

```typescript
validateAuth(req)           // Extract + verify JWT, return { user, firmMemberId }
assertCompanyMembership(supabase, firmMemberId, companyId)  // RLS guard
checkIdempotency(supabase, key)     // Returns existing result if key seen before
completeIdempotency(supabase, key, result)  // Mark key complete
failIdempotency(supabase, key, error)       // Mark key failed
recordEngineRun(supabase, params)   // Write to engine_runs table
sha256Hex(data)             // Deterministic input hash
canonicalJson(obj)          // Stable JSON serialisation for hashing
```

Do not inline any of this logic. Always import from `_shared/auth.ts`.

---

## 6. Critical Database Tables

### engine_runs
Reproducibility ledger. Every engine invocation writes one row.
Created by migration `20260720200000`.
Columns: `id, function_name, company_id, period_year, input_hash, output_hash, firm_member_id, duration_ms, created_at`

### idempotency_keys
Deduplication table for Edge Function POST retries.
Created by migration `20260720300000`.
An idempotency key is `sha256(functionName + companyId + periodYear + inputHash)`.

### tax_computations
The canonical output table for KINGA.
**`computation_detail`** is the canonical JSONB column. NOT `result_json`.
`result_json` does not exist. Any reference to it is a bug.

### trial_balance_uploads
Columns include: `id, file_name, file_path, file_size, status, user_id,
company_id, company_name, period_year, uploaded_at, validation_report,
accounting_errors, safisha_status`

### statement_sign_offs
Sign-off workflow table. Has the `hesabu_gate_before_signoff` trigger which
enforces that hesabu-validate must pass before a sign-off is accepted.

### five WIP migrations (NOT yet in origin/main)
These must be applied in this exact order before any other WIP work:
1. `20260720100000` — RLS hardening + segregation of duties
2. `20260720200000` — engine_runs reproducibility ledger
3. `20260720300000` — idempotency_keys dedup table
4. `20260720400000` — tenant_events unified audit log
5. `20260720500000` — sync_outbox offline-first queue

---

## 7. Canonical File Map

```
src/
  lib/
    workspace/
      stageMetadata.ts        ← CANONICAL stage slugs/labels/icons/sequence
      types.ts                ← WorkspaceMission, MissionStatus, WorkspaceState
      deriveWorkspaceState.ts ← Pure state engine (no async, no side effects)
    computeComplianceScore.ts ← Pure scoring engine (no DB writes)
    computeWearTear.ts        ← Pure W&T calculator (ITA s.34 rates)
    normalizeAccountName.ts   ← Account name normalisation

  pages/
    Dashboard.tsx             ← Auth gateway only. Routes to /workspace. NO panels.
    workspace/
      WorkspaceLayout.tsx     ← Shell: top bar + stage tab nav + <Outlet>
      WorkspaceOverview.tsx   ← Command center: next action + 7-row progress table
      PrepareWorkspace.tsx    ← Stage 1
      ReconcileWorkspace.tsx  ← Stage 2
      StatementsWorkspace.tsx ← Stage 3 (has known TS bug — see section 9)
      TaxWorkspace.tsx        ← Stage 4
      ComplianceWorkspace.tsx ← Stage 5
      FilingWorkspace.tsx     ← Stage 6
      MonitorWorkspace.tsx    ← Stage 7

  components/
    TrialBalanceUpload.tsx    ← Upload component. Has TIN gate + duplicate detection.
    SaffLogo.tsx              ← Inline SVG logo. Single source of truth for branding.
    Header.tsx                ← PUBLIC header only. Not used inside workspace.
    safisha/
      SafishaGate.tsx         ← Post-upload evidence gate. Cannot be skipped.

  contexts/
    WorkspaceContext.tsx      ← React context wrapping useWorkspaceData
  hooks/
    useWorkspaceData.ts       ← Authoritative DB reads for workspace state
  constants/
    copy.ts                   ← All user-visible copy strings. Nav labels live here.

supabase/
  functions/
    _shared/
      auth.ts                 ← CANONICAL shared auth utilities (see section 5)
    kinga-tax-engine/         ← ITA Cap.332 engine. Has idempotency + engine_runs.
    process-trial-balance/    ← TB ingestion + classification
    hesabu-validate/          ← H-01 to H-12 assurance assertions
    safisha-ingest/           ← Bank statement CSV/XLSX → safisha_transactions
    safisha-efdms-ingest/     ← EFDMS Z-Report → safisha_transactions (service role)
    safisha-match/            ← 6-tier fuzzy matching engine
    generate-xbrl/            ← XBRL filing pack generator
  migrations/                 ← All migrations. Apply in filename order.
```

---

## 8. Absolute Prohibitions

These are hard stops. If a task description would require any of these, refuse
and ask the user to confirm before proceeding.

1. **Do not modify financial engine calculations** (kinga-tax-engine rates,
   thresholds, waterfall logic) without an explicit statutory reference.

2. **Do not alter DB schema** unless Architecture v3.1 explicitly requires it.
   No new columns on financial tables without a migration file.

3. **Do not weaken authentication, RLS, firm-member identity, sign-off gates,
   stale-validation gates, or filing locks.** Ever.

4. **Do not expose SAFISHA, HESABU, KINGA, or MAONO as primary user navigation
   labels.** These names are internal. Users see "Reconcile", "Statements",
   "Compute Tax", "Monitor".

5. **Do not move CapitalAllowancesRegister out of the Tax stage.**

6. **Do not delete Compliance functionality.**

7. **WorkspaceOverview must have exactly one dominant operational CTA.**
   Never show two primary action buttons simultaneously.

8. **Header.tsx is the public header only.** It must never appear inside the
   authenticated workspace. WorkspaceLayout.tsx has its own header.

9. **Do not reference `result_json`** anywhere. The canonical column is
   `computation_detail` in `tax_computations`.

10. **Do not use `auth.users.id` as the actor identity** in any financial write.
    Always use `firm_members.id` (`firmMemberId`).

11. **Do not write financial data from React components or hooks.**
    All financial writes go through Edge Functions.

12. **`safisha-efdms-ingest` uses service role.** This is intentional — TIN
    anti-impersonation requires it. Do not change this to anon key.

---

## 9. Known Pre-Existing TypeScript Errors (Do Not Fix Without Task)

These errors exist in origin/main and are NOT caused by recent changes.
Do not fix them as a side effect of other work — they need separate tasks.

- `StatementsWorkspace.tsx`: destructures `{ upload, workspaceState }` but JSX
  uses `company`, `companyId`, `periodYear` — compile blocker, needs its own task
- `SaffLogo.tsx`: missing SVG asset imports (brand assets not committed)
- `AvatarUpload.tsx`: CSS side-effect import
- `ErrorBoundary.tsx`, `PageErrorBoundary.tsx`: `import.meta.env.DEV` type
- `ExportStatements.tsx`: missing `xlsx` module types
- `KingaFindingsPanel.tsx`, `SafishaGate.tsx`, etc.: `VITE_SUPABASE_URL` not in
  `ImportMetaEnv` (needs vite-env.d.ts update)
- `integrations/supabase/client.ts`: same env var types issue

### 9.1 Registered Live Defects (Do Not Fix Opportunistically)

**DEFECT-KINGA-MAPPING-TENANCY-001** — Severity: HIGH — Status: OPEN / PRE-EXISTING

`supabase/functions/kinga-findings-engine/index.ts` reads `account_mappings`
for its `is_retained_earnings`/`is_payroll_account` override checks using
`.eq("user_id", companyUserId)` only — **no `company_id` filter**. Where one
firm/user operates multiple companies, an account mapping from one company
may potentially influence KINGA WHT/SDL processing for another company via a
shared account code.

Discovered during the Phase 2A professional-review-authority audit
(2026-08-16). Not introduced by Phase 2A, not fixed by Phase 2A — this is a
pre-existing gap in `kinga-findings-engine` itself. Do not modify that file
as a side effect of other work; it needs its own task with its own review of
`kinga-tax-engine`'s statutory calculation surface.

Phase 2A migration identity reconciliation: see `MIGRATION_RECONCILIATION.md`.

**DEFECT-SAFISHA-TRANSACTION-LEDGER-GAP-001** — Severity: HIGH — Status: OPEN / MISSING CAPABILITY

`safisha_transactions` (`supabase/migrations/20260711200000_safisha_core.sql`)
is real, immutable, hash-verified evidence, but it is **not** the
period-complete, classified cash-movement ledger V5 Phase 5's dual-engine
cash-flow requirement needs. Specifically:
- Rows are scoped per `reconciliation_id` → one `tb_upload_id` — whichever
  bank/cash accounts a firm chose to reconcile for that upload, not every
  cash-account movement for the full reporting period.
- `source_id = 'tb'` rows are the trial balance re-ingested as rows — not
  independent evidence; only `bank`/`subledger`/`momo` rows are genuinely
  external.
- No `presentationCode`/`accountNature`/cash-flow classification authority
  attaches at the row level — the table exists to prove bank-reconciliation
  match quality, not to feed a P&L-adjacent cash-flow statement.
- No opening-balance-carry-forward row concept; no certification gate
  equivalent to `tb_certifications` scoped to this table specifically.

Consequence: V5 Phase 5's `hesabu-cashflow-present` (IAS 7/IPSAS 2 primary
statement) and `hesabu-cashflow-reconcile` (indirect-method reconciliation)
cannot honestly produce two *independently derived* operating-cash-flow
numbers today — both `kinga-tax-engine.scfEngine` (live) and
`cashFlowEngines.ts` (pure, dormant, certified Phase 5 Slice 1) derive
operating CF from the same TB/IS/BS deltas via the same indirect method.
Genuine independence (e.g. a direct-method presentation) requires a
complete, period-scoped, professionally-classified cash-movement
transaction ledger that does not exist in this repository.

Discovered during the V5 Phase 5 Gate 1 dual-engine closure investigation
(2026-09-04), on branch `phase5-cashflow-foundation-20260903` /
main `14375160c7aa3b55774bf9142e984989f4fb7d90`. Not introduced by, and not
fixable within, Phase 5 Slice 1 (`cashFlowEngines.ts` — certified, correctly
does not claim independence it cannot support). Building this ledger is a
future SAFISHA/ledger-completeness capability with its own scope, its own
schema design, and its own certification pass — do not attempt it as a side
effect of Phase 5 or any other in-flight work.

Related, separately registered: **DEFECT-KINGA-COMPARATIVE-ENGINE-ZERO-SUBSTITUTION-001**
(`supabase/functions/kinga-comparative-engine/index.ts`) — a different,
unrelated live defect in a different comparative-period engine, found during
Phase 4.

**DEFECT-ACCOUNT-REVIEW-AUTHORITATIVE-FLAGS-001** — Severity: HIGH — Status:
OPEN / AUTHORITATIVE PROJECTION CORRUPTION (repair in progress on the same
branch that registers this entry — see Phase 6 below)

`src/lib/accounting/buildReviewDecisions.ts` — `buildReviewDecision()`
unconditionally emits:
```
is_cash_account: false,
is_retained_earnings: false,
is_payroll_account: false,
```
on every decision payload it builds, regardless of what the professional
actually reviewed. `src/components/AccountReviewPanel.tsx` — the live
Account Review workflow — currently has no professional input capable of
setting these three authoritative flags `true`; there is no UI path to
express "this is a cash account," "this is the retained-earnings account,"
or "this is a payroll account" at all.
`resolve_account_review_batch` (`supabase/migrations/20260816120000_account_review_authority.sql`)
persists the resulting decision/projection into `account_mappings` via
`INSERT ... ON CONFLICT (company_id, account_key) DO UPDATE SET
is_cash_account = EXCLUDED.is_cash_account, ...` — an unconditional
overwrite, so every reviewed decision (even one only about statement/
classification) replaces any existing authoritative flag value on that
account with `false`.

Consequences:
1. genuine cash accounts can be persisted as non-cash;
2. genuine retained-earnings / accumulated-surplus accounts can be
   persisted with false authority;
3. genuine payroll accounts can be persisted with false authority;
4. Phase 5's cash-perimeter authority can therefore be contaminated by the
   live Account Review workflow;
5. professional review can make authoritative `account_mappings` less
   correct than the source/machine state.

This is **not** a Phase 5 HESABU defect. HESABU correctly requires
caller-supplied cash-perimeter authority — it never invents one. The defect
is in the upstream professional Account Review authority that produces
`account_mappings`. Repair owner: **V5 Phase 6**. The repair does not
create a separate mapping authority — it corrects `buildReviewDecision()`
and `resolve_account_review_batch()`'s existing UPSERT logic in place, so
that a review decision no longer manufactures `false` for a flag the
professional never reviewed.

Discovered during the V5 Phase 6 Reversible Account Review Gate 0
discovery (2026-09-04), on branch `phase6-reversible-account-review-20260904` /
main `382f9a71415de11714a20a6e5ed818e95d376795`.

**DEFECT-MAONO-UNTRACKED-CLASSIFICATION-TABLES-001** — Severity: HIGH —
Status: OPEN / UNVERIFIED AUTHORITY CHAIN

`supabase/functions/maono-compute/index.ts` and
`supabase/functions/maono-cashflow/index.ts` read account-level
classification data from two tables, `account_classifications` and
`account_pl_mapping`, that have **no `CREATE TABLE` migration anywhere in
`supabase/migrations/`** — grepped across the full migration history,
zero matches. No function other than `maono-*` reads or writes either
table. `maono-compute`'s own header comment documents the pipeline as
`trial_balance_uploads → account_classifications`, confirming they are
TB-derived, but nothing in this repository proves they are kept in sync
with, or derived from, the certified `account_mappings` /
`account_review_decisions` authority chain (Phases 2A/6/8). `maono-compute`
separately reads `period_closing_balances` (a real, KINGA-written,
`hesabu-validate`/`generate-xbrl`-trusted authoritative closing-balance
table) — so MAONO's variance computation is a MIX of at least one
provably authoritative source and at least two unverifiable ones in the
same pipeline.

Consequence: the claim "MAONO consumes SAFISHA → HESABU → MAONO" cannot
be fully proven from this repository as it stands; the untracked tables
could be a legitimate, currently-correct MAONO-side projection, or a
stale/orphaned artifact from an earlier architecture iteration that no
longer reflects the current classification authority. Live schema
inspection (this session had none) is required to resolve this — do not
assume either direction without it.

Discovered during the V5 Phase 9 MAONO Unlock repair-forward
(2026-09-04), on branch `phase9-maono-live-20260904` / main
`16ccdfc475dc10c171b35b7860ab77fe98d0239b`. Not fixed here: rewriting
`maono-compute`'s data-sourcing logic without live database access to
verify the change would risk an unverifiable regression in an
already-deployed financial function — exactly the failure mode this
repository's own discipline (`controlledActivation.ts`'s docstring,
Phase 8) explicitly warns against.

---

## 10. Current Project State (as of 2026-07-25)

### What is complete and deployed
- Architecture v3.1 routing shell (WorkspaceLayout + WorkspaceOverview + 7 stage pages)
- deriveWorkspaceState.ts deterministic engine with 14-path coverage
- KINGA tax engine with idempotency + engine_runs hash (ITA Cap.332 / FA2026)
- SAFISHA 6-stage pipeline (ingest → match → categorize → score → resolve → gate)
- HESABU H-01 to H-12 assurance assertions
- MAONO variance + cashflow + risk + monitor + decide + root-cause engines — live, not env-var-gated (see section 3)
- XBRL filing pack generator (Tanzania taxonomy)
- Iron Dome Strikes 1–7 (RLS hardening, engine_runs, idempotency, tenant_events, sync_outbox)
- 8-fix UX pass (FY2001 fix, TIN gate, unified 7-row progress, BLOCKED reasons,
  jargon removal, responsive tabs, visible logout, duplicate filename detection)

### Completed 8-fix UX changes (committed, not yet pushed)
Files changed:
- `src/pages/Dashboard.tsx` — year-range guard on resolvePeriodYear
- `src/lib/workspace/stageMetadata.ts` — shortLabel on all 7 stages
- `src/pages/workspace/WorkspaceLayout.tsx` — UserMenu + responsive tabs + StatusDot tooltips
- `src/pages/workspace/WorkspaceOverview.tsx` — unified rows + BLOCKED reason + plain English
- `src/components/TrialBalanceUpload.tsx` — TIN gate + duplicate detection

### Pending tasks (not yet done)
- **Task #106**: Deploy Sprint 2 — `git push origin main` then `supabase db push`
  then deploy 7 edge functions (user must run these commands)
- **Task #255**: Phase C — re-home panels by accounting stage inside each workspace page
- **Task #256**: Phase D — acceptance tests + certification pass
- **StatementsWorkspace.tsx TS bug**: destructuring mismatch (own task needed)

### WIP branch (`recover-wip-20260720`) — Integration Authority
A recovery branch exists that is 3 commits ahead / 45 commits behind origin/main.
Common ancestor: `bc4693f`. The 5 WIP migrations are NOT in origin/main.
Integration plan: create fresh branch from origin/main HEAD (`e9d6ff0`),
cherry-pick only the 5 migration files in order, then take all other files
from origin/main. Do NOT rebase the WIP branch directly.

---

## 11. Deploy Procedure

### Frontend
```bash
git add -A
git commit -m "your message"
git push origin main
```
Lovable.dev auto-deploys from main.

### Database migrations
```bash
supabase db push
```
Always run AFTER pushing migrations to git. Always apply in filename order.

### Edge functions (deploy individually)
```bash
supabase functions deploy kinga-tax-engine
supabase functions deploy process-trial-balance
supabase functions deploy hesabu-validate
supabase functions deploy safisha-ingest
supabase functions deploy safisha-efdms-ingest
supabase functions deploy safisha-match
supabase functions deploy generate-xbrl
```

### Verify after deploy
```bash
# Check function health
supabase functions list

# Run TypeScript check (pre-existing errors are acceptable — see section 9)
node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json
```

---

## 12. Tanzania Regulatory Context

- **ITA Cap.332**: Income Tax Act, Tanzania. Main corporate tax statute.
- **Finance Act 2026**: Enacted. Updated KINGA constants (rates, thresholds).
  CIT rate 30% (unchanged). Minimum tax 0.5% of turnover (s.65). 
  Presumptive tax threshold TZS 200M (FA2026 s.31).
- **TRA**: Tanzania Revenue Authority. EFDMS = Electronic Fiscal Device Management System.
- **TIN**: Tanzania Revenue Authority Tax Identification Number. 9-12 digits.
  Placeholder sentinel "PUT-REAL-TRA-TIN-HERE" must never reach production.
- **IPSAS**: International Public Sector Accounting Standards (for LGA/government clients).
- **GFRS**: Government Financial Reporting System (Tanzania LGA chart of accounts).
- **SDL**: Skills Development Levy (account range ~6050). Statutory payable.
- **NSSF/PPF/WCF**: Statutory retirement/social security funds. Treated as payables.
- **VAT**: Standard rate 18%. EFDMS Z-Reports are the source documents for VAT reconciliation.
- **Withholding tax**: Service payments to residents (5%) and non-residents (15%).
- **Thin capitalisation**: ITA s.24A — debt:equity 3:1 ratio. Interest disallowance above cap.
  (Note: frontend ThinCapWorkpaper shows gated state only — no frontend computation.)
- **Transfer pricing**: ITA s.33 management fees cap (1% of turnover or arm's length).
- **Installment tax**: ITA s.88 — quarterly payments due Mar/Jun/Sep/Dec.
- **Loss carry-forward**: Indefinite carry-forward of assessed losses under ITA.
- **Wear and tear**: ITA s.34 — Class 1 (37.5%), Class 2 (25%), Class 3 (12.5%), Class 4 (5%).

---

## 13. Key Constraints for New Tasks

Before starting any new task, verify:

1. Does it touch a financial engine calculation? → need statutory reference
2. Does it write to DB from frontend? → forbidden, must be Edge Function
3. Does it use `auth.users.id` as actor? → wrong, must be `firm_members.id`
4. Does it expose an engine name (SAFISHA/HESABU/KINGA/MAONO) in nav? → forbidden
5. Does it alter the stage sequence or slug? → update stageMetadata.ts ONLY
6. Does it add a new DB column? → needs a migration file with timestamp
7. Does it touch WorkspaceOverview? → must maintain exactly one dominant CTA
8. Does it bypass SafishaGate? → forbidden, the gate is non-skippable

When in doubt: read Iron Dome Ω∞ rules in section 4 first.
