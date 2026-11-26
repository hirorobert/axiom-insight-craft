# 13 — Release-critical bounded evidence table (4 claims)

Bounded reconciliation, **not** a broad audit. Pinned commit: **`origin/main 02c516a`**. Read-only; I
cannot execute PostgreSQL in this environment, so for each claim I give the guard, the exact inputs
that would exercise it, the assertion, and — honestly — whether an **executed** test exercises that
**exact** case. Where it does not, it is **SOURCE-ONLY** (guard read in source) or **UNKNOWN**
(execution/hosted state undeterminable). Adjacent executed cases are named but **not** counted as
proof of the asked case. **I do not approve these corrections — the independent audit session reviews
them.** NORMAL remains implementation owner.

## Baseline reconciliation (no silent cross-implementation comparison)
My baseline is `02c516a` (current `origin/main`). On this baseline my findings now **agree with the
independent auditor** on the three release-critical claims below. The earlier apparent conflict was a
**method error on my part**, not a different implementation: my prior "no unsupported path to FINAL"
cited aggregate proof PASS and adjacent assertions (an **SFP** figure tamper; an **IFRS-SME OCI**
case) and generalised them to SCF/SOCIE, other frameworks and granular disclosures, which the exact
guards do **not** cover. If the auditor cited a *different* commit, provide it and I will diff; I did
not assume parity.

## The table

| # | Claim (exact case) | Guard/function @ `02c516a` | Exact test inputs | Assertion | Executed output | Grade |
|---|---|---|---|---|---|---|
| 1 | Replace **SCF/SOCIE evidence** after REVIEWED → approval goes stale? | `fs_publication_blockers` evidence binding `EVIDENCE_SUPERSEDED`/`EVIDENCE_MISSING` (20261021100000:148-170) + `dependenciesSha256` over composition+notes+comparative; `fs_bind_publication` trigger (`BINDING_STALE`, :303-327) | REVIEW a complete report; then accept a **new EQUITY_MOVEMENTS/TRANSACTION_LEDGER batch** (same type) superseding the bound one; re-read readiness | REVIEWED version now carries `EVIDENCE_SUPERSEDED` (or `REPORTING_DEPENDENCIES_STALE`); cannot FINAL without a new version | **NONE for this exact case.** Executed staleness tests use a *synthetic* `dependenciesSha256="0"×64` tamper (`signoffBinding.mjs:129`) and a *pre-REVIEWED* disclosure edit / lost-response evidence version (`reportingClosure.mjs:114-121,148`) — neither replaces SCF/SOCIE evidence *after* REVIEWED | **SOURCE-ONLY** (mechanism present; exact case unexecuted) |
| 2 | Alter **only an SCF/SOCIE figure** → FINAL refuses? | Figure binding `STATEMENT_FIGURE_MISMATCH`/`STATEMENT_FIGURE_NOT_COMPOSED` is scoped to `provenance='TRIAL_BALANCE_DERIVED' AND framework='IFRS_FOR_SMES'` and binds **only SFP+SCI** composed figures — "nothing else bound on those two statements" (20261021100000:244-261). SCF/SOCIE faces are **not composed** (composition enum = SFP/SCI only, `composition.ts:34`); their rollforward tie lives in **disabled World B** | Build a complete report; change one **SCF or SOCIE** line figure in the saved document; attempt FINAL | FINAL refuses with a figure-accuracy blocker | **NONE — and the guard does not cover it.** The only executed figure tamper is an **SFP** figure (`fact:…:sfp.inventories` → `STATEMENT_FIGURE_MISMATCH`, `signoffBinding.mjs:96,128`). There is **no composed authority** for SCF/SOCIE to mismatch against; World-B reconciliation (`RECONCILIATION_UNMET`) is off | **SOURCE-ONLY → NEGATIVE:** FINAL does **not** refuse an altered SCF/SOCIE figure on accuracy grounds. **Auditor is correct.** |
| 3 | Attempt REVIEWED/FINAL for each **unsupported framework / provenance** → DB refuses? | `fs_publication_blockers` looks up `financial_statement_framework_requirements` by `framework.kind`; absent → `FRAMEWORK_UNKNOWN` (20260919110000:509-511). Rows seeded for **IFRS_FOR_SMES, IPSAS_ACCRUAL, IPSAS_CASH** (:258-260). Deep figure binding applies **only** to TB-derived + IFRS_FOR_SMES (20261021100000:244,314) | Save+attempt FINAL for (a) `framework=FULL_IFRS`; (b) `framework=IPSAS_ACCRUAL`/`IPSAS_CASH`; (c) `provenance_origin≠TRIAL_BALANCE_DERIVED` | Each refuses | **NONE executed.** Source result: **(a) FULL_IFRS → `FRAMEWORK_UNKNOWN` refuses** (no row). **(b) IPSAS_ACCRUAL/CASH → NOT `FRAMEWORK_UNKNOWN`** (rows exist) — gated only on generic required-statement/evidence/coarse-disclosure presence, **no composition/pack exists**, deep figure binding **skipped**. **(c) non-TB provenance → deep binding skipped** (:314) | **SOURCE-ONLY → MIXED:** FULL_IFRS refused; **IPSAS frameworks + non-TB provenance are NOT refused on framework grounds and bypass figure verification** — a release-critical hole. **Auditor is correct for IPSAS/provenance.** |
| 4 | **Missing applicable disclosures** → can FINAL still succeed? | FINAL disclosure gate iterates `v_req.disclosure_area_ids` — for IFRS_FOR_SMES only **3 coarse areas**: `{accounting-policies, basis-of-preparation, supporting-notes}` (20260919110000:258; loop 20261021100000:183-203). The 50 granular `fs_pack_requirements` (all `blocking=true`) are enforced only via `REQUIREMENT_UNDECIDED`/`REPORTING_CASE_UNSUPPORTED`/conditional `REQUIRED_DISCLOSURE_MISSING`, not a per-note completeness sweep in the publication gate | Mark a mandatory applicable note (e.g. related-party, `smes.note.*`) **absent** (not merely undecided) outside the 3 coarse areas; attempt FINAL | FINAL refuses | **PARTIAL.** Executed: an **undecided** 5.5(e/g/h) requirement blocks (`REQUIREMENT_UNDECIDED`, `reportingClosure.mjs:87-93`) and an **applicable** OCI case is `UNSUPPORTED`/blocked (:177-188). **NOT executed:** a missing applicable *granular note disclosure* outside the 3 coarse areas → FINAL refused | **SOURCE-ONLY → LIKELY-NEGATIVE:** a missing granular applicable disclosure outside the 3 coarse areas **may not block FINAL**. **Auditor's concern substantiated at source.** |

## Net reconciliation
- **Claim 2:** conceded — FINAL does not verify SCF/SOCIE figure accuracy (not composed; World-B tie disabled).
- **Claim 3:** conceded for **IPSAS_ACCRUAL/IPSAS_CASH** and **non-TB provenance** (not refused, figure binding skipped); FULL_IFRS is refused via `FRAMEWORK_UNKNOWN`.
- **Claim 4:** conceded at source — FINAL's disclosure completeness gate is 3 coarse areas plus specific decided/unsupported requirements, not a per-note sweep.
- **Claim 1:** mechanism present (evidence-supersede + dependency/trigger) but the exact post-REVIEWED SCF/SOCIE evidence-replacement case is **unexecuted**.
- **Therefore the reconciliation is NOT closed.** These are release blockers for any FS rollout and feed the ranked plan in doc 12 (owner: NORMAL). I do not self-approve; the independent audit session reviews this table.

## Corrections to earlier docs (proposed, pending independent review — not self-approved)
- `12` claim 4 ("no unsupported path to FINAL") is **withdrawn**: unsupported paths exist for SCF/SOCIE figures (2), IPSAS/non-TB provenance (3), and granular disclosures (4).
- `11`/`12` must not state FINAL verifies SCF/SOCIE figures or that all applicable disclosures block FINAL.
- What stands: FULL_IFRS → `FRAMEWORK_UNKNOWN`; SFP/SCI figure mismatch refuses REVIEWED (executed, `signoffBinding.mjs`); undecided/unsupported IFRS-SME requirements block (executed, `reportingClosure.mjs`). These are the only EXECUTED positives among the four asked cases, and none of them *is* the asked case.
