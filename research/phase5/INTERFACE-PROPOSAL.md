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
interface IndividualAccount { account_key: string; account_name: string; reason: "NO_RECOGNISED_MEANING"|"HIGH_UNCERTAINTY";
  signals?: "UNEXPECTED_BALANCE_FOR_PROPOSED_ROLE"[];               // a review TRIGGER, never a "wrong mapping" verdict (see §3b)
  proposed_treatment: ProposedTreatment|null }
```
Amounts (`debitMinor`/`creditMinor`) are **exact integer minor units** — `string` over the wire, `bigint` in the engine;
no float is ever used for money or for a sign/relationship comparison.

### 3b. What the interpretation layer does NOT claim — "unexpected balance" ≠ "incorrect mapping"
The role-aware sign check emits `UNEXPECTED_BALANCE_FOR_PROPOSED_ROLE` (a signal) and raises uncertainty; it **never**
returns a verdict that a mapping is wrong. The two are independent: the signal fires on some correct mappings (a legitimate
bank overdraft) and is silent on some wrong ones (a mis-mapped account whose sign looks normal). "Role-aware" means the
expected side is taken from the specific role — contra-assets are credit-normal, drawings are debit-normal — so neither is
mis-flagged. Consumers must treat the signal as a prompt for individual review, not as proof. (Proven: `coverage.test.mjs`
groups (A), (A≠B), (B, undetectable).)

### 3c. Manual multi-account treatment (deliberate selection — uncertain accounts are never auto-grouped)
`HIGH_UNCERTAINTY` / `NO_RECOGNISED_MEANING` accounts are **never** grouped for acceptance by inferred equivalence. They may
be organised **visually by issue** (no treatment/approval implied), and a reviewer may **deliberately select** several and
assign **one** common treatment in a single action, after a shown preview.
```ts
organiseByIssue(individual, meaningsByKey) => { issue: string; impliesTreatment: false; impliesApproval: false; members: {account_key,account_name}[] }[]
previewManualAssignment({store, upload, summary, selectedKeys, treatment, reason}) => {
  rows: { account_key; account_name; previous_treatment: Treatment|null; proposed_treatment: ProposedTreatment;
          warnings: { code; advisory: boolean; note? }[];         // advisory sign/role signals ≠ blocking errors
          preflight: { ok: true } | { ok: false; code; detail } }[];
  blocking: { account_key; code }[]; submittable: boolean; decisions: ReviewDecisionPayload[] }
assignCommonTreatment(store, {upload, summary, selectedKeys, treatment, actor, reason, client_request_id})
  // ATOMIC: validates every selected account first; ANY failure throws and NOTHING is written (mirrors the RPC).
  // decision_action = "USER_MANUAL_CLASSIFICATION"; proposal_type = "NONE"; reason OPTIONAL (server requires none here).
  => { batch_id; decisions_logged; mappings_written } | throws Refusal
```
**Atomicity (authoritative, read from `20261007100000`):** `resolve_account_review_batch` validates all decisions and
`RAISE`s before any write; one aggregate `result_summary`; **no partial outcomes**. So the UI shows each account's
**pre-flight outcome before submission**, submits the confirmed set, and a failing submit rejects the **whole** batch naming
the offending account — never a silent skip or blanket success. Same-account concurrency is serialized by
`pg_advisory_xact_lock(company, account_key)` (last-writer-wins; append-only ledger keeps both).

### 3d. Reuse is more than a file hash
A prior accepted decision is reusable for a later upload only when the accounting **context** is compatible — entity +
currency + dimensions + ruleset — not merely the same bytes or `account_key`. A KNOWN change (e.g. currency) reopens the
decision (`CONTEXT_INCOMPATIBLE`); a field the live schema cannot track (`account_mappings` keys only
`(company_id, account_key)`) is **disclosed as unverified**, never assumed equal (UNKNOWN ≠ EQUAL ≠ MISMATCH). Closing this
needs context on the decision ledger — see §9 gap #4. Period is confirmed but intentionally not a reuse blocker (mappings
reuse across periods by design).
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

## 9. Persistence & reuse — what production stores today, and the PRECISE gaps
Verified against the real schema/functions (read-only). "Do not claim unchanged-contract compatibility if new persistence or
authority is necessary" — so this is stated honestly.

| Concern | Stored today | New persistence/authority needed? |
|---|---|---|
| Proposed mapping sets | **Not persisted** (proposals are computed per upload). | **No** — proposals stay ephemeral; only accepted decisions persist. |
| Authorised accepted decisions | `account_review_decisions` (append-only, `sequence_no`) + `account_mappings` (current projection). | **No**. |
| Evidence references | `financial_evidence` batches, `tb_certifications`, close-review evidence. | **No**. |
| Decision attribution | `firm_member_id` on batches/decisions; actor from `auth.uid()`. | **No**. |
| Mapping/rule versions | `sequence_no` latest-wins; `account_mappings.review_decision_id` provenance link; `rule_id`/`rule_version`; `tb_certifications.normalized_input_hash`/`engine_run_id`; `layout_templates.version`. | **No** (no monotonic mapping-version column, but `sequence_no` serves). |
| Reuse scope | `account_mappings` is **company-scoped** → a repeat upload's accounts match existing mappings natively. | **No** — reuse within a company is native. |
| Invalidation | certification invalidation (append-only), reprocess `SOURCE_CHANGED`, provenance-link clearing, dependency bump, **identity-drift reopen for `MARK_NON_REPORTING` only**. | **Partial** — see gaps. |

### The precise gaps and the MINIMUM compatible change
1. **Reuse status for CLASSIFICATION decisions (`REUSABLE/NEW/STALE_IDENTITY`).** The identity-drift reopen exists today only
   for `MARK_NON_REPORTING_ACCOUNT` (`get_effective_non_reporting_status`). Generalising it to classification decisions is
   **new read logic, NO new table/authority** — it compares an account's current `account_key` + normalized name to the
   `account_review_decisions`/`account_mappings` basis already stored. It only **surfaces** the account for re-review; it does
   not auto-invalidate. Minimum change: one read projection (RPC or edge) + the summary UI.
2. **`STALE_MEANING` beyond identity drift** (a comparative/GL reconciliation reveals a different meaning). **No production
   mechanism exists.** The first Phase 6 slice handles only identity/chart-code changes (derivable with no new persistence);
   richer meaning-change detection is a **future, separately-scoped** signal/authority — **do not build it in the first slice**.
3. **Output version-binding (a completed summary must bind the exact versions used; changing a reusable profile must not
   silently change history).** Layout templates are already versioned and `layout_confirmations` bind `source_file_hash` +
   `resolved_profile_sha256` per upload, so changing a template never rewrites an old confirmation. For the TB **review
   summary** itself: record, at completion, the `reviewInputVersion` + the `(account_key → review_decision_id/sequence_no)` set
   it used. **Minimum compatible change: a `close_review_events` row** (`subject_kind='upload'`, a new `event_type` such as
   `tb_review_summarised`, `detail` = the versions/decision set) — the existing append-only timeline, **no new table**. A
   completed summary is then immutable and bound; a later reopen produces a NEW summary, never mutating the old one.
4. **Reuse context beyond entity + `account_key`.** Live `account_mappings` keys only `(company_id, account_key)`, and the
   write RPC does not compare context — so reuse *through the RPC* is entity + account_key today. **Corrected, verified:**
   currency and period are **not** a schema gap — they are authoritative on `fiscal_periods` (`reporting_currency` FK to
   `currency_registry`, no TZS fallback; explicit dates), reached from an upload via `trial_balance_uploads.period_id`
   (`20260630100000` / `20261009100000`), so a Phase 6 reuse check can **read** them. The genuine remaining gaps are
   narrower: (a) **bind** the accepting context onto the **decision ledger** (`account_review_decisions` already carries
   `previous_value`/`new_value` JSON — add context there, or an additive column) so reuse can compare it; (b) a **dimension**
   axis; (c) a **ruleset-version** axis. The prototype **discloses** every field it could not verify rather than assuming
   equality (UNKNOWN ≠ EQUAL ≠ MISMATCH). **Additive; no change to the write path's authority. Not in the first slice.**
   Entity itself is already enforced natively (`UPLOAD_COMPANY_MISMATCH` + company-scoped mappings).

## 10. Prototype vs real-contract evidence (necessary vs sufficient)
- **Executed now — static shape+semantics against the REAL function** (`tests/real_contract_static.mjs`, 14/14): the
  grouped-acceptance expansion uses only fields the real `resolve_account_review_batch` consumes, a non-forbidden
  `proposal_type`, an accepted `decision_action`, a supported `statement`/`classification` pairing, tri-state flags, and
  deterministic (replay-safe) payloads; refusal codes align. *This is necessary, not sufficient — shape-match alone is not
  compatibility.*
- **Replayable, NOT executed on this host — execution against the REAL function** (`proof/real_contract_proof.mjs`): replays
  the authoritative chain on disposable PG17 and proves legitimate SUCCESS (`account_mappings` written) + refusals + lifecycle.
  This host has no Docker / local Postgres (Windows embedded-pg unavailable) and scope-cleanliness forbids wiring a CI
  workflow here, so it is delivered as a one-command replayable package for a PG-capable runtime (CI service / local Docker).
- **Prototype behaviour** (`tests/phase5.test.mjs` 29/29, `tests/coverage.test.mjs` 15/15): deterministic layers + lifecycle,
  with simulated/LIMIT lines labelled. DB/RLS-enforced guarantees (auth.uid binding, server-computed account_key, append-only
  immutability) are asserted against the production RPCs in the replayable proof, not re-proven in the pure prototype.
