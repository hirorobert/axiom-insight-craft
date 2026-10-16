# Phase 5 — Interface proposal (minimum compatible interfaces, reusing existing contracts)

Research only. NORMAL owns the canonical accepted contract; this is a proposal whose shapes deliberately reuse production
contracts so that Phase 6 contract tests can demonstrate compatibility. **No new database structure is proposed** — every
interface below projects over, or expands into, mechanisms that already exist. File:line evidence is in the prototype headers
and the inspection notes; the load-bearing facts are summarised inline.

## Design rule
Recognising export structure or column names **does not** approve accounting treatment. The five layers stay separate:
1. export structure · 2. account identity · 3. accounting meaning · 4. reporting treatment · 5. evidence sufficiency.
The server authority is unchanged: `resolve_account_review_batch` remains the sole writer of `account_mappings`, per account.
Grouping is a **projection/expansion** on top of it, not a new authority.

## 1. Source / version identity  (reuse: trial_balance_uploads, layout_confirmations, fiscal_periods, account_key)
```ts
interface ReviewInputIdentity {
  companyId: string;                 // scope of every mapping (account_mappings is company-scoped only)
  uploadId: string;                  // trial_balance_uploads.id
  sourceFileHash: string;            // trial_balance_uploads.source_file_hash — the content version
  resolvedProfileSha256: string|null;// newest layout_confirmations.resolved_profile_sha256 (null = automatic path)
  periodId: string; periodYear: number;         // fiscal_periods.id / synced period_year
  reportingCurrency: string; currencyExponent: number;  // fiscal_periods.reporting_currency → currency_registry
  parserVersion: string;             // TB_INGESTION_VERSION ("tb-ingest-3.0.0")
}
// The "review input version" that a summary and its acceptances bind to:
reviewInputVersion = sha256(sourceFileHash | resolvedProfileSha256 | periodId | reportingCurrency | parserVersion)
// Per-account identity is the EXISTING account_key = COALESCE(account_code, normalized_account_name), company-scoped.
```
Why reusable: these fields already exist; `reviewInputVersion` is a derived digest (like `tb_certifications.normalized_input_hash`), not a stored column.

## 2. Accounting context  (reuse: fiscal_periods, tb_two_period_registrations, engagement scope)
```ts
interface AccountingContext {
  periodUnderReview: { periodId: string; start: string; end: string; datesBasis: "confirmed"|"v1_calendar_convention" };
  priorPeriod?: { periodId: string; priorUploadId: string };   // from tb_two_period_registrations (current↔prior)
  framework: string | null;                                    // companies.reporting framework
  reportingCurrency: string;
}
```
"Identify necessary accounting context" = surface what is present vs required; a missing prior period is a context gap (§5), never assumed.

## 3. Proposals — grouped treatments  (reuse: ReviewDecisionPayload, proposal_type/decision_action split)
```ts
type Statement = "balance_sheet" | "income_statement";              // cash_flow is rejected by the RPC — never proposed
type Classification = "current_assets"|"non_current_assets"|"current_liabilities"|"non_current_liabilities"|"equity"
                    | "revenue"|"cost_of_goods_sold"|"operating_expenses"|"other_income"|"taxes";
interface ProposedTreatment { statement: Statement; classification: Classification; normal_balance: "debit"|"credit";
  flag_candidate: "cash"|"retained"|"payroll"|null; }             // flags stay TRI-STATE; a candidate is reviewer-confirmed
interface TreatmentGroupProposal {
  groupId: string; treatment: ProposedTreatment;
  members: { account_key: string; account_code: string|null; account_name: string; debitMinor: string; creditMinor: string }[];
  uncertainty: { level: "low"|"medium"|"high"; reasons: string[] };  // consequential uncertainty is explicit, per group
  relationshipRefs?: string[];                                       // links to AccountRelationship (§3a)
}
interface AccountRelationship { kind: "asset_lifecycle"; stem: string; members: { account_key: string; role: "opening"|"addition"|"transfer"|"disposal"|"depreciation"|"cost" }[]; note: string }
interface IndividualAccount { account_key: string; account_name: string; reason: "NO_RECOGNISED_MEANING"|"HIGH_UNCERTAINTY"; proposed_treatment: ProposedTreatment|null }
```
Acceptance EXPANDS one group into the existing per-account batch. No "Accept all": one explicit, reasoned acceptance per group;
`HIGH_UNCERTAINTY`/`NO_RECOGNISED_MEANING` accounts are never groupable and must be classified individually.
```ts
// Expansion (client/edge) → the UNCHANGED server call:
acceptTreatmentGroup(group, reason) => ReviewDecisionPayload[]   // decision_action: "USER_ACCEPTED_SUGGESTION"
  then resolve_account_review_batch(companyId, uploadId, clientRequestId, decisions)   // existing SECURITY DEFINER writer
```

## 4. Evidence  (reuse: financialEvidence EvidenceBatch, fs_publication_blockers, cashPerimeter, trust tier)
```ts
type Tier = "KNOWN" | "MISSING" | "CANNOT_ASSESS";                 // maonoAnalyticalContract — never a coerced zero/plug
interface EvidenceAssessment { req: string; tier: Tier; id?: string; coverage?: string }
interface OutputReadiness { output: "tb_review_summary"|"complete_financial_statements"; ready: boolean; gaps: string[]; assessments: EvidenceAssessment[] }
// gaps use EXISTING blocker codes: COMPARATIVE_PERIOD_MISSING, REQUIRED_EVIDENCE_MISSING:<type>,
// CASHFLOW_LEDGER_AUTHORITY_UNRESOLVED, MAPPING_UNREVIEWED:<total=..;unmapped=..;ambiguous=..>, EVIDENCE_NOT_VALID:<id>.
```
Output-specific requirements (the honest "not every TB is enough"): `tb_review_summary` needs `{TRIAL_BALANCE, MAPPING_REVIEW}`;
`complete_financial_statements` needs `{TRIAL_BALANCE, MAPPING_REVIEW, COMPARATIVE, CASH_ACCOUNT_MAP, TRANSACTION_LEDGER}`.

## 5. Accepted mapping versions + reuse  (reuse: account_mappings.review_decision_id, account_review_decisions.sequence_no)
```ts
interface AcceptedMapping {
  account_key: string; reviewDecisionId: string;       // account_mappings.review_decision_id (provenance link)
  sequenceNo: number;                                  // latest-wins effective state
  basisDigest: string;                                 // sha256(account_key | normalized_account_name) — the accepted basis
  treatment: ProposedTreatment & { line_item: string };
}
type ReuseStatus = "REUSABLE" | "NEW" | "STALE_IDENTITY" | "STALE_MEANING";
classifyForReuse(account, effectiveDecision) => ReuseStatus
// REUSABLE: account_key + basisDigest unchanged → no re-approval. NEW: no prior decision.
// STALE_IDENTITY: same account_key, normalized name materially changed (generalises PRIOR_NON_REPORTING_DECISION_STALE_IDENTITY_CHANGED).
// STALE_MEANING: an upstream signal (comparative/GL reconciliation) marks the meaning/context as changed.
```

## 6. Readiness  (reuse: fs_report_readiness → {ready, blockers})
```ts
interface ReviewSummaryReadiness { ready: boolean; coverage: string; blockers: string[] }   // ready ⇔ unmapped=0 ∧ ambiguous=0
getStatementReadiness(companyId, reportId, version) => { ready: boolean; blockers: string[] } // = existing fs_report_readiness
```

## 7. Errors  (reuse: existing refusal codes — one vocabulary)
`NOT_A_MEMBER_OF_COMPANY`, `UPLOAD_COMPANY_MISMATCH`, `CAPABILITY_REQUIRED`(prepare_close), `ENTITLEMENT_REQUIRED`,
`SOURCE_CHANGED`, `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`, `UNSUPPORTED_LAYOUT`/`CURRENCY_UNRESOLVED`/`PERIOD_NOT_SELECTED`
(ingestion), `PROVIDER_DISABLED` (AI). New (grouping-only): `GROUP_UNCERTAIN_REVIEW_INDIVIDUALLY` (a high-uncertainty group
cannot be blanket-accepted).

## 8. Stale-result handling  (reuse: certification invalidation, reprocess, dependency bump, requires_revalidation)
- A changed source (`source_file_hash` divergence) ⇒ `tbu_request_reprocess(SOURCE_CHANGED)` and certification invalidation;
  a prior review summary built on the old version is stale and must be rebuilt (bound by `reviewInputVersion`).
- A changed account identity/meaning ⇒ `STALE_IDENTITY`/`STALE_MEANING` reopen (that account re-surfaces; others stay reused).
- A layout re-confirmation bumps `#layout_confirmation:<uploadId>` ⇒ dependent results go "Needs re-check" (existing).
- Approved adjustments against a superseded authority show `requires_revalidation` (existing) — never silently re-applied.

## Compatibility contract (for Phase 6)
The prototype `research/phase5/prototype/*` implements §1–§8 deterministically and is exercised by `tests/phase5.test.mjs`
(29 checks). A Phase 6 production slice would (a) keep `resolve_account_review_batch` as the authority, (b) add the grouping
projection + reuse classification as pure functions + one read RPC/edge summary, and (c) prove byte-compatibility of the
expanded per-account decisions against the existing RPC via a contract test. No migration, entitlement, payment, lockfile,
registry or deployment change is implied.
