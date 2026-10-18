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

### B.3 Two distinct state machines — approval vs issuance (do not conflate)

**(a) APPROVAL state — implemented server-authoritative publication state** (`fs_set_publication_state`,
`fs_commit_revision`, migration `20260919110000`). The persisted states are exactly **`DRAFT` →
`REVIEWED` → `FINAL`** (existing code; CI-exercised on the allow-listed demo, not GA). The client
cannot stamp them — `fs_commit_revision` writes DRAFT only and recomputes its own content hash;
REVIEWED/FINAL require zero publication blockers; FINAL requires `approve_certification` with SoD
(approver≠preparer≠reviewer, CI-proven #151) and is immutable.
```
 DRAFT ──(zero blockers; reviewer accepts, review_close)──▶ REVIEWED ──(approve_certification, SoD)──▶ FINAL (immutable)
   ▲                                                            │
   └──(any bound input changes — TB recert / evidence / adjustment / mapping / edition / comparative:
       dependency identity differs → approval goes stale, server refuses it, state is DRAFT; the prior
       REVIEWED/FINAL version stays immutable, history append-only)
```
*Invalidation is existing server behaviour* — dependency identity (`dependenciesSha256` +
composition/notes/comparative SHAs) must match or the sign-off is refused. Correction after FINAL is a
**new version** (new content hash) that supersedes; the prior version is never rewritten.

**(b) ISSUANCE state — a SEPARATE implemented machine** for the Official Reporting Pack
(`seal-reporting-pack`, `reporting_pack_issuances`, `reporting_pack_sealed_object`; CI-proven #157).
An issuance is **UNISSUED → SEALED(/ISSUED) → VERIFIABLE(intact|substituted|…)** and binds to one
FINAL version. It is **not** an approval state: issuing or verifying a pack never makes a report
reviewed/approved, and a payment/entitlement never does either. Issuance holds **no delete
capability** — a byte conflict refuses (`object_conflict`), recovery is a new issuance, unsealed
orphans expire.

**(c) PROPOSED UX states (this design — not server states).** The workspace surfaces a thin workflow
overlay the server does **not** persist: `IN_PREPARATION`, `IN_REVIEW`, `RETURNED_BY_REVIEWER`,
`READY_TO_SIGN`. These are **derived** from the server approval state + `nextAction` + review events
for display/routing only; they must never be treated as, or substituted for, the persisted
DRAFT/REVIEWED/FINAL. *Proposed work: the derivation + review-event surface (reviewer rejection with
per-item reasons is a UX overlay over a DRAFT approval state; the rejection reasons themselves need a
small persisted review-comment store — identify whether `signoff`/review events already carry them or
a thin addition is required, as a Slice-0 verification item).*

### B.4 Rollover (next year) — reconcile, never silently carry
From a FINAL prior year, "Start next period" reuses company/framework/currency and carries forward the
**mapping decisions**, **accounting-policy elections** and **answered requirement applicabilities**
(each marked *carried, re-confirm if changed*). Opening balances are **not** blindly copied:

- **Reconcile imported openings to the authoritative prior closing.** The new period's opening
  balances are reconciled, per account, against the prior year's **authoritative FINAL closing** (the
  immutable sealed version). The reconciliation is surfaced as a worklist item; equality clears it.
- **Preserve discrepancies — never overwrite.** If an imported opening (e.g. a re-imported TB, a
  migrated ledger) differs from the authoritative prior closing, the **difference is preserved and
  shown** (which source, which account, the delta); it is never silently reconciled away, and the
  approved source data is never modified in place. An unexplained opening difference is a blocker.
- **Governed restatement for legitimate prior-figure changes.** A change to the comparative/opening
  figures is recorded as a **governed restatement** — the existing `fs_comparative_restatements` /
  `fs_comparative_restatement_decisions` / `fs_comparative_approvals` authority (migration
  `20261020100000`, existing code): a balanced set of line deltas with a reason + reference,
  two-person approved; the **as-reported figure is kept** and the restated figure applies alongside
  it. History is not rewritten.

Period-specific **evidence** (new transaction ledger, equity movements, schedules, budget) and
**judgements** do **not** carry forward; they reopen as worklist items. Edition is re-resolved from the
**new period's start date** — a period beginning on/after 1 Jan 2027 re-evaluates the IFRS-for-SMEs
third edition, which is currently **GAP/UNSUPPORTED** and refused by name until that pack exists (a
later slice, below).

*Existing code:* the restatement/bridge authority (`fs_comparatives`) and the immutable prior FINAL
version. *Proposed work:* the rollover reconcile-and-preserve worklist step and the opening-difference
blocker. *Executed evidence:* none yet for the rollover path specifically — it is a Slice-1 proof
(opening = prior authoritative closing; a seeded discrepancy is preserved and blocks, not absorbed).

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
8. **Rollover.** Next period reuses company/framework/currency, carries mappings + elections
   (re-confirm chips), reopens period-specific evidence/judgements; edition re-resolved from new period
   start. Opening balances are **reconciled to the authoritative prior FINAL closing** — a matching
   opening clears; a **seeded discrepancy is preserved and surfaced (never overwritten) and blocks**;
   a legitimate prior-figure change applies as a **governed restatement** (`fs_comparative_restatements`,
   balanced, two-person, reason+reference) alongside the as-reported figure. *Proof:* opening reconciles
   to prior authoritative closing; discrepancy preserved + blocking; restatement applied without
   rewriting history; a 2027 period → edition `UNSUPPORTED` refused by name.
9. **Unsupported treatment (honesty).** A revenue/lease/ECL recognition question → `UNSUPPORTED`,
   escalated to a qualified person, **never** auto-composed. *Proof:* `REPORTING_CASE_UNSUPPORTED:`.

---

## E. Supported statement set + sequenced plan

### E.0 Complete supported statement set — first IFRS-for-SMEs slice (2015 ed., single entity)
The first slice must satisfy the IFRS-for-SMEs **complete set (3.17)**. The pack already **models**
the full set and its permitted alternatives; the honest gap is **face composition** for SOCIE/SCF on
the reporting layer (today `fs_statement_composition` composes SFP+SCI faces; SOCIE/SCF are required
and evidence-gated but their face assembly lives in the **disabled** canonical generation engine).
Code = `ifrsForSmes.ts` + `fs_statement_composition`/`fs_notes_status` (`20261018/19100000`),
`fs_comparatives` (`20261020100000`). Executed evidence = demo/allow-list + CI proofs only.

| Statement (3.17) | Existing code | Executed evidence | Proposed work for the slice | Honest gap |
|---|---|---|---|---|
| **SFP** (3.17a) + 4.2 lines, 4.4 current/non-current | **Yes** — composed face | demo/CI | drill + presentation | — |
| **SCI** (3.17b) + 5.5 lines, 5.11 by-nature/by-function | **Yes** — composed face | demo/CI | drill + presentation | — |
| **SOCIE** (3.17c) | requirement **modelled**, evidence-gated (`EQUITY_MOVEMENTS`; `STATEMENT_EVIDENCE_MISSING:smes.set.socie`) | gate only | **compose the SOCIE face** from equity-movements evidence on the reporting layer | face composition not confirmed on reporting layer (canonical generator is disabled) — **must complete + prove** |
| **SCF** (3.17d, Section 7) — direct method | requirement **modelled**, evidence-gated (classified cash-movement ledger) | gate only | **compose the SCF face**; opening+movement=closing tie to SFP cash | face composition to complete; `DEFECT-SAFISHA` — ledger is preparer-supplied, **not bank-independent** (disclosed, no dual-derived CF) |
| **Comparatives** (one prior period) | **Yes** — bridges + balanced two-person restatements into the comparative column | partial (restatement authority CI-adjacent) | wire restatement UX; reconcile openings (§B.4) | **one comparative only**; a comparative SCF needs prior-prior opening cash |
| **Notes** (3.17e) + disclosure checklist (3.3/3.23/8.x) | **Yes** — `fs_pack_requirements` DISCLOSURE + `fs_disclosure_texts`, blocking at sign-off | demo/CI | numbering + cross-refs to faces | content is preparer text (no auto-derivation of TB-undetectable disclosures) |
| **Permitted alternative presentations** — single vs two-statement SCI (3.17b); **single statement of income & retained earnings in lieu of SCI+SOCIE (3.18)** as a recorded decision; current/non-current vs liquidity (4.4); expenses by nature vs function (5.11) | **Modelled** (requirement ids + conditions in `ifrsForSmes.ts`) | — | **verify each alternative renders a correct face** and the 3.18 election suppresses SOCIE correctly | rendering of each alternative face must be verified/completed |

**Honest set-level gaps:** SOCIE/SCF face composition on the reporting layer; no bank-independent cash
flow (DEFECT-SAFISHA); one comparative only; no recognition/measurement (unsupported, refused by name);
DOCX/native-XLSX export (below). None of these are hidden by an aggregate score.

### E.1 Boundary note
The **first Phase 6 slice (account-meaning review: grouped review → authorised versioned decisions →
traceable TB summary → compatible reuse/reopening)** is **unchanged and upstream** of all FS work
below; FS is a strictly **separate, downstream set of slices** and does not expand the Phase 6 scope.

### E.2 Sequenced plan — per-capability verify → complete → separately authorised rollout
Not "reuse-and-activate". Each capability is **(V) verified** against its proof, **(C) completed**
where code is partial, and **rolled out only by a separate owner authorisation** — no slice flips
`FINANCIAL_STATEMENTS_WORKSPACE_ENABLED` or widens the `financial_statements_workspace_access`
allow-list; that is an explicit owner act after the evidence exists.

- **Slice 0 — Journey wiring (no capability change, no gate change).** Compose the existing views
  (`StatementsView`+`NotesView` one preview, `ReportingWorkbench` worklist from `nextAction`, drill
  drawer over `composition`/`fs_schedule_submissions`/`close_review_adjustments`); derive the proposed
  UX overlay states (§B.3c) and confirm where reviewer-rejection reasons persist. *Proof:* component +
  interaction tests; the prototype is the spec.
- **Slice 1a — Divergent-export containment (PRECEDES any customer rollout).** Make the legacy
  `ExportStatements` XLSX **reconcile to `sealedPack` or be disabled for FS**, so no FS output can
  diverge from the one approved model (gap 5). *Existing code:* `sealedPack`/`fs_commit_revision`
  (sealed model) + `ExportStatements.tsx` (divergent surface). *Proposed:* the fence/reconcile.
  *Proof:* a test that **no** FS export path produces bytes outside the sealed model. **This is a
  precondition of Slice 1's rollout gate — not a later slice.**
- **Slice 1 — IFRS-for-SMEs end-to-end, verify + complete, on a disposable stack.** Per-capability:
  **(V)** SFP/SCI faces, adjustments, capability+SoD sign-off, sealed pack+verify, publication
  blockers, `UNSUPPORTED` refusal, stale-approval invalidation — each already coded, **prove executed**.
  **(C)** compose + prove the **SOCIE** and **SCF** faces and each **permitted alternative** (incl. the
  3.18 election suppressing SOCIE), the **rollover reconcile-and-preserve** step (§B.4), and note
  numbering/cross-refs. *Proof requirements (all executed, not code-only):* (a) SFP/SCI/SOCIE/SCF +
  chosen alternative faces reconcile to the adjusted reviewed TB and tie to each other, with
  independently-reviewed expected numbers; (b) every publication blocker fires on its missing input
  and FINAL is refused; (c) `UNSUPPORTED` refuses by name; (d) SoD + stale-approval invalidation; (e)
  sealed pack byte-reproducible + verify `intact`, and (1a) no divergent export; (f) rollover opening
  reconciles to the authoritative prior FINAL closing and a **seeded discrepancy is preserved and
  blocks**, a governed restatement applies alongside the as-reported figure. **Rollout is a separate
  owner decision after this evidence**, capability by capability.
- **Slice 2+ (separately authorised, later, each own scope+proof):** DOCX / native-XLSX export; then
  additional frameworks (IFRS-full incl. **IFRS 18**; IPSAS-accrual incl. **IPSAS 47**; IPSAS-cash) —
  each a distinct pack; the transition / IAS-8 & Section-10 constructs; and any first
  recognition/measurement domain (PPE depreciation + comparative restatement are the nearest
  evidence-backed candidates). None promised by this design.

**Material tradeoffs (stated, not hidden):** (1) presentation/disclosure/adjustment governance ships
**without** a measurement engine — correct for trust, so the product assists a qualified preparer and
the UI says so. (2) Single-framework-first trades breadth for a provable release boundary. (3)
Verifying-and-completing the gated layer (not "activating" it) keeps GA an explicit, capability-by-
capability owner gate, never a side effect. (4) SOCIE/SCF face composition is real completion work,
not a flip — the slice is honest that two of the four faces still need building+proving on the
reporting layer.

**Unsupported — do not claim:** performing accounting treatment (recognition/measurement); IFRS-full/
IPSAS/public-sector; IFRS 18 / IPSAS 47; transition/first-time adoption; a bank-independent or
dual-derived cash flow; more than one comparative; TB-undetectable disclosures derived automatically;
"compliance" with any framework or award checklist.

Prototype (deliverable C): see the published artifact — the happy path and the four recovery paths
(missing evidence, changed-input invalidation, reviewer rejection, unsupported-refusal) with
synthetic IFRS-for-SMEs data.
