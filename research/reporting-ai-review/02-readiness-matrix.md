# 02 — Evidence-to-Output Readiness Matrix

Per statement: minimum evidence, calculation authority, control/sign-off gate, permitted output
status, and what is precisely missing. The professional generation engine ("World B",
`src/lib/canonicalStatement` + `financialStatementsWorkspace` + `financialGeneration`) is
**DISABLED** in product (`FINANCIAL_STATEMENTS_WORKSPACE_ENABLED=false`, `workspaceGate.ts:21`;
`persistenceGate.ts:16=false`; migrations `20260919100000/110000` unapplied). The live path is
HESABU validation + certification + the thinner `ExportStatements` renderer (see `04`).

**Permitted output status legend:** READY (within scope) · DRAFT (stated limitations) ·
NEEDS-CONFIRMATION · MISSING-EVIDENCE · BLOCKED-BY-CONTROL · WITHHELD.

## 2.1 Frameworks are modelled SEPARATELY (no unsafe inference — VERIFIED)
`src/lib/financialStatementsWorkspace/frameworkProfiles.ts` (v`1.1.0`) has four distinct,
standards-referenced profiles; selection is the manual `companies.reporting_framework` column
**with no default** (`20260903100000_companies_reporting_framework_no_default.sql`).
`resolveCanonicalFramework()` throws `UnresolvedFrameworkError` on null/unknown (`adapterContract.ts:96-101`).

| Framework | Profile | UI-selectable | Status |
|---|---|---|---|
| IFRS (full) | `FULL_IFRS` `:74-102` | No ("coming soon") | IMPLEMENTED—UNVERIFIED, unreachable |
| IFRS for SMEs | `IFRS_FOR_SMES` `:104-131` | Yes | IMPLEMENTED—UNVERIFIED (gen gated) |
| IPSAS accrual | `IPSAS_ACCRUAL` `:133-166` | Yes | IMPLEMENTED—UNVERIFIED |
| IPSAS cash | `IPSAS_CASH` `:168-205` (TB `UNSUPPORTED` by design) | No ("coming soon") | IMPLEMENTED—UNVERIFIED |

**Framework is never inferred** from ERP name, country, account prefix, or AI confidence
(VERIFIED): `detectEntityContext.ts` writes nothing and never guesses; the one name-based
heuristic (`publicSectorClassification.ts`) classifies *line items* **only within an already-chosen**
IPSAS/GFRS framework (gate `:113`), never selects the framework. **IFRS 18: absent everywhere**
(grep zero hits) — full-IFRS is still modelled on the pre-IFRS-18 IAS 1 P&L+OCI split; correctly,
no IFRS 18 logic has leaked into IPSAS/SME.

## 2.2 Readiness per statement

| Statement | Minimum evidence | Calculation authority | Control gate | Permitted status today | Precisely missing |
|---|---|---|---|---|---|
| **TB review report** | Uploaded TB; all accounts classified; arithmetic balance | 6-layer certification `computeCertificationReadiness.ts:116-165`; debits=credits hard block (`process-trial-balance:1680-1726`, tol 1 TZS) | `get_authoritative_certification` must be non-blocking + not requires_review + source-hash current (`20260902130000:395-402`); revalidation guard downgrades stale "certified" | **READY** (within TB scope) | Unresolved accounts → `review`; fetch failure → `unknown` (never silently passed) |
| **Financial position (SFP)** | Reviewed TB with mapped BS accounts | Canonical Rule 1 `sfp-equation` A=L+E; HESABU **H-01** | HESABU gate feeds legacy sign-off (role gate **absent**, C-1) | **DRAFT** (live `ExportStatements`, float-summed, no comparatives) / READY only if World B enabled | Comparatives; decimal-exact recomputed totals; drill-down |
| **Performance (P&L)** | Reviewed TB with mapped income/expense; complete income+expense for net result | HESABU **H-04/H-05**; canonical net-result concept | HESABU gate | **DRAFT** | OCI `UNDETERMINED` (mappings carry no OCI class, `frameworkProfiles.ts:72`); comparatives |
| **Changes in equity (SOCIE)** | Opening equity by component tied to prior close; each movement; prior-period adjustments (`statementComposition.ts:59-63`) | World-B `equityStatement.ts`; `equityClosingTie`/`equityProfitTie`; HESABU **H-09/10/11** | World-B blockers; HESABU | **MISSING-EVIDENCE** (live renderer exists but is fed `taxResult=null`, see `04`) | Supplied equity-movement evidence beyond the TB |
| **Cash flows** | Period-complete classified cash-movement ledger; opening+closing cash tied to SFP; reviewed cash perimeter (`statementComposition.ts:53-57`) | World-B `cashFlowDirect.ts` + `cashflow-account-rollforward` + `cashPerimeterReconciliation`; HESABU **H-06/07/08** | World-B authority blockers; server refuses Reviewed/Final while authority missing (`RELEASE_PACKAGE.md:92`) | **MISSING-EVIDENCE / BLOCKED** | `DEFECT-SAFISHA-TRANSACTION-LEDGER-GAP-001`: ledger is preparer-supplied, not bank-independent → **no genuine dual-engine CF**; Slice-1 `cashFlowEngines.ts` is dormant |
| **PPE / depreciation movement** | Opening + additions − disposals ± other = closing, with declared schedule children | Canonical Rule 7 `movement-reconciliation` + `scheduleCasting`; `notesAndSchedules.ts` | World-B schedule rules | **MISSING-EVIDENCE** (gated) | Movement schedule evidence; two-TB net movements cannot split cash/credit/transfer/disposal (needs GL / asset register) |
| **Other material notes / policies** | Preparer-supplied notes/policy evidence; framework disclosure areas | Note-to-face + orphaned-reference rules; disclosure checklist in stored report | World-B `DISCLOSURE_CHECKLIST` blocker | **DRAFT** (live = 5 boilerplate notes, `ExportStatements:579-646`) | Document extraction (gated); evidence-bound notes (gated) |
| **Budget vs actual (IPSAS)** | Approved original + final budget by line, same classification basis; variance explanations (`statementComposition.ts:65-68`) | World-B `budgetActual.ts` (conditional, IPSAS only) | World-B budget-completeness blockers (`fs_publication_blockers:589-599`) | **MISSING-EVIDENCE** (gated) | Budget evidence; cross-currency/scale budgets excluded with reason (never converted) |

## 2.3 How the gate ordering protects truthfulness (VERIFIED)
`nextAction.ts:33-46`: comparative-missing → framework/currency/basis unset → accounts
unmapped/ambiguous → no report → open blocking/insufficient findings → composition blockers →
outputs. Exactly one dominant action; **"outputs" only when nothing blocks**. `exports.outputStatus`
forces DRAFT unless the server has recorded state with zero blockers (`exports.ts:83-87`); the
client can never stamp REVIEWED/FINAL (`fs_commit_revision` writes DRAFT only and recomputes its
own hash, `20260919110000:716-834,758-759`). HESABU gate model is **count-of-failures**
(`hesabu-validate:607,663`): any `fail` (critical or warn) blocks; `skip` (first-year/missing
input) does not; hard pre-conditions 422-BLOCK on missing materiality / `computation_detail` /
`period_closing_balances` (`:188-256`).

**Net:** the system is built to **refuse** rather than fabricate — null ≠ zero, no silent
defaults, evidence gaps surface as first-class states. The limiting factor for most statements is
not calculation but **missing evidence the TB alone cannot supply** (SOCIE movements, an
independent cash ledger, budgets, asset registers) **and the fact that the engine able to honour
all this is switched off**.
