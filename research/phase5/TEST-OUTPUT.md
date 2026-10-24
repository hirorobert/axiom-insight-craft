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

### research/phase5/tests/manual.test.mjs
_Manual multi-account treatment path: no inferred-equivalence grouping, visual-by-issue, atomic submission, cross-tenant/stale/idempotency/concurrent-conflict, reuse-context._

```

== Uncertain accounts are NOT auto-grouped by inferred equivalence
  PASS  every unrecognised account is INDIVIDUAL (no proposal group formed from inferred equivalence)
  PASS  each is flagged NO_RECOGNISED_MEANING (not silently treated)

== Visual organisation by issue implies NO treatment or approval
  PASS  accounts are organised into issue buckets for display
  PASS  every bucket explicitly implies NO common treatment and NO approval

== Deliberate selection → preview shows selected accounts, proposed treatment, warnings, and per-account preflight
  PASS  the preview lists exactly the selected accounts with the proposed treatment
  PASS  the preview is submittable (all three preflight OK) with no reason required

== Proposed-role sign WARNING (advisory) is distinct from a blocking mapping ERROR
  PASS  an UNEXPECTED_BALANCE sign warning is ADVISORY (warning present, preflight still OK — not a block)
  PASS  an unsupported statement/classification pair BLOCKS (STATEMENT_CLASSIFICATION_MISMATCH), not merely warns

== Mixed valid/invalid selection → ATOMIC: nothing is written, the offending account is named
  PASS  the preview shows each outcome explicitly: 2 OK, 1 blocking (never a blanket success)
  PASS  submission is refused atomically (ACCOUNT_NOT_IN_UPLOAD) — no partial accept
  PASS  NOTHING was written from the aborted batch (store unchanged — all-or-nothing)

== Valid manual assignment succeeds, logs USER_MANUAL_CLASSIFICATION, becomes effective
  PASS  all three are written (decisions_logged = mappings_written = 3)
  PASS  each decision is a USER_MANUAL_CLASSIFICATION with proposal_type NONE
  PASS  the effective treatment is the assigned one and the previous value was preserved on the decision

== Cross-tenant / stale-source refusals on the manual path
  PASS  an actor from another company cannot assign (UPLOAD_COMPANY_MISMATCH)
  PASS  assigning against a summary whose source has changed is refused (SOURCE_CHANGED)

== Duplicate submission / lost-response retry (idempotency)
  PASS  a retry with the same request id + same payload replays (no duplicate rows)
  PASS  the same request id with a DIFFERENT payload is refused (IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD)

== Conflicting concurrent decisions on the same account (serialized; last-writer-wins; no lost write)
  PASS  both conflicting decisions are retained in the append-only ledger (no lost write)
  PASS  the latest (highest sequence_no) decision is effective — deterministic last-writer-wins

== Reuse is MORE than a file-hash match (entity + currency + dimensions + ruleset context)
  PASS  verified-compatible context (entity + currency equal; dimensions/ruleset authoritatively N/A) → reusable across a new period
  PASS  a changed currency reopens reuse as CONTEXT_INCOMPATIBLE (file hash alone is insufficient)
  PASS  an unverifiable (absent) currency reopens for explicit confirmation (CONTEXT_UNVERIFIED), not silent reuse
  PASS  absent dimensions/ruleset with NO authoritative N/A rule → UNKNOWN → reopen (not silently reused)

== Exact money preserved on the manual path (BigInt; nothing netted)
  PASS  selected account balances remain exact BigInt minor units (no float, no netting)

25/25 manual-path checks passed.
```
**exit status: 0**

### research/phase5/tests/accounting_boundaries.test.mjs
_Accounting-boundary refusals: prepayment three-component bridge, two-TB net movement, source imbalance survives balanced adjustment, signed-prior vs comparative, corrected-version immutability, MUSE candidate-rule scope._

```

== Prepayments require the three-component bridge (arithmetic agreement ≠ net-presentation authority)
  PASS  with all three components, closing = opening + additions - release (exact BigInt)
  PASS  missing the release component → net presentation refused (bridge incomplete)
  PASS  a closing figure that merely agrees arithmetically does NOT authorise net presentation

== Two TBs establish NET movement only — never gross additions, credit movements or a split
  PASS  net movement = closing - opening, labelled NET_MOVEMENT (not additions, not a split, not cash flow)
  PASS  attempting to split a net movement into additions/disposals from two TBs is refused

== Source imbalance survives a balanced adjustment; no balancing entry is invented
  PASS  a balanced adjustment is accepted (Σdebit = Σcredit > 0, each line one side)
  PASS  the adjusted imbalance equals the source imbalance (the balanced layer cures nothing)
  PASS  an UNBALANCED adjustment is refused — the prototype never invents a balancing entry
  PASS  a two-sided (not one-side-only) line is refused

== Signed prior figure is distinct from a comparative (source precision preserved)
  PASS  a signed prior figure and a comparative figure are preserved separately, never merged

== Corrected source is a linked immutable version; outputs re-evaluated; history unchanged
  PASS  the correction links a NEW version and leaves the original signed artefact unchanged
  PASS  every dependent output is marked requires_revalidation (re-evaluated, not silently carried)
  PASS  a correction that reuses the same version is refused (a correction must be a new version)

== MUSE observations are candidate rules — scoped, evidenced, proposed; never global; approval ≠ reuse
  PASS  a MUSE observation is a CANDIDATE rule scoped to entity + chart version + years
  PASS  it carries evidence, is PROPOSED (not auto-applied), is not global, and reuse still needs context compatibility
  PASS  a MUSE observation without scope is refused
  PASS  a MUSE observation without evidence is refused

17/17 accounting-boundary checks passed.
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
  PASS  manual decisions use decision_action USER_MANUAL_CLASSIFICATION (in the real accepted set)
  PASS  manual decisions use proposal_type NONE (not AUTO_MAPPED_RULE) and a supported statement/class pair
  PASS  manual decisions carry no field the real function does not consume (account_key is the local identity, not sent)
  FINDING  same-name/different-code — constraint uq_acct_map_company_norm_name present: true; fixture (4000/4100 Sales) collides on normalized name: true
  PASS  FINDING (production limitation, preserved): the real schema forbids two same-normalized-name accounts per company, and the fixture reproduces it — a RAW constraint error, not a structured refusal (Phase 6 treatment in HANDOFF)

18/18 static real-contract checks passed.
NOTE: static shape+semantics only. Execution against the real function (success + refusal + lifecycle) is in
research/phase5/proof/real_contract_proof.mjs — replayable on a disposable PostgreSQL (16+/17; version reported at runtime); NOT executed on this host.
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
- **Why deferred:** Needs a disposable PostgreSQL 17 (no Docker / local PG / embedded-pg available here; scope confines writes to research/phase5/** so no CI workflow was added). Coordinate the run with NORMAL on the existing branch — DB requirements/migration chain are in HANDOFF.md §Coordination. NEVER run it against hosted customer systems; it refuses the production ref and non-loopback hosts.
- **Proves (when run):** EXECUTION against the real RPC on the replayed authoritative chain: legitimate success + every refusal + the reuse/invalidation lifecycle + the MANUAL path (USER_MANUAL_CLASSIFICATION) + atomic mixed-batch failure + conflicting-decision serialization.
- **One-command replay:** `DB_PROOF_CONN=postgres://user:pass@127.0.0.1:5432/db node research/phase5/proof/real_contract_proof.mjs`

══════════════════════════════════════════════════════════════════════════════════════════════════════════════
## Roll-up
══════════════════════════════════════════════════════════════════════════════════════════════════════════════

- PASS  [PROTOTYPE]  research/phase5/tests/phase5.test.mjs  (exit 0)
- PASS  [PROTOTYPE]  research/phase5/tests/coverage.test.mjs  (exit 0)
- PASS  [PROTOTYPE]  research/phase5/tests/manual.test.mjs  (exit 0)
- PASS  [PROTOTYPE]  research/phase5/tests/accounting_boundaries.test.mjs  (exit 0)
- PASS  [REAL-CONTRACT (executed here)]  research/phase5/tests/real_contract_static.mjs  (exit 0)
- PASS  [REAL-CONTRACT (executed here)]  research/phase5/proof/real_layout_contract.mjs  (exit 0)
- DEFERRED  [DEFERRED (not executed on this host)]  research/phase5/proof/real_contract_proof.mjs  (exit DEFERRED)

Executed: 6  ·  Passed: 6  ·  Failed: 0  ·  Deferred: 1
