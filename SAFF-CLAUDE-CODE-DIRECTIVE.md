# SAFF ERP — Ω∞ CLAUDE CODE IMPLEMENTATION DIRECTIVE — V2
## Iron Dome Nuclear Design · Reconciled Against Repository Evidence
## Classification: MASTER IMPLEMENTATION AUTHORITY — Reconciled 2026-09-01

> **READ THIS FIRST, CLAUDE CODE.**
> This file is the single implementation authority for SAFF ERP.
> V2 preserves every V1 architectural objective (Phases 0–9, the canonical
> pipeline, KINGA parallel). It corrects V1's status claims and a set of
> implementation details that were found — by direct repository audit, not
> assumption — to contradict either actual shipped code or SAFF's own
> orthogonality invariants. Repository evidence is authoritative over
> documentation, always. Where V1 said something was CERTIFIED and it wasn't
> found in the repository, V2 says so plainly.
> Execute phases in strict numerical order, including the new Phase 0A.
> Do not skip. Do not combine. Do not improvise beyond the spec.
> When a phase is done, mark it CERTIFIED in your session notes — but only
> after the repository, not just the plan, proves it.

---

## STATUS TAXONOMY (used throughout this document)

| Status | Meaning |
|---|---|
| **CERTIFIED / SHIPPED** | Verified present and correct in the repository this session |
| **PARTIAL** | Some real, verified capability exists; the full claim does not |
| **DESIGNED / NOT SHIPPED** | A design exists (in this doc or elsewhere); no code/schema yet |
| **REQUIRED FOUNDATION** | Later phases depend on this; it must be built, not assumed |
| **PLANNED** | Not yet designed in detail |
| **BLOCKED** | Cannot proceed until a named prerequisite resolves |

---

## IRON DOME NUCLEAR CERTIFICATION — Current State (Corrected)

| # | Invariant | Location | Status | Note |
|---|-----------|----------|--------|------|
| 1 | firmMemberId canonical actor identity | `_shared/auth.ts` | **PARTIAL** | `validateAuth()` returns only `{userId, email?}` — never `firmMemberId`. `assertCompanyMembership(adminClient, userId, companyId)` takes `userId`, checks `firm_members`, returns `Response \| undefined` — it never returns the resolved `firm_members.id` either. Only `kinga-tax-engine` correctly derives `firmMemberId` today, inline, itself. A canonical shared resolver is Phase 0A scope. |
| 2 | NULL-means-NOT-COMPUTED | Computed columns, no defaults | **CERTIFIED / SHIPPED** | Verified broadly applied; no violation found |
| 3 | Sole write authority via Edge Functions | React = read-only for financial tables | **PARTIAL** | Phase 2A now enforces this for account-review decisions via `resolve_account_review_batch`. `AccountMappingManager.tsx` remains a legacy, **unreachable** (no route/import — confirmed) direct-write violator; left as `LEGACY_UNREACHABLE_WRITE_SURFACE`, not deleted, not fixed opportunistically. |
| 4 | No silent defaults (TIN, fiscal year, rates) | `isTinMissing()`, KINGA guards | **PARTIAL** | TIN upload gate is real. V1 of *this directive* itself violated this invariant (`isVATRegistered: false`, `defaultFrameworkForEntityClass`, `defaultFiscalYearEnd` as silent defaults) — corrected in V2 §Phase 1 below. |
| 5 | Stale-validation gate | `engine_runs` input hash | **REQUIRED FOUNDATION** | No implementation found anywhere in `supabase/functions/`. Blocked on Phase 0A. |
| 6 | Sign-off role enforcement | `statement_sign_offs` RLS | **CERTIFIED / SHIPPED, RELABELED** | Real enforcement exists and is *more* rigorous than V1 described: `firm_members.role` is constrained to `owner \| partner \| preparer \| viewer` — `'manager'` referenced in several RLS expressions can never match any real row (dead policy text, not a role). Actual gate: `preparer` may set only `preparer_signed_at`; only `owner`/`partner` may set `reviewer_signed_at`/`approver_signed_at`/`locked_at`, with maker-checker (`reviewer_id ≠ preparer_id`, `approver_id ≠ preparer_id/reviewer_id`) enforced in `WITH CHECK`. |
| 7 | `engine_runs` reproducibility ledger | Migration `20260720200000` | **REQUIRED FOUNDATION** | Migration does not exist. Phase 0A. |
| 8 | `idempotency_keys` deduplication | Migration `20260720300000` | **REQUIRED FOUNDATION** | Migration does not exist. Phase 0A. |
| 9 | RLS hardening + segregation of duties | Migration `20260720100000` | **PARTIAL** | The *cited* migration doesn't exist, but real segregation-of-duties/RLS work exists under other, real timestamps (`20260707`–`20260720` range, `20260712050748`, `20260719101913`). |
| 10 | KINGA ITA Cap.332 / FA2026 tax engine | `kinga-tax-engine/` | **CERTIFIED / SHIPPED** | Not re-audited for calculation correctness this pass; firmMemberId derivation independently verified correct |
| 11 | 7-stage workspace shell | Architecture v3.1 | **CERTIFIED / SHIPPED** | Extensively verified this session |
| 12 | TIN gate on upload | `TrialBalanceUpload.tsx` | **CERTIFIED / SHIPPED** | |
| 13 | Duplicate filename detection | `TrialBalanceUpload.tsx` | **CERTIFIED / SHIPPED** | |
| 14 | Professional account-review authority (`account_review_batches`/`decisions`, `resolve_account_review_batch`) | Migration `20260816120000` | **PARTIAL** | Repository-certified across a multi-gate design/security review; live privilege hardening not yet applied; live migration-history canonicalization is a documented, accepted Lovable-Cloud governance gap, not a blocker (see `MIGRATION_RECONCILIATION.md`). |
| 15 | `account_mapping_memory` provenance ledger (framework-intelligence) | Migration `20260811000000`/`...001` | **CERTIFIED / SHIPPED** | Confirmed live via regenerated Supabase types and prior forensics |

### Gaps still blocking Ω∞

| Gap | Severity | Unlocked by Phase |
|-----|----------|-------------------|
| Engine execution / idempotency infrastructure absent | 🔴 CRITICAL | **Phase 0A (new)** |
| SAFISHA lacks TB-validation/certification capability (additive gap, not an identity defect) | 🔴 CRITICAL | Phase 0 |
| EntityAccountingContext absent, and framework/entity orthogonality must be enforced from day one | 🔴 CRITICAL | Phase 1 |
| Framework Registry absent | 🔴 CRITICAL | Phase 2 |
| 8-tier evidence ladder (phrase match only) | 🔴 CRITICAL | Phase 3 |
| Comparative: zero-for-missing risk | 🟠 HIGH | Phase 4 |
| Two cash flow engines absent | 🟠 HIGH | Phase 5 |
| Account Review not reversible / risk of a second write-authority backend | 🟡 MEDIUM | Phase 6 |
| Supporting schedule contracts absent | 🟡 MEDIUM | Phase 7 |
| Machine-side classification provenance absent (distinct from Phase 2A and `account_mapping_memory`) | 🟡 MEDIUM | Phase 8 |
| MAONO locked behind env var | 🟢 READY | Phase 9 |

**VERDICT: IRON DOME PARTIAL — 15 invariants tracked, several PARTIAL/REQUIRED-FOUNDATION rather than CERTIFIED. International deployment: BLOCKED until Phase 0A + Phase 0–5 are genuinely shipped, not merely documented.**

---

## A NOTE ON MAGIC CONSTANTS (applies throughout this document)

Several places below specify a hardcoded currency or percentage threshold (e.g. "TZS 1,000", "TZS 100", "5% of TB value"). **None of these are authoritative.** Every such number in this directive is a *default suggestion* only. Before production use, each must be sourced from a versioned, per-engagement materiality/tolerance configuration. Until that configuration exists, treat the check as **unconfigured** (block/flag for explicit setting), never silently assume the stated number is correct for every jurisdiction, entity size, or currency.

---

## THE CANONICAL PIPELINE (Immutable, additive evolution only)

```
UPLOAD (CSV · XLSX · XLS · PDF)
    ↓
SAFISHA — TB VALIDATION + CERTIFICATION (L1–L6)
    (existing bank/EFDMS reconciliation and matching capabilities are NOT
     removed or replaced — they become supporting evidence signals,
     principally at Layer 5, within this broader assurance domain)
    ↓
CERTIFIED TRIAL BALANCE
    ↓
    ├── HESABU ← Financial Statements (IPSAS · IFRS · IFRS-SME)
    └── MAONO  ← Analytics · Forecasting · Board Pack
```

**KINGA** is a parallel pipeline, drawing from the same certified accounting evidence, running Tanzania ITA Cap.332 tax computation independently. It is NOT part of the HESABU pipeline.

---

## PHASE 0A — ENGINE EXECUTION & IDEMPOTENCY FOUNDATION
### Status: REQUIRED FOUNDATION — SCOPE DEFINED, NOT YET DESIGNED IN DETAIL
### Gate: requires its own dedicated design-certification pass — identity, concurrency, and security model reviewed with the same rigor Phase 2A received — before any SQL or code is written

This phase exists because Phase 0 (and any later phase) cannot honestly call `checkIdempotency()`/`recordEngineRun()` or implement the stale-validation gate until this infrastructure is real. It is being named and scoped here, deliberately, rather than invented ad hoc inside Phase 0.

**Required design surface (not designed in this document):**
- `engine_runs` table — reproducibility ledger
- `idempotency_keys` table — request deduplication
- Company tenancy boundary on both tables
- `firmMemberId` actor derivation — a real, canonical, shared resolver (today, every function that needs this derives it inline; Phase 0A should end that duplication)
- `input_hash` / `output_hash` computation and provenance
- Request identity and request-hash canonicalization
- Retry semantics; handling of failed/incomplete runs
- Concurrency behavior (per-function? per-company? per-request?)
- Stale-input detection (the actual mechanism behind Iron Dome invariant #5)
- Retention policy
- RLS model for both tables
- ACL / grants — who can read, who can write (service role only, almost certainly)
- `SECURITY DEFINER` boundaries, if any function-based approach is used
- Migration replay compatibility (apply the lesson from the Phase 2A migration-identity reconciliation: whatever gets designed must survive a Lovable-Cloud-managed deployment path, not assume personal-CLI `db push` access)
- Tests, including concurrency

**Do not implement Phase 0A during this document's authoring.** The next action after V2 is accepted is a dedicated Phase 0A design turn, not code.

### Status: DESIGN CERTIFIED, IMPLEMENTATION CANDIDATE BUILT — NOT LIVE

Phase 0A's design gate closed with the following decisions, recorded here rather than re-argued:

- **Atomicity**: Phase 0A does NOT provide a universal domain-result-commit RPC. `engine_runs`/`idempotency_keys` are generic execution provenance only. Each future domain phase that needs to atomically commit its own domain result alongside completing a run (e.g. a future `commit_tb_certification(...)` in Phase 0) provides its own narrowly-scoped transactional authority. Phase 0A has no dependency on `tb_certifications` or any other domain table.
- **Failed-request retry**: same `client_request_id` + same `request_hash` + prior `failed` status → replays the recorded failure, never re-executes. A genuine retry requires a new `client_request_id`. The prior failed key and run remain, forever, as evidence.
- **`trial_balance_uploads.source_file_hash`**: belongs to Phase 0, not Phase 0A. Phase 0A does not modify `trial_balance_uploads`.
- **Retention**: `engine_runs` — no automatic deletion, ever (durable accounting execution provenance). `idempotency_keys` — no automatic cleanup implemented in Phase 0A; a retention/archival policy may be designed separately later.
- **`engine_name` removed**: `engine_runs` stores `function_name`/`engine_version`/`rule_version` only — no denormalized coarse-grouping column. Future engine-family grouping derives from a controlled registry, not a duplicated free-form value.
- **`replay_result` (bounded envelope)**: `idempotency_keys`'s replay payload is a structurally-bounded JSONB object — permitted top-level keys ONLY `status`, `reference_id`, `reference_table`, `summary`, `error_code`, enforced by a `CHECK` constraint, not documentation alone. It must never hold a full TB, statements, raw uploaded data, or auth material.
- **System-actor uniqueness correction**: `UNIQUE (company_id, firm_member_id, function_name, client_request_id)` alone would NOT protect two system-triggered (`firm_member_id IS NULL`) claims from both winning, since plain `UNIQUE` treats `NULL` as distinct from `NULL`. Corrected to `UNIQUE NULLS NOT DISTINCT (...)` — a pattern already proven in this project (`uq_acct_map_company_code`, `20260703100000_account_mappings_v2_and_keyword_dict.sql`).

Implementation candidate: `supabase/migrations/20260901120000_engine_execution_foundation.sql`, `supabase/functions/_shared/{actor,hash,idempotency,engine-run}.ts`, `src/lib/shared/canonicalHash.ts` (+ test). Not applied to any live project. Not deployed. See `supabase/tests/engine_execution_foundation_manual_verification.sql` for the DB-level test specification, not yet executed against a real database.

---

## PHASE 0 — SAFISHA TB VALIDATION & CERTIFICATION (Additive)
### Priority: CRITICAL FIRST, once Phase 0A's blocking pieces are available
### Files: 3 new + 2 modified · Migration and infra-dependent pieces are separately gated (see split below)

SAFISHA's existing, certified, deployed 6-stage bank-reconciliation pipeline (`ingest → match → categorize → score → resolve → gate`) is **not being replaced**. This phase adds TB validation/certification as a new, primary SAFISHA capability; the existing pipeline becomes a supporting evidence source (principally Layer 5) within the broader assurance domain SAFISHA now covers.

### Implementation split (do not blur these groups)

**A. Pure/safe — buildable now, no dependency on missing infrastructure:**
`src/lib/safisha/types.ts` in full; L1 (file integrity) and L2 (structure) validation logic; response-shape types; unit tests; the `CertificationSummaryProps` UI contract.

**B. Requires existing repository integration (buildable now, using REAL APIs — see corrected §0.2):**
L3 (mathematics) reusing the existing `totalDebits`/`totalCredits` pattern from `process-trial-balance`; calling the real `validateAuth`/`assertCompanyMembership` signatures.

**C. Blocked on Phase 0A:**
`checkIdempotency()`, `recordEngineRun()`, and the input-hash stale-detection logic.

**D. Requires DB migration via the Lovable-Cloud workflow, not personal CLI `db push`:**
`tb_certifications` (§0.3).

---

### 0.1 — New Contract: `src/lib/safisha/types.ts`

```typescript
// ── SAFISHA canonical types — do not import from anywhere else ──────────────

export type L1Verdict = "pass" | "reject";
export type L2Verdict = "pass" | "warn";
export type L3Verdict = "pass" | "fail";
export type L4Verdict = "auto" | "review" | "unresolved";
export type L5Verdict = "complete" | "gaps";
export type L6Verdict = "reconciled" | "drift" | "no_prior";

export interface SafishaException {
  code: string;          // e.g. "L3-IMBALANCE", "L4-UNRESOLVED-6099"
  layer: 1 | 2 | 3 | 4 | 5 | 6;
  severity: "error" | "warning" | "info";
  accountCode?: string;
  accountName?: string;
  message: string;
  resolution?: string;   // what the user must do to fix it
}

export interface SafishaLayerResult {
  layer: 1 | 2 | 3 | 4 | 5 | 6;
  verdict: string;
  passedChecks: number;
  failedChecks: number;
  exceptions: SafishaException[];
  durationMs: number;
}

// Certification status is explicit and three-valued. A certificationId is
// issued ONLY when certificationStatus === "certified". Computation
// finishing is not certification — blocking review is a distinct state.
export type CertificationStatus = "validated_pending_review" | "certified" | "blocked";

export interface CertifiedTB {
  certificationId: string | null;   // non-null ONLY when certificationStatus === "certified"
  certificationStatus: CertificationStatus;
  companyId: string;
  periodYear: number;
  certifiedAt: string | null;       // ISO 8601 — null unless certificationStatus === "certified"
  firmMemberId: string;
  inputHash: string;                // sha256 of source file bytes
  tbRows: CertifiedTBRow[];
  layers: SafishaLayerResult[];
  overallConfidence: number;        // 0.00–1.00
  exceptionCount: number;
  isBlockingException: boolean;     // true = cannot proceed to HESABU
  sourceSystem: SourceSystem;
  entityClass: EntityClass;
}

export interface CertifiedTBRow {
  accountCode: string;
  accountName: string;
  nature: AccountNature;        // asset | liability | equity | income | expense
  subNature?: string;           // e.g. "non_current_asset", "operating_expense"
  debitBalance: number;         // always >= 0
  creditBalance: number;        // always >= 0
  netBalance: number;           // debitBalance - creditBalance
  evidenceTier: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  ruleId: string;
  ruleVersion: string;
  confidence: number;
  requiresReview: boolean;
}

export type AccountNature = "asset" | "liability" | "equity" | "income" | "expense";

export type SourceSystem =
  | "muse"        // Tanzania MUSE (LGRCIS) government accounting
  | "gacs"        // Government Accounting & Control System
  | "quickbooks"  // QuickBooks export
  | "sage"        // Sage accounting
  | "tally"       // Tally ERP
  | "excel_manual"// Hand-built Excel TB
  | "unknown";

// Orthogonal taxonomy: describes WHAT THE ENTITY IS, never what it reports
// under. Reporting framework is a SEPARATE fact — see EntityAccountingContext
// in Phase 1. Do not reintroduce framework names into this type.
export type EntityClass =
  | "lga"                     // Local Government Authority
  | "central_government"      // Central government ministry/department
  | "government_agency"       // Semi-autonomous government agency
  | "regulator"                // Regulatory body
  | "public_corporation"       // Wholly government-owned corporation
  | "state_owned_enterprise"   // Majority government-owned commercial entity
  | "ngo"                      // Non-governmental organisation
  | "cbo"                      // Community-based organisation
  | "private_company"          // Private commercial entity, any size
  | "other"
  | "unknown";
```

---

### 0.2 — New Edge Function: `supabase/functions/safisha-validate-tb/index.ts`

This is the NEW primary SAFISHA entry point for certification. It does not remove or replace `safisha-ingest`, which remains the entry point for bank-statement evidence ingestion (now one evidence input among several, principally consumed at L5).

**Request shape:**
```typescript
interface SafishaTBValidateRequest {
  uploadId: string;      // trial_balance_uploads.id
  companyId: string;
  periodYear: number;
  // firmMemberId derived server-side — see corrected invariants below
}
```

**Response shape:**
```typescript
interface SafishaTBValidateResponse {
  certificationId: string | null;   // null unless certificationStatus === "certified"
  certificationStatus: CertificationStatus;
  overallConfidence: number;
  layerResults: SafishaLayerResult[];
  exceptions: SafishaException[];
  exceptionCount: number;
  isBlockingException: boolean;
  requiresReview: boolean;          // review without blocking
  tbRowCount: number;
  debitTotal: number;
  creditTotal: number;
  imbalance: number;                // abs(debit - credit)
  sourceSystem: SourceSystem;
  entityClass: EntityClass;
  durationMs: number;
}
```

**Validation layers — implement in this exact order:**

```
L1 — File Integrity
  - File parseable (not corrupt)
  - Encoding detectable (UTF-8 / UTF-16 / Latin-1 auto-detect)
  - Minimum rows present (>= 2 data rows)
  - Verdict: pass | reject (reject = hard stop, no further layers)

L2 — Structure
  - Required columns present (account code, account name, debit/credit or net)
  - No completely empty rows
  - Header row detected and excluded from data
  - Verdict: pass | warn (warn = continue with flagged rows excluded)

L3 — Mathematics (Iron Dome: the most critical check)
  - Sum of all debit balances vs sum of all credit balances
  - Tolerance: abs(debit - credit) / max(debit, credit) < 0.0001 (0.01%)
    — this specific tolerance is a mathematical-rounding allowance, not a
      materiality judgment; it may remain a fixed engineering constant
  - Verdict: pass | fail (fail = block HESABU until resolved)
  - Exception code: "L3-IMBALANCE" with exact debit, credit, and difference

L4 — Account Classification
  - For each row: run EvidenceLadder (Phase 3) to determine AccountNature
  - Tier 1–5 = auto-classified
  - Tier 6–7 = review required (not blocking) — Tier 7 is NEVER final, see
    Phase 3's corrected sign≠nature rule
  - Tier 8 = unresolved (blocking only if the configured unresolved-value
    threshold is exceeded — see Magic Constants note; default suggestion 5%,
    not authoritative)
  - Verdict: auto | review | unresolved

L5 — Completeness
  - Check expected account families present for detected entityClass
    (see EntityProfiles.ts, Phase 1)
  - Missing families = warning, not error (user may legitimately have none)
  - Bank statement evidence: if safisha_transactions exist for this period
    (from the existing, certified bank-reconciliation pipeline), compare bank
    closing balance to TB bank account balance. Drift threshold: see Magic
    Constants note — default suggestion, not authoritative.
  - Verdict: complete | gaps

L6 — Comparative Reconciliation
  - Look up prior year certified TB for same company (prior periodYear)
  - If exists: check retained earnings closing = current opening equity
    (drift threshold: see Magic Constants note)
  - If no prior certified TB: verdict = no_prior (not an error)
  - Verdict: reconciled | drift | no_prior
```

**Iron Dome invariants for this function — corrected to the ACTUAL shared-helper API:**
1. Call `validateAuth(authHeader, corsHeaders)` → returns `{result?: {userId, email?}, error?: Response}`. On error, return the `error` Response directly.
2. Resolve `firmMemberId` via a real `firm_members` lookup (`user_id = userId AND company_id = companyId AND accepted_at IS NOT NULL`) — `validateAuth` does **not** provide this; no shared helper does today. Reject with 403 if no accepted membership row exists.
3. Call `assertCompanyMembership(adminClient, userId, companyId)` — returns a `Response` to short-circuit on failure (`const denied = await assertCompanyMembership(...); if (denied) return denied;`). Note this duplicates part of step 2's membership check; both exist today because no canonical combined resolver exists yet (Phase 0A scope).
4. `checkIdempotency(...)` / `recordEngineRun(...)` — **BLOCKED on Phase 0A.** Do not call functions that don't exist. Until Phase 0A ships, this function proceeds without idempotency/reproducibility guarantees; that gap must be visible in code comments, not hidden.
5. Never write a certification row with `certificationStatus: "certified"` unless all 6 layers have completed AND no blocking exception remains AND no review-required Tier 8 account remains outstanding.
6. Write certification to `tb_certifications` table (see 0.3 below) — only once, and only through this edge function; RLS denies any direct client write.

---

### 0.3 — New Migration (design; NOT applied this pass): `supabase/migrations/[timestamp]_tb_certifications.sql`

```sql
-- TB certifications — output of SAFISHA validate-tb
create table if not exists tb_certifications (
  id                   uuid primary key default gen_random_uuid(),
  upload_id            uuid not null references trial_balance_uploads(id),
  company_id           uuid not null references companies(id),
  period_year          integer not null check (period_year between 2000 and 2099),
  firm_member_id       uuid not null references firm_members(id),
  certification_status text not null default 'validated_pending_review'
    check (certification_status in ('validated_pending_review', 'certified', 'blocked')),
  certified_at         timestamptz,        -- null unless certification_status = 'certified'
  input_hash           text not null,
  overall_confidence   numeric(5,4) not null check (overall_confidence between 0 and 1),
  exception_count      integer not null default 0,
  is_blocking          boolean not null default false,
  requires_review      boolean not null default false,
  source_system        text not null default 'unknown',
  entity_class          text not null default 'unknown',
  layer_results         jsonb not null default '[]',
  exceptions            jsonb not null default '[]',
  debit_total           numeric(20,2) not null,
  credit_total           numeric(20,2) not null,
  tb_rows                jsonb not null default '[]',
  created_at             timestamptz not null default now()
);

alter table tb_certifications enable row level security;

-- CORRECTED from V1: firm_members.id is a distinct primary key, NOT the same
-- UUID space as auth.uid(). V1's policy (`where id = auth.uid()`) would never
-- match a real row. Membership is resolved through user_id, matching the
-- pattern already established and security-reviewed for Phase 2A.
create policy "firm members read own certifications"
  on tb_certifications for select
  using (
    company_id in (
      select company_id from firm_members
       where user_id = auth.uid()
         and accepted_at is not null
    )
  );

-- Only Edge Functions (service role) may write.
-- No insert/update/delete policy for anon/authenticated — sole write
-- authority via Edge Functions.
create index tb_certifications_company_period
  on tb_certifications(company_id, period_year, certified_at desc);
```

Not applied. Migration application follows the corrected deployment workflow (§Deployment, below) — Lovable-mediated, never a personal-CLI `db push` against `bvyivmmfjejbmqoydezk`.

---

### 0.4 — Modified: `src/pages/workspace/PrepareWorkspace.tsx`

After L3 (Math) passes and L4 review is complete, show the Certification Summary panel:

```typescript
interface CertificationSummaryProps {
  certification: CertifiedTB;
  onProceedToStatements: () => void; // disabled unless certificationStatus === "certified"
}
```

The UI must show:
- `certificationStatus` prominently and unambiguously distinguished: **Validated, pending review** / **Certified** / **Blocked** — three visually distinct states, never collapsed into one
- Overall confidence score
- L1–L6 verdicts as a checklist (green/amber/red per layer)
- Exception count with expandable list
- ONE button: "Proceed to Statements" — disabled unless `certificationStatus === "certified"`
- If `requiresReview = true`, show "Review accounts first" inline prompt
- NEVER show a "skip" option

---

### Phase 0 Done When:
- [ ] `src/lib/safisha/types.ts` compiles (Group A)
- [ ] L1/L2/L3 logic implemented and unit-tested (Group A/B)
- [ ] `safisha-validate-tb` edge function deploys using the REAL `validateAuth`/`assertCompanyMembership` signatures (Group B)
- [ ] L3 correctly blocks a TB where debits ≠ credits
- [ ] `checkIdempotency`/`recordEngineRun` calls added only after Phase 0A ships (Group C)
- [ ] `tb_certifications` migration applied via the Lovable-Cloud workflow (Group D)
- [ ] PrepareWorkspace shows the three-state Certification Summary
- [ ] Existing bank-reconciliation pipeline still works as L5 evidence — no regression

---

## PHASE 1 — ENTITY ACCOUNTING CONTEXT
### Files: 3 new pure TypeScript · No DB migration required

Nothing about a company's accounting framework should be hardcoded — and nothing about a company's *identity* should be allowed to silently imply its framework either. Entity context, reporting framework, source system, account nature, statement presentation, cash-flow classification, and tax treatment are **orthogonal dimensions**. None of them determines another automatically.

---

### 1.1 — New: `src/lib/entity/EntityAccountingContext.ts`

```typescript
import type { EntityClass, SourceSystem } from "@/lib/safisha/types";

export type ReportingFramework =
  | "ipsas_accrual"
  | "ipsas_cash"
  | "ifrs"
  | "ifrs_sme"
  | "gaap_us"        // future
  | "unknown";

export type AccountingBasis = "accrual" | "cash" | "modified_accrual" | "unknown";

// Distinguishes a professionally-confirmed fact from a machine-suggested
// candidate from nothing at all. NEVER treat "candidate" as "confirmed".
export type ConfidenceLevel = "confirmed" | "candidate" | "unknown";

export interface EntityAccountingContext {
  entityClass: EntityClass;

  reportingFramework: ReportingFramework;
  reportingFrameworkConfidence: ConfidenceLevel;

  accountingBasis: AccountingBasis;
  accountingBasisConfidence: ConfidenceLevel;

  sourceSystem: SourceSystem;
  jurisdictionCode: string;     // ISO 3166-1 alpha-2, e.g. "TZ" — from company registration, not inferred

  currencyCode: string;         // ISO 4217, e.g. "TZS" — from company registration, not inferred

  fiscalYearEndMonth: number | null;   // 1–12, null = unknown
  fiscalYearEndDay: number | null;     // 1–31, null = unknown
  fiscalYearEndConfidence: ConfidenceLevel;

  isTanzaniaEFDMSRegistered: boolean | null;  // null = unknown — NOT inferable from TIN presence alone
  isVATRegistered: boolean | null;            // null = unknown — VAT and TIN are legally distinct facts

  tinNumber: string | null;     // null = unknown/not provided

  confidence: number;           // 0.00–1.00 — how certain the OVERALL detection is
  evidence: string[];           // list of signals that drove detection (evidence, not authority)
}

// CORRECTED FROM V1: this is a SUGGESTION function. Its output is a
// candidate, never authoritative. Entity class is evidence toward a
// framework, never proof of one. government ownership ≠ automatically
// IPSAS; SOE ≠ automatically IFRS; NGO ≠ automatically IFRS-SME; MUSE/GACS
// source system ≠ automatically IPSAS. Callers MUST NOT apply this value
// to reportingFramework without either explicit company configuration or
// professional confirmation.
export function suggestedFrameworkForEntityClass(
  entityClass: EntityClass
): ReportingFramework {
  switch (entityClass) {
    case "lga":                    return "ipsas_accrual";
    case "central_government":     return "ipsas_accrual";
    case "government_agency":      return "ipsas_accrual";
    case "regulator":              return "ipsas_accrual";
    case "public_corporation":     return "ifrs";
    case "state_owned_enterprise": return "ifrs";
    case "ngo":                    return "ifrs_sme";
    case "cbo":                    return "ifrs_sme";
    case "private_company":        return "ifrs_sme"; // suggestion only — size determines full IFRS vs SME, not knowable from entity class alone
    default:                       return "unknown";
  }
}

// CORRECTED FROM V1: suggestion only, never silently applied. Tanzania LGA
// entities COMMONLY use 30 June; this is not universal even within
// government, and must never override actual company configuration.
export function suggestedFiscalYearEnd(
  entityClass: EntityClass
): { month: number; day: number } | null {
  switch (entityClass) {
    case "lga":
    case "central_government":
    case "government_agency":
    case "regulator":
      return { month: 6, day: 30 };  // suggestion — Tanzania government convention
    case "private_company":
    case "public_corporation":
    case "state_owned_enterprise":
    case "ngo":
    case "cbo":
      return { month: 12, day: 31 }; // suggestion — calendar year convention
    default:
      return null; // no suggestion — unknown entity class, unknown fiscal year
  }
}
```

---

### 1.2 — New: `src/lib/entity/detectEntityContext.ts`

```typescript
import type { EntityAccountingContext, ReportingFramework, ConfidenceLevel } from "./EntityAccountingContext";
import type { CertifiedTB } from "@/lib/safisha/types";
import { suggestedFrameworkForEntityClass, suggestedFiscalYearEnd } from "./EntityAccountingContext";

export interface DetectionSignal {
  signal: string;
  weight: number;
  value: string;
}

// Pure function — no async, no DB.
// Signals are EVIDENCE toward a candidate framework — never authority.
// A framework is only ever "confirmed" when the caller supplies an explicit,
// professionally-set company configuration value. Absent that, the best this
// function can ever return is "candidate", regardless of signal strength.
export function detectEntityContext(params: {
  certifiedTB: CertifiedTB;
  companyName: string;
  tinNumber: string | null;
  registeredCountry: string;
  registeredCurrency: string | null;
  configuredFramework?: ReportingFramework;        // explicit, authoritative company config
  configuredFiscalYearEnd?: { month: number; day: number };
  configuredIsVATRegistered?: boolean;
  configuredIsEFDMSRegistered?: boolean;
}): EntityAccountingContext {
  const {
    certifiedTB, companyName, tinNumber, registeredCountry, registeredCurrency,
    configuredFramework, configuredFiscalYearEnd,
    configuredIsVATRegistered, configuredIsEFDMSRegistered,
  } = params;
  const signals: DetectionSignal[] = [];

  if (certifiedTB.sourceSystem === "muse") {
    signals.push({ signal: "source_system_muse", weight: 0.9, value: "muse" });
  }
  if (certifiedTB.sourceSystem === "gacs") {
    signals.push({ signal: "source_system_gacs", weight: 0.9, value: "gacs" });
  }

  const lgaPatterns = [
    /district council/i, /municipal council/i, /city council/i,
    /town council/i, /village council/i, /\bDC\b/, /\bMC\b/,
  ];
  if (lgaPatterns.some((p) => p.test(companyName))) {
    signals.push({ signal: "name_lga_pattern", weight: 0.8, value: companyName });
  }

  const accountCodes = certifiedTB.tbRows.map((r) => r.accountCode);
  const hasMUSECodes = accountCodes.some((c) => /^[2-9]\d{6}$/.test(c));
  if (hasMUSECodes) {
    signals.push({ signal: "account_codes_muse_pattern", weight: 0.7, value: "7-digit codes" });
  }

  const entityClass = certifiedTB.entityClass; // detected by SAFISHA L2/context, itself evidence-based
  const rawConfidence = signals.reduce((sum, s) => sum + s.weight, 0) / Math.max(signals.length, 1);

  const reportingFramework = configuredFramework ?? suggestedFrameworkForEntityClass(entityClass);
  const reportingFrameworkConfidence: ConfidenceLevel =
    configuredFramework ? "confirmed" : (signals.length > 0 ? "candidate" : "unknown");

  const fiscalYearEnd = configuredFiscalYearEnd ?? suggestedFiscalYearEnd(entityClass);
  const fiscalYearEndConfidence: ConfidenceLevel =
    configuredFiscalYearEnd ? "confirmed" : (fiscalYearEnd ? "candidate" : "unknown");

  const accountingBasis =
    reportingFrameworkConfidence === "confirmed"
      ? (reportingFramework === "ipsas_cash" ? "cash" : "accrual")
      : "unknown"; // CORRECTED — never assert accrual/cash on an unconfirmed framework

  return {
    entityClass,
    reportingFramework,
    reportingFrameworkConfidence,
    accountingBasis,
    accountingBasisConfidence: reportingFrameworkConfidence,
    sourceSystem: certifiedTB.sourceSystem,
    jurisdictionCode: registeredCountry, // company registration fact, not inferred
    currencyCode: registeredCurrency ?? "unknown",
    fiscalYearEndMonth: fiscalYearEnd?.month ?? null,
    fiscalYearEndDay: fiscalYearEnd?.day ?? null,
    fiscalYearEndConfidence,
    // CORRECTED — EFDMS registration and VAT registration are legally
    // distinct facts from "has a TIN". Neither is inferable from TIN
    // presence + country. Only explicit company-record configuration
    // establishes them; otherwise unknown.
    isTanzaniaEFDMSRegistered: configuredIsEFDMSRegistered ?? null,
    isVATRegistered: configuredIsVATRegistered ?? null,
    tinNumber,
    confidence: Math.min(rawConfidence, 1.0),
    evidence: signals.map((s) => `${s.signal}:${s.value}`),
  };
}
```

---

### 1.3 — New: `src/lib/entity/EntityProfiles.ts`

```typescript
// Entity profiles — expected account families by entity class.
// Used by SAFISHA L5 completeness check. Keys match the corrected,
// framework-orthogonal EntityClass taxonomy (src/lib/safisha/types.ts).

import type { EntityClass } from "@/lib/safisha/types";

export interface AccountFamilyExpectation {
  familyCode: string;
  familyName: string;
  required: boolean;
  nature: "income" | "expense" | "asset" | "liability" | "equity";
  notes: string;
}

const LGA_PROFILE: AccountFamilyExpectation[] = [
  { familyCode: "PE", familyName: "Personal Emoluments", required: true, nature: "expense", notes: "Staff costs — mandatory for any LGA" },
  { familyCode: "UGS", familyName: "Use of Goods and Services", required: true, nature: "expense", notes: "Operational procurement" },
  { familyCode: "TRANS", familyName: "Transfers and Grants", required: false, nature: "expense", notes: "Intergovernmental transfers" },
  { familyCode: "REV", familyName: "Own Source Revenue", required: true, nature: "income", notes: "LGA own revenue" },
  { familyCode: "GRANT", familyName: "Government Grants", required: false, nature: "income", notes: "Treasury subventions" },
];

const CENTRAL_GOV_PROFILE: AccountFamilyExpectation[] = [
  { familyCode: "PE", familyName: "Personal Emoluments", required: true, nature: "expense", notes: "" },
  { familyCode: "UGS", familyName: "Use of Goods and Services", required: true, nature: "expense", notes: "" },
  { familyCode: "REV", familyName: "Revenue", required: false, nature: "income", notes: "" },
];

const COMMERCIAL_PROFILE: AccountFamilyExpectation[] = [
  { familyCode: "REV", familyName: "Revenue", required: true, nature: "income", notes: "" },
  { familyCode: "OPEX", familyName: "Operating Expenses", required: true, nature: "expense", notes: "" },
];

const NGO_PROFILE: AccountFamilyExpectation[] = [
  { familyCode: "GRANTS_IN", familyName: "Grants and Donations Received", required: true, nature: "income", notes: "" },
  { familyCode: "PROG_EXP", familyName: "Programme Expenditure", required: true, nature: "expense", notes: "" },
  { familyCode: "ADMIN", familyName: "Administrative Expenses", required: true, nature: "expense", notes: "" },
];

export const ENTITY_PROFILES: Record<EntityClass, AccountFamilyExpectation[]> = {
  lga: LGA_PROFILE,
  central_government: CENTRAL_GOV_PROFILE,
  government_agency: CENTRAL_GOV_PROFILE,
  regulator: CENTRAL_GOV_PROFILE,
  public_corporation: COMMERCIAL_PROFILE,
  state_owned_enterprise: COMMERCIAL_PROFILE,
  ngo: NGO_PROFILE,
  cbo: NGO_PROFILE,
  private_company: COMMERCIAL_PROFILE,
  other: [],
  unknown: [],
};
```

---

### Phase 1 Done When:
- [ ] `EntityAccountingContext` type compiles with no errors
- [ ] `detectEntityContext` never returns `reportingFrameworkConfidence: "confirmed"` without an explicit `configuredFramework` input
- [ ] `isVATRegistered`/`isTanzaniaEFDMSRegistered` are `null` unless explicit company configuration provides them
- [ ] `ENTITY_PROFILES` covers all 11 entity classes (including `other`/`unknown` as empty arrays)
- [ ] No DB migrations required — pure TypeScript contracts only

---

## PHASE 2 — FRAMEWORK REGISTRY
### Files: 4 new pure TypeScript · No DB migration required

The Framework Registry defines what each reporting framework produces. It is DATA not code. No if/else branching on framework name anywhere in HESABU. An empty `statements: []` array must never be presented as production support — every framework entry carries an explicit maturity state.

---

### 2.1 — New: `src/lib/frameworks/FrameworkRegistry.ts`

```typescript
import type { ReportingFramework } from "@/lib/entity/EntityAccountingContext";

export interface LineItemDefinition {
  code: string;
  label: string;
  nature: "asset" | "liability" | "equity" | "income" | "expense";
  subNatures: string[];
  aggregation: "sum" | "subtotal" | "header";
  presentation: "debit_positive" | "credit_positive";
  required: boolean;
  zeroIfMissing: false;   // NEVER true — Iron Dome invariant 4.4
}

export interface StatementDefinition {
  statementCode: string;
  statementName: string;
  lineItems: LineItemDefinition[];
}

export interface NoteDefinition {
  noteCode: string;
  noteTitle: string;
  requiredFor: string[];
  optional: boolean;
}

// CORRECTED FROM V1: explicit maturity state. Consuming code MUST check
// this before treating a framework as production-ready. An empty
// `statements`/`notes` array is never itself sufficient evidence of support.
export type FrameworkMaturity = "supported" | "partial" | "reserved" | "unsupported";

export interface FrameworkProfile {
  framework: ReportingFramework;
  displayName: string;
  maturity: FrameworkMaturity;
  statements: StatementDefinition[];
  notes: NoteDefinition[];
  requiresComparatives: boolean;
  comparativeYears: number;
  allowCashBasis: boolean;
}

export const FRAMEWORK_REGISTRY: Record<ReportingFramework, FrameworkProfile> = {
  ipsas_accrual: {
    framework: "ipsas_accrual",
    displayName: "IPSAS Accrual Basis",
    maturity: "supported",
    requiresComparatives: true,
    comparativeYears: 1,
    allowCashBasis: false,
    statements: [
      {
        statementCode: "SFP",
        statementName: "Statement of Financial Position",
        lineItems: [
          { code: "IPSAS-SFP-001", label: "Cash and Cash Equivalents",       nature: "asset",     subNatures: ["cash_and_equivalents"],          aggregation: "sum",      presentation: "debit_positive",  required: false, zeroIfMissing: false },
          { code: "IPSAS-SFP-002", label: "Receivables",                     nature: "asset",     subNatures: ["receivable"],                     aggregation: "sum",      presentation: "debit_positive",  required: false, zeroIfMissing: false },
          { code: "IPSAS-SFP-003", label: "Inventories",                     nature: "asset",     subNatures: ["inventory"],                      aggregation: "sum",      presentation: "debit_positive",  required: false, zeroIfMissing: false },
          { code: "IPSAS-SFP-004", label: "Property, Plant and Equipment",   nature: "asset",     subNatures: ["ppe_net"],                        aggregation: "sum",      presentation: "debit_positive",  required: false, zeroIfMissing: false },
          { code: "IPSAS-SFP-010", label: "Payables",                        nature: "liability", subNatures: ["payable"],                        aggregation: "sum",      presentation: "credit_positive", required: false, zeroIfMissing: false },
          { code: "IPSAS-SFP-011", label: "Borrowings",                      nature: "liability", subNatures: ["borrowing"],                      aggregation: "sum",      presentation: "credit_positive", required: false, zeroIfMissing: false },
          { code: "IPSAS-SFP-020", label: "Accumulated Surplus / (Deficit)", nature: "equity",    subNatures: ["retained_earnings", "surplus"],   aggregation: "sum",      presentation: "credit_positive", required: true,  zeroIfMissing: false },
        ],
      },
      {
        statementCode: "SOFP",
        statementName: "Statement of Financial Performance",
        lineItems: [
          { code: "IPSAS-SOFP-001", label: "Revenue from Non-Exchange Transactions", nature: "income",  subNatures: ["grant_income", "tax_revenue"],  aggregation: "sum", presentation: "credit_positive", required: false, zeroIfMissing: false },
          { code: "IPSAS-SOFP-002", label: "Revenue from Exchange Transactions",     nature: "income",  subNatures: ["exchange_revenue"],             aggregation: "sum", presentation: "credit_positive", required: false, zeroIfMissing: false },
          { code: "IPSAS-SOFP-010", label: "Employee Costs",                         nature: "expense", subNatures: ["personal_emoluments"],          aggregation: "sum", presentation: "debit_positive",  required: false, zeroIfMissing: false },
          { code: "IPSAS-SOFP-011", label: "Use of Goods and Services",              nature: "expense", subNatures: ["goods_and_services"],           aggregation: "sum", presentation: "debit_positive",  required: false, zeroIfMissing: false },
          { code: "IPSAS-SOFP-012", label: "Depreciation",                           nature: "expense", subNatures: ["depreciation"],                 aggregation: "sum", presentation: "debit_positive",  required: false, zeroIfMissing: false },
          { code: "IPSAS-SOFP-020", label: "Surplus / (Deficit) for the Period",    nature: "equity",  subNatures: [],                               aggregation: "subtotal", presentation: "credit_positive", required: true, zeroIfMissing: false },
        ],
      },
    ],
    notes: [
      { noteCode: "NOTE-PPE", noteTitle: "Property, Plant and Equipment — Movement Schedule", requiredFor: ["SFP"], optional: false },
      { noteCode: "NOTE-RECEIVABLES", noteTitle: "Analysis of Receivables", requiredFor: ["SFP"], optional: false },
      { noteCode: "NOTE-PAYABLES", noteTitle: "Analysis of Payables", requiredFor: ["SFP"], optional: false },
    ],
  },

  ifrs_sme: {
    framework: "ifrs_sme",
    displayName: "IFRS for SMEs",
    maturity: "supported",
    requiresComparatives: true,
    comparativeYears: 1,
    allowCashBasis: false,
    statements: [
      {
        statementCode: "SFP",
        statementName: "Statement of Financial Position",
        lineItems: [
          { code: "IFRS-SME-SFP-001", label: "Cash and Cash Equivalents",     nature: "asset",     subNatures: ["cash_and_equivalents"], aggregation: "sum",      presentation: "debit_positive",  required: false, zeroIfMissing: false },
          { code: "IFRS-SME-SFP-002", label: "Trade and Other Receivables",   nature: "asset",     subNatures: ["receivable"],           aggregation: "sum",      presentation: "debit_positive",  required: false, zeroIfMissing: false },
          { code: "IFRS-SME-SFP-003", label: "Inventories",                   nature: "asset",     subNatures: ["inventory"],            aggregation: "sum",      presentation: "debit_positive",  required: false, zeroIfMissing: false },
          { code: "IFRS-SME-SFP-004", label: "Property, Plant and Equipment", nature: "asset",     subNatures: ["ppe_net"],              aggregation: "sum",      presentation: "debit_positive",  required: false, zeroIfMissing: false },
          { code: "IFRS-SME-SFP-010", label: "Trade and Other Payables",      nature: "liability", subNatures: ["payable"],              aggregation: "sum",      presentation: "credit_positive", required: false, zeroIfMissing: false },
          { code: "IFRS-SME-SFP-011", label: "Borrowings",                    nature: "liability", subNatures: ["borrowing"],            aggregation: "sum",      presentation: "credit_positive", required: false, zeroIfMissing: false },
          { code: "IFRS-SME-SFP-020", label: "Retained Earnings",             nature: "equity",    subNatures: ["retained_earnings"],    aggregation: "sum",      presentation: "credit_positive", required: true,  zeroIfMissing: false },
        ],
      },
      {
        statementCode: "PL",
        statementName: "Statement of Comprehensive Income",
        lineItems: [
          { code: "IFRS-SME-PL-001", label: "Revenue",                       nature: "income",  subNatures: ["exchange_revenue"],     aggregation: "sum",      presentation: "credit_positive", required: true,  zeroIfMissing: false },
          { code: "IFRS-SME-PL-002", label: "Cost of Sales",                 nature: "expense", subNatures: ["cost_of_sales"],        aggregation: "sum",      presentation: "debit_positive",  required: false, zeroIfMissing: false },
          { code: "IFRS-SME-PL-010", label: "Gross Profit",                  nature: "income",  subNatures: [],                       aggregation: "subtotal", presentation: "credit_positive", required: true,  zeroIfMissing: false },
          { code: "IFRS-SME-PL-011", label: "Distribution Costs",            nature: "expense", subNatures: ["distribution_costs"],   aggregation: "sum",      presentation: "debit_positive",  required: false, zeroIfMissing: false },
          { code: "IFRS-SME-PL-012", label: "Administrative Expenses",       nature: "expense", subNatures: ["admin_expenses"],       aggregation: "sum",      presentation: "debit_positive",  required: false, zeroIfMissing: false },
          { code: "IFRS-SME-PL-020", label: "Profit / (Loss) Before Tax",    nature: "income",  subNatures: [],                       aggregation: "subtotal", presentation: "credit_positive", required: true,  zeroIfMissing: false },
          { code: "IFRS-SME-PL-021", label: "Income Tax Expense",            nature: "expense", subNatures: ["tax_expense"],          aggregation: "sum",      presentation: "debit_positive",  required: false, zeroIfMissing: false },
          { code: "IFRS-SME-PL-030", label: "Profit / (Loss) for the Year",  nature: "income",  subNatures: [],                       aggregation: "subtotal", presentation: "credit_positive", required: true,  zeroIfMissing: false },
        ],
      },
    ],
    notes: [
      { noteCode: "NOTE-PPE", noteTitle: "Property, Plant and Equipment", requiredFor: ["SFP"], optional: false },
    ],
  },

  ifrs: {
    framework: "ifrs",
    displayName: "IFRS (Full)",
    maturity: "reserved",   // CORRECTED — empty statements/notes must not imply support
    requiresComparatives: true,
    comparativeYears: 1,
    allowCashBasis: false,
    statements: [],
    notes: [],
  },

  ipsas_cash: {
    framework: "ipsas_cash",
    displayName: "IPSAS Cash Basis",
    maturity: "reserved",   // CORRECTED
    requiresComparatives: true,
    comparativeYears: 1,
    allowCashBasis: true,
    statements: [],
    notes: [],
  },

  gaap_us: {
    framework: "gaap_us",
    displayName: "US GAAP",
    maturity: "unsupported", // CORRECTED — not even attempted yet
    requiresComparatives: true,
    comparativeYears: 2,
    allowCashBasis: false,
    statements: [],
    notes: [],
  },

  unknown: {
    framework: "unknown",
    displayName: "Unknown (requires selection)",
    maturity: "unsupported",
    requiresComparatives: false,
    comparativeYears: 0,
    allowCashBasis: false,
    statements: [],
    notes: [],
  },
};
```

**New rule:** any consumer of this registry must check `maturity === "supported"` before treating a framework as production-ready. `"partial"`/`"reserved"`/`"unsupported"` must surface as an explicit blocker or warning, never silently proceed with an empty statement list.

---

### Phase 2 Done When:
- [ ] All frameworks compile with no TypeScript errors
- [ ] `FRAMEWORK_REGISTRY["ipsas_accrual"].maturity === "supported"` and has SFP + SOFP
- [ ] `FRAMEWORK_REGISTRY["ifrs_sme"].maturity === "supported"` and has SFP + PL
- [ ] `FRAMEWORK_REGISTRY["ifrs"|"ipsas_cash"|"gaap_us"].maturity !== "supported"`
- [ ] `zeroIfMissing` is `false` on every line item (invariant 4.4 enforced at type level)
- [ ] Every consumer checks `maturity` before rendering statements

---

## PHASE 3 — 8-TIER EVIDENCE LADDER
### Files: 2 new · Modifies: `process-trial-balance` edge function

Replace phrase matching with a deterministic, auditable, tiered classification system. Every classification decision is recorded with its ruleId, ruleVersion, tier, and confidence. **Sign is evidence, never authority — a debit balance does not prove "asset", a credit balance does not prove "liability".**

---

### 3.1 — New: `src/lib/evidence/EvidenceLadder.ts`

```typescript
export type EvidenceTier = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface ClassificationResult {
  accountCode: string;
  nature: "asset" | "liability" | "equity" | "income" | "expense";
  subNature: string;
  tier: EvidenceTier;
  ruleId: string;
  ruleVersion: string;
  confidence: number;
  requiresReview: boolean;    // Tier 7 MUST always be true here — see rule below
  evidence: string[];
  conflicts: ConflictRecord[];
}

export interface ConflictRecord {
  conflictingRuleId: string;
  conflictingNature: string;
  resolution: "primary_wins" | "review_required";
}

// The 8 tiers — from most to least authoritative.
// CORRECTED: Tier 1 is reserved for GENUINELY statutory authority (e.g. a
// real ITA s.34 wear-and-tear class code table, if one is ever built as a
// classification rule — no such rule currently exists in this registry).
// Source-system-native chart codes (MUSE, GACS) are Tier 3 evidence, not
// statutory authority, however consistently they're used — a government
// chart-of-accounts convention is not itself an enacted statute.
const TIER_DESCRIPTIONS: Record<EvidenceTier, string> = {
  1: "Exact statutory code match — genuine legal/regulatory authority only (none registered yet)",
  2: "Audited confirmed mapping (firm-certified, version-controlled)",
  3: "Source system native code match (MUSE/GACS chart-of-accounts convention — administrative, not statutory)",
  4: "Standard chart of accounts exact name match (IFAC/IPSAS CoA)",
  5: "Industry-standard keyword match with high confidence (>= 0.85)",
  6: "Phonetic or fuzzy name match with medium confidence (0.60–0.84)",
  7: "Balance-side inference — CANDIDATE EVIDENCE ONLY, never a final classification. A debit balance does not prove asset/expense; a credit balance does not prove liability/income/equity. requiresReview MUST be true unconditionally for every Tier 7 result, regardless of its confidence score.",
  8: "Unresolved — human review required",
};

export { TIER_DESCRIPTIONS };
```

---

### 3.2 — New: `src/lib/evidence/classificationRules.ts`

```typescript
import type { EvidenceTier, ClassificationResult } from "./EvidenceLadder";
import type { AccountNature } from "@/lib/safisha/types";

export interface ClassificationRule {
  ruleId: string;
  ruleVersion: string;
  tier: EvidenceTier;
  description: string;
  codeRange?: { from: string; to: string; source: string };
  exactNames?: string[];
  keywords?: string[];
  nature: AccountNature;
  subNature: string;
  confidence: number;
}

// RULE REGISTRY — add rules here, never in engine code.
export const CLASSIFICATION_RULES: ClassificationRule[] = [

  // ── Tier 3: MUSE / GACS source-system chart conventions ──────────────────
  // CORRECTED FROM V1: these were mislabeled Tier 1 ("statutory"). MUSE's
  // chart-of-accounts code ranges are Tanzania government's own
  // administrative convention, not an ITA Cap.332 or other enacted statute.
  // Genuine Tier 1 rules require independent statutory citation — none
  // exist in this registry yet; do not manufacture statutory authority
  // through a rule's naming.
  { ruleId: "TZ-MUSE-PE-001", ruleVersion: "1.0.0", tier: 3,
    description: "MUSE Personal Emoluments range (2100xxx–2199xxx) — source-system chart convention",
    codeRange: { from: "2100000", to: "2199999", source: "MUSE_CHART_2024" },
    nature: "expense", subNature: "personal_emoluments", confidence: 0.85 },

  { ruleId: "TZ-MUSE-UGS-001", ruleVersion: "1.0.0", tier: 3,
    description: "MUSE Use of Goods and Services (2200xxx–2499xxx) — source-system chart convention",
    codeRange: { from: "2200000", to: "2499999", source: "MUSE_CHART_2024" },
    nature: "expense", subNature: "goods_and_services", confidence: 0.85 },

  { ruleId: "TZ-MUSE-ASSET-001", ruleVersion: "1.0.0", tier: 3,
    description: "MUSE Non-Financial Assets (3000xxx–3999xxx) — source-system chart convention",
    codeRange: { from: "3000000", to: "3999999", source: "MUSE_CHART_2024" },
    nature: "asset", subNature: "ppe_net", confidence: 0.80 },

  // ── Tier 4: IFAC standard chart of accounts exact names ──────────────────
  { ruleId: "IFAC-COA-CASH-001", ruleVersion: "1.0.0", tier: 4,
    description: "Standard cash account names",
    exactNames: ["Cash and Cash Equivalents", "Cash at Bank", "Petty Cash", "Bank Account"],
    nature: "asset", subNature: "cash_and_equivalents", confidence: 0.95 },

  { ruleId: "IFAC-COA-RECV-001", ruleVersion: "1.0.0", tier: 4,
    description: "Standard receivable account names",
    exactNames: ["Trade Receivables", "Accounts Receivable", "Debtors", "Trade Debtors"],
    nature: "asset", subNature: "receivable", confidence: 0.95 },

  { ruleId: "IFAC-COA-PPE-001", ruleVersion: "1.0.0", tier: 4,
    description: "Standard PPE account names",
    exactNames: ["Property, Plant and Equipment", "Fixed Assets", "PP&E"],
    nature: "asset", subNature: "ppe_net", confidence: 0.95 },

  { ruleId: "IFAC-COA-PAY-001", ruleVersion: "1.0.0", tier: 4,
    description: "Standard payable account names",
    exactNames: ["Trade Payables", "Accounts Payable", "Creditors", "Trade Creditors"],
    nature: "liability", subNature: "payable", confidence: 0.95 },

  { ruleId: "IFAC-COA-RE-001", ruleVersion: "1.0.0", tier: 4,
    description: "Retained earnings",
    exactNames: ["Retained Earnings", "Retained Surplus", "Accumulated Surplus", "Accumulated Deficit"],
    nature: "equity", subNature: "retained_earnings", confidence: 0.99 },

  // ── Tier 5: Keyword rules ─────────────────────────────────────────────────
  { ruleId: "KW-FUEL-001", ruleVersion: "1.0.0", tier: 5,
    description: "Fuel and petroleum expenses",
    keywords: ["fuel", "diesel", "petrol", "petroleum", "lubricant"],
    nature: "expense", subNature: "goods_and_services", confidence: 0.88 },

  { ruleId: "KW-SALARY-001", ruleVersion: "1.0.0", tier: 5,
    description: "Salary and wages",
    keywords: ["salary", "salaries", "wages", "payroll", "emoluments", "allowance"],
    nature: "expense", subNature: "personal_emoluments", confidence: 0.90 },

  { ruleId: "KW-RENT-001", ruleVersion: "1.0.0", tier: 5,
    description: "Rent and premises costs",
    keywords: ["rent", "lease", "office rent", "premises"],
    nature: "expense", subNature: "goods_and_services", confidence: 0.85 },

  { ruleId: "KW-REVENUE-001", ruleVersion: "1.0.0", tier: 5,
    description: "Revenue and income",
    keywords: ["revenue", "income", "sales", "fees", "charges", "cess", "levy"],
    nature: "income", subNature: "exchange_revenue", confidence: 0.80 },

  // ── Tier 7: Balance-side inference — CANDIDATE EVIDENCE ONLY ──────────────
  // CORRECTED FROM V1: these results must ALWAYS carry requiresReview: true
  // in the ClassificationResult, regardless of the confidence value stored
  // here. Confidence is deliberately low (0.30, down from 0.40) to make
  // clear this is the weakest possible evidence tier, one step above
  // "unresolved". Engine code applying these rules MUST hardcode
  // requiresReview = true for tier === 7, not derive it from confidence.
  { ruleId: "BSI-ASSET-001", ruleVersion: "1.0.0", tier: 7,
    description: "Debit balance + unknown account = CANDIDATE asset/expense signal only",
    nature: "asset", subNature: "other_asset", confidence: 0.30 },

  { ruleId: "BSI-LIABILITY-001", ruleVersion: "1.0.0", tier: 7,
    description: "Credit balance + unknown account = CANDIDATE liability/income/equity signal only",
    nature: "liability", subNature: "other_liability", confidence: 0.30 },
];
```

---

### Phase 3 Done When:
- [ ] Every TB account classified with a ruleId and tier (no silent phrase-match)
- [ ] `process-trial-balance` uses `EvidenceLadder` not inline phrase matching
- [ ] Tier 7 results always have `requiresReview: true`, enforced in code, not just by convention
- [ ] Tier 8 accounts flagged in PrepareWorkspace review list
- [ ] No rule claims statutory authority (`tier: 1`) without a genuine legal citation
- [ ] ruleVersion recorded in every classification (immutable audit trail)

---

## PHASE 4 — COMPARATIVE PERIOD ENGINE
### Files: 1 new · No DB migration required (uses `tb_certifications` from Phase 0)

**Iron Dome invariant:** No comparative figure is ever invented, inferred, or defaulted to zero. A missing comparative is MISSING — not zero, not null, not blank. A **known** comparative that happens to equal zero (the account genuinely had a zero balance, evidenced by a real prior-period certified TB) is a completely different fact from a **missing** comparative, and the type system must make it impossible to confuse them.

---

### 4.1 — New: `src/lib/hesabu/ComparativePeriodEngine.ts`

```typescript
// CORRECTED FROM V1: "zero" is REMOVED as a ComparativeState union member.
// Making the invalid state structurally unrepresentable is stronger than a
// runtime assertion against it. There are exactly three legitimate states.

export type ComparativeState =
  | "known"           // prior-period certified TB found → use it (amount may legitimately be 0)
  | "missing"         // no prior-period certified TB → must surface to user
  | "not_applicable"; // first year of operations → comparative legally excused

export interface ComparativePeriodResult {
  state: ComparativeState;
  priorPeriodYear: number | null;
  certificationId: string | null;
  // Present ONLY when state === "known". A known row's amount may be 0 —
  // that is a real, evidenced fact, distinct from state === "missing".
  tbRows: ComparativeTBRow[] | null;
  sourceType: "certified_tb" | "manual_entry" | "audited_fs_pdf" | null;
}

export interface ComparativeTBRow {
  accountCode: string;
  netBalance: number;   // may legitimately be 0 when state === "known"
  nature: string;
  subNature: string;
}
```

`assertComparativeNotZero` is removed — the "zero" state it guarded against no longer exists as a representable value, so the runtime assertion is redundant with the type system rather than a substitute for it.

---

### Phase 4 Done When:
- [ ] `ComparativeState` has exactly three members: `known | missing | not_applicable`
- [ ] HESABU never uses a fabricated zero for a missing comparative
- [ ] A `known` comparative with `netBalance: 0` renders distinctly from a `missing` comparative in the UI
- [ ] "missing" state surfaces to user with explicit message and resolution options
- [ ] Prior certified TB (from `tb_certifications`, Phase 0) is the preferred source; manual entry is fallback

---

## PHASE 5 — TWO CASH FLOW ENGINES
### Files: 2 new edge functions

No single cash flow engine. Two separate engines with a cross-check enforced.

**Engine A:** `supabase/functions/hesabu-cashflow-present/index.ts`
— Produces the primary Statement of Cash Flows (direct or indirect method)
— Input: CertifiedTB + EntityAccountingContext + framework profile (only if `maturity === "supported"`)
— Output: SCF line items per framework

**Engine B:** `supabase/functions/hesabu-cashflow-reconcile/index.ts`
— Produces the reconciliation (profit → operating cash flow)
— Cross-check: Engine A operating total MUST equal Engine B operating total within a **configured** tolerance

**CORRECTED FROM V1:** the reconciliation tolerance is NOT a hardcoded "TZS 1,000" — see the Magic Constants note at the top of this document. It must be read from a versioned, per-engagement materiality/tolerance policy. Until that policy exists, treat the check as unconfigured (block sign-off pending explicit configuration), never silently assume any specific number is correct across jurisdictions, entity sizes, and currencies.

**Iron Dome invariant for Phase 5:**
Operating cash flow from Engine A and Engine B must agree within the configured tolerance. If they disagree, the `statement_sign_offs` trigger must block sign-off. This is a new hesabu_gate trigger: `hesabu_cashflow_reconciliation_gate`.

---

### Phase 5 Done When:
- [ ] Both engines deploy and return correct shapes
- [ ] Cross-check enforced: sign-off blocked if engines disagree beyond the configured (not hardcoded) tolerance
- [ ] `hesabu_cashflow_reconciliation_gate` trigger added to `statement_sign_offs`
- [ ] Only frameworks with `maturity === "supported"` can reach cash-flow generation

---

## PHASE 6 — ACCOUNT REVIEW WORKBENCH (UI ONLY — REUSES PHASE 2A AUTHORITY)
### Files: 1 new component · Modifies: `PrepareWorkspace.tsx`

**This phase does not create a second professional-decision persistence system.** Phase 2A's `resolve_account_review_batch` RPC, `account_review_batches`, and `account_review_decisions` — an append-only, actor-attributed, company-scoped, reversible-via-supersession ledger — already exist, are repository-certified, and are the sole write authority for this domain. Phase 6 is the UI layer over that existing authority, extended (if genuinely needed) rather than duplicated.

---

### 6.1 — New: `src/components/safisha/AccountReviewWorkbench.tsx`

```typescript
interface AccountReviewWorkbenchProps {
  accounts: ReviewableAccount[];    // Tier 6–8 accounts from SAFISHA L4
  onCommit: (decisions: WorkbenchDecision[]) => Promise<void>; // → resolve_account_review_batch, not a new table
  onCancel: () => void;
}

interface ReviewableAccount {
  accountCode: string;
  accountName: string;
  netBalance: number;
  currentNature: AccountNature;
  currentSubNature: string;
  currentTier: EvidenceTier;
  evidence: string[];
  ruleId: string;
}

// CORRECTED FROM V1: field names and shape align with Phase 2A's real
// decision vocabulary (proposal_type / decision_action), not an invented
// AccountDecision shape. `decidedBy` is REMOVED from the client payload —
// actor identity is server-derived inside resolve_account_review_batch
// from auth.uid(), exactly as Phase 2A's "never trust client-supplied
// firmMemberId" invariant requires. The client sends intent; the server
// derives authority.
interface WorkbenchDecision {
  account_code: string | null;
  account_name: string;
  proposal_type: "NONE" | "MACHINE_SUGGESTION"; // AUTO_MAPPED_RULE not authorized client-side
  decision_action: "USER_ACCEPTED_SUGGESTION" | "USER_MANUAL_CLASSIFICATION" | "MARK_NON_REPORTING_ACCOUNT";
  statement?: string;
  classification?: string;
  line_item?: string;
  normal_balance?: "debit" | "credit";
  reason?: string;
}
```

**UX contract:**
- Previous / Next navigation — decisions are LOCAL DRAFT STATE until commit
- `currentIndex` and `decisions` live in `useState` — no network calls on each click
- "Save decisions" button → ONE call to `resolve_account_review_batch` with all decisions as an array (the existing RPC's batch/idempotency/concurrency model applies unmodified)
- If user clicks Next without deciding → account remains in review queue
- Progress indicator: "14 of 31 reviewed" — a count, not a wall of items
- Commit is disabled until all blocking (Tier 8) accounts have decisions

---

### Phase 6 Done When:
- [ ] Previous/Next works without page reload or API call
- [ ] Draft decisions survive navigation between accounts
- [ ] Save is one call to `resolve_account_review_batch` — no new table, no new RPC with independent write authority
- [ ] Blocking accounts cannot be skipped
- [ ] `decidedBy`/actor identity is never present in the client-sent payload

---

## PHASE 7 — SUPPORTING SCHEDULE CONTRACTS
### Files: 2 new TypeScript · 1 new edge function stub

Schedules are first-class data. They are not afterthoughts.

**Required schedules by framework (`maturity === "supported"` frameworks only):**

| Schedule | Required For | Optional For |
|----------|-------------|--------------|
| PPE Movement (additions, disposals, depreciation) | IPSAS, IFRS-SME | — |
| Deferred Income Movement | IPSAS (grants) | IFRS-SME |
| Capital Grants Movement | IPSAS | — |
| Provisions Movement | IFRS-SME | — |

```typescript
interface SupportingSchedule {
  scheduleCode: string;
  scheduleTitle: string;
  periodYear: number;
  companyId: string;
  openingBalance: number | null;  // null = MISSING, not zero
  additions: number | null;
  disposals: number | null;
  depreciation: number | null;
  closingBalance: number | null;  // must equal SFP balance if reconciled
  reconciliationStatus: "reconciled" | "drift" | "pending";
  drift: number;
}
```

**Iron Dome invariant:** `openingBalance: null` is MISSING — never zero. The `closingBalance` vs. SFP line-item-balance drift threshold is, like Phase 5's tolerance, a **configured** materiality value — see the Magic Constants note — not a hardcoded currency figure.

---

### Phase 7 Done When:
- [ ] PPE Movement schedule contract implemented
- [ ] Schedule reconciliation check runs after HESABU statement generation
- [ ] Drift beyond the configured threshold surfaces as a HESABU finding (not a hard block)

---

## PHASE 8 — MACHINE-CLASSIFICATION PROVENANCE
### Requires its own design gate before any migration is written (same rigor as Phase 0A)

**V1's Phase 8 is superseded — not merely renamed.** V1 proposed `ALTER TABLE account_mappings ADD COLUMN effective_from, effective_to, audit_status, confirmed_by, ...` — converting the mutable current-projection table into something history-shaped. That collides with three concepts that must stay architecturally distinct:

| Concept | Table | Role |
|---|---|---|
| Professional decision history | `account_review_decisions` (Phase 2A) | Immutable, append-only, actor-attributed history of human review decisions. Already has `firm_member_id`, `decision_action`, `previous_value`, `new_value`, `rule_id`, `rule_version`, `sequence_no`. |
| Framework-intelligence evidence memory | `account_mapping_memory` (Ω∞ Slice 12, shipped) | Provenanced classification *confirmations* for the reporting-framework/presentation domain — a different schema, different purpose, already live. |
| Current mapping projection | `account_mappings` | Mutable, current-state only. Stays that way. |

None of these should be collapsed into another, and `account_mappings` should not be altered into a fourth, competing history shape.

**What Phase 8 actually needs, once correctly scoped:** provenance for **machine-side** (EvidenceLadder Tier 1–7) auto-classifications — which today live only inside a single run's ephemeral `processing_result` JSON, with no durable ledger at all. This is a real, non-redundant gap, distinct from both `account_review_decisions` (human decisions) and `account_mapping_memory` (framework-intelligence confirmations). Closing it needs its own dedicated design pass — table shape, whether it reuses `account_review_decisions`'s sequence/ordering pattern or needs its own, RLS, retention — before any SQL is written. Not designed in this document.

---

### Phase 8 Done When:
- [ ] A dedicated design gate for machine-classification provenance has been certified (not started)
- [ ] `account_mappings` schema is unchanged by this phase
- [ ] `account_review_decisions` and `account_mapping_memory` remain untouched and architecturally distinct
- [ ] Historical machine classifications are queryable for audit without conflating them with professional decisions

---

## PHASE 9 — MAONO UNLOCK
### Condition: Phases 0A, 0–8 certified. Framework = a `maturity: "supported"` framework producing statements.

Set `MAONO_ENABLED=true` in Supabase Edge Function env vars (via the Lovable-Cloud workflow — see Deployment, below).
Remove the 503 guard from `maono-*` functions.

**MAONO scope (already built, now enabled):**
- Variance analysis (budget vs actual)
- Cashflow forecast (12-month rolling)
- Risk scoring
- Board pack generation

**MAONO invariants (must remain enforced):**
- MAONO never writes to financial tables — reads only
- MAONO output is advisory — not accounting records
- MAONO `engine_runs` still recorded for auditability (Phase 0A dependency)

---

### Phase 9 Done When:
- [ ] MAONO_ENABLED set in production env (via Lovable, not a personal CLI action against `bvyivmmfjejbmqoydezk`)
- [ ] Variance analysis returns correct figures against budget
- [ ] MonitorWorkspace shows live MAONO outputs
- [ ] Phase B locked guard removed

---

## DEPLOYMENT — CORRECTED WORKFLOW

**V1's deploy checklist (`git push origin main`, `supabase db push` against `bvyivmmfjejbmqoydezk`) is invalid for this project.** `bvyivmmfjejbmqoydezk` is Lovable Cloud-managed — it does not appear in, and cannot be reached by, a personal Supabase CLI session (established and repeatedly reconfirmed this session). Never substitute an unrelated personally-owned project as a workaround.

**Actual workflow, per phase:**

```
1. Work on a dedicated feature branch (never main directly)
2. TypeScript check:
   node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json
3. Full test suite (vitest)
4. Clean, scoped commit — only the phase's own files
5. Push the feature branch (never main)
6. Lovable applies any DB migration for that phase, when required
7. Live verification — relayed evidence from Lovable (SQL Editor output,
   regenerated types, etc.), the same pattern used to certify Phase 2A
8. Certification gate for the phase, evidence-backed
9. Controlled merge to main — only after certification, only with explicit
   authorization
```

---

## IRON DOME INVARIANTS — PERMANENT, NON-NEGOTIABLE (Corrected)

These apply to every phase. No exception. No workaround.

1. **firmMemberId is the canonical actor**, but no shared helper resolves it automatically today — every function must derive it explicitly (via `firm_members` lookup) until Phase 0A ships a canonical resolver. `auth.users.id` is for auth only.
2. **NULL means NOT COMPUTED.** No zero defaults on computed columns, and no "zero" as a valid *state* where "missing" is the correct state (see Phase 4).
3. **Sole write authority via Edge Functions / certified RPCs.** React = read-only for financial tables. Account-review decisions specifically go through `resolve_account_review_batch` — never a second backend.
4. **No silent defaults.** Missing fiscal year / TIN / VAT status / EFDMS registration / reporting framework = explicitly unknown, not guessed. Entity class is evidence toward a framework, never proof of one.
5. **Stale-validation gate.** Input hash mismatch reverts stage to in_progress — requires Phase 0A's `engine_runs` to exist; not yet enforceable.
6. **Sign-off role enforcement.** Real roles are `owner`, `partner`, `preparer`, `viewer` — `preparer` self-attests only; `owner`/`partner` alone may lock/approve, with maker-checker enforced. `'manager'` is not a valid role.
7. **`computation_detail` not `result_json`.** `result_json` does not exist.
8. **`safisha-efdms-ingest` uses service role.** Do not change to anon key.
9. **No exposure of SAFISHA/HESABU/KINGA/MAONO in user navigation.**
10. **`zeroIfMissing` is always false.** At type level and at runtime.
11. **Sign is evidence, never account nature.** A debit or credit balance alone never authoritatively determines asset/liability/equity/income/expense (Phase 3, Tier 7).
12. **No hardcoded materiality/tolerance constants in production logic.** Every currency/percentage threshold in this directive is a default suggestion, sourced from configuration once it exists (see Magic Constants note).

---

## FINAL VERDICT — ARCHITECTURE CERTIFICATION (V2)

> The security architecture's *principles* (firmMemberId as canonical actor,
> NULL-means-NOT-COMPUTED, sole write authority, sign-off segregation of
> duties) are sound and, where actually shipped (Phase 2A, TIN gate, RLS
> segregation-of-duties work), verified world-class. The *infrastructure*
> claimed to support them project-wide — `engine_runs`, `idempotency_keys`,
> a canonical `firmMemberId` resolver — is **not yet built**. Phase 0A exists
> to close that gap honestly rather than let later phases quietly assume it.
>
> The computation architecture (KINGA, HESABU, SAFISHA pipeline) requires
> **Phase 0A, then Phases 0–5** — genuinely shipped and repository-verified,
> not merely documented — before international deployment is defensible.
>
> After Phase 5, repository-verified: **IRON DOME NUCLEAR — CERTIFIED.**
> After Phase 9, repository-verified: **IRON DOME NUCLEAR Ω∞.**
>
> V1's certification language was, in places, aspirational rather than
> descriptive. V2 does not repeat that — every "CERTIFIED" claim in this
> document has been checked against the actual repository this session.

*SAFF ERP Claude Code Implementation Directive — V2, reconciled 2026-09-01*
*This document is the sole implementation authority. Repository evidence outranks documentation, always.*
