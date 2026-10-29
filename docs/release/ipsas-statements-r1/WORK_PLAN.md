# IPSAS statement composition: implementation boundary

Baseline: foundation #216, `29a4e396b5417356b35a7733b33e754fa233e98d`. The work was initially inspected against combined candidate #224 at `a992cadc84c94fa195b5b6b316daa5be19fa911e`, then isolated onto #216 because it needs none of Claude's PPE/grants changes. PR base: `feat/ipsas-accrual-ngo`. This avoids inheriting the integration rehearsal's entire stack.
Owner authorized parallel statement development in this conversation on 2026-10-29. No authorization to merge, spend, deploy, install, publish or activate. Charter v4 remains proposed, with adoption and accounting appointments unrecorded. This work does not amend that status.

## Applicable requirements

- P1/P2, R1/R2 and section 11.1: exact minor units, source lineage, separate accounting/provenance hashes.
- P6, R10/R12 and section 11.3: no browser or supplied JSON authorizes approval/issuance. This is an inert composition candidate; official issuance remains unavailable.
- R4/R6/R8, G3/G5/G7: preserve published comparatives, explicitly bridge changes, inherit period/eligibility resolution, refuse currency/scale mismatch.
- R7, G6, section 11.5: structured notes with figure reconciliation and actionable unresolved tasks. No assertion that the requirement universe is complete.
- R13: immutable owned snapshots; changes produce a different input fingerprint.
- B6: incremental presentation and budget comparison; accounting acceptance and frozen issuance are not delivered by arithmetic.

## Facts before implementation

| Capability | Status | Evidence |
|---|---|---|
| Four IPSAS statements, direct cash flow, budget calculations | candidate | `release/candidates/ipsas-accrual-r1/preparation.ts`, `ngoCalculations.ts`, `adapter.ts` |
| Canonical proof kernel | candidate | `release/candidates/framework-kernel-r1/kernel.ts` |
| PPE/grants authenticated preparation | branch, not hosted-verified here | #224; `src/components/ipsas/`, migrations `20261207100000` and `20261208100000` |
| Existing SME database composition | merged; deployment not reverified | `src/lib/statements/composition.ts` |
| Complete IPSAS notes/comparatives/issuance | not built | candidate README work list; `src/lib/ipsasAccrual/preview.ts` official blockers |
| Qualified accounting and no-coaching acceptance | not performed | #224 handoff |

## Owned scope and concrete exit

Only new `release/candidates/ipsas-statements-r1/`, its tests and release record are owned here. Claude retains existing PPE/grants/server/transport remediation. No existing source or deployed compiler is modified.

Reuse `prepareNgo` rather than create a second ledger calculator. Compose four primary statements and the applicable budget statement into a joined, traceable draft. Add a bounded non-cash comparative journal bridge, immutable as-reported versus restated columns, structured note reconciliation, completion tasks, deterministic offline HTML review and hostile tests. Preserve all upstream limitations. Runtime authentication, database persistence, complete accounting workpapers, transition adoption relief and issued-report sealing remain integration work.

Source facts enter through the existing validated preparation boundary; additional values enter through strict comparative-journal and note schemas. Every such figure requires scoped evidence. Confirmation identities in JSON remain assertions, never authenticated records.

## Dependencies / stop boundaries

No modifications to Claude's files or source transports. Do not register this adapter in production or import it from `src` except tests. Do not change SME canonical identities or fixtures. First-time adoption, groups, comparative cash-flow restatements and unsupported standard transitions retain named refusals. This scope does not claim that all statements/notes meet all IPSAS requirements.
