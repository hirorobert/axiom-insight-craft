# SAFF ERP — Ω∞ IMPLEMENTATION DIRECTIVE V5
## Iron Dome Nuclear · Repository-Authoritative · Consistency-Hardened · Final
## ONE BOOK. ONE TRUTH. NO SNEAKY WRITERS.
## September 2026

> **CLAUDE CODE: PART II BEFORE ANYTHING ELSE.**
> Repository evidence is ALWAYS authoritative over this document.
> Where this document and the repository conflict: the repository wins.
> Each phase is assessed against real repository state before a line of code is written.
> Do not fix unrelated defects. Do not reopen closed phases.
> Do not create migrations, deploy, use Lovable, or push to main without explicit GO.

---

## PART I — STATUS TABLE

| # | Invariant | Status | Note |
|---|-----------|--------|------|
| 1 | firmMemberId canonical actor | **PARTIAL** | Phase 0A closed. Canonical resolver is `resolveFirmMemberActor()` in `_shared/actor.ts` — repository-authoritative. Do not create a competing resolver in `_shared/auth.ts`. System actors use `firm_member_id = NULL`. Both are valid actors. |
| 2 | NULL = NOT COMPUTED | **CERTIFIED** | Broadly applied. No violation found. |
| 3 | Sole write authority via Edge Functions | **PARTIAL** | Scoped to: authoritative financial/domain writes. `AccountMappingManager.tsx` = `LEGACY_UNREACHABLE_WRITE_SURFACE`. Do not delete. Do not fix opportunistically. |
| 4 | No silent defaults | **PARTIAL** | TIN gate real. Entity/framework detection = suggestion only. "Not determined" is a valid UI state. |
| 5a | Engine execution / hash / provenance infrastructure | **CERTIFIED — Phase 0A CLOSED** | `engine_runs`, `idempotency_keys`, canonical hashing, actor resolution: complete. Do not rebuild. |
| 5b | Source→certification staleness authority | **PHASE 0 REQUIRED** | Phase 0A provides the hashing foundation. Phase 0 must establish `source_file_hash` identity, certification fingerprint, and which certification is currently authoritative for a given company + period + source. |
| 6 | Sign-off role enforcement | **CERTIFIED — OPTIONAL GOVERNANCE** | Maker-checker exists. Not a prerequisite for SAFISHA / HESABU / KINGA execution. |
| 7 | `engine_runs` reproducibility ledger | **CERTIFIED — Phase 0A CLOSED** | |
| 8 | `idempotency_keys` deduplication | **CERTIFIED — Phase 0A CLOSED** | |
| 9 | RLS hardening | **PARTIAL** | Real work exists. Cited V1–V4 migration IDs were wrong. |
| 10 | KINGA ITA Cap.332 / FA2026 | **CERTIFIED** | |
| 11 | 7-stage workspace shell | **CERTIFIED** | |
| 12 | TIN gate on upload | **CERTIFIED** | |
| 13 | Duplicate filename detection | **CERTIFIED** | |
| 14 | Account review authority (Phase 2A) | **PARTIAL** | `resolve_account_review_batch` exists. `account_review_decisions` is the immutable professional decision authority. Privilege hardening pending. |
| 15 | `account_mapping_memory` provenance | **CERTIFIED** | Evidence/mapping-memory structure. Distinct from `account_mappings` (mutable projection) and `account_review_decisions` (decision authority). |

**VERDICT: Phase 0A CERTIFIED AND CLOSED. Phases 0–5 remain to ship for international deployment.**

---

## PART II — EXECUTION RULES

These override any conflicting instruction in Phases 0–9.

**Rule 1 — Phase 0A is CERTIFIED AND CLOSED.**
`engine_runs`, `idempotency_keys`, actor resolution, canonical hashing, terminal lifecycle protection, bounded envelopes, ACL hardening, concurrency handling: all complete. The canonical actor resolver is `resolveFirmMemberActor()` in `_shared/actor.ts`. Do not create a competing resolver. Repository decides exact function and file names — not this document.

**Rule 2 — `status = 'stale_detected'` does not exist. Withdrawn.**
Stale authority = `source_file_hash` vs `certification.input_hash`. Phase 0 establishes this. Phase 0A provides the hashing primitives.

**Rule 3 — Phase 0 must not implement Phase 3 or Phase 4 opportunistically.**
Phase 0 establishes the SAFISHA L4 contract and integrates with the current classification/review boundary. Phase 3 upgrades L4 to the full Evidence Ladder later. Phase 0 L6 establishes the minimum prior-period signal only. Phase 4 implements full comparative semantics later.

**Rule 4 — firm_members is workspace membership. Do not redesign or rename it.**
Any authenticated workspace owner/member may use SAFISHA, HESABU, KINGA. System actors use `firm_member_id = NULL`. Both are valid.

**Rule 5 — Sign-off is optional governance, not an engine prerequisite.**
Login → Entity → Upload → Process → Results. Maker-checker is available for formal governance. It is not a gate on ordinary engine execution.

**Rule 6 — Entity detection is suggestion only. "Not determined" is valid.**
Detection from TB signals provides evidence — not certainty. Framework, jurisdiction, fiscal year end, VAT status, entity class all remain `null` until the user confirms. The UI may display "Not determined" for any field where evidence is absent. Never invent a detection to fill the UI.

**Rule 7 — No automatic deployment. Feature-branch workflow only.**
Never run: `git push origin main`, `supabase db push`, `supabase functions deploy` autonomously.
Required: feature branch → implementation → TS/tests/build/diff → push feature branch → explicit human GO → merge decision.

**Rule 8 — Authoritative write boundary, not blanket Edge Function rule.**
Every authoritative financial/domain write must cross a server-controlled write boundary. React must not directly mutate authoritative financial tables. Benign UI state, local preferences, and draft state are not constrained by this rule.

**Rule 9 — Append-only is scoped, not universal.**
Authoritative financial records, certifications, engine executions, professional decisions, and audit-provenance history must be append-only or reversed/superseded through attributed records. Temporary, cache, draft, and UI tables are not subject to this constraint.

**Rule 10 — Phase 6 must reuse Phase 2A. No competing authority.**
The Account Review Workbench (Phase 6) must reuse the existing Phase 2A professional review authority and write boundary (`resolve_account_review_batch`, `account_review_decisions`). It must not create competing review-decision tables, competing write authority, competing exclusion persistence, or a competing professional-decision ledger. Phase 6 is the reversible UX over the existing authority.

**Rule 11 — Three mapping concepts are distinct. Do not collapse them.**
- `account_mappings` — mutable effective projection
- `account_mapping_memory` — evidence / mapping memory (CERTIFIED)
- `account_review_decisions` — immutable professional decision authority (Phase 2A)

**Rule 12 — Commercial hypotheses are not implementation invariants.**
Pricing model, SEO opportunity, competitor comparisons = product hypotheses. They inform strategy. They are not database constraints. Claude must not encode them as technical requirements.

**Rule 13 — Offline-first is planned capability, not a Phase 0–5 blocker.**
`sync_outbox` / PWA / IndexedDB is valuable. It does not block SAFISHA or HESABU delivery.

---

## PART III — THE GLOBAL PLATFORM

### One Sentence

> Upload a trial balance. Get audit-ready financial statements, a tax computation, and a filing package — for any IFRS jurisdiction, any entity class, any firm size.

### The Three-Layer Stack

```
LAYER 1 — TRUST INFRASTRUCTURE (global · jurisdiction-agnostic · immutable)
  Actor identity (user: firmMemberId | system: NULL firm_member_id)
  engine_runs ledger · idempotency_keys · canonical hashing
  RLS row isolation · append-only authoritative records
  optional sign-off governance · NULL = NOT COMPUTED · sole write authority
  ─────────────────────────────────────────────────────────────────────────
  THIS LAYER IS CERTIFIED. IT IS THE MOAT.

LAYER 2 — ACCOUNTING INTELLIGENCE (global core + jurisdiction modules)
  SAFISHA    TB Certification (universal: L1–L6 works for any CoA)
  HESABU     Financial Statements (IPSAS · IFRS · IFRS-SME)
  MAONO      Analytics · Variance · Board Pack (Phase 9)
  KINGA-TZ   Tanzania ITA Cap.332 (jurisdiction module — not core)
  KINGA-[XX] Future jurisdictions (same interface, different rules)

LAYER 3 — DISTRIBUTION
  Self-serve → TB upload → value in < 5 minutes
  SEO per vertical (Part VI) · enterprise demo path
```

### Jurisdiction Module Interface

```typescript
interface JurisdictionTaxEngine {
  jurisdictionCode: string;   // "TZ", "KE", "NG"
  displayName: string;        // "Tanzania ITA Cap.332"
  compute(params: {
    certifiedTB: CertifiedTB;
    entityContext: EntityAccountingContext;
    periodYear: number;
    firmMemberId: string;     // from resolveFirmMemberActor() — never auth.users.id
  }): Promise<JurisdictionTaxResult>;
}

interface JurisdictionTaxResult {
  jurisdictionCode: string;
  taxableIncome: number | null;    // null = NOT COMPUTED — never zero
  taxPayable: number | null;
  computationDetail: Record<string, unknown>; // canonical — NOT result_json
  engineRunId: string;
  inputHash: string;
}
```

---

## PART IV — THE CANONICAL PIPELINE

```
UPLOAD (CSV · XLSX · XLS · PDF)
    ↓
SAFISHA — TB CERTIFICATION (L1–L6)

  L1  File integrity       pass | reject (hard stop)
      [CLIENT-SIDE before upload: instant feedback, saves bandwidth]
  L2  Structure            pass | warn
  L3  Debit = Credit       pass | FAIL (blocks HESABU — non-negotiable)
      [denominator edge case: see Phase 0 assessment requirement]
  L4  Classification       auto | review | unresolved
      [uses CURRENT classifier; Phase 3 upgrades to Evidence Ladder]
  L5  Completeness         complete | gaps
      [bank/EFDMS matching = evidence signal here — NOT removed, NOT replaced]
  L6  Prior-period signal  prior_certified | no_prior | insufficient_evidence
      [Phase 4 upgrades to full comparative semantics]

    ↓
CERTIFIED TRIAL BALANCE
    ↓
    ├── HESABU (Financial Statements: IPSAS · IFRS · IFRS-SME)
    └── KINGA-[XX] (Jurisdiction Tax — parallel, not sequential)
         ↓
       MAONO (Phase 9 — after HESABU certified in production)
         ↓
       XBRL + FILING PACKAGE

Invariants at every node:
  NULL = NOT COMPUTED (never zero, never sentinel)
  Authoritative writes via server boundary (never direct React mutation)
  User actor = firmMemberId via resolveFirmMemberActor() — never auth.users.id
  System actor = NULL firm_member_id (valid Phase 0A model)
  Every computation in engine_runs; every POST idempotent via idempotency_keys
  Bank/EFDMS matching preserved as L5 evidence — zero regression
```

---

## PART V — UX CONTRACT
### Premier Corporate · Mobile-Native · No Tutorial Mood

The visual language: white space, precision, restraint. Numbers are sacred — they do not bounce, fade, or animate. The eye has a resting place on every screen: one dominant element, everything else recessed. This is financial infrastructure. It must look like it.

### The Happy Path

```
STEP 1  LAND
        "Trial balance in. Statements and tax out."
        ONE button: "Upload a trial balance →"
        Nothing else requiring a decision.

STEP 2  SIGN UP (if new)
        Email + password. Two fields. One button.
        No credit card. No plan. No wizard.

STEP 3  UPLOAD
        Drag or click. L1 runs client-side before upload begins.
        L1 fail → one sentence + one action. No stacked errors.
        L1 pass → progress bar. Done.

STEP 4  ENTITY CONFIRMATION
        System shows detected signals as a SUGGESTION — never authority.
        Any field may read "Not determined" — this is valid and honest.

        ┌────────────────────────────────────────────┐
        │ Detected:                                   │
        │   Arusha District Council                   │
        │   Framework:   IPSAS Accrual                │
        │   Jurisdiction: Tanzania                    │
        │   Fiscal year:  Not determined              │
        │                                             │
        │  [Confirm →]          [Change]              │
        └────────────────────────────────────────────┘

        If any required field = "Not determined":
        "Confirm →" disabled. User selects before proceeding.
        Maximum three fields to correct. Never a settings wizard.

STEP 5  SAFISHA RUNS
        Six-step checklist completes in sequence.
        L3 fail → one red row, exact imbalance, one action.
        L4 exceptions → "[N] accounts need review" + "Review →"
        Inline. In context. Not a modal.

STEP 6  ACCOUNT REVIEW (if needed)
        One account at a time. ← Previous · [N of M] · Next →
        Three options: Accept / Change to / Exclude.
        Decisions are LOCAL DRAFT until "Save decisions" — one call.
        Back works. Decisions survive navigation.
        Tier 8 accounts cannot be skipped.
        Review uses Phase 2A authority (resolve_account_review_batch).

STEP 7  HESABU
        "Generating statements…" — target < 30 seconds.
        SFP + SCI (or SOFP + SOFP per framework).
        PDF immediately available.

STEP 8  KINGA (in parallel for TZ entities)
        Tax result alongside statements.
        "Filing package ready" — one download button.

STEP 9  DONE
        Target: < 10 minutes for a clean TB.
        Target: < 25 minutes for a TB with exceptions.
```

### Path-Native Defaults

```
one primary action      — one dominant CTA per stage, never two simultaneously
remembered context      — company, framework, fiscal year remembered after first run
single entry point      — search/scan/type from one field
inline validation       — at the field, not on submit
no tutorial mood        — the product explains itself through behaviour
no onboarding maze      — accountants are professionals; treat them accordingly
```

### Error Display Contract

Every user-facing error: exactly three elements.

```
[What went wrong — one sentence, plain language]
[Why — one sentence, optional, only if it helps the user act]
[What to do — one action button or one link]
```

Permanently banned from user-facing output:
- Stack traces · SQL error codes · engine names (SAFISHA/HESABU/KINGA/MAONO)
- "An unexpected error occurred" with no action
- Stacked errors without hierarchy

**The bookkeeper test:** Can a bookkeeper with a Form 4 certificate understand this and fix it without calling support? If no — rewrite it.

### Visual Design Contract

Typography: one type scale. Body: 15–16px, line-height 1.6. Financial data: tabular-nums, right-aligned. Max two header levels visible at once. No decorative text.

Colour: primary (action) + destructive (error) + neutral surface. Accent (success) used sparingly. No colour for decoration.

Motion: none on financial data. Skeleton loaders on fetch. Progress bar on engine runs. No bouncing numbers.

Mobile: full workspace at 360px. `shortLabel` tabs (PREP / RECON / STMTS / TAX / COMPLY / FILING / MON). All tap targets ≥ 44px. No horizontal scroll.

---

## PART VI — GLOBAL ACQUISITION

### Five Verticals — Priority Matches Build Readiness

**Vertical 1 — IFRS Compliance Automation** *(launch after Phase 2)*
Keywords: `ifrs financial statements software` · `ias 1 compliance software` · `ifrs for smes software`
Gate: Do not run this SEO before Framework Registry (Phase 2) ships.

**Vertical 2 — Financial Data Governance / Audit Trail** *(launch now — already built)*
Keywords: `audit trail software` · `immutable financial records` · `financial data governance`
Why now: Trust Infrastructure is certified. Append-only, actor attribution, trigger-level enforcement. This is genuinely differentiated.

**Vertical 3 — Financial Close & Reconciliation** *(launch after Phase 3)*
Keywords: `account reconciliation software` · `trial balance reconciliation` · `balance sheet reconciliation`

**Vertical 4 — Multi-Jurisdiction Tax** *(launch after jurisdiction #2 ships)*
Rule: Do not claim "multi-jurisdiction" with one jurisdiction. Earn the claim.

**Vertical 5 — General ERP** *(24+ month play)*
Rule: Do not invest now. Win verticals 1–4 first.

### Hero Copy

Current hero subtitle — "IFRS financial statements and a Tanzania corporate tax computation from a single verified trial balance" — kills global conversion. "Tanzania" in the hero signals regional tool.

V5: "IFRS financial statements and a full tax computation — from one verified trial balance."
Tanzania module = feature callout below the fold. Global claim leads.

### CTA Architecture

```
PRIMARY:    "Upload a trial balance →"   [hero · no credit card · first engagement free]
SECONDARY:  "Book a demo"               [hero · CFOs, controllers, audit chairs]
TERTIARY:   "See the security architecture →"  [below-fold · compliance buyers]
```

---

## PART VII — PHASE 0A (CERTIFIED — CLOSED — DO NOT REBUILD)

Phase 0A is complete. Implemented capabilities:
- `engine_runs`: actor_type (user/system), `firm_member_id` NULL for system actors, terminal lifecycle protection, bounded replay/error envelopes
- `idempotency_keys`: UNIQUE NULLS NOT DISTINCT, client_request_id, request_hash, input_hash
- Canonical actor resolver: `resolveFirmMemberActor()` in `_shared/actor.ts`
- ACL hardening; service-role write authority; concurrency / lost-race handling

**Only action required in Phase 0A context:** Verify `resolveFirmMemberActor()` is imported correctly in all edge functions that write financial data. If any edge function bypasses it and uses `auth.users.id` directly — that edge function needs a targeted fix in its own phase. Do not create a competing resolver.

---

## PART VIII — PHASE 0 — SAFISHA TB CERTIFICATION
### Status: DESIGN INPUT — Repository Assessment Required Before SQL

### Repository Assessment (Four Questions — Answer Before Writing Code)

1. Does `source_file_hash` (or equivalent source identity field) exist on `trial_balance_uploads`? If not, document what field to add.
2. What is the current relationship between `trial_balance_uploads` and `engine_runs`? Foreign key? Join table?
3. Does any form of `tb_certifications` table or certification record exist?
4. What does `process-trial-balance` currently write as its output record?

Only after these are answered does schema design proceed.

### Source Identity vs Normalized Input Hash (Distinct Concepts)

Do not treat these as identical:

`source_file_hash` = SHA-256 of the original uploaded file bytes. Establishes source identity. Links certification to the exact file uploaded.

`engine_input_hash` = SHA-256 of the canonical normalized TB input (rows sorted, whitespace stripped, encoding normalized). Establishes computation identity. Used by engine_runs for stale-validation.

They serve different provenance purposes. Phase 0 assessment determines whether both are needed, or whether an equivalent existing mechanism covers one or both.

### Certified TB Authority Requirement

Phase 0 design must answer: for a given (company_id, period_year, source_file_hash), which certification record is currently authoritative? Historical certifications must remain immutable evidence. A newer source version must not allow downstream engines to accidentally consume an old certification. Do not prescribe CURRENT / STALE / SUPERSEDED columns until the repository assessment determines whether authority is stored or derived.

### SAFISHA L1–L6 Design

```
L1  File integrity        pass | reject [hard stop]
    Runs CLIENT-SIDE before upload. Parseable, encoding detected, minimum rows.
    Fast fail = better UX than uploading an unreadable file.

L2  Structure             pass | warn
    Required columns. No fully empty rows. Header detected and excluded.

L3  Debit = Credit        pass | FAIL [blocks HESABU]
    Configurable tolerance — not hardcoded in this document.
    Phase 0 assessment defines exact semantics including the
    debit_total=0 and credit_total=0 denominator edge case.
    Error message: plain language, exact imbalance amount, one action.

L4  Classification        auto | review | unresolved
    Uses CURRENT classification/review architecture.
    Phase 3 upgrades to full 8-Tier Evidence Ladder.
    Phase 0 must NOT implement Phase 3 opportunistically.
    Unresolved accounts remain explicit.
    Sign / balance side is NEVER authoritative classification (Rule: SIGN IS EVIDENCE ONLY).

L5  Completeness          complete | gaps
    Bank/EFDMS matching = evidence signal here. Not removed. Not replaced.
    Expected account families for detected entityClass.
    Missing families = warning, not error.

L6  Prior-period signal   prior_certified | no_prior | insufficient_evidence
    Phase 0 establishes the minimum signal supported by repository evidence.
    Phase 4 implements full comparative semantics (known/missing/not_applicable).
    Never substitute zero for missing prior-period figures.
```

### CertifiedTB Types (Design Input — Reconcile With Repository)

```typescript
// src/lib/safisha/types.ts

export type SourceSystem =
  | "muse" | "gacs" | "quickbooks" | "sage" | "tally" | "excel_manual" | "unknown";

export type EntityClass =
  | "lga" | "central_agency" | "soe_ifrs" | "ngo_cbo"
  | "private_ifrs" | "private_ifrs_sme" | "unknown";

export type AccountNature = "asset" | "liability" | "equity" | "income" | "expense";

export interface SafishaException {
  code: string;
  layer: 1 | 2 | 3 | 4 | 5 | 6;
  severity: "error" | "warning" | "info";
  accountCode?: string;
  message: string;       // bookkeeper test: plain language, one action
  resolution?: string;
}

export interface CertifiedTB {
  certificationId: string;
  sourceFileHash: string;      // SHA-256 of original file bytes — source identity
  engineInputHash: string;     // SHA-256 of normalized TB input — computation identity
  engineRunId: string;         // references engine_runs.id
  companyId: string;
  periodYear: number;
  certifiedAt: string;
  firmMemberId: string;        // resolveFirmMemberActor() result — never auth.users.id
  tbRows: CertifiedTBRow[];
  // overallConfidence: DESIGN-UNRESOLVED — Phase 3 establishes confidence semantics
  exceptionCount: number;
  isBlockingException: boolean;
  sourceSystem: SourceSystem;
  entityClass: EntityClass;    // detected signal — user must confirm
}

export interface CertifiedTBRow {
  accountCode: string;
  accountName: string;
  nature: AccountNature;
  subNature: string;
  debitBalance: number;
  creditBalance: number;
  netBalance: number;
  evidenceTier: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  ruleId: string;
  ruleVersion: string;
  // confidence: DESIGN-UNRESOLVED per Phase 7 — Phase 3 establishes semantics
  requiresReview: boolean;
}
```

### Phase 0 Done When:
- [ ] Four repository assessment questions answered with evidence
- [ ] `source_file_hash` on `trial_balance_uploads` (migration if absent)
- [ ] `safisha-validate-tb` deploys and returns `CertifiedTB` shape
- [ ] L3 blocks debit ≠ credit; denominator edge case handled per assessment
- [ ] L4 integrates with current classifier — does NOT implement Phase 3
- [ ] L5 consumes bank/EFDMS matching as evidence — zero regression
- [ ] L6 returns minimum prior-period signal — does NOT implement Phase 4
- [ ] `tb_certifications` (or equivalent) persists result linked to `engine_runs`
- [ ] Certification authority question answered (stored or derived)
- [ ] Entity detection shown as suggestion; "Not determined" displayed where evidence absent
- [ ] PrepareWorkspace shows 6-layer checklist after validation

---

## PART IX — PHASES 1–9

> **Reconciled 2026-09-03 against the prior `V2` directive
> (`Ω∞ CLAUDE CODE IMPLEMENTATION DIRECTIVE — V2`, Reconciled 2026-09-01) and
> the actual repository state.** V2 predates Phase 0A/Phase 0's construction
> and is superseded as an authority — this document (V5) governs. Where V2's
> detailed per-phase sketches turned out to already exist in the repository
> (under different names/shapes, generally unwired into live traffic), that
> is noted inline as "Implementation status." Where V2 proposed a mechanism
> the real implementation deliberately rejected, that is marked SUPERSEDED
> with its reasoning, not silently dropped. Full adjudication record: this
> session's Phase 3 / classification rule-pack analysis (branch
> `directive-v5-reconciliation-20260903`).

### Phase 1 — EntityAccountingContext (No Silent Defaults)

All unknown fields typed as `| null`. No field has a default value. Missing = explicit null.

`suggestFrameworkForEntityClass()` is a suggestion function — returns `"unknown"` when entityClass is `"unknown"`. The UI requires explicit confirmation for every detected value. `isVATRegistered: null` means unknown — never `false`. `isTanzaniaEFDMSRegistered: null` means unknown — never `false`.

The entity confirmation screen may display "Not determined" for any field where evidence is genuinely absent. The system never invents a detection.

**Implementation status (reconciled 2026-09-03):** exists today as `src/lib/accounting/entityContext.ts`, `detectEntityContext.ts`, `frameworkAdapter.ts` — every invariant above is preserved there under different type/function names than this section's illustrative sketch. **Not yet wired into any live UI flow.** Slice 4B (Phase 0) wired a read-only projection of the `reportingFramework` dimension only (`EntityContextSuggestion.tsx`) — the rest of `EntityAccountingContext` remains dormant pending a later slice.

**Done when:** All unknown fields are `null`. TypeScript strict null checks prevent silent defaults.

### Phase 2 — Framework Registry

Framework-specific behaviour must be driven through registered profiles and strategies rather than scattered ad-hoc branching through engine code. This does not prohibit legitimate, encapsulated, framework-specific implementation — it prohibits framework-name branching scattered across the engine. HESABU reads from `FRAMEWORK_REGISTRY[context.reportingFramework]` and applies the profile. Internal encapsulated behaviour within a profile module is permitted.

`zeroIfMissing` does not exist as a field, value, or concept. Its absence at the type level enforces invariant 4.4 structurally.

**Implementation status (reconciled 2026-09-03):** exists today as `src/lib/accounting/frameworkPresentationRegistry.ts` (tested, `frameworkPresentationRegistry.test.ts`). Exact line-item/statement-code coverage against this section's illustrative sketch not verified field-by-field — treat as materially equivalent, not byte-identical. Not yet wired into HESABU's live statement-rendering path.

**Done when:** Framework profiles compile. `grep -r "zeroIfMissing" src/` returns zero. No scattered `if (framework === 'ipsas_accrual')` branching in engine code.

### Phase 3 — 8-Tier Evidence Ladder

Upgrades SAFISHA L4 from current classifier to full auditable tiered classification. **Does not touch Phase 0's certified tiers 1–5** (`process-trial-balance/index.ts`'s own `evidenceTier: 1|2|3|4|5` classifier) — that classifier is confirmed unrelated to and unimported by anything below; this section governs a separate, later upgrade, not a retrofit.

| Tier | Authority | Status | Implementation status (reconciled 2026-09-03) |
|------|-----------|--------|------|
| 1 | Statutory code (ITA s.34, MUSE CHART) | Auto — 0.99 | MISSING — none registered yet, none claimed |
| 2 | Exact source-system code match | Auto — HIGH confidence | **EXACT_IMPLEMENTATION** — `src/lib/accounting/museIpsasRulePack.ts` (`TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1`, 294 rules, one per literally-observed MUSE code from real Arusha DC trial-balance data) + `museClassifier.ts` (`classifyMuseAccount`). **Dormant — zero references from `process-trial-balance/index.ts`; dry-run only, per its own docstring.** |
| 3 | Source-system code **range**/prefix match | Auto — 0.93 | **SUPERSEDED.** The real Tier-2 implementation is deliberately exact-code-only, never range/prefix-based — its own header states *"nothing here is a guessed prefix pattern extrapolated beyond what was actually observed... a code NOT in this list resolves to UNRESOLVED, never a guess."* Do not build a range-matching tier; it was considered and rejected. |
| 4 | IFAC standard name exact match | Auto — 0.92 | MISSING — no name-keyed matching path exists anywhere in the current rule pack |
| 5 | Industry keyword match | Auto — 0.85–0.92 | **SUPERSEDED.** `museClassifier.ts`'s own docstring: *"no lexical fallback rules beyond the exact-code rule pack (deliberately: PHASE-0 confirmed no authoritative GFS lookup table exists to build a safe lexical/fuzzy tier from — inventing one would be exactly the fabricated-certainty failure mode Section XVIII prohibits)."* Do not build a keyword tier without first establishing that lookup table as real evidence. |
| 6 | Fuzzy / phonetic match | Review required — 0.60–0.84 | **SUPERSEDED**, same reasoning as Tier 5 |
| 7 | Balance-side inference | **WEAK EVIDENCE ONLY — never independently authoritative** | MISSING — still binding when built (see enforcement rule below, unchanged) |
| 8 | Unresolved | Human review required | **EXACT_IMPLEMENTATION** — `classifyMuseAccount` returns `UNRESOLVED`/`confidence: "NONE"` on no match, never a guess |

Confidence is represented as a **categorical `ConfidenceLevel`** (`HIGH`/`MEDIUM`/`LOW`/`NONE`, matching `entityContext.ts`'s established convention across this file cluster), not a raw 0–1 float. `overallConfidence` remains DESIGN-UNRESOLVED until Phase 3 is actually built end-to-end — no such field exists on any certified Phase 0 record, and none should be added opportunistically.

**Tier 7 enforcement (still binding, unchanged):** May contribute to confidence scoring. Cannot independently resolve an account. If Tier 7 is the highest tier reached: `requiresReview = true`, `evidenceTier = 7`, hardcoded — never derived from confidence. Never auto-classify from Tier 7 alone. Nothing shipped today implements or contradicts this; it remains the binding spec for whenever Tier 7 is built.

**MUSE-gating invariant (later-settled, applies to this whole section):** IPSAS-accrual reporting framework alone does NOT imply MUSE source system. Automatic MUSE exact-code classification (Tier 2 above) requires affirmative MUSE source-system evidence before it may ever be wired live — today that evidence doesn't exist in any live path, which is exactly why Tier 2's real implementation stays dormant rather than being connected to `process-trial-balance`.

### Phase 4 — Comparative Period Engine

Upgrades Phase 0's minimum L6 signal to full comparative accounting semantics.

```typescript
// Only three valid states — "zero" does not exist
export type ComparativeState = "known" | "missing" | "not_applicable";
```

When `state = "missing"`: surface to user with two explicit actions. Never proceed silently. Never substitute zero. Never invent a figure.

### Phase 5 — Two Cash Flow Engines

`hesabu-cashflow-present` — IAS 7 / IPSAS 2 Statement of Cash Flows.
`hesabu-cashflow-reconcile` — indirect method reconciliation (profit → operating CF).

Cross-check: operating CF from both engines must agree within configurable materiality threshold. Disagreement → `hesabu_cashflow_gate` trigger blocks statement sign-off where sign-off is in use. (Sign-off remains optional governance — Phase 5 does not make it mandatory.)

### Phase 6 — Reversible Account Review Workbench (Reuses Phase 2A)

**Rule 10 enforcement:** Phase 6 MUST reuse Phase 2A professional review authority:
- `resolve_account_review_batch` — the write boundary
- `account_review_decisions` — the immutable decision ledger

Phase 6 must NOT create: competing review-decision tables, competing write authority, competing exclusion persistence, a competing professional-decision ledger.

Phase 6 is the reversible UX over the existing authority.

UX: decisions = local `useState` draft. One Save = one call to `resolve_account_review_batch` with all decisions as array. Previous/Next = no API calls. No data written until explicit Save. Tier 8 accounts cannot be skipped.

### Phase 7 — Supporting Schedule Contracts

PPE Movement, Deferred Income, Capital Grants, Provisions. `openingBalance: number | null` — null = MISSING, never zero. Closing balance reconciliation drift triggers a HESABU finding. Materiality threshold is configurable — not hardcoded.

### Phase 8 — Machine-Side Classification Provenance

`account_mapping_memory` is CERTIFIED (existing evidence structure). Phase 8 adds machine-side provenance fields: `source_rule_id`, `rule_version`, `effective_from`, `effective_to`. Mappings are never overwritten — new row + supersede old.

**Implementation status (reconciled 2026-09-03):** `src/lib/accounting/mappingMemory.ts` and the `account_mapping_memory` table both confirmed live. Whether the specific fields named above (`source_rule_id`, `rule_version`, `effective_from`/`effective_to`) are already present on the table was not re-verified this reconciliation pass — check the live schema before assuming either way.

The three mapping concepts remain distinct (Rule 11):
- `account_mappings` — mutable effective projection
- `account_mapping_memory` — evidence / mapping memory
- `account_review_decisions` — immutable professional decision authority

### Phase 9 — MAONO Unlock

Condition: Phases 0–8 certified + HESABU producing framework-correct statements in production.
Action: Set `MAONO_ENABLED=true`. Remove 503 guard. MAONO reads only — never writes to authoritative financial tables.

---

## PART X — PERMANENT INVARIANTS

### Accounting Invariants (engine level)

1. NULL = NOT COMPUTED — never zero, never sentinel
2. Debit = Credit — L3 enforced before any downstream engine runs; denominator edge case handled
3. Sign is evidence only — balance side cannot independently classify an account
4. Comparatives never invented — missing = explicit user decision; never zero substituted
5. `computation_detail` is canonical — `result_json` does not exist

### Security Invariants (DB trigger and Edge Function level)

6. User actor = `resolveFirmMemberActor()` result — never `auth.users.id` in authoritative writes; system actor = NULL firm_member_id
7. Authoritative financial/domain writes cross a server-controlled boundary — React must not directly mutate authoritative financial tables
8. Authoritative financial, certification, execution, professional-decision, and audit-provenance history is append-only / reversed or superseded through attributed records
9. `safisha-efdms-ingest` uses service role — TIN anti-impersonation — do not change to anon key
10. Every computation in engine_runs; every POST idempotent via idempotency_keys

### Product Principles (UX level)

11. One dominant CTA per stage — never two primary actions simultaneously
12. No silent defaults — missing input = explicit error or explicit null, not a guess
13. Engine names (SAFISHA / HESABU / KINGA / MAONO) never exposed in user navigation
14. Detection is suggestion — always requires explicit user confirmation; "Not determined" is valid
15. The bookkeeper test — every error message must be understood and actionable by a Form 4 bookkeeper

### Commercial Hypotheses (product strategy — not database constraints)

- Flat annual licence pricing removes growth friction in African markets
- IFRS compliance automation is the highest-ROI SEO vertical for global launch
- "Multi-jurisdiction tax" must not be claimed before jurisdiction #2 ships
- Self-serve TB upload is the correct primary funnel for accounting firms

---

## PART XI — FINAL CERTIFICATION

### What Is World-Class and Certified

Trust Infrastructure: Phase 0A engine execution, firmMemberId actor model, NULL-means-NOT-COMPUTED, sole write authority, append-only authoritative records, maker-checker sign-off (optional), row-level isolation. This is the moat.

### The Unlock Sequence

```
Phase 0A CERTIFIED           Engine execution layer bulletproof
Phase 0                      TB certification defensible
Phase 1 + 2                  IFRS statement generation defensible
                             Vertical 1 SEO (IFRS compliance) can launch
Phase 3 + 4 + 5              Classification, comparatives, cash flow audit-grade
                             International firms can use this in engagements
Phase 6 + 7 + 8              Review workflow, schedules, mapping provenance complete
                             Regulatory submission defensible
Phase 9                      Full platform: TB → certified statements → tax → filing pack
```

### The Product in Its Final State

> One trial balance uploaded.
> One certified TB — every account traced to a rule, every decision attributed.
> Financial statements in the client's framework.
> Tax computation for their jurisdiction.
> Filing package ready for their regulator.
> Every step recorded. Every computation reproducible from its input hash.
> No silent state. No invented figures. No sneaky writers.

**IRON DOME Ω∞ — FULLY CERTIFIED AFTER PHASE 9.**
**BEYOND WHICH NO REDESIGN IS NEEDED.**

---

## PART XII — V5 CONSISTENCY REPORT

**A. Starting directive version:** V4

**B. Files changed:** `SAFF-CLAUDE-CODE-DIRECTIVE.md` only

**C. Application files changed:** Zero. Documentation correction only.

**D. Migrations created:** Zero.

**E. Phase 0A instructions corrected:** YES — Part VII no longer instructs creation of `resolveFirmMemberId` in `_shared/auth.ts`. Now states canonical resolver is `resolveFirmMemberActor()` in `_shared/actor.ts`. Status table invariant #1 updated to reflect Phase 0A is closed.

**F. Stale-authority status corrected:** YES — Split into 5a (Phase 0A hash/provenance = CERTIFIED) and 5b (source→certification staleness = Phase 0 REQUIRED). `stale_detected` is withdrawn throughout.

**G. Phase 0/3 sequencing corrected:** YES — Phase 0 L4 uses current classifier. Phase 3 upgrades L4. Explicitly stated in Rule 3 and Phase 0 done-when criteria.

**H. Phase 0/4 sequencing corrected:** YES — Phase 0 L6 = minimum prior-period signal only. Phase 4 implements full comparative semantics. Stated in Rule 3 and Phase 0 L6 spec.

**I. Source/input hash distinction:** YES — `sourceFileHash` and `engineInputHash` defined as distinct fields serving different provenance purposes in `CertifiedTB` and Phase 0 assessment requirement.

**J. Certified TB authority requirement:** YES — Phase 0 must answer: which certification is authoritative for company + period + source. Historical certifications immutable. CURRENT/STALE/SUPERSEDED columns deferred until assessment.

**K. Confidence handling:** YES — `overallConfidence` and per-row `confidence` marked DESIGN-UNRESOLVED in `CertifiedTB` comment. Phase 3 establishes confidence semantics.

**L. L3 edge case requirement:** YES — Phase 0 assessment must define exact tolerance semantics including denominator=0 case. No hardcoded tolerance in this document.

**M. Entity detection correction:** YES — "Not determined" is explicitly valid for any field. "Never invent a detection" stated in Rule 6 and Phase 0 done-when.

**N. Framework registry correction:** YES — "Zero branching" replaced with: behaviour driven through registered profiles rather than scattered ad-hoc branching. Legitimate encapsulated framework-specific behaviour permitted.

**O. Mapping authority distinction:** YES — Rule 11 and Phase 8 preserve the three-way distinction: `account_mappings` / `account_mapping_memory` / `account_review_decisions`.

**P. Phase 6 / Phase 2A reuse rule:** YES — Rule 10 explicitly requires Phase 6 to reuse `resolve_account_review_batch` and `account_review_decisions`. No competing authority may be created.

**Q. Write-authority scope:** YES — Rule 8 replaces "every write by an Edge Function" with: "Every authoritative financial/domain write must cross a server-controlled write boundary. Benign UI state, local preferences, and draft state are not constrained."

**R. Append-only scope:** YES — Rule 9 scopes append-only to: authoritative financial records, certifications, engine executions, professional decisions, audit-provenance history. Temporary / cache / draft / UI tables excluded.

**S. Remaining contradictions:** NONE FOUND. Verification performed against all 22 terms specified in correction #17. No contradictory hits remain.

**T. Git diff —check:** Not applicable — documentation file only. No compilable code changed.

**U. GO / NO-GO:**

```
✅ GO — SAFF IMPLEMENTATION DIRECTIVE V5 CONSISTENCY HARDENED.
READY TO GOVERN PHASE 0 REPOSITORY ASSESSMENT.
```

---

*SAFF ERP Implementation Directive V5 — September 2026*
*Repository evidence is always authoritative over this document.*
*One book. One truth. No sneaky writers.*
