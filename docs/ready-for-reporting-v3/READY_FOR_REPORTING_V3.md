# Ready for Reporting — V3 specification

Status: **proposed specification, not implemented.** Nothing here is enabled, migrated or deployed. It does not replace
the development charter; where the charter or an existing repository control is stricter, that control wins.

Repository inspected: `hirorobert/axiom-insight-craft` at **`f36636771bf9c907084c74adb9516043d77eccbc`**
(2026-11-06 13:50:36 +0000, "Verified release prereqs"). Hosted state is taken only from the Drizzle apply journal
in that commit (`drizzle/migrations/0000`–`0101`); no hosted database or QuickBooks company was read.

Codex's V3 draft and acceptance runner were not in the repository at this commit, nor among the files attached to
this conversation. This specification therefore resolves the drafts that were available: Ready for Reporting v2
(the Docs artifact), the reviewer critique (the "Claude's claim / My verdict" review) and the V3 assignment. If
Codex's V3 surfaces later, diff it against §15 (open decisions) and the acceptance contract, not against prose.

Companion files:
- `ACCEPTANCE_CONTRACT.md`: fixtures, the three evidence categories, the adapter interface and the database contracts.
- `CHANGE_LOG.md`: every review finding mapped to a resolution or a remaining blocker.
- `scripts/acceptance/rfr-v3/`: `cases.mjs` (fixtures), `referenceModel.mjs` (the rules, executable), `run.mjs` (runner).

## Evidence labels used throughout

| Label | Meaning |
|---|---|
| **[REPO]** | Read in the source at the commit above (path and function cited). Says what the code does, not that the hosted system runs it. |
| **[JOURNAL]** | The migration appears in the hosted apply journal (`drizzle/migrations`). Says it was applied, not that it behaves as proven. |
| **[PROPOSED]** | New in V3. Not in the repository. |
| **[DB-TEST]** | Must be proven on real PostgreSQL (existing `scripts/db-proof` pattern) before it is relied on. |
| **[SANDBOX]** | Must be proven against an authenticated QuickBooks sandbox company before it is relied on. |

---

## 1. What CFOClose already has, verified

| Capability | What the code does **[REPO]** | Where | Hosted | What V3 may reuse | Gap V3 fills |
|---|---|---|---|---|---|
| QuickBooks connector | Read-only by an exact allow-list: one report, `TrialBalance` (`QBO_ALLOWED_REPORTS`), query keys `start_date`, `end_date`, `accounting_method`, `minorversion`; Preferences GET and token endpoints only. Pull = refresh lease → token rotation by compare-and-swap → fiscal-basis check against Preferences → fetch → `parseQboTrialBalanceReport` (refuses, never repairs) → three SHA-256 fingerprints → evidence-first intent → the SAME upload steps as a manual file. Customer switch off: `QBO_CONNECTOR_ENABLED = false`. | `supabase/functions/_shared/qboReadOnlyGuard.ts`, `qboPull.ts` (`runQboPull`), `qboTrialBalance.ts`, `qboFiscalBasis.ts`, `qbo-pull-trial-balance/`, `src/lib/workspace/qboConnectorClient.ts` | [JOURNAL] `0100`, `0101`; live acceptance incomplete (`docs/release/qbo-readiness-r2/LIVE_ACCEPTANCE_20261103.md`) | Lease, rotation, guard, fingerprints, evidence-first intent, upload path | No GL, no transaction detail, no change detection, no freshness check at finalization |
| TB validation | Ingestion core with exact minor units, explicit period and currency; certification ledger; authoritative certification resolved at read time with staleness. | `_shared/tbIngestion.ts`, `process-trial-balance/`, `get_authoritative_certification` | [JOURNAL] | "TB validated" = an authoritative certification | — |
| TB finding decisions | Per-finding decisions bound to source bytes, layout and entity revision; `CLEARING_ACCOUNT_BALANCE` is a review indicator unless a recorded policy requires a decision. | `_shared/tbFindingDecisions.ts`, `20261118100000` (`tb_finding_requirements`, `tb_current_finding_decisions`, `record_tb_finding_decision`) | [JOURNAL] `0059`+ | Decision identity pattern | Balance-level only: a clearing account whose entries net to zero raises nothing |
| Treatment decisions | A treatment request id = SHA-256 of rule id/version, company, upload, source hash, account, debit/credit, mapping decision; any change expires the confirmation. One rule today: `closing_stock_credit`. | `_shared/treatmentRequest.ts`, `20261007100000` (`treatment_request_id`) | [JOURNAL] `0029` | The binding-by-hash pattern for every V3 decision | Only one rule |
| Close Review findings | Catalogue `tb-anomaly-catalogue/1`: evaluated A01, A03, A10, T01 (scoped). A02 (suspense/clearing), A04 (retained-earnings roll-forward), A05, A06, A08, A09 not evaluated. | `src/lib/closeReview/findings.ts`, `20261014100000` (`close_review_refresh_findings`, `close_review_finding_action`) | [JOURNAL] `0036` | Finding lifecycle, blocking count in sign-off | No evidence-backed findings; no entry-level rules |
| Adjustments | `adjustment/1`: exact, balanced, proposed against the authoritative TB, append-only, decided once; reversal is a new adjustment; adjusted TB is a layer; after a re-check an adjustment shows "requires revalidation" until a reviewer revalidates or declines; two-person policy by default, owner self-approval only under a recorded policy, disclosed. | `20261015100000` (`close_review_propose_adjustment`, `_decide_`, `_revalidate_`, `close_review_adjusted_trial_balance`), `src/lib/closeReview/adjustments.ts` | [JOURNAL] `0037` | **All of it.** V3 corrections are adjustment/1 rows plus a correction identity | No link to a source posting; no "corrected in source" state |
| Reporting input | `fs_reporting_input` = authoritative certification + applied adjustments + findings run, with `inputSha256`; a saved report records it; when it changes the report is stale. | `20261016100000`, `20261017100000` | [JOURNAL] `0038`, `0039` | The identity V3 extends | Does not cover ledger, evidence, coverage or source freshness |
| Comparatives | Prior year = its authoritative certification through account bridges; restatements proposed (`prepare_close`) and decided (`review_close`, never the proposer), as-reported kept beside presented; first-period declaration only for a genuine first period. | `20261020100000` (`fs_bridge_comparative_account`, `fs_propose_restatement`, `fs_decide_restatement`), `docs/reporting/COMPARATIVES.md`, `20261017100000` (`fs_first_period_declarations`) | [JOURNAL] `0042`, `0039` | Restatement path and as-reported preservation | Compares TB to TB; no bridge from signed statements produced outside CFOClose |
| Comparative Assurance | Read-only movement analysis between the current and prior authoritative TBs (movement table, retained-earnings reconciliation, ECL, deferred tax, margin). | `_shared/comparativeAssurance.ts`, `comparative-assurance-engine/` | function code | Movement analytics for the review queue | Advisory; not an evidence test |
| SAFISHA | Ingest (CSV/XLSX/PDF worker), 6-tier matcher: exact, fuzzy name ≥ 80, timing ≤ 7 days, fuzzy reference, **amount drift ≤ 1%**, one-to-many ≤ 5 lines; fuzzy results always become exceptions; matches evidence to **TB-derived lines** (`source_id = 'tb'`). | `safisha-match/index.ts`, `safisha-ingest/`, `safisha-pdf-extract/` | The server-authority migrations `20261004100000` and `20261005100000` are **quarantined** (never applied); CLAUDE.md states the safisha functions on main call their objects and must not be deployed until a revival migration | Parsing, evidence storage pattern, exception queue concept | Not deployable as is; tolerance is unsafe for readiness; matches TB lines, not ledger entries |
| Cash ledger evidence | Financial-statements cash flow takes a preparer-supplied transaction ledger and requires each cash account's ledger movement to equal its TB movement (`cashflow-account-rollforward`). | `src/lib/canonicalStatement/rules/cashLedgerRollforward.ts`, `src/lib/financialGeneration/cashLedgerAuthority.ts` | code + `20261123100000` | The per-account tie-out rule shape | Cash accounts only; no bank evidence |
| Finalization | `fs_set_publication_state`: REVIEWED needs `review_close`, FINAL needs `approve_certification`, only the latest version; `fs_publication_blockers` (input stale, blocking findings, undecided adjustments, comparatives, server compilation, document closure and structure); one FINAL authority per company and period under `_fs_scope_lock`; FINAL, seal and trial-balance removal serialized by `tb_official_output_lock`, READ COMMITTED required (`tb_require_read_committed`); official pack bytes generated and sealed by the database, verified only by re-hash. | `20261111100000`, `20261123100000`–`20261127100000`, `20260927100000`, `seal-reporting-pack/` | [JOURNAL] `0076`–`0081` | **The finalization transaction.** V3 adds one blocker family and one manifest | Does not know about ledger, evidence coverage or QuickBooks freshness |

Corrections to earlier claims, found in this inspection:
- The CLAUDE.md register still lists `DEFECT-ACCOUNT-REVIEW-AUTHORITATIVE-FLAGS-001` as open. The source now writes
  a flag only when the reviewer decided it (`buildReviewDecisions.ts`, `20260904120000_account_review_flag_preservation.sql`).
  V3 still does not take the cash-account population from these flags alone (§5.1): flags describe ledger accounts,
  and the population problem is accounts the ledger does not have.
- "Everything in front of the TB is missing" (v1) was wrong; "SAFISHA already reconciles bank evidence for readiness"
  would also be wrong: its authority layer is quarantined and its tolerances are unsuitable for a readiness decision.

---

## 2. The decision model: four separate states

| State | Question | Decided by | Depends on GL? | Blocks |
|---|---|---|---|---|
| **TB validated** | Is this a well-formed, balanced, certified TB for this entity and period? | Existing certification **[REPO]** | No | Drafting |
| **Draft eligible** | May the accountant build statements now? | TB validated ∧ period ∧ currency **[PROPOSED rule, existing data]** | No | Nothing else. Never waits for GL, evidence or findings |
| **Scope ready** | Is this account group (or cross-cutting test) supported well enough to report? | V3 rules per scope **[PROPOSED]** | Only for the checks marked GL in §2.1 | Pack readiness for scopes the framework requires |
| **Pack ready** | May this version be finalized? | Server, in the finalizing transaction (§9) | Indirectly | FINAL |

Uploading evidence, mapping accounts, writing notes, proposing adjustments and drafting independent sections are
always allowed while any scope is held. A held scope stops only FINAL (and REVIEWED where §9 says so).

### 2.1 What each check needs

| Check | TB | GL | Independent evidence | If the GL is missing | If the GL does not tie to the TB |
|---|---|---|---|---|---|
| Arithmetic, classification, A01/A03/A10 | ✓ | | | runs | runs |
| Comparatives (TB to TB), movements | ✓ | | | runs | runs |
| Opening bridge at line or account level | ✓ | | prior pack or signed FS | runs | runs |
| Opening bridge at entry level (OBE, suspense, clearing) | | ✓ | supporting documents | **held: LEDGER_REQUIRED** | **held: LEDGER_NOT_RELIED** |
| Bank row ↔ book entry matching | | ✓ | statements | held | held |
| Cash tie: reconciled book cash = TB | ✓ | ✓ | statements | held | held |
| Bank coverage, population, running balances | | | statements, confirmations | **runs** | **runs** |
| Cut-off / omitted liabilities search | | ✓ (to show absence) | subsequent invoices, payments listing | held | held |
| Correction verification in source | | ✓ | | held | held |

A failed GL tie-out marks that **snapshot** unreliable. It never blocks drafting, uploading evidence or work on
TB-only checks; it holds only the checks that would otherwise rely on that snapshot.

### 2.2 Scope status vocabulary [PROPOSED]

`NOT_STARTED` · `AWAITING_EVIDENCE` · `HELD` (with typed reasons) · `READY` · `NOT_REQUIRED` (only with a framework
basis recorded in the scope registry). Hold reasons: `EVIDENCE_MISSING`, `LEDGER_REQUIRED`, `LEDGER_NOT_RELIED`,
`FINDING_OPEN`, `TREATMENT_UNDECIDED`, `ADJUSTMENT_UNDECIDED`, `COMPLETENESS_INCOMPLETE`, `STALE`.

Finding outcomes: `confirmed` (an error, evidenced), `suspected` (an indicator needing a decision or document),
`evidence_missing`, `incomplete` (a search that has not been performed or cannot complete), `pass`. Only `pass`, or
a `confirmed` finding resolved by an applied approved adjustment, leaves a scope READY.

### 2.3 Required scopes

A **scope registry** per framework pack lists the scopes a pack requires (for example cash per bank account,
deposits, receivables, payables and accruals, completeness of liabilities, opening equity, each suspense or clearing
account, comparatives). Some families are required **whatever the framework says**: `ledger` (when a snapshot is
bound), every `cash:*` and `population:*` scope, `pack` (evidence single use) and `rule_pack` (citations). A
`NOT_REQUIRED` scope needs the pack's recorded reason; absence of a registry entry is `HELD`, never `NOT_REQUIRED`.

---

## 3. Ledger snapshots and tie-out [PROPOSED]

**Snapshot.** An immutable record of one General Ledger read: source (`qbo_api` | `export_file`), realm or file hash,
period, accounting basis, currency, pulled-at, raw-response SHA-256, normalised-entries SHA-256, and the TB
certification it is compared with. Entries carry a source identity (QuickBooks transaction id + line id where
present; otherwise `weak:` + date, account, amount, document number, memo hash, occurrence index).

**Tie-out.** Per account, exact minor units: opening + Σ entries = TB closing. The account population must be equal
both ways. Period, basis and currency must equal the TB's. Any difference: `LEDGER_TIEOUT_FAILED` naming each account.

**QuickBooks route.** The connector allows only `TrialBalance` today **[REPO]**. Adding `GeneralLedger` (or
`TransactionList`) to `QBO_ALLOWED_REPORTS` is a separate reviewed change, gated by contracts C5 and C6
**[SANDBOX]**: the response must reproduce an independent QuickBooks export of the same company, period and basis
account by account (opening, debits, credits, closing, entry count), and transaction identifiers must be shown stable
across edits and re-pulls. Until then the export route (CSV/XLSX General Ledger) is the only ledger source, with the
same tie-out. Intuit's documented response limits (cells per report, date-range splitting) are handled by splitting
ranges and proving the union reproduces the TB; this is **[SANDBOX]**, not assumed.

---

## 4. Opening-balance bridge and opening tests

### 4.1 Paths

| Path | Authority for the opening | Level it can verify |
|---|---|---|
| A. Prior CFOClose pack | The prior year's FINAL (the explicit `fs_report_authority` row) and its account-level composition **[REPO]** | Account |
| B. Approved statements produced elsewhere | Signed approved FS (statement lines) + final TB + audit adjustments schedule + supporting schedules (debtors, creditors, deposit certificates, bank reconciliations) | Line by default; account where a final TB maps lines to accounts; sub-ledger or item only where that schedule is held |
| C. First reporting period | `fs_first_period_declarations` **[REPO]**: genuinely first period only; refused when any earlier TB exists | Opening is nil by declaration |
| D. Migration (another system, or QuickBooks opening balances loaded to Opening Balance Equity) | Path A or B for the authority, plus the migration journal(s) at entry level | Entry, once the opening journal is held |

Each issued statement line is mapped to its underlying ledger accounts (`line → accounts[]`, versioned, reviewed).
The bridge compares the authority with the current ledger opening and records the **level verified** per line:
`line`, `account`, `subledger` or `item`. Agreement on a total verifies only that total: a receivables line that
agrees at line level is reported as "agrees in total; individual debtors not verified", and any scope that relies on
debtor detail (ECL, ageing, cut-off) stays held until the debtor schedule is held.

### 4.2 Differences and their classification

Every non-zero difference needs one classification **with evidence of the matching kind**:

| Classification | Evidence it needs | Effect |
|---|---|---|
| `mapping` | opening journal or mapping schedule showing where the amount sits | Bridge proposal (adjustment/1) or a mapping correction; nothing restated |
| `timing` | prior bank reconciliation, subsequent statement | No adjustment; item carried in the reconciliation |
| `unposted_audit_adjustment` | audit adjustments schedule | Reporting adjustment, or a source correction verified per §8 |
| `possible_prior_period_error` | an error analysis showing the original posting and what it should have been | Routed to the existing restatement path (`fs_propose_restatement` → `fs_decide_restatement`); as-reported comparative preserved and shown beside the restated one |
| `other_evidenced` | the document named | As decided |

A reviewer's approval is recorded, but **never satisfies the evidence requirement**: a classification without
probative evidence stays `evidence_missing` (`APPROVAL_IS_NOT_EVIDENCE`). Unclassified differences are `suspected`.

### 4.3 Independent opening tests

**Cash.** For each bank account: the new statement's opening (bank side) must equal the prior year's bank-side
closing as shown in the prior bank reconciliation; documented reconciling items (unpresented cheques, deposits in
transit) bridge bank to book; book opening must equal the approved opening. Without the prior reconciliation the
cash opening scope is held (EWMA: 30 June 2025 reconciliations are not held).

**Opening Balance Equity, suspense and clearing — entry level.** Every entry in these accounts needs its own support,
whatever the balance. A balance of zero is not evidence: two unsupported entries that cancel hold the scope (fixture
S4). A non-zero balance that is fully supported passes (S3). This replaces v2's "must be zero" rule and extends the
existing balance-level `CLEARING_ACCOUNT_BALANCE` indicator **[REPO]**, which cannot see a net-zero account.

**Arithmetic reconstruction is not content.** A figure reproduced from a TB and journals proves the arithmetic only;
the scope stays held until the source entries are held (E3).

### 4.4 Standards: verify before citing or encoding

The rule pack carries a citation register; each citation has a status. Only `verified` citations may be shown as a
basis or encoded in a rule (fixture S11). At this commit:

| Framework | Provision | Status |
|---|---|---|
| IPSAS 3 | paras 47 (retrospective correction of material prior-period errors), 54 (disclosure) | verified earlier in this engagement against the IFAC text |
| IPSAS 1 | paras 7, 27 | verified earlier |
| IAS 8 (full IFRS) | prior-period errors | **not verified here**; cite only after reading the current IFRS Foundation text |
| IFRS for SMEs | Section 10 | **not verified here** (paragraph numbers differ between editions) |

---

## 5. Banks and other balances, in parallel

### 5.1 Expected bank-account population

Population = the union of: ledger cash accounts; accounts in the prior-year statements and bank reconciliations;
accounts named in bank confirmations; accounts on uploaded statements. Each member must resolve to exactly one of:

| Status | Needs |
|---|---|
| active, mapped to one ledger account | coverage + matching + tie (§5.2–5.4) |
| active, not in the ledger | a mapping decision with evidence (account number on the statement = the ledger account's), or a finding that an account is unrecorded; its balance may support only **one** reported line (`EVIDENCE_SINGLE_USE`) |
| dormant | a statement or confirmation covering period end; a statement that stops earlier is a coverage gap |
| closed | a bank closure letter dated before period start, or a statement to the closure date |
| newly opened | the opening statement and a ledger account |

Completeness of the population itself needs, per bank relationship, a confirmation listing **every** account held
at period end (`BANK_POPULATION_UNCONFIRMED` otherwise). Without it the pack is held: an account known to no ledger,
prior record or upload is otherwise invisible (failure mode 1).

### 5.2 Coverage and file integrity

- Statement periods must cover period start to period end with no gap; pages are counted against the printed total.
- Printed running balances are recomputed row by row; a break is a missing page or a misread row and is `confirmed`.
- The same bytes uploaded twice count once. Overlapping files must agree row by row where they overlap; disagreement
  is `suspected` and holds the account.
- **Extraction uncertainty.** Every extracted row records how its facts were established: `reproduced` (amounts
  reproduce the printed running balance), `human_confirmed`, or `ai_unconfirmed`. Only the first two are probative.
  An AI-read page whose balances do not chain is never matched.
- Matches on the pages supplied cannot clear an account whose coverage is incomplete (E4).

### 5.3 Matching bank rows to ledger entries

- One-to-one by exact amount; reference (cheque or transfer number) takes precedence; date window per account
  (default 5 days, recorded).
- More than one candidate and no unique reference: **no match**, `MATCH_AMBIGUOUS` (failure mode 2).
- Splits: one bank row to at most N book entries (or the reverse) only when the sum is exact and the references link.
- Transfers between two population accounts: matched as a pair; a leg without its counterpart is `suspected`.
- Reversals: a row and its reversal on the same account net to zero only when the bank marks the reversal or the
  references link; otherwise both are matched individually.
- SAFISHA's fuzzy tiers and 1% amount drift **[REPO]** may *suggest* candidates; they never produce a match that
  counts for readiness.

### 5.4 Tie to the TB and timing items

Reconciled book cash = bank closing − outstanding cheques + deposits in transit ± other evidenced items; it must
equal the ledger closing and the TB. Each timing item gets a **targeted request** for the evidence that would clear
it (for cheque 000777: "statement for 1–15 July 2026 showing cheque 000777"), not a blanket two-month rule. An item
still uncleared when its evidence arrives is re-classified (stale cheque, error) by a reviewer with evidence.

### 5.5 Completeness of liabilities (cut-off), independent of the bank

The search window runs from period end to the longest supplier payment term on file (or the observed payment lag,
whichever is longer), recorded with its basis. Sources: subsequent payments listing and supplier invoice register
for that window, plus goods-received notes. An invoice dated after year end for goods received on or before year
end, absent from the ledger's liabilities, is `CUTOFF_OMITTED_LIABILITY` (confirmed, with an accrual proposal). If
the search sources are absent the check is `incomplete` and the scope is held, **even when the bank reconciliation
is clean** (S1-M1): a bank reconciliation tests recorded cash, not unrecorded obligations.

### 5.6 Other balances

The same pattern (population → evidence coverage → item-level agreement → tie to the TB) applies to receivables
(debtor schedule, confirmations, subsequent receipts), payables and accruals (creditor statements, §5.5), deposits
and investments (certificates, confirmations, movement history), payroll liabilities (returns and subsequent
payments), PPE (register agreeing to the TB). Each scope is evaluated independently; one held scope never stops
another from being worked.

---

## 6. Deposits (EWMA E1 pattern)

A deposit's movement history must explain approved opening → closing: placements, rollovers, interest capitalised,
partial withdrawals, payouts, each with a certificate, confirmation or statement row. A payout proves only itself.
The system never infers a restatement from an unexplained difference and never recognises a second asset for a
balance already presented under another line. Both are refusals, not warnings.

---

## 7. Roles and separation [REPO capabilities, PROPOSED assignments]

Capabilities, never titles (`workspace_member_capabilities`, `has_workspace_capability` **[REPO]**):

| Act | Capability | Separation |
|---|---|---|
| Upload evidence, map accounts, propose corrections and classifications, draft | `prepare_close` | — |
| Decide findings, approve corrections and classifications, approve comparatives, mark REVIEWED | `review_close` | Not the proposer under the two-person policy; owner self-approval only under the recorded policy, disclosed **[REPO]** |
| Finalize (FINAL), designate or replace a FINAL authority | `approve_certification` | Not the person who marked REVIEWED (existing review/approval separation **[REPO]**) |
| Issue an official pack | `issue_reporting_pack` | — |

A solo user may hold all capabilities. Then every self-approval is stamped and disclosed in the pack, and no
self-approval can satisfy an evidence requirement.

---

## 8. Corrections: one accounting effect each

### 8.1 Record [PROPOSED, on top of adjustment/1]

Each correction is one adjustment/1 row **[REPO]** plus a correction record:
- `correction_id` = stable identity: `corr:<rule>:<anchor>`, anchor = the sorted source identities of the original
  postings it corrects (or, for an omission, the evidence id and account). The same facts in a later import give the
  same id; different facts give a different id.
- `effect` = the account deltas (balanced, exact) and its SHA-256.
- Documentation, all required: the original posting(s) or the omission; the underlying event and its evidence; the
  treatment and its basis (rule id and version, citation if any); the journal or reporting adjustment; the downstream
  effect (statement lines, cash flow classification, disclosures).

A correction may span several original postings (one anchor with several identities) but has **one** effect. Two
effects are two corrections (EWMA food rations: the opening bridge and the reclassification are separate).

### 8.2 Verification in QuickBooks before retirement

For each later snapshot, the server looks for postings **linked** to the anchor (reference to the original
transaction, bill or correction id in the posting's reference or memo):

| Observation | State | Reporting adjustment | Readiness |
|---|---|---|---|
| Linked postings' combined effect equals the correction's effect | `verified_in_source` | Retired (stops applying; history kept) | ready |
| No linked posting, no same-effect posting | `not_corrected_in_source` | Applies | ready if approved |
| No linked posting, but a posting with the same accounts and amounts | `candidate_needs_confirmation` | Applies, flagged | **held** until a reviewer links or rejects the candidate with evidence (failure mode 5) |
| Linked postings with a different or partial effect | `partial_or_different` (residual shown) | Suspended (applying both would double count) | held until the residual is proposed or the source completed |
| Linked postings that net to zero (corrected, then reversed) | `corrected_then_reversed` | Not silently reinstated | held |

An unrelated posting with the same amount but other accounts (a refund banked to 1020) is ignored (E2-L5).
Repeated import of the same snapshot is the same observation (E2-L4). Retirement and reinstatement are each a
recorded binding decision (`close_review_revalidate_adjustment` pattern **[REPO]**), so the adjusted TB and
`fs_reporting_input.inputSha256` change and dependent report versions go stale.

---

## 9. Finalization

### 9.1 The readiness manifest [PROPOSED]

Canonical JSON, SHA-256, containing: `fs_reporting_input.inputSha256` (certification, applied adjustments, findings
run) **[REPO]**; ledger snapshot id and its two hashes, tie-out result; every evidence object hash bound to a scope;
coverage and population results per account; account-to-line mapping version; treatment and classification decision
ids; correction states; rule pack id and version and citation register hash; source freshness record (§9.3);
scope registry version and every required scope's status.

REVIEWED records the manifest hash the reviewer saw. FINAL must present the same hash.

### 9.2 The finalizing transaction [PROPOSED, DB-TEST]

One new splice in `fs_publication_blockers` (the existing single sign-off path **[REPO]**), executed inside
`fs_set_publication_state` when the target is FINAL:

```
require READ COMMITTED (tb_require_read_committed)          -- PT412 otherwise, before any write
lock order: _fs_scope_lock(company, year) → lineage → version → tb_official_output_lock   -- existing order
manifest_now := _rfr_readiness_manifest(company, year)     -- recomputed from rows, never from the request
if manifest_now.sha256 <> reviewed_manifest_sha256 → RFR_MANIFEST_STALE
if any required scope <> READY                       → RFR_SCOPE_HELD:<scope>
if source is QuickBooks and freshness not proven     → RFR_SOURCE_FRESHNESS_UNDETERMINED / RFR_SOURCE_CHANGED:<tb|gl>
insert rfr_finalization_manifests(publication_id, manifest jsonb, sha256)   -- immutable, same transaction
```

Every function that writes a manifest input (evidence registration, mapping, decisions, adjustments, snapshot
import, correction state) takes `_fs_scope_lock` for that company and year first (contract C4). Then:
- **Change commits first**: finalize waits on the lock, recomputes, sees a different hash, refuses
  `RFR_MANIFEST_STALE`; no FINAL row, no issuance (C1).
- **Finalize commits first**: the change waits, then commits; FINAL and its stored manifest are unchanged; the next
  version sees the change; the issued version is shown as superseded only when a later FINAL exists (C2).

Both orderings are proven with held transactions, as `publicationAuthority.mjs` does for replacement versus seal.

### 9.3 QuickBooks freshness

A local lock cannot freeze QuickBooks. For a workspace whose ledger snapshot came from QuickBooks, FINAL requires a
**freshness record** made by a server pull completed within a bounded window before the finalizing transaction: TB
fingerprint (and GL fingerprint, once GL is allow-listed) equal to the bound snapshot's. Outcomes:
- equal → finalize may proceed;
- different → `RFR_SOURCE_CHANGED`, the affected scopes reopen, nothing is finalized;
- the pull cannot run (reconnect needed, Intuit unavailable, period refused) → `RFR_SOURCE_FRESHNESS_UNDETERMINED`,
  nothing is finalized. There is no override. Disconnecting does not convert a QuickBooks-bound workspace into an
  export-bound one.

The residual window (QuickBooks edited between the freshness pull and commit) is disclosed in the pack: "Source
re-read at <time>". After issue, a later pull that differs for a finalized period raises a
`SOURCE_CHANGED_AFTER_ISSUE` finding on the issued version (shown on verify), never a rewrite. Whether QuickBooks'
closing-date setting or change data capture can narrow the window is **[SANDBOX]**, not assumed.

### 9.4 Preserving issued evidence

Objects bound in a FINAL manifest are retained: replacing or retiring a statement, ledger snapshot or upload leaves
the bound bytes retrievable (contract C7), following the existing rule that referenced objects are never deletable
**[REPO]** (`tbu_object_referenced`, `reporting_pack_storage_orphans`).

---

## 10. Claude inside the product

Claude extracts facts from documents (rows, dates, amounts, references, counterparties), proposes candidate matches
and explains findings in plain language. It never decides: extracted facts are `ai_unconfirmed` until they reproduce
an independent control (printed running balance, document total) or a person confirms them; candidate matches count
only when the deterministic rules accept them; treatments, classifications, approvals and readiness are decided by
verified rules and authorized people. Model calls go through the metered assistant path (`ai_assistant_reserve`
**[REPO]**), not the withheld unmetered endpoints (`DEFECT-UNMETERED-LLM-ENDPOINTS-001`).

## 11. What the user sees

One action, "Check my books", and one queue grouped by scope. Each card: what was found (figures), the evidence held,
the one next action, and the effect of the permitted correction in words with the journal expandable. Example (E2):
"TZS 33,518,793.00 was charged to food-ration expense on 2 July 2025, but it paid last year's approved bill
003/2024.2025. Correcting it lowers this year's expense by 33,518,793.00 and settles the opening payable. Cash does
not change." Scope status sits beside the statements; drafting is never locked by it.

## 12. Pilot

Frozen exports, one company, one path: E2 (food rations) from TB and constructed GL to the two approved reporting
adjustments, the reviewed adjusted TB (`close_review_adjusted_trial_balance`), and its handoff through
`fs_reporting_input` into the existing reporting workflow, with the finalization blocker active. Exit criteria:
E2, its mutations and E2-L1…L5 pass in IMPLEMENTATION_TEST; C1–C4 pass on PostgreSQL; the constructed GL rows are
replaced by EWMA's real QuickBooks GL export and E2 re-run. The authenticated QuickBooks GL route (C5, C6) is proven
separately before any customer relies on it.

## 13. Fixtures

Defined in `ACCEPTANCE_CONTRACT.md` §3 and executable in `cases.mjs`: E1 (CRDB payout), E2 / E2-REAL / E2-L1…L5
(food rations and its correction lifecycle), E3 (Opening Balance Equity), E4 (missing pages and accounts), S1
(June liability), S2 (outstanding cheque), S3 (supported equity), S4 (net-zero suspense), S7–S12 (missing GL,
failed tie-out, duplicate files, approval without evidence, unverified citation, QuickBooks freshness), FM1–FM5.

## 14. Five ways this design could wrongly clear a pack

| # | How it could clear wrongly | Defence in V3 | Test that catches it |
|---|---|---|---|
| 1 | **Invisible account.** A bank account known to no ledger, prior record or upload never enters the population, so nothing holds. | Per-bank confirmation of every account held is required for population completeness; unresolved confirmation accounts hold. | FM1 (and sabotage: ignoring confirmations fails FM1) |
| 2 | **Same-amount false match.** Two cheques of equal amount: amount/date matching pairs a book entry with the wrong bank row, hiding an unrecorded payment. | One-to-one; reference precedence; ambiguity never auto-matches; SAFISHA fuzzy tiers only suggest. | FM2 (sabotage: first-candidate matching fails FM2) |
| 3 | **Source changed under the binding.** QuickBooks reclassifies or re-dates entries between approval and FINAL; the TB fingerprint is unchanged, so a TB-only freshness check passes. | Manifest binds GL fingerprints too; freshness compares both; undeterminable freshness refuses. | FM3, S12; C1/C2 on PostgreSQL |
| 4 | **Present but not probative evidence.** A document of the right kind is attached (AI-read, or the wrong amount or period) and the scope clears. | Evidence counts only with confirmed facts that equal the item's amount, reference and window; AI extraction is unconfirmed until reproduced. | FM4, FM4-M1 (sabotage: accepting AI facts fails FM4) |
| 5 | **Wrong retirement of a correction.** A same-accounts, same-amount QuickBooks journal that is not the correction retires the reporting adjustment, so the error returns, or both apply and it double counts. | Retirement needs a linked posting; an unlinked same-effect posting is a candidate that holds the pack until a reviewer decides with evidence. | FM5, E2-L5 (sabotage: retiring on an unlinked journal fails FM5) |

## 15. Open decisions and blockers

1. Allow-listing `GeneralLedger` in the connector (blocked on C5, C6 **[SANDBOX]**).
2. The scope registry per framework pack (owner and accounting review needed; IPSAS accrual first).
3. Date window and split limit defaults for matching (proposed 5 days, 5 lines; owner decision).
4. Freshness window length (proposed 10 minutes, the issuance expiry already used by `issue_reporting_pack`).
5. SAFISHA revival: V3 needs a new evidence store with server authority; whether that is a revival of the
   quarantined `20261004100000`/`20261005100000` or a new design is a separate reviewed change.
6. EWMA documents still required for the real replay: QuickBooks GL export and opening journal; NMB 40102300487
   pages 8 and 38–40; CRDB deposit certificates and confirmations at 30 June 2025 and 2026; 30 June 2025 bank
   reconciliations; Jambo statement or confirmation to 30 June 2026; payment voucher for cheque 001593 and the
   Enduimet Rangers Association confirmation; Bank of Tanzania closing rates for the USD accounts.
