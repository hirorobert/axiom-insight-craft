# Phase 5 — recorded test output

Runtime: Node v24.15.0 on win32. Recorder: research/phase5/run_all.mjs.
Legend: PROTOTYPE = pure Node; REAL-CONTRACT = executes the unmodified production contract here; DEFERRED = needs a runtime this host lacks.


══════════════════════════════════════════════════════════════════════════════════════════════════════════════
## PROTOTYPE
══════════════════════════════════════════════════════════════════════════════════════════════════════════════

### research/phase5/tests/phase5.test.mjs
_Deterministic 5-layer prototype + lifecycle (7 North-Star behaviours)._

```

== 1 · Grouped mapping review (not hundreds of individual approvals; no Accept-all)
  PASS  summary recognised the structure and read 21 accounts
  PASS  far fewer groups than accounts (grouped treatments)
  PASS  the Suspense account is NOT grouped — it surfaces for individual classification
  PASS  the accumulated-depreciation contra-asset surfaces individually (consequential sign), never swept into a group
  PASS  each group accepted individually (explicit reason each); no single Accept-all call
  PASS  group acceptance expanded to one per-account decision per member in the append-only ledger
        SIMULATED: 21 accounts reviewed as 10 groups + 3 individual, 10 explicit group approvals.

== 2 · Different codes with similar descriptions are NOT auto-duplicates
  PASS  4000 'Sales' and 4100 'Sales' resolve to DIFFERENT account_keys
  PASS  both appear as distinct members of the revenue group (two decisions, not one merged account)
  PASS  the similar-description uncertainty is surfaced on the group

== 3 · Opening / addition / transfer / depreciation relationships (surfaced, never netted)
  PASS  a motor-vehicles lifecycle relationship is detected across its accounts
  PASS  the relationship spans opening/addition/transfer/depreciation roles
  PASS  balances are preserved separately — no automatic netting of cost against depreciation (exact BigInt minor units)
  PASS  the relationship note states movements are never netted into one figure or a cash flow

== 4 · Missing comparative / GL evidence blocks the OUTPUT, not the review
  PASS  TB review summary is READY once the TB is read and mapping review is complete
  PASS  complete statements are NOT ready — comparative period missing
  PASS  complete statements are NOT ready — cash-flow ledger authority unresolved
  PASS  complete statements are NOT ready — transaction ledger evidence missing
  PASS  with valid comparative + cash map + ledger, the gaps clear (evidence present, not plugged)
  PASS  an invalid/REQUIRES_REVIEW ledger is CANNOT_ASSESS → still a gap (never treated as present)

== 5 · Compatible repeat-upload reuse (no re-approval of unchanged accounts)
  PASS  every previously-accepted account is REUSABLE on the repeat upload
  PASS  only the previously-UN-reviewed accounts need review again — no accepted account re-surfaces
        SIMULATED: round 2 reused 18 approved decisions; only 3 still-unreviewed accounts remain.

== 6 · Changed account meaning / identity reopens the affected decision
  PASS  a coded account whose name materially changed is reopened as STALE_IDENTITY
  PASS  the reopened account re-appears for review; unchanged accounts stay reused
  PASS  an account flagged as meaning/context-changed is reopened as STALE_MEANING
  PASS  the reopen reason is explicit and traceable

== 7 · Cross-tenant and stale-decision refusal (executable where pure)
  PASS  cross-tenant: an actor from another company cannot accept this upload's group
  PASS  stale source: accepting against a summary whose source has since changed is refused (SOURCE_CHANGED)
  PASS  replay with the same key + same payload is a safe no-op (no duplicate decisions)
  PASS  reusing the same key with a DIFFERENT payload is refused
        NOT executable here (needs real Postgres/RLS): true auth.uid() identity binding, server-computed account_key, and DB-level append-only immutability — these are asserted against the production RPCs, not this pure prototype.

29/29 checks passed.
```
**exit status: 0**

### research/phase5/tests/coverage.test.mjs
_Extended synthetic coverage; detection concepts separated; limits disclosed as LIMIT lines._

```

== QuickBooks-style export (Account name only, no code column)
  PASS  recognised as a flat trial balance
  PASS  account identity falls back to the normalized name (no code column)
  PASS  'Opening Balance Equity' is read as an equity-side account for review (not silently dropped)

== Odoo-style export (Code, Account Name, Debit, Credit, Balance)
  PASS  recognised as a flat trial balance
  PASS  account identity = the code column
  PASS  debit/credit are read directly (balance column ignored when both are present)

== SunSystems-style export (T/B Code, Description, YTD Debit, YTD Credit)
  PASS  structure recognised via Description + YTD Debit/Credit
  PASS  the 'T/B Code' column is NOT auto-recognised as the account code (keyed by description instead)
  LIMIT SunSystems 'T/B Code' is not matched by the deterministic header recognizer -> codes are lost on the automatic path.
  LIMIT RESOLUTION — VERIFIED (not merely proposed): the manual LayoutProfile route executes through the REAL, unmodified production contract (supabase/functions/_shared/layoutProfile.ts: validateProfile + resolveLayout map 'T/B Code'->accountCode and recover every code). Proven by `node --experimental-strip-types research/phase5/proof/real_layout_contract.mjs` (8/8). No new mechanism needed.

== (A) UNEXPECTED BALANCE DETECTED — a signal for individual review, NOT a wrong-mapping verdict
  PASS  an UNEXPECTED_BALANCE signal is raised for 'Rent income' (revenue recognised, balance on the debit side)
  PASS  the prototype emits NO 'wrong mapping' verdict — only elevated uncertainty + a named signal
  PASS  as a consequence 'Rent income' is routed to INDIVIDUAL review (not auto-grouped/accepted)

== (A≠B) An UNEXPECTED BALANCE on a CORRECTLY-identified account — the signal is NOT proof of a wrong mapping
  PASS  the overdrawn account is correctly IDENTIFIED as a cash/bank asset (nature = asset)
  PASS  the UNEXPECTED_BALANCE signal fires on it (credit balance on a debit-normal role)
  LIMIT The signal fires on a CORRECTLY-identified account (a legitimate overdraft). 'Unexpected balance detected' is therefore NOT proof of 'incorrect mapping' — it is a review trigger; the reviewer decides the presentation (e.g. reclassify an overdraft to current liabilities). No test here claims the mapping is wrong.

== (B, undetectable) BALANCED + INCORRECTLY MAPPED with NORMAL signs — the prototype CANNOT detect it
  PASS  the prototype recognises 'Prepaid rent' as an EXPENSE — the WRONG role (it is truly a prepayment / current asset)
  PASS  NO unexpected-balance signal fires and uncertainty is not high (both the wrong role and the true role are debit-normal)
  PASS  it is SILENTLY grouped as an operating expense — the mapping error is UNDETECTED by the prototype
  LIMIT A balanced TB whose accounts are mis-mapped but carry NORMAL signs is NOT detectable by sign/structure heuristics. Only a reviewer or corroborating evidence (a lease schedule, a GL drill-down, a prior-year comparative) can catch it. This is an inherent limit of deterministic interpretation; AI could PROPOSE a correction, separately governed, but never auto-accept it.

== Genuine imbalance (debits != credits)
  PASS  the trial balance is detectably out of balance
  LIMIT Balance checking is owned by the production ingestion core (tbIngestion raises TRIAL_BALANCE_IMBALANCE); this prototype defers to it rather than re-implementing it.

== MUSE-style opening/addition/transfer/depreciation (scoped example, not a prefix rule)
  PASS  opening/addition/transfer/depreciation detected generically (no MUSE prefix)

== Compatible repeat vs INCOMPATIBLE reuse (chart re-code & identity drift)
  PASS  a re-coded account (new code, same name) is NEW, not silently reused (incompatible reuse)
  PASS  an identity-drifted account (same code, changed name) is reopened STALE_IDENTITY

== Conflicting / unresolved evidence
  PASS  an unresolved/conflicting comparative keeps the statement NOT ready (CANNOT_ASSESS, not plugged)
  LIMIT Production evidence family models conflict explicitly (ReplayStatus CONFLICTING_REPLAY); this prototype treats any non-VALID batch as CANNOT_ASSESS -> gap.

21/21 coverage checks passed. (LIMIT lines are disclosed limitations, not failures.)
```
**exit status: 0**

══════════════════════════════════════════════════════════════════════════════════════════════════════════════
## REAL-CONTRACT (executed here)
══════════════════════════════════════════════════════════════════════════════════════════════════════════════

### research/phase5/tests/real_contract_static.mjs
_Parses the REAL resolve_account_review_batch SQL; asserts field+semantics compatibility. Static — necessary, not sufficient._

```
  [real contract] consumed decision fields: account_code, account_name, classification, decision_action, is_cash_account, is_payroll_account, is_retained_earnings, line_item, normal_balance, proposal_type, reason, source, statement, treatment, treatment_request_id
  [real contract] accepted decision_action: CONFIRM_ACCOUNT_TREATMENT, MARK_NON_REPORTING_ACCOUNT, USER_ACCEPTED_SUGGESTION, USER_MANUAL_CLASSIFICATION
  [real contract] supported BS classes: current_assets, current_liabilities, equity, non_current_assets, non_current_liabilities
  [real contract] supported IS classes: cost_of_goods_sold, operating_expenses, other_income, revenue, taxes
  PASS  the real function was located and its decision contract parsed
  PASS  grouped acceptance expands to one decision per groupable account
  PASS  every field we send is consumed by the real function (no unknown fields)
  PASS  every decision carries account_name + proposal_type + decision_action
  PASS  proposal_type is MACHINE_SUGGESTION — never AUTO_MAPPED_RULE (which the real function rejects 42501)
  PASS  decision_action (USER_ACCEPTED_SUGGESTION) is in the real accepted set
  PASS  every statement/classification pairing is in the real supported subset (no STATEMENT_CLASSIFICATION_MISMATCH)
  PASS  no decision proposes a cash_flow statement or an activity classification (real function rejects these 22023)
  PASS  authoritative flags are only ever present as `true` (tri-state; never a manufactured false)
  PASS  expansion is deterministic (a retry replays byte-identically; real request_hash would match)
  PASS  refusal code 'UPLOAD_COMPANY_MISMATCH' exists in the real function
  PASS  refusal code 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' exists in the real function
  PASS  refusal code 'NOT_A_MEMBER_OF_COMPANY' exists in the real function
  PASS  refusal code 'EMPTY_DECISION_BATCH' exists in the real function

14/14 static real-contract checks passed.
NOTE: static shape+semantics only. Execution against the real function (success + refusal + lifecycle) is in
research/phase5/proof/real_contract_proof.mjs — replayable on a disposable PostgreSQL 17; NOT executed on this host.
```
**exit status: 0**

### research/phase5/proof/real_layout_contract.mjs
_Imports & executes the REAL layoutProfile.ts (validateProfile + resolveLayout) to prove the SunSystems manual-layout fallback._

```
== Production module surface (read-only import)
  PASS  validateProfile, resolveLayout, profileSha256 and LAYOUT_TEMPLATE_FORMAT are exported by the REAL module

== Negative control: the automatic recognizer loses the SunSystems code
  PASS  auto-recognizer does NOT match 'T/B Code' as the account code (code would be lost on the automatic path)

== REAL contract: a manual LayoutProfile naming 'T/B Code' validates and resolves
  PASS  the REAL validateProfile ACCEPTS the manual layout that names 'T/B Code' as the account code
  PASS  the REAL resolveLayout RESOLVES the layout against the file (ok=true, no blocking issues)
  PASS  'T/B Code' resolves to the account-code column at index 0 (code column RECOVERED by the real contract)
  PASS  'Description' resolves to the account-name column
  PASS  'YTD Debit' / 'YTD Credit' resolve to the debit/credit columns
  PASS  every SunSystems code is captured through the manual layout (no code lost)

8/8 real-layout-contract checks passed.
```
**exit status: 0**

══════════════════════════════════════════════════════════════════════════════════════════════════════════════
## DEFERRED (recorded, NOT executed here)
══════════════════════════════════════════════════════════════════════════════════════════════════════════════

### research/phase5/proof/real_contract_proof.mjs
- **Why deferred:** Needs a disposable PostgreSQL 17 (no Docker / local PG / embedded-pg available here; scope confines writes to research/phase5/** so no CI workflow was added).
- **Proves (when run):** EXECUTION against the real RPC on the replayed authoritative chain: legitimate success + every refusal + the reuse/invalidation lifecycle.
- **One-command replay:** `DB_PROOF_CONN=postgres://user:pass@127.0.0.1:5432/db node research/phase5/proof/real_contract_proof.mjs`

══════════════════════════════════════════════════════════════════════════════════════════════════════════════
## Roll-up
══════════════════════════════════════════════════════════════════════════════════════════════════════════════

- PASS  [PROTOTYPE]  research/phase5/tests/phase5.test.mjs  (exit 0)
- PASS  [PROTOTYPE]  research/phase5/tests/coverage.test.mjs  (exit 0)
- PASS  [REAL-CONTRACT (executed here)]  research/phase5/tests/real_contract_static.mjs  (exit 0)
- PASS  [REAL-CONTRACT (executed here)]  research/phase5/proof/real_layout_contract.mjs  (exit 0)
- DEFERRED  [DEFERRED (not executed on this host)]  research/phase5/proof/real_contract_proof.mjs  (exit DEFERRED)

Executed: 4  ·  Passed: 4  ·  Failed: 0  ·  Deferred: 1
