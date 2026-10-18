# 11 — Financial-Statements customer journey: design + implementation plan

Continues the FS evidence in this folder (`00`–`10`) and the PR reviews #150/#151/#153/#154/#157.
Design + prototype only. **No** capability enablement, hosted migration, merge or publish. Pricing,
unlimited membership (#161) and TB-UX cleanup are **out of scope** and not touched here.

Baseline: `origin/main` `02c516a`. The reporting layer is **merged to main but gated off**
(`FINANCIAL_STATEMENTS_WORKSPACE_ENABLED = false`, `workspaceGate.ts:21`) and additionally
per-company allow-listed (`ReportingAccessGate.tsx`, `financial_statements_workspace_access`).
Nothing below is described as GA-runtime-verified; see the evidence-grade column.

---

## A. Evidence map (reuse — do not rediscover)

Grades: **CI-PROVEN** (ran green in CI, cited run) · **ON-MAIN/GATED** (code+schema on main, exercised
only by CI proofs + the allow-listed demo company — not GA) · **GAP** (absent).

| Capability | Canonical files / DB objects | Evidence grade | Reference |
|---|---|---|---|
| Reporting workspace shell (3 views already exist) | `src/components/reporting/ReportingWorkbench.tsx`, `StatementsView/NotesView/SchedulesView/EvidenceIntake/ComparativesView/SignoffView/ExportsView.tsx` | ON-MAIN/GATED | `04`, `10` |
| Statement composition (SFP + SCI) | `src/lib/statements/composition.ts`; `fs_statement_composition` (`20261018100000`) | ON-MAIN/GATED | `10` §3 |
| Notes + applicability catalogue | `fs_pack_requirements`, `fs_requirement_decisions`/`fs_decide_requirement` (`20261019100000`/`20261022100000`); `fs_notes_status` (provided/missing/undecided/not_applicable/unsupported); fail-closed `REPORTING_CASE_UNSUPPORTED:` | ON-MAIN/GATED | `10` §1,§3 |
| Evidence intake + binding | `src/lib/financialEvidence/{types,intake,csv,xlsx,correction}.ts`; families TRANSACTION_LEDGER / EQUITY_MOVEMENTS / CASH_ACCOUNT_MAP / PRIOR_PERIOD_STATEMENTS / SUPPORTING_SCHEDULE / BUDGET / IPSAS_CASH | ON-MAIN/GATED | `10` §5 |
| Movement schedules (PPE etc.) with server arithmetic | `fs_schedule_submissions` (`20261019100000` §4) | ON-MAIN/GATED | `10` §5 |
| Approved adjustments → statements | `close_review_adjustments`(+lines) DB-balanced, two-person/owner-self approval, bound to `tb_certifications`, read via `_fs_adjusted_accounts` with `adjustmentIds` lineage (`20261015100000`/`20261016100000`) | CI-PROVEN (balance+authority) | `10` §2 |
| Framework + edition + period binding | `frameworkProfiles.ts` (FULL_IFRS/IFRS_FOR_SMES/IPSAS_ACCRUAL/IPSAS_CASH); `editionPolicy.ts` (2015 vs 2025 by period **start**, no default, early-application only with recorded confirmation) | ON-MAIN/GATED | `10` §3, `02` |
| Comparatives / restatement | `fs_comparatives` two-person restatement (`20261020100000`) | ON-MAIN/GATED | `10` §4 |
| Versioned, sealed, reproducible report | `src/lib/reporting/signoff.ts` → `fs_commit_revision` (`20260919110000`); `sealedPack.ts`; binds doc+contentHash+evidenceBatchIds+rulePack+dependencies/composition/notes/comparative SHAs+edition+approver | ON-MAIN/GATED | `10` §8 |
| Publication state machine + role gate | `fs_set_publication_state` (DRAFT/REVIEWED/FINAL, blockers, owner/partner only) | ON-MAIN/GATED | `10` §2; `00` C-1 (legacy path separate; #124 hardens it) |
| Capability authorisation (sign-off) | `20260925140000_workspace_capability_authorization` — `approve_certification`/`review_close`/`prepare_close`; SoD on `statement_sign_offs` | CI-PROVEN | #151 verdict |
| Readiness / next-action ordering | `nextAction.ts`; `fs_report_readiness_volatility` (`20261023100000`) | ON-MAIN/GATED | `10` §2 |
| Official Reporting Pack issuance (no delete/overwrite; conflict refusal; new-issuance recovery) | `_shared/reportingPackSeal.mjs`, `seal-reporting-pack/index.ts`; proof `billingSuspension.mjs` P-05 | CI-PROVEN (run 39058033407) | #157 verdict |
| Self-checking release wrappers (payload integrity, atomic rollback, journal reconciliation) | `release/wrappers/*.wrapper.sql`, `selfCheckingWrapper.mjs`, `releaseJournal.mjs`, proof `selfCheckingWrappers.mjs` | CI-PROVEN (run 39058115916, tb-release-r1 ALL PASSED) | #154 verdict |
| **Recognition/measurement treatment engine** | — | **GAP** (never computes a treatment; refuses by name) | `10` §1, gap 1 |
| Frameworks beyond IFRS-for-SMEs (IFRS-full/IFRS 18, IPSAS-accrual/IPSAS 47, IPSAS-cash) | only IFRS-SME pack built | **GAP** | `10` §3, gap 2 |
| Transition / IAS-8 & Section-10 (first-time adoption, change in estimate/policy, prior-period error) | — | **GAP** | `10` §4, gap 3 |
| Treatment-specific bound evidence (lease, ECL, going concern, subsequent events, related party, valuation) | preparer disclosure text only | **GAP** | `10` §5, gap 4 |
| DOCX / native-XLSX export; legacy `ExportStatements` divergence | `ExportStatements.tsx` (separate XLSX account dump) | **GAP / RISK** | `10` §7, gap 5 |

**Honest framing of "accounting depth" within what is supported:** CFOClose does **not compute**
recognition or measurement. Its governed "treatments" are (a) **presentation/classification**
decisions, (b) **disclosure applicability + content** decisions, (c) **approved, balanced manual
adjustments** with two-person authority, and (d) **professional-judgement capture** attached to
specific figures/notes — each bound to evidence, each versioned, and every case it cannot compose is
**refused by name** (`REPORTING_CASE_UNSUPPORTED:`), never silently assumed. The journey below is
designed to make that boundary legible, not to hide it.

---

## B. Complete screen flow + state transitions

### B.1 Entry & progressive reuse
Entry from a **reviewed, certified TB** for a company+period (the existing certification authority).
Reused without re-asking: **company, period (start/end), reporting currency, framework, reviewed TB
and its mappings**. The workspace asks a contextual question **only** when a reporting requirement
needs it (e.g. "Does the entity have share capital?" gates the equity sub-classification note), and
every question is a `fs_requirement_decision` with NOT_APPLICABLE / EVIDENCE_MISSING /
JUDGMENT_REQUIRED / SUPPORTED / UNSUPPORTED — a missing answer never means "no". Save/resume is the
saved DRAFT revision; nothing is lost on leave.

### B.2 The one workspace, three regions (matches the DESIGN TARGET)
1. **Report preview (centre)** — statements **and** notes in one continuous, cross-referenced view;
   every figure is a drill target.
2. **Prioritised worklist + readiness (left rail)** — one ordered list of what blocks FINAL, by the
   `nextAction` gate order: framework/currency/basis unset → accounts unmapped/ambiguous → missing
   evidence (`EVIDENCE_GAP`) → undecided requirements → composition blockers → unresolved findings →
   then "ready for review". Each item names its figure/note and jumps to it.
3. **Contextual drawer (right)** — for the focused figure/note: **Calculation** (inputs → formula →
   result, exact precision), **Source evidence** (the bound evidence rows/schedule + provenance),
   **Decisions** (the applicability/classification/adjustment decisions and professional-judgement
   notes, with any **AI suggestion shown as a distinct, unapproved chip**).

### B.3 Lifecycle state machine (server-authoritative; client never stamps a state)
```
 DRAFT ──(zero blockers + reviewer requested)──▶ IN_REVIEW
   ▲  │                                             │
   │  └─(edit evidence/adjustment/decision)         ├─(reviewer rejects → reasons on items)─▶ DRAFT
   │                                                 └─(reviewer accepts, role=review_close)─▶ REVIEWED
   │                                                                                            │
   └───────────(any bound input changes: TB recert / evidence / adjustment / mapping /          │
                edition / comparative)  INVALIDATES approval, reverts to DRAFT, history kept ◀──┤
                                                                                                │
 REVIEWED ──(role=approve_certification, SoD: approver≠preparer≠reviewer)──▶ FINAL (immutable)  │
 FINAL ──(issue Official Reporting Pack: server renders canonical bytes, seals own hash)──▶ ISSUED
```
- REVIEWED/FINAL require **zero publication blockers** and are decided by `fs_set_publication_state`;
  the client cannot stamp them (`fs_commit_revision` writes DRAFT only, recomputes its own hash).
- **Relevant-change invalidation** is by dependency identity (`dependenciesSha256` + composition/
  notes/comparative SHAs): a changed bound input makes the approval stale and reverts to DRAFT
  **without rewriting the prior immutable version** — history is append-only.
- **Correction/restatement/withdrawal:** a FINAL version is never edited; a correction is a **new
  version** (new content hash) that supersedes; a published pack is never deleted (per #157 — issuance
  holds no delete capability; conflicts refuse, a new issuance recovers, orphans expire).

### B.4 Rollover (next year)
From a FINAL/ISSUED prior year, "Start next period" reuses company/framework/currency and **carries
forward**: prior **closing balances → opening balances**, the **mapping decisions**, the
**accounting-policy elections** and the **answered requirement applicabilities** — each marked
*carried, re-confirm if changed*. It does **not** carry forward period-specific **evidence** (a new
transaction ledger, equity movements, schedules, budget) or **judgements**; those reopen as worklist
items. Edition is re-resolved from the **new period's start date** (so a 2027+ period re-evaluates
the IFRS-for-SMEs third edition — currently **GAP/UNSUPPORTED**, refused by name until that pack
exists).

---

## D. Acceptance scenarios (each independently verifiable)
Format: trigger → expected state → proof. "Proof" = the executed check kind; prototype shows the UI.

1. **Normal preparation.** Reviewed TB + bound ledger/equity/schedules + answered requirements →
   preview composes SFP+SCI+notes, worklist empties to "ready for review". *Proof:* composition =
   adjusted reviewed TB; every figure drills to inputs; db-proof on composition totals.
2. **Missing evidence.** No cash-movement ledger → cash-flow note is `EVIDENCE_GAP`; worklist item
   "Cash flow needs a classified cash-movement ledger"; **FINAL refused**. Draft/diagnostic view
   stays available and labelled DRAFT. *Proof:* `fs_notes_status=missing` + publication blocker.
3. **Adjustment.** Preparer proposes a balanced reclassification; second authorised approver accepts;
   the figure updates with an `adjustmentIds` lineage chip; an unbalanced entry is refused. *Proof:*
   `close_review_adjustments` DB balance CHECK + two-person authority (CI-proven).
4. **Changed input invalidates approval.** After REVIEWED, the TB is re-certified → version goes
   stale, reverts to DRAFT, the prior REVIEWED version is preserved immutable, the worklist shows
   "inputs changed since approval". *Proof:* `dependenciesSha256` mismatch → `fs_set_publication_state`
   refuses stale sign-off.
5. **Reviewer rejection.** Reviewer rejects with per-item reasons → state DRAFT, worklist carries the
   reasons on the exact figures/notes; no history rewrite. *Proof:* review event recorded; state
   transition logged.
6. **Sign-off.** Partner with `approve_certification` finalises; SoD enforced (approver≠preparer≠
   reviewer); binds doc+inputs+rules+statements+disclosures hash. *Proof:* capability RLS + SoD
   (CI-proven, #151).
7. **Publication.** Issue Official Reporting Pack: server renders canonical bytes, stores no-overwrite,
   seals its own hash; a byte conflict refuses (`object_conflict`), recovery is a new issuance; verify
   route re-hashes stored bytes → `intact`. *Proof:* #157 P-05 real-PG (CI-proven, run 39058033407).
8. **Rollover.** Next period reuses company/framework/currency, carries opening balances + mappings +
   elections (re-confirm chips), reopens period-specific evidence/judgements; edition re-resolved from
   new period start. *Proof:* opening = prior closing; carried decisions flagged; a 2027 period →
   edition `UNSUPPORTED` refused by name.
9. **Unsupported treatment (honesty).** A revenue/lease/ECL recognition question → `UNSUPPORTED`,
   escalated to a qualified person, **never** auto-composed. *Proof:* `REPORTING_CASE_UNSUPPORTED:`.

---

## E. Sequenced implementation plan

**Guiding principle:** the first complete framework-specific reporting slice is **IFRS-for-SMEs
(2015 edition), single entity**, because that pack is the one already built — so the work is
*activate → complete → prove → stage rollout*, not build a new engine. Each slice is independently
verifiable and does not enable anything beyond its proof.

- **Slice 0 — Journey wiring (no capability change).** Compose the three existing views
  (`StatementsView`+`NotesView` as one preview, `ReportingWorkbench` worklist from `nextAction`,
  drill drawer over `composition`/`fs_schedule_submissions`/`close_review_adjustments`). *Proof:*
  component + interaction tests; the prototype (deliverable C) is the spec. No gate change.
- **Slice 1 — First framework-specific reporting slice: IFRS-for-SMEs end-to-end on a disposable
  stack.** Reviewed TB → evidence intake → composition (SFP+SCI) → notes/disclosure checklist →
  balanced adjustments → comparatives → REVIEWED/FINAL under capability+SoD → sealed Official Pack →
  verify `intact`. *Proof requirements (all executed, not code-only):* (a) composition totals =
  adjusted reviewed TB with independently-reviewed expected numbers; (b) every publication blocker
  fires on its missing input and FINAL is refused; (c) `UNSUPPORTED` cases refuse by name; (d) SoD +
  stale-approval invalidation; (e) sealed pack byte-reproducible + verify route; (f) rollover opening=
  prior closing. Only after this evidence exists does an **owner** decide the gate/allow-list rollout
  — this slice does **not** flip `FINANCIAL_STATEMENTS_WORKSPACE_ENABLED`.
- **Slice 2 — Fence the divergent export.** Make the legacy `ExportStatements` XLSX either reconcile
  to the sealed model or be disabled for FS, so there is one approved model (gap 5). *Proof:* a test
  that no FS export path can diverge from `sealedPack`.
- **Slice 3+ (separately approved, later):** DOCX/native-XLSX; then — as distinct, product-owned
  decisions — additional frameworks (IFRS-full/IFRS 18, IPSAS-accrual/IPSAS 47, IPSAS-cash), the
  transition/IAS-8 constructs, and any first recognition/measurement domain (PPE depreciation +
  comparative restatement are the nearest evidence-backed candidates). None of these are promised by
  this design; each needs its own scope + proof.

**Material tradeoffs (stated, not hidden):** (1) We ship presentation/disclosure/adjustment
governance **without** a measurement engine — correct for trust, but it means the product assists a
qualified preparer, it does not replace one; the UI must say so. (2) Single-framework first trades
breadth for a provable release boundary. (3) Reusing the gated reporting layer avoids a parallel
engine but inherits its allow-list rollout — GA remains an explicit owner gate, not a side effect.

**Unsupported — do not claim:** performing accounting treatment (recognition/measurement); IFRS-full/
IPSAS/public-sector; IFRS 18 / IPSAS 47; transition/first-time adoption; TB-undetectable treatment
disclosures derived automatically; "compliance" with any framework or award checklist.

Prototype (deliverable C): see the published artifact — the happy path and the four recovery paths
(missing evidence, changed-input invalidation, reviewer rejection, unsupported-refusal) with
synthetic IFRS-for-SMEs data.
