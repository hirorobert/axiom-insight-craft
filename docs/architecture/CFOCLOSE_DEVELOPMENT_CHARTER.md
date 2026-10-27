# CFOCLOSE Development Charter and Reporting Specification — v4

**Status:** Proposed for owner adoption and technical/accounting review. This document supersedes v3 as a proposal; it becomes the governing charter only when its adoption is recorded in the repository. It is a target specification, not evidence that its capabilities are implemented.
**Scope:** Shared web-native preparation architecture for IFRS for SMEs, full IFRS and IPSAS accrual. IPSAS cash is a future extension requiring its own requirements and acceptance criteria; accrual gates must not be assumed to apply unchanged.
**Audience:** Every developer, accounting author and reviewer working on CFOClose.
**Rule of use:** After adoption, changes must conform to this charter or carry a reviewed amendment under §12. Until adoption, existing repository controls remain authoritative. This charter does not itself authorize spending, merging, deployment, publication, activation or modification of hosted records. Conflicts with applicable standards, law or professional obligations must be escalated and resolved; the charter cannot override them.

---

## 0. Happy path

Everything in this specification exists to make the following journey work without coaching from CFOClose staff.

| Step | What the accountant does | What the product guarantees |
|---|---|---|
| 1. Bring in | Uploads trial balance(s), prior-year statements (text or scan), registers, workpapers; or connects a source | One entry point. Every input becomes an immutable source revision. |
| 2. Confirm | Reviews what was read: period, basis, currency, unit, framework edition, and what changed since the last revision | Nothing is reconciled before units, currency and period are confirmed. |
| 3. Complete | Works one task list | Every task states the missing fact, the requirement it serves, the evidence accepted and who can answer it. No blank composition boxes. |
| 4. Review | Reads statements, schedules and notes; clicks any figure to its source | Every figure has provenance. Every discrepancy has a bridge or a blocker. |
| 5. Approve and issue | Reviews per firm policy; issues; downloads | Issued versions are frozen. Limited-scope exports are visibly incomplete and never use the issuance path. |

Unresolved **accounting** questions become visible tasks for management. Questions about **operating the product** are product defects.

---

## 1. Principles

| ID | Principle |
|---|---|
| P1 | Every reported figure has provenance. No provenance, no figure. |
| P2 | Arithmetic, reconciliation and gate decisions are deterministic code with fixtures. No unconfirmed model output is an authoritative figure. Extracted numeric candidates remain proposals until confirmed; financial calculations use approved deterministic modules. |
| P3 | AI proposes; a named person confirms. Proposals are stored as proposals until confirmed. |
| P4 | Confirmation records who, what, evidence and lineage. Gates establish specified checks; the register records assessed coverage. Neither guarantees accounting correctness or compliance. |
| P5 | Framework content is versioned data in a governed register, plus restricted, tested calculation and validation modules where a requirement needs executable logic. Content and modules are versioned together. |
| P6 | The server enforces authorization, authoritative state transitions and financial gates. The UI guides preparation and may provide previews; client checks never substitute for server enforcement. |
| P7 | Issued output is immutable. Later changes create drafts; they never mutate an issued version. |
| P8 | Product claims (site, pitch, report label) equal register status. |

---

## 2. Step 0 — Facts before building

Run once, in the repository, before any code change under this specification.

1. Produce a **FACTS TABLE**: `capability | status | source (file:line)`. Status values: `deployed`, `merged-not-deployed`, `branch`, `candidate`, `not built`. Include #207, its SQL candidate, the canonical migration process and the current deployment verification route.
2. List every place a number enters the system. Each must satisfy P1 or be listed as a gap.
3. Unverifiable items become `[TODO: …]`. Never a claim.
4. Produce the **GAP LIST** against §3–§5 with `file:line`.
5. Propose delivery estimates for B1–B9 (including B8a and B8b) (§8) from the gap list. Estimates are proposals until the team commits them (§9).

---

## 3. Data model

Logical layers. Realise them within the existing application; this is not a rewrite instruction.

| Layer | Name | Definition |
|---|---|---|
| L1 | SourceRevision | Immutable import (file or connector). Content hash, provenance hash, period, basis, currency, unit, source organisation id, stable source account ids, completeness-check result. |
| L2 | Mapping | `account → treatment → caption(s) → schedule → policy → note`. Versioned; carried forward year to year. **Allocations** are permitted: one account may split across captions by explicit, reviewed allocation whose parts sum to the source amount. |
| L3 | Journal | Reason, evidence link, preparer, reviewer per firm policy (R10), timestamp. Never edits L1. |
| L4 | AdjustedTB | Derived only: L1 + L3. Never stored by hand. |
| L5 | Schedule | `opening + movements = closing` per area. Movement source recorded: movement accounts, register or workpaper. |
| L6 | PriorReport | Extracted published statements, captured **progressively** (statement by statement, note by note). Each figure: page reference, page image, unit, confirmation record. Published figures preserved exactly; restatements recorded as a separate bridge with authority and evidence. Unconfirmed items are shown as unconfirmed. |
| L7 | FrameworkRegister | One row per requirement: framework, edition, effective period, adoption conditions, applicability test, required facts, treatment workflow (content or named module), disclosure structure, fixture with expected result, accounting author, independent reviewer, version, change-impact rule, implementation status: `supported` / `external-workpaper` / `unsupported` / `not-assessed`. Applicability is a separate entity-and-period assessment: `applicable` / `not-applicable` / `unresolved`. Requirement identity and authoritative source references must be recorded. “Excluded” is not a way to waive an applicable requirement. |
| L8 | Answer | A confirmed fact with evidence and confirmer. Reused by every dependent output. Includes **bounded narrative** where judgment requires it: fixed prompt, length limit, linked to the requirement it serves. |
| L9 | Workpaper | Governed external document (e.g. an IFRS 9 ECL model): preparer, reviewer, period, extracted figures with confirmation, linked to the register rows it satisfies. |
| L10 | ReportVersion | Bound to its exact dependency set: L1 revisions, L2 version, L3 journal ids, L5, L6 confirmations, L8 answer ids, L9 workpaper ids, L7 register version. Carries a normalised accounting-result hash and a separate provenance hash. States: `draft → under review → issued (frozen)`. |

---

## 4. Rules

| ID | Rule |
|---|---|
| R1 | **Provenance.** Every number resolves to one of: source account id, journal id, allocation id, answer id, prior-report page reference, workpaper figure id, or a formula over those. Build fails otherwise. |
| R2 | **Deterministic calculation.** See P2. Calculation and validation modules under P5 are tested against fixtures and versioned with the register. |
| R3 | **AI scope.** Extract, propose mappings and allocations, draft wording, phrase tasks, explain discrepancies. Never approve or establish authoritative calculations. Models may request approved deterministic tools; the server authorizes the request and computes the result. |
| R4 | **Opening bridge.** Opening balances versus prior published closing balances: every difference is a bridge item (posted journal, authorised restatement, scope change, identified error) with evidence. An unexplained residual is a BLOCKER. The product never creates a balancing entry. |
| R5 | **Movements.** Where the chart carries movement accounts (frozen opening cost, cumulative additions, accumulated depreciation, WIP, transfers), movements may be derived from account differences **only after** account semantics, period alignment and extraction completeness are confirmed as answers (L8). Otherwise registers or workpapers are the source. Two balances alone never produce a schedule. |
| R6 | **Period resolves the standard.** Register rows are selected by reporting period and adoption flags (e.g. IPSAS 23 vs IPSAS 47; IFRS for SMEs 2015 vs third edition; full IFRS by effective dates). The framework name alone selects nothing. |
| R7 | **Structured disclosure.** A disclosure is complete when its required facts (L8/L9) exist with evidence. Generated wording is output for review. Free composition is replaced by structured questions plus bounded narrative. |
| R8 | **Units and currency** are confirmed per source, section or page as appropriate before authoritative reconciliation. Consistent metadata can be confirmed in a batch; overrides remain page-linked. Preview calculations may assist confirmation but are clearly provisional. |
| R9 | **OCR** (already present) is an input method feeding the same extraction contract as text PDFs. OCR output is a proposal; the page image is shown beside each figure; confirmation is required. |
| R10 | **Review policy.** A server-enforced firm policy defines who may prepare, review and issue. Solo practice is an explicit, recorded policy that respects applicable legal, governance, professional and platform requirements. The policy is enforced and stored as report metadata; whether and how review arrangements are disclosed on the financial statements is determined separately by the applicable register rows. Firm policy cannot waive those obligations. Policy changes are versioned, authorized and audited; each report binds its applicable policy revision. |
| R11 | **Claims equal register.** Site, pitch and report labels may assert support only for scopes whose L7 rows are `supported` (or satisfied by L9) with passing fixtures and a named reviewer. The site build fails on mismatch. |
| R12 | **Issuance versus export.** Two distinct paths. (a) **Official issuance** produces a ReportVersion labelled "prepared in accordance with [framework, edition]" and is available only when every applicable register row is `supported` or satisfied by a governed workpaper (L9). Unsupported applicable requirements block this path. (b) **Limited-scope export** is a draft/internal workpaper export: visibly incomplete, watermarked, lists unsupported applicable rows, carries no compliance assertion, and never uses the issuance path. Non-applicability is a recorded assessment, not an exclusion. |
| R13 | **Change control.** Each ReportVersion binds to its dependency set. A change to a bound dependency creates or refreshes a draft and requires re-review. Unrelated imports do nothing. Issued versions never change state. |
| R14 | **Connectors.** Read-only first. "Connected" shows per-item status (organisation confirmed, period, chart, transactions, registers, prior report, last refresh, reconciliation to source). Missing items become targeted uploads. Write-back is a separate, later, explicitly authorised feature. |

---

## 5. Gates

Server-side. All applicable gates must pass before official issuance (R12a). Limited-scope export (R12b) records which gates failed.

| ID | Gate | Pass condition |
|---|---|---|
| G1 | Import integrity | Debits = credits; no duplicate source account ids; period, basis, currency, unit confirmed; completeness check passed. Applies to trial-balance imports only. |
| G2 | Mapping complete | Every relevant account is accounted for, including zero-net accounts carrying movements or disclosures; nonzero balances are mapped or allocated; allocations sum to source; unused template captions derive to zero where completeness is established, and the product asks only where it cannot establish it. |
| G3 | Opening bridge | R4 satisfied; residual = 0 after authorized, evidenced bridge items. Otherwise the gate fails and records a blocker. A test can pass by correctly detecting that failure; the report cannot pass the gate. |
| G4 | Schedules | Each L5 schedule: opening + movements = closing; movement source confirmed per R5; register ties to trial balance. |
| G5 | Cross-statement | Statement of financial position balances. Changes in equity/net assets: opening + result ± items = closing. Cash flow reconciles to the framework-defined cash and cash equivalents, including classification and exchange-effect adjustments as applicable, not necessarily a single caption. Each note reconciles per the reconciliation defined in its register row. Comparatives = L6 confirmed published figures ± recorded restatement bridge. Inconsistencies found inside a prior printed statement are recorded here, not under G1. |
| G6 | Disclosures | Every applicable L7 row has its required L8/L9 with evidence; non-applicable rows carry a recorded assessment. |
| G7 | Framework and period | R6 resolved; adoption flags recorded; R12 path determined. |
| G8 | Review | R10 policy satisfied; all proposals used by the report confirmed, unused proposals explicitly excluded from its dependency set; no open BLOCKER. |
| G9 | Change control | Dependency set unchanged since the draft was built (R13). |

---

## 6. Fixtures

Golden cases. CI reproduces normalised results exactly. Any change altering a golden result fails the build until the accounting reviewer re-approves the fixture.

| ID | Case | Expected results |
|---|---|---|
| F1 | SME two-year company (existing) | Issues through all gates on the SME scope. |
| F2 | Enduimet 2025/26, IPSAS accrual | Requires authorisation and source evidence. Until obtained: status `pending evidence`. The reinstated-receivable journal is excluded. The previously quoted residual (272,281,866.76) is an **unverified expectation** until reproduced from authorised source files; the expected behaviour is a G3 BLOCKER, not a figure. |
| F3 | MUSE 2025 + 2026 trial balances | Movement-account semantics confirmed as answers; PPE and WIP schedules derived under R5. The previously quoted printed-statement imbalance (29,260,180.10) is an **unverified expectation** until reproduced; if reproduced it is recorded under G5 comparatives, not G1. |

---

## 7. Acceptance tests

Tests are executable for the slice being built. Later tests remain documented here and become executable when their feature enters development.

| ID | Test | Pass condition |
|---|---|---|
| A1 | Equipment slice on F1 and F2 | Trial balance and available prior-year inputs in; only unresolved questions asked; every discrepancy explained; reconciled PPE schedule, policy and note linked to statements; no unexplained blank composition; no hidden manual step. F2 passes by either completing or **correctly stopping at an evidenced BLOCKER**. |
| A2 | Parity | Identical normalised accounting-result hash for equivalent file and connector inputs; provenance hashes differ and are retained. |
| A3 | Negative test per gate | Official issuance refused while the gate fails; limited-scope export records the failure. |
| A4 | Coaching test | One named accountant, one real entity, timed. Log A: questions the product asked. Log B: questions asked to CFOClose staff about operating the product. Log C: accounting questions raised to management, visible as tasks. **Pass = Log B empty.** |
| A5 | Claims test | Site build and report label fail when claims exceed register status (R11, R12). |

---

## 8. Build order

Exit criteria, not dates. Dates are assigned under §9.

| ID | Work | Exit criterion |
|---|---|---|
| B1 | Close #207 properly: final candidate reviewed; CI green; SQL promoted through the canonical migration process; installation authorised; browser acceptance; deployment evidence recorded. | FACTS TABLE row `deployed` with evidence. |
| B2 | Provenance (R1) and gates G1, G2, G5 on the existing SME path. | G1, G2, G5 pass on F1; A3 executable and passing for those three gates. Does **not** authorise issuance before other applicable gates pass. |
| B3 | Equipment journey on F1 and F2 with shared preparation logic; opening bridge (R4/G3); schedule (R5/G4). | A1 passes on both (F2 may pass at an evidenced BLOCKER). |
| B4 | Prior-report onboarding (L6), progressive capture, scans included (R9), units confirmed (R8), restatement bridge. | Enduimet 2025 scan: the statements and notes F2 requires are captured, page-linked and confirmed; remaining items shown as unconfirmed; F2 comparatives sourced from L6. |
| B5 | Framework register (L7) populated for the SME scope F1 exercises; author and reviewer named; R11/R12 enforced. | G6, G7 pass on F1; A5 passes; F1 issues on the official path with the correct label. |
| B6 | IPSAS accrual scope F2 exercises: presentation, non-exchange revenue per period (R6), net assets movements, budget comparison where applicable with basis reconciliation and variance explanations, disclosures. | F2 issues through all gates on the official path; IPSAS reviewer signs the rows. |
| B7 | Next area selected from the first BLOCKER the fixtures raise (expected: receivables and ECL). Repeat B3–B6 per area. | Per-area A1-equivalent passes. |
| B8a | Full IFRS preparation scope selected from a real entity’s applicable requirements; implement supported modules or governed external-workpaper paths as needed. Do not assume an ECL, revenue, lease or tax workpaper alone covers an entire standard. | Reconciled preparation and clearly incomplete internal export demonstrated; this is not a compliance or official-issuance milestone. |
| B8b | Full IFRS official-report scope: all applicable requirements satisfied, including recognition, measurement, presentation and disclosure; framework and jurisdiction assessments reviewed. | One real IFRS entity completes the official journey with qualified accounting review and recorded evidence. Remains incomplete if only B8a succeeds. |
| B9 | First customer-backed connector, read-only, into L1 (R14). | A2 passes. |

---

## 9. Ownership and clock

Each of B1–B9 (including B8a and B8b) carries three named roles: **technical owner**, **accounting author**, **independent reviewer**.

| Item | Rule |
|---|---|
| Step 0 completion date | Set by the team on adoption of this document. |
| B1–B9 (including B8a and B8b) estimates | Proposed from the GAP LIST by the implementing agent; committed by the team within one week of Step 0. |
| First A4 test date | Set at the same time, against a named real entity. |
| Appointments | Only the team appoints people and commits dates. No agent or document may assign them. |

A plan missing any field in this section is not a plan.

| Build item | Technical owner | Accounting author | Independent reviewer | Committed date |
|---|---|---|---|---|
| Step 0 | | | | |
| B1 | | | | |
| B2 | | | | |
| B3 | | | | |
| B4 | | | | |
| B5 | | | | |
| B6 | | | | |
| B7 | | | | |
| B8a | | | | |
| B8b | | | | |
| B9 | | | | |

---

## 10. Deliverable from the implementing agent now

1. FACTS TABLE (§2.1).
2. GAP LIST against §3–§5 with `file:line`.
3. B1 closure checklist with evidence fields.
4. Proposed PRs for B2 only.
5. Executable tests for B2's gates (G1, G2, G5 on F1). A1, A2, A4, A5 remain documented until their build items start.
6. Proposed estimates for B1–B9 (including B8a and B8b) (§2.5).

No engine rewrite. Nothing beyond B2 until B1 is deployed.

---

## 11. Binding implementation boundaries

### 11.1 Provenance and calculation contract

- Provenance includes authoritative source revisions, approved standard/rule constants, recorded estimates, rates, useful lives, dates, rounding rules and deterministic formula versions. A ledger account is not the only valid origin.
- Monetary arithmetic uses explicit decimal precision or integer minor units; rounding, sign conventions, currency conversion and presentation scale are versioned. Reconciliations distinguish exact accounting differences from defined presentation-rounding tolerances. Tolerances never hide an unexplained balancing entry.
- Source account identity is scoped to source organisation, revision, period and other necessary dimensions. Legitimate segmented rows must not be rejected merely because their account code repeats.
- Raw published figures remain immutable. OCR correction, metadata confirmation and restatement create traceable revisions or decisions rather than rewriting the evidence.
- Framework selection also assesses entity eligibility, jurisdictional adoption, reporting-period boundaries and transition choices. Unknown applicability cannot silently default to not-applicable.
- Prior-year information is used where required and available. First-period, transition and missing-evidence cases need explicit requirement-driven paths, not a fictitious prior audited report.

### 11.2 What makes an external workpaper sufficient

A file link does not satisfy a requirement. The server records its immutable version and hash, entity and period, author and reviewer, applicable requirement, relevant method and assumptions, confirmed extracted figures, reconciliation to the adjusted trial balance and other schedules, required disclosures, and review disposition. Missing or stale evidence leaves the requirement unresolved. Requirements outside the workpaper remain separately assessed.

### 11.3 Atomicity, retries and concurrent work

- Each authoritative save or transition carries an authenticated actor, exact scope, expected revision and request identity. Reusing a request identity with a different intent is refused; repeating the original intent returns the original receipt without duplicate financial or issuance records.
- Issuance checks permissions, review policy, dependency fingerprint and applicable gate results for the same immutable report revision in its committing transaction. Gate results bind the input fingerprint and calculation/register versions. Concurrent relevant changes refuse the transition.
- Unknown write outcomes are labelled unconfirmed. Recovery reuses the original request identity; a matching current value is not proof that the original request succeeded.
- Draft work can be saved while incomplete; official issuance cannot. A combined transactional save either records all its promised database artifacts or none.
- Database and object storage are not one transaction. Issuance uses the existing recoverable state machine with idempotent artifact creation, durable receipts, integrity verification and reconciliation. No completed issuance is claimed before required files and seals are verified. Crashes, duplicate delivery and interrupted uploads have tested recovery paths.
- Issued payloads remain frozen. Retraction, supersession and correction are new authorized audit events; they never erase or silently replace original issued records.

### 11.4 Privacy, access and release evidence

- Tenant and capability checks run server-side on every authoritative read and write, including evidence downloads. No browser-held service credentials. Tests include cross-tenant access, revoked access and direct-RPC attempts.
- Uploaded evidence remains private, bounded and subject to the approved scanning and retention controls. OCR and extracted text are untrusted input. Sending client information to an external model requires approved data-processing terms and explicit activation controls.
- Paid AI, Lovable or other metered work requires the owner’s explicit authorization before use, including scope and budget. Offline/local development must remain usable without AI. AI cannot change classifications, journal entries, approval states or issuance on its own.
- Deployment evidence distinguishes approved source, build artifact, deployed artifact, observed runtime behaviour and accounting validation. A declared compiler digest or successful upload is not deployed-source attestation. Unavailable evidence is recorded unresolved; only the authorized owner can accept a specifically described residual risk where policy permits.
- Never repeat applied migrations. Promote candidates through the canonical migration process; use approved recovery evidence, exact identities, postconditions and journal registration. Do not repair hosted history by rewriting applied files.
- Installation, publication and activation are separate recorded actions. Existing issued history, commercial settings and unrelated data are outside scope unless explicitly authorized.

### 11.5 Usability and coverage acceptance

- Confirm consistent source metadata in one action, with explicit exceptions. Ask only unanswered applicable questions; preserve answers and show what a change will affect.
- Each blocker provides a concrete next action, accepted evidence, responsible capability, honest save state and a return path. Necessary narrative remains available for unusual judgments.
- A4 logs include task completion, abandoned steps, misleading messages and failed recovery, not just questions asked. An empty coaching log does not count as success if the accountant cannot finish. Accounting questions to management are legitimate visible tasks.
- F1/F2/F3 are evidence-backed acceptance fixtures, not proof of broad framework coverage. Add materially different entities and adversarial cases before expanding support claims. Expected-output changes require a recorded explanation and review of the affected accounting result; unrelated byte changes do not demand accountant approval.
- Standards and illustrative materials require verified edition, paragraph/source references and permission for the intended commercial use. No proprietary template is copied without rights. Jurisdictional templates supplement, rather than replace, applicable standards.
- Official compliance wording is never generated solely because all currently registered rows pass: the applicable requirement universe and its completeness must itself have accounting review. Assess materiality and applicability under the framework; do not turn every immaterial difference into an arbitrary universal blocker.

## 12. Amending and adopting this document

An amendment is a PR against this file with: the section changed, the reason, the fixture or test affected, and sign-off from one technical owner and one accounting reviewer. Discussion documents, chat transcripts and AI outputs are inputs to an amendment, never a substitute for one.

Adoption record: owner decision, technical reviewer, accounting reviewer, date and repository commit remain **unassigned** until the team records them. This document does not appoint people or assert approval.

The charter is a durable decision framework, not a guarantee that no redesign will ever be needed. Changes in standards, evidence, security or user needs are handled through reviewed amendments. The final delivery target is demonstrated accountant-led completion of supported reports, not the number of modules, tests or documents produced.

*End of specification.*
