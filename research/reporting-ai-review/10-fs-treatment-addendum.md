# 10 — Financial-Statements Treatment Addendum to #150

Targeted extension of the #150 review (not a new programme). Reuses #150's corrected inventory and
the current candidate baseline **`69155ae`**. Read-only. Does **not** repeat release QA, competitor
research or the general AI inventory. No production change, engine activation, migration, model call
or scope expansion. Deployed/hosted apply-state is **UNKNOWN** throughout (code/schema presence in
`69155ae` is as cited; "live" means routed-and-reachable in source, rollout-gated per company).

## 0. Two corrections to #150's inventory (found on `69155ae`)
1. **There is a third statements layer #150 did not name.** #150 described only the thin live
   `ExportStatements.tsx` and the hard-disabled "World B" (`FINANCIAL_STATEMENTS_WORKSPACE_ENABLED=false`).
   A **separately-gated "reporting layer"** also exists and is routed live: `src/lib/frameworkPacks/**`,
   `src/lib/statements/**`, `src/lib/notes/**`, `src/lib/reporting/**`, `src/components/reporting/**`,
   DB migrations `20261015100000`–`20261026100000`; routed in `src/App.tsx:85,140-150` under
   `WORKBENCH_NAVIGATION_ENABLED` (`workbench/gate.ts:10`) + `REPORTING_PAGES_SHIPPED`
   (`workbench/routes.ts:109`), gated **per company by a server allow-list + kill switch**
   (`components/reporting/ReportingAccessGate.tsx`, `financial_statements_workspace_access`). It is
   **built and shipped, rollout-gated to allow-listed companies (the demo company)** — not hard-off.
   This layer, not World B, is the treatment-adjacent system assessed below.
2. **Adjusting journals are now balanced in the DB and read into statements.** #150 reported AJEs
   existed but were unread with client-side balancing. On `69155ae`: `close_review_adjustments`
   (+ `_lines`) are server-side, `CHECK`-balanced (Σdebit=Σcredit>0), append-only, two-person/owner-self
   approval, bound to `tb_certifications` (`20261015100000`), and **read into composition** via
   `_fs_adjusted_accounts`/`close_review_adjusted_trial_balance` with `adjustmentIds` lineage
   (`20261016100000`, surfaced in `fs_statement_composition`). Legacy browser `adjusting_journal_entries`/
   `aje_lines` writes are **retired** (`20261026100000`).

## 1. Answers first

**Q1 — Which treatment requirements are explicitly in the approved first Phase 6 slice?**
**None of the recognition/measurement/presentation/disclosure treatment contracts.** The first
Phase 6 slice (per #150 §05) is *account-meaning* governance: grouped review → authorised versioned
decisions → traceable TB summary → compatible repeat-upload reuse + changed-context reopening — i.e.
layer **B** (mapping/classification) plus part of layer **G** (versioned decisions). Its only
treatment-adjacent output is the three authoritative classification flags (`is_cash_account`,
`is_retained_earnings`, `is_payroll_account`), which feed a presentation perimeter but are **not** a
recognition/measurement treatment. The treatment-adjacent capabilities that *do* exist live in the
**separate rollout-gated reporting layer** (correction 0.1), not in the Phase 6 slice.

**Q2 — Which require a separate financial-statements implementation slice?**
Everything in the attachment's layers **C–F** that is not account-meaning:
- the **recognition/measurement engine** (entirely absent today — the single largest item);
- **framework coverage beyond IFRS-for-SMEs** — IFRS-full (incl. **IFRS 18**, eff. 1 Jan 2027),
  IPSAS-accrual (incl. **IPSAS 47**, eff. 1 Jan 2026), IPSAS-cash — each a separate pack;
- **transition / first-time adoption / IAS 8 & Section 10** constructs (change in estimate, change
  in policy, prior-period error) — absent as treatment constructs;
- **treatment-specific evidence families** (lease, ECL/impairment, going concern, subsequent events,
  related party, receivables ageing, valuation) — absent;
- **export parity** (DOCX, native XLSX) and **national-regulator model-FS/"best-presented"**
  checklists (NBAA BPFS / ICPAK / ICPAU FiRe) — absent.

**Q3 — Which existing components can support that slice, and what execution evidence is missing?**
*Reusable (present on `69155ae`, IFRS-for-SMEs only unless noted):*
`frameworkPacks` requirement + applicability catalogue (`types.ts PackRequirement`; `fs_pack_requirements`
`20261019100000`) and per-report decisions (`fs_requirement_decisions`/`fs_decide_requirement`
`20261022100000`, fail-closed `REPORTING_CASE_UNSUPPORTED:`); `editionPolicy.ts` edition selection by
period-start with recorded early-application; `fs_statement_composition` (SFP+SCI composition + per-line
+ blockers, `src/lib/statements/composition.ts`); approved balanced adjustments read into composition
(`close_review_adjustments`); `fs_schedule_submissions` movement schedules with server arithmetic
validation (`20261019100000` §4); `financialEvidence` intake/binding (ledger/equity/cash-map/prior-period);
IFRS-for-SMEs disclosure checklist + `fs_disclosure_texts`; `sealedPack`/`fs_commit_revision` version
binding (`20260919110000`) + capability-authorised sign-off (`20260925140000`); `tb_certifications`.
*Missing execution evidence:* the reporting layer is **rollout-gated to allow-listed companies** — its
only exercised path is the demo company, on a local/allow-list basis; **no recognition/measurement
engine exists to execute**; **no IFRS-full/IPSAS packs** (multi-framework unverified); **no
treatment-specific evidence-family** execution; **no DOCX/native-XLSX**; and **no executed worked-case
suite** proving a composed+adjusted+disclosed report finalises through the publication gate for a real
framework/edition with full source traceability. Hosted apply-state of all `2026101x/2026102x`
migrations is **UNKNOWN**.

## 2. Executive verdict — is governed treatment capability in the next phase?
**PARTLY.** Presentation/disclosure **applicability governance** and **versioned, sealed publication**
are designed, implemented and shipped (rollout-gated) **for IFRS-for-SMEs only**; the
**recognition & measurement** treatment capability is **NOT ESTABLISHED** (absent in code and in any
identified approved plan for the first slice).
- **Designed:** PARTLY — applicability/requirement catalogue + edition policy + fail-closed
  unsupported-case handling are a genuine design; recognition/measurement is not designed anywhere.
- **Implemented:** PARTLY — layer **C** applicability-only, **D** evidence-binding for
  ledger/equity/schedules/comparatives (not treatment-specific), **E** composition totals +
  approved-adjustment application + schedule arithmetic (no measurement), **F** SFP/SCI + disclosure
  checklist + sealed pack. One framework.
- **Verified:** execution-verified only via unit/DB proofs + the demo/allow-list path; **not**
  hosted-general, **not** across frameworks, **no** executed treatment worked-cases.
- **Released:** rollout-gated to allow-listed companies — **not** general availability.

## 3. Standards applicability (verified, dated — do not presume all-framework completeness)
Applicability is by period **start date** + adoption, not the printed year.
- **IFRS 18** *Presentation and Disclosure in Financial Statements* — effective annual periods
  **beginning on/after 1 Jan 2027**, replaces IAS 1, issued 9 Apr 2024, early application permitted;
  five mandatory P&L categories + management-defined performance measures. Full-IFRS only; must **not**
  touch IPSAS/SME. [ifrs.org](https://www.ifrs.org/projects/completed-projects/2024/primary-financial-statements/) ·
  [EY](https://www.ey.com/en_gl/technical/ifrs-technical-resources/iasb-issues-ifrs-18-presentation-and-disclosure-in-financial-statements)
- **IFRS for SMEs, third edition (2025)** — effective periods **beginning on/after 1 Jan 2027**,
  issued 27 Feb 2025, early application permitted, retrospective per Section 10.
  [ICAEW](https://www.icaew.com/insights/viewpoints-on-the-news/2025/feb-2025/iasb-publishes-third-edition-of-ifrs-for-smes-accounting-standard) ·
  [PwC](https://viewpoint.pwc.com/dt/gx/en/pwc/in_briefs/in_briefs_INT/in_briefs_INT/iasb-issues.html)
- **IPSAS 47** *Revenue* — effective periods **beginning on/after 1 Jan 2026**, early application
  permitted; **replaces IPSAS 9, 11 and 23**.
  [IPSASB at-a-glance](https://ifacweb.blob.core.windows.net/publicfiles/2023-05/IPSAS%2047-Revenue-At-a-Glance.pdf)

`69155ae` represents edition/early-application **only for IFRS-for-SMEs** (`editionPolicy.ts`:
2015 vs 2025 by period-start, no default, early application only with recorded jurisdiction
confirmation). There is **no** IFRS 18, IPSAS 47, IFRS-full or IPSAS pack (grep-clean). Any claim of
IFRS-full/IPSAS treatment support would be false today.

## 4. Coverage register (attachment checklist → status + evidence)
Status: **E**=existing · **PL**=planned (doc only) · **M**=missing · **U**=unknown.

| # | Requirement | Status | Evidence |
|---|---|---|---|
| A | Source integrity / canonical TB | **E** | `tb_certifications` ledger; `fs_reporting_input` adjusted TB (`20261016100000`) |
| B | Account meaning / statement mapping | **E** | `account_mappings`, review authority (`20260904120000`); Phase-6 first slice |
| C | Client-specific **recognition/measurement** treatment | **M** | no engine; `recognition/measurement` = test/fixtures only; OCI/tax/equity-method refused (`coverage.ts`, `_fs_comprehensive_income`) |
| C′ | Treatment **applicability/requirement** governance | **E** (IFRS-SME) | `frameworkPacks/types.ts PackRequirement`; `fs_pack_requirements`; `fs_requirement_decisions`/`fs_decide_requirement` fail-closed `REPORTING_CASE_UNSUPPORTED:` |
| D | Evidence intake & binding (ledger/equity/cash-map/prior-period/schedules) | **E** | `financialEvidence/types.ts EVIDENCE_TYPES`; `EvidenceIntake.tsx`; `fs_schedule_submissions` arithmetic (`20261019100000` §4) |
| D′ | Treatment-specific evidence (lease/ECL/going-concern/subsequent-events/related-party/ageing/valuation) | **M** | grep-clean in live generation; disclosure-text only |
| D″ | Authorised judgment/estimate capture | **PARTIAL (E)** | preparer judgement/estimate **disclosure text** (`fs_disclosure_texts`); not a computed judgment |
| E | Deterministic calc / adjustments / schedules | **E (no measurement)** | composition totals; approved balanced `close_review_adjustments` read in; schedule validation |
| E′ | Adjusting journals flow into statements | **E** | `_fs_adjusted_accounts`→`fs_statement_composition` `adjustmentIds` lineage; legacy browser AJE retired (`20261026100000`) |
| F | Presentation: SFP / SCI | **E** | `fs_statement_composition` composes SFP+SCI (`composition.ts`) |
| F | SOCIE / cash flow / budget-vs-actual | **E (evidence-gated)** | resolve via `fs_notes_status` + evidence families; `EVIDENCE_GAP`/`undecided`/`unsupported` when absent |
| F | Disclosures / policies / material judgments | **E (IFRS-SME)** | disclosure checklist `fs_pack_requirements` DISCLOSURE rows; sign-off blockers `DISCLOSURE_CHECKLIST_ABSENT/INCOMPLETE` (`20261017100000:239,241`) |
| F | Comparatives / restatements / opening balances | **E (comparative only)** | `fs_comparatives` two-person restatement (`20261020100000`); **not** IAS-8 policy/estimate/error |
| F | Cross-refs / numbering / totals / rounding | **E** | composition per-line totals; sealed pack render |
| — | Composition decision taxonomy (NOT_APPLICABLE/EVIDENCE_MISSING/JUDGMENT_REQUIRED/SUPPORTED/UNSUPPORTED) | **PARTIAL** | live: `provided/missing/undecided/not_applicable/unsupported`; **JUDGMENT_REQUIRED and SUPPORTED absent** (grep 0) |
| §3 | Framework + basis + edition + effective dates + early application | **E (IFRS-SME only)** | `FrameworkEdition`, `editionPolicy.ts`; `frameworkAdapter.ts` basis⊥framework |
| §3 | IFRS 18 / IPSAS 47 / first-time adoption / change-in-estimate/policy / prior-period error | **M** | grep 0 (`IFRS18`, `IPSAS 47`, `first_time_adoption`, `change_in_estimate/policy`) |
| §4 | Scenario contract (stable ID, rule version, fact questions, journals, acceptance fixtures, author/reviewer/approval) | **PARTIAL (M for recognition)** | requirement rows carry `kind`/`applicability`/`citations`/`blocking`; **no** recognition scenario with journals + author/reviewer release metadata |
| §4 | Conflicting-rule precedence → visible unresolved decision | **PARTIAL/U** | requirement decisions fail-closed `undecided`; no evidence of an inter-rule precedence/conflict surfacer — **U** |
| §7 | Web / PDF | **E** | `ExportsView.tsx` print pack from one `sealedPack` (nothing recomputed) |
| §7 | Excel (native) / Word (DOCX) | **M** | CSV only; DOCX grep 0; legacy `ExportStatements` XLSX is a **divergent** surface |
| §7 | One approved model for all outputs | **E (reporting layer)** | `sealedPack.ts` binds from saved version; divergence risk = the legacy `ExportStatements` surface |
| §8 | National-regulator / award checklists (NBAA BPFS, ICPAK/ICPAU FiRe) | **M** | grep 0; `NBAA` only as edition jurisdiction rationale |
| §9 | Version binding (source/mapping/treatment/journals/standards-pack/disclosures/rendering/sign-off) | **E (no treatment pack)** | `fs_commit_revision` binds doc+hash+evidenceBatchIds+rulePack+dependencies/composition/notes/comparative SHAs+edition+approver (`signoff.ts:26-145`); **no distinct treatment-pack version (none exists)** |
| §9 | Concurrency / stale approvals / idempotency | **E** | optimistic `expectedReportVersion` + `idempotencyKey`; staleness invalidation; payment⊥financial status |
| §6 | AI boundary (propose-only, never invent figures/post journals) | **E (by absence)** | per #150: no in-product AI reachable; treatment is deterministic/preparer-supplied |

## 5. Five ranked gaps
1. **No recognition/measurement engine (layer C core).** The system governs *applicability* and
   *presentation/disclosure* and fail-closed-refuses what it cannot compose, but never *computes* an
   accounting treatment. Everything measured is the TB (± approved manual adjustments and supplied
   schedules). *This is the defining limit of the whole phase.*
2. **Single-framework only (IFRS-for-SMEs).** No IFRS-full (so no IFRS 18 pathway), no IPSAS-accrual
   (so no IPSAS 47), no IPSAS-cash. Public-sector entities are **not** served; any multi-framework
   claim is false. Framework eligibility by entity type is not modelled.
3. **No transition / IAS-8 / Section-10 constructs.** No first-time adoption, change in estimate,
   change in policy, or prior-period error as treatments; "restatement" exists only as an approved
   comparative delta. Edition transition is represented for IFRS-SME *selection* but not for the
   accounting *effects* of transition.
4. **Treatment-specific evidence + judgment are text, not bound facts.** Lease/ECL/going-concern/
   subsequent-events/related-party/valuation are preparer disclosure wording, not intaken/bound
   evidence with provenance/period/unit; `JUDGMENT_REQUIRED` is not even a composition state.
5. **Output parity + divergence risk.** No DOCX, no native XLSX; the sealed reporting pack is sound,
   but the **legacy `ExportStatements` XLSX** remains a separate, divergent surface the product does
   not reconcile — a path to an output that disagrees with the approved model.

## 6. Smallest end-to-end financial-statements slice (reuse, don't rebuild)
Scope it as **"IFRS-for-SMEs, single entity, composed-from-reviewed-TB + approved manual adjustments +
supplied schedules + checklist disclosures → sealed, versioned, finalised report,"** explicitly
**without** a recognition/measurement engine:
- **Reuse** the reporting layer end to end: `frameworkPacks` (IFRS-SME, edition by period-start) →
  evidence intake (ledger/equity/cash-map/prior-period/schedules) → `fs_statement_composition`
  (SFP+SCI) + `fs_notes_status` → approved `close_review_adjustments` → disclosure checklist →
  `fs_commit_revision`/`sealedPack` under the capability-authorised publication gate.
- **Add only:** (a) an executed worked-case acceptance suite (below); (b) reconcile or fence the
  legacy `ExportStatements` surface so only the sealed model can export; (c) a written, framework-
  scoped boundary stating the slice computes no recognition/measurement and every such case is
  `UNSUPPORTED`/refused by name.
- **Do not** add: IFRS-full/IPSAS packs, a measurement engine, transition treatments, or treatment-
  specific evidence families — each is a later, separately-approved slice.
- **Approval boundary:** this is a distinct FS slice; it must not be folded into the Phase-6
  ingestion/review slice NORMAL is executing.

## 7. Acceptance criteria (including rendered outputs)
A release of the slice in §6 is acceptable only if **executed** evidence (not source) shows, for
IFRS-for-SMEs on a disposable stack:
1. **Accounting correctness (bounded):** composed SFP/SCI totals equal the adjusted reviewed TB; every
   approved adjustment is balanced (DB `CHECK`) and traced via `adjustmentIds`; schedule movements
   reconcile (opening±movements=closing) — with **independently reviewed expected numbers**, not just
   "tests pass".
2. **Framework/edition selection:** edition chosen from period-start; early application only with the
   recorded jurisdiction confirmation; a period before an edition's effective date is refused, not
   defaulted.
3. **Missing evidence blocks finalisation:** absent SOCIE/cash-ledger/budget/disclosure evidence yields
   `EVIDENCE_GAP`/`missing`/`undecided` and the publication gate **refuses** REVIEWED/FINAL, while
   draft/diagnostic work remains available and clearly labelled.
4. **Unsupported treatment is named, never silent:** OCI, tax, equity method, discontinued ops, leases,
   impairment resolve to `UNSUPPORTED`/`REPORTING_CASE_UNSUPPORTED:` with the reason — a missing answer
   never means "no".
5. **Permissions/concurrency/stale approvals:** only `approve_certification` can finalise (SoD);
   `expectedReportVersion`+`idempotencyKey` hold under concurrency; an upstream change (mapping/
   adjustment/evidence) invalidates dependent approvals and refuses a stale sign-off.
6. **Traceability:** every published amount traces line → composition → mapping → approved adjustment →
   reviewed TB → certified source.
7. **Rendered outputs:** the **web** pack, the **PDF** (print host) and the **CSV** are produced from
   the **one** `sealedPack` (nothing recomputed), byte-stable on re-render; the legacy `ExportStatements`
   XLSX is either fenced off or reconciled to the sealed model. DOCX/native-XLSX, if promised, are a
   **named later item**, not part of this acceptance.

## 8. Worked cases (design mapping — NOT executed by me; distinguish evidence class)
Labels: **[ET]** partially executable today on `69155ae`; **[PF]** proposed acceptance fixture (not
yet implemented); **[UX]** unsupported today, correctly refused. None below are independently-reviewed
executed results — they are design targets; seven cases do **not** establish standards coverage.
1. **Grant/revenue arrangement** — needs the grant agreement + performance obligations; framework-
   specific (SME §23 / IPSAS 47 non-exchange). **[UX]** no revenue recognition engine; refuse
   `UNSUPPORTED`; disclosure text only. Journal inappropriate without the agreement facts.
2. **PPE additions/disposals/depreciation** (TB net movement insufficient) — needs the movement
   schedule. **[ET]** `fs_schedule_submissions` intakes + validates opening±additions−disposals±other
   =closing; note composes; finalisation blocks if schedule absent.
3. **Receivables impairment (ECL)** — needs ageing + loss-rate inputs + method. **[UX]** no impairment
   evidence family or methodology; refuse; do not infer from two TBs.
4. **Lease/financing** — needs contract terms/schedule. **[UX]** no lease evidence family or
   measurement; refuse. Journal inappropriate without contractual facts.
5. **Prior-period error / opening-balance discrepancy** — **[ET, partial]** approved comparative
   restatement delta exists (`fs_comparatives`, two-person) for the presentation effect; **[UX]** the
   IAS-8/Section-10 *error treatment* (classification, note) is not modelled.
6. **Standards-edition transition (IFRS-SME 2015→2025, periods ≥ 1 Jan 2027)** — **[ET, selection]**
   `editionPolicy.ts` selects the edition and records early application; **[UX]** the transition
   *reliefs/reconciliations* themselves are not implemented.
7. **Disclosure not detectable from the TB** (e.g. related-party, commitments) — **[ET, checklist]**
   the disclosure checklist raises it and blocks finalisation until answered; **[UX]** the content is
   preparer text, not derived/validated from bound evidence.
Adverse cases (design): conflicting evidence → unresolved/`undecided` (precedence surfacer is **U**);
missing agreement → `EVIDENCE_GAP`/refuse; unknown applicability → `undecided` blocks; unsupported
treatment → `UNSUPPORTED`; stale approval → refused on dependency change; changed rule pack →
dependent versions stale, published reports unchanged.

## 9. Explicit unsupported cases (today)
Recognition/measurement of anything (revenue, leases, impairment/ECL, financial instruments, tax, OCI,
equity method, discontinued operations); IFRS-full (incl. IFRS 18); IPSAS accrual (incl. IPSAS 47) and
IPSAS cash; public-sector entities; first-time adoption and IAS-8/Section-10 estimate/policy/error
treatments; transition reliefs/reconciliations; treatment-specific evidence binding; DOCX and native
XLSX; national-regulator/award "best-presented" checklists. Each must present as `UNSUPPORTED`/refused
by name — never silently composed.

## 10. Remaining owner decisions
1. **Framework scope for v1** — confirm IFRS-for-SMEs-only (recommended) and the explicit public-sector
   / IFRS-full deferral, each as a named later slice.
2. **The recognition/measurement boundary** — ratify that v1 computes **no** treatment and refuses all
   such cases; decide the roadmap order for the first measurement domain (PPE depreciation and
   comparative restatement are the nearest-term, evidence-backed candidates).
3. **Legacy `ExportStatements` surface** — fence it off or reconcile it to the sealed model before any
   GA claim (divergence risk, gap 5).
4. **Export promises** — decide whether DOCX / native XLSX are in-scope for the FS product claim; if
   so, schedule them as named items with their own acceptance.
5. **Standards content rights** — licensing for IFRS-for-SMEs / IPSAS text, illustrative statements and
   any NBAA/ICPAK/ICPAU checklist before reproducing substantive content (legal verification required;
   do not assume free online access permits product reproduction).
6. **Rollout gate → GA** — define the exit criteria for `financial_statements_workspace_access` moving
   from the demo allow-list to general availability.

## 11. What CFOClose still cannot responsibly claim
That it *performs accounting treatment* (recognition/measurement); that it supports IFRS-full, IPSAS,
public-sector entities, IFRS 18 or IPSAS 47; that it handles transition/first-time adoption or IAS-8/
Section-10 changes; that it detects treatment-specific disclosures from the TB; or that its statements
are "compliant" with any framework or award checklist. It *can* responsibly claim: a governed,
single-framework (IFRS-for-SMEs) **presentation + disclosure-applicability + approved-adjustment +
sealed-versioned-publication** capability, rollout-gated, that **refuses** by name what it cannot
compose. All evidence here is source/local on `69155ae`; hosted apply-state is UNKNOWN.
