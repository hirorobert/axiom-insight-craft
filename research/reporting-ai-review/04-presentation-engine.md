# 04 — Presentation Engine: Capabilities & Gaps

## 4.1 There are TWO engines, on opposite sides of a feature gate

**Engine A — LIVE.** `src/components/ExportStatements.tsx` (~1092 lines), rendered unconditionally
inside `StatementsWorkspace.tsx:106-116`. PDF (jsPDF + autotable) + XLSX (`xlsx`). Totals summed
in-component from JS `number` balances (`:404-405` `reduce`). **No comparatives.** Framework
presentation from `frameworkPresentationRegistry.ts` (only `IFRS_FOR_SMES` + `IPSAS_ACCRUAL`).
SOCIE/Cash-flow render **only** if a `taxResult` with `socie_engine`/`scf_engine` is passed — the
live caller passes `taxResult={null}` (`StatementsWorkspace.tsx:115`), so production emits only
**SFP + P&L + 5 hardcoded boilerplate notes + a TB appendix**. Output embeds `new Date()`
(`:398,955`) ⇒ **non-deterministic**.

**Engine B — DISABLED.** `src/lib/canonicalStatement/**`, `financialStatementsWorkspace/**`,
`financialGeneration/**`, `components/financialStatements/**`. Deterministic, versioned,
framework-selected, provenance-bearing. Hard-gated off: `FINANCIAL_STATEMENTS_WORKSPACE_ENABLED =
false` (`workspaceGate.ts:21`); component returns `null` unless `import.meta.env.DEV`
(`FinancialStatementsWorkspace.tsx:59`); not bundled in production (`StatementsWorkspace.tsx:23-25`).

**Nearly every professional capability is IMPLEMENTED in Engine B and DISABLED; Engine A is what ships.**

## 4.2 Capability matrix

| Capability | Status | Evidence |
|---|---|---|
| Framework-SELECTED templates, no inference | **VERIFIED (B) / DISABLED** | 4 profiles `frameworkProfiles.ts:74-205`; `resolveCanonicalFramework` throws on unknown `adapterContract.ts:96-101` |
| Framework default red-flag (LIVE paths) | **present (bad)** | `generate-xbrl:118` silent `?? "ifrs_for_smes"`; Engine A registry supports only 2 frameworks | 
| SFP / P&L | **VERIFIED (A live) + (B)** | A `:472-570`; B `trialBalanceAdapter.ts:504-520` |
| SOCIE | **IMPLEMENTED, dark in live** | A renders only if `taxResult.socie_engine` (null live) `:648-753`; B `equityStatement.ts` |
| Cash flows | **DISABLED / dark** | TB adapter refuses SCF by design `trialBalanceAdapter.ts:10-17,469-476`; B `cashFlowDirect.ts` gated; A SCF unfed |
| PPE / movement note | **IMPLEMENTED—UNVERIFIED (B)** | generic `MovementSchedule` `notesAndSchedules.ts:111-130` + `movementReconciliation`/`scheduleCasting` |
| Other notes | **B evidence-bound (gated); A = 5 boilerplate strings** | `notesAndSchedules.ts:145-174`; `ExportStatements:579-646` |
| Budget vs actual | **IMPLEMENTED—UNVERIFIED (B)** | `budgetActual.ts`; IPSAS-conditional |
| Comparatives | **VERIFIED (B) / ABSENT (A)** | B `StatementRenderer.tsx:30-83` + `comparativePeriodAlignment`/`missingComparativeDetection`; A single-column |
| Exact arithmetic, totals recomputed, display rounding | **VERIFIED (B) / WEAK (A)** | B bigint minor-units `money.ts`, `sumMoney`/`subtractMoney`, `subtotalCastingRule`; A floats `reduce` |
| PDF | **A jsPDF (live); B browser-print w/ DRAFT watermark** | `ExportStatements:391-940`; `OutputsStage.tsx:42-62` |
| XLSX | **A only (account dump, not a formatted statement)** | `ExportStatements:942-1067`; B `exports.ts:10-11` none |
| DOCX (Word) | **ABSENT (both)** | `exports.ts:169 DOCX_EXPORT={available:false}` |
| Notes numbering / cross-ref / pagination / TOC | **IMPLEMENTED—UNVERIFIED (B)** | `noteNumbering.ts`, `noteToFaceReconciliation`, `orphanedNoteReferenceDetection`, print TOC `OutputsStage:170-196` |
| Line-to-evidence drill-down | **IMPLEMENTED—UNVERIFIED (B) / ABSENT (A)** | provenance locators `types.ts:117-125`; `EvidenceSources` panel; A has only a flat TB appendix |
| Governed presentation overrides / evidence-backed allocations | **UNKNOWN / effectively ABSENT** | no render-time override module; current/non-current inherited from upstream `account_mappings` classification, not a presentation allocation |
| Exact reproduction of an approved report (snapshot/determinism) | **VERIFIED (B) / ABSENT (A)** | deterministic id+content-hash `evaluationOrchestrator.ts:66-72`; restore accepts only on byte-for-byte hash else `DIVERGED` `savedVersions.ts:79-126`; A embeds `new Date()` |
| IFRS 18 | **ABSENT (nowhere)** | grep zero; full-IFRS still IAS 1 P&L+OCI |
| XBRL/iXBRL as versioned OUTPUT layer | **IMPLEMENTED—UNVERIFIED, UNROUTED** | `generate-xbrl` (Arelle worker, taxonomy `2023-01-01`) but no UI invoke, sourced from KINGA tables not the canonical model, IPSAS blocked, silent framework default |

## 4.3 Concrete missing pieces for professional output
1. **The good engine is switched off.** Everything deterministic/framework-selected/comparative/
   provenance/snapshot lives in Engine B behind the gate; what ships (Engine A) sums floats, has
   no comparatives, no drill-down, non-deterministic output, and in live wiring emits only
   SFP + P&L + boilerplate + TB listing (SOCIE/SCF dark because `taxResult=null`).
2. **No DOCX; XLSX is an account dump, not a formatted statement.**
3. **XBRL is a disconnected parallel pipeline**, not an output layer over the canonical model;
   UI-unreachable; IPSAS blocked; carries a silent framework default (C-3). Taxonomy versioning
   itself is correctly externalised (`2023-01-01`).
4. **No IFRS 18** (categories/subtotals/MPM); full-IFRS modelled on superseded IAS 1. *Verify
   effective dates / jurisdictional applicability from current primary sources before building —
   IFRS 18 is full-IFRS only and must not touch IPSAS/IFRS-for-SMEs.*
5. **No governed presentation-override / evidence-backed reclassification layer** distinct from
   upstream account classification.
6. **Cash flow from a TB is deliberately impossible** (honest refusal) and the evidence-ledger
   alternative is gated — root cause `DEFECT-SAFISHA-TRANSACTION-LEDGER-GAP-001`.
7. Minor even within B: detail-line ordering is **alphabetical** (`trialBalanceAdapter.ts:257`),
   not presentational; thousands/millions display scaling is defined but pinned to `1n`
   (`evaluationOrchestrator.ts:105`).

**Where deterministic rendering must replace repeated free-form generation:** all **numbers,
totals, tables, notes numbering, cross-references and the statement structure** — Engine B already
does this and must be the renderer. **Where AI-drafted narrative remains useful:** prose only
(management-letter / disclosure commentary / MAONO narratives), always over validated figures and
never as the figure itself.
