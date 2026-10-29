# IPSAS accrual — first accounting chain, implementation record

Stacked on draft PR #216 (`feat/ipsas-accrual-ngo`, head `29a4e39`, base main `db6cef7`; CI run 40813292787 green, manual staging job skipped).
Branch `feat/ipsas-accrual-first-chain`. Nothing here is merged, installed, deployed, published or activated. No paid service was used.
Status vocabulary (charter §2): **authored/tested here**; not merged; not installed; not deployed; not accountant-accepted.

## 1. Starting point (verified 2026-10-29)

| Item | Result |
|---|---|
| main | `db6cef701b0856b98cd485d30431ac7b1137f2e4` (unchanged since #216 was opened) |
| #216 | open draft, head `29a4e396b5417356b35a7733b33e754fa233e98d`, all required jobs passed |
| Concurrent open work touching shared files | #215 (`ci.yml`, `CLAUDE.md`, `databaseInert.test.ts`, SME report proofs), #212 (`AGENTS.md`, `CLAUDE.md`). This branch edits `ci.yml` and `databaseInert.test.ts` minimally; a rebase conflict there is expected and mechanical. `CLAUDE.md` and `AGENTS.md` are untouched. |
| Local tree | unrelated uncommitted work in the primary checkout was not touched; work is in a separate worktree |

## 2. Corrections applied to the design (brief §3)

1. Invariants map to existing charter IDs below; no competing rule is defined. No amendment is proposed by this PR beyond what #216's A-01 already proposes.
2. Materiality is **not** implemented and no threshold is assumed. Every difference is exact; there is no tolerance in the bridge or the PPE ties. A versioned engagement materiality assessment is an open item (§7).
3. Applicability and implementation are separate. In the PPE slice every entity question needs an explicit answer; "applies" on a question with no native module is a **blocker** (`SPECIALISED_ROUTE_REQUIRED`), never "not applicable".
4. Resume uses persisted state only (`ipsas_prep_context`); no browser history or storage is progress truth.
5. No latency target was normalised; none was measured in this slice (§7).
6. Standards are cited at standard level only (IPSAS 45, 21, 26, 44; IPSAS 3 for estimates). **No paragraph numbers are asserted** because the accounting content owner is unassigned and the paragraph text was not verified here. No standard text is reproduced; no AI/RAG ingestion.
7. Personal data: the chain handles organisation-level balances only. No beneficiary/employee data is accepted or stored.
8. No enquiry was sent to any regulator or body.
9. Standards content is period-resolved by #216's profile; this slice does not extend it.
10. File/line evidence below.

## 3. Facts table (charter §2.1) — reuse audit

`present in source` is not `deployed`. All paths are on this branch.

| Capability | Status | Source |
|---|---|---|
| `companies.reporting_framework` admits `ipsas_accrual`; audited change RPC | merged-not-deployed* | `supabase/migrations/20260701000001_companies_reporting_framework.sql:21`, `20261127100000`/`20261128100000` |
| Certified per-account balances (`tb_certifications.rows_snapshot`) and reader | merged | `20260902130000_safisha_certification_foundation.sql:55`, `20261014100000_close_review_findings.sql:116` |
| Neutral depreciation / roll-forward / disposal arithmetic (TS and SQL twin) | merged | `src/lib/preparation/depreciation.ts:86`, `equipmentSchedule.ts:119,192`, `20261206100000…sql:75` |
| Original-document retention (private bucket, hash, malware gate) | merged | `supabase/functions/financial-statement-intake/handleIntake.ts:96`, `20260915100000` |
| Local PDF read + OCR as proposals | merged | `src/lib/preparation/priorReport.ts:34` |
| Request-identity replay, compare-and-set, advisory lock pattern | merged | `20261206100000…sql:450–488` |
| Capability resolver | merged | `20260925140000_workspace_capability_authorization.sql:546` |
| SME composition/compiler/notes/equipment gates | **SME-only** | `composition.ts:39`, `composedReport.ts:83,125,136`, `serverCompilation.ts:49,56`, `20261206100000…sql:545`, `workpaperClient.ts:11,20,93` |
| IPSAS composition, notes, compiler, issuance | **not built** | `docs/release/ipsas-accrual-r1/RECORD.md` Step 0 |

\* Hosted state of every migration after the last journal entry is **unknown from this repository**; `drizzle/migrations/meta/_journal.json` ends at 0090.

Where a number enters the chain (charter §2.2): trial-balance balances (certified rows, server-read); prior-report figures (preparer-entered, page-referenced, partner-confirmed against an exact hash); class balances, movements and item estimates (preparer-entered, server-recalculated and tied); estimates (entity's own, confirmed, never supplied). Source-file extraction (OCR/PDF → figures) is **not** wired into this chain yet — see gap G3.

## 4. What this PR delivers

**One chain, one slice, working end to end at the data layer, with an honest boundary:**
current/prior information → opening bridge → evidence-tied PPE workpaper → generated policy and note → incomplete report preview with exact remaining tasks.

| Layer | Delivered | Where |
|---|---|---|
| Domain (pure, exact integers) | opening bridge (no plug), cost-model PPE workpaper, generated policy/note with typed fact bindings, task contract, incomplete preview | `src/lib/ipsasAccrual/` — 31 tests with hand-derived expectations |
| Server authority | append-only revisions + confirmations; live assessment recomputed from persisted inputs; TB facts from certified rows; CAS save with request replay; subject-hash confirmation | `supabase/migrations/20261207100000_ipsas_accrual_preparation.sql` |
| Real-database proof | 29 cases on the full chain, TS ≡ SQL equivalence on 14 mutated workpapers and 6 bridge inputs, hand-derived fixture, concurrency, revocation, SME byte-identity | `scripts/db-proof/ipsasPreparation.mjs` + manifest |
| Browser client + page | typed client (unknown outcome ≠ refusal ≠ success), five-area page, entry link on Prepare, 6 jsdom tests | `src/lib/ipsasAccrual/ipsasClient.ts`, `src/components/ipsas/`, `src/pages/workspace/IpsasPreparationPage.tsx` |

### Why equipment, not grants (brief §5)
Repository evidence: equipment already has proven neutral arithmetic in both TS and SQL, a recorded tie to certified balances, and a prior-figure/bridge shape; grants have only the inert candidate's bounded fixed-grant calculator and no server counterpart. Equipment is the smaller independently useful first chain. Grants remain the first remaining blocker for a typical NGO (§7).

### IPSAS suitability of the reused arithmetic
Reused unchanged: straight-line / reducing-balance / units-of-production charges from the entity's own recorded estimates, daily or whole-period convention, derecognition and available-for-use dates, class roll-forward, disposal gain/loss. Not reused: the IFRS-for-SMEs question set, OCI revaluation movement, `sci.*` destinations, section citations, and any tax-rate table (`computeWearTear` is Tanzanian tax, not accounting depreciation, and is untouched). **Supported: the cost model on ordinary assets only.** Revaluation, heritage and infrastructure assets, impairment indicators, held-for-sale items, combinations and investment-property transfers are explicit blockers. An illustrative life/rate is never supplied; "unconfirmed" is the default until a reviewer records a confirmation.

## 5. Charter / spec → implementation → test matrix

| Requirement | Implementation | Test |
|---|---|---|
| P1/R1 provenance | every figure resolves to a certified TB row, a page-referenced prior figure, a register/ledger source on a movement, or an item estimate | `tb.facts-from-certified-rows`, domain tests |
| P2/R2 deterministic | exact bigint / `numeric`; SQL twin of the TS rules | `calc.sql-equals-hand-derived-fixture`, `calc.sql-equals-typescript-rules` |
| P3 proposals vs confirmation | estimate confirmation bound to the exact subject hash; prior-figure set likewise | `confirm.*`, `bridge.unconfirmed-then-agrees` |
| P6 server enforces | authz, assessment and confirmation are server-side; client forged fields ignored | `authz.*`, `save.forged-authority-fields-ignored` |
| R4/G3 opening bridge, no plug | `_ipsas_bridge_assess`, `computeOpeningBridge` | `bridge.residual-never-plugged`, `bridge.evidenced-item-bridges-exactly` |
| R5/G4 schedules tie | roll-forward identities, item register = class, TB ties | domain tests; `calc.*`; `tb.unknown-is-not-zero` |
| R7 structured disclosure | policy/note from confirmed facts only | `policyNote` tests |
| 11.3 retries/concurrency | request identity + CAS + advisory locks (request lock before period lock) | `save.twenty-way-same-request`, `save.twenty-writers-one-revision`, `save.changed-intent-same-request` |
| 11.4 access | capability + framework gate; revoked access refuses replay | `authz.*`, `access.revoked-preparer-refused-incl-replay` |
| P7/R13 history | append-only tables; SME rows byte-identical | `history.append-only`, `preserve.sme-authority-byte-identical` |
| R12 issuance vs export | **no** issuance path is touched; `officialIssuance.available` is always `false` with the reasons as data | preview tests |

**Deviation dispositions:** none from the charter. Confirmation requires `review_close`; whether a solo owner may confirm their own estimates is governed by the existing capability model (an owner holds all capabilities), and **no new review policy is introduced** (decision D3 below).

## 6. Lock order and atomicity
Request lock `ipsas_request:<uid>:<request>` → period lock `ipsas:<company>:<year>`; this follows the order documented in `20261206100000` (request locks before the period lock). Each RPC writes exactly one row (plus nothing else) in one transaction. Object storage is not touched in this slice (original-document retention continues to use the existing intake function; the chain only references a retained document id and validates company/status).

## 7. Gaps, in dependency order (no overstatement)

- **G1 Browser proof.** The page exists (`/workspace/:companyId/:periodYear/ipsas`, entry link on Prepare for `ipsas_accrual` companies) with 6 jsdom tests (refusal wording, lost-response retry with the original request identity, stale keeps edits, no zero coercion, axe). It has **not** been driven in a real browser against a local Supabase stack (none exists on this machine and the CI real-app job does not cover it). The page is also unreachable on the hosted site until the migration is installed and a company's framework is set to `ipsas_accrual`. Keyboard/narrow-screen and timed no-coaching runs are not done.
- **G9 Installation transport (authored and proven; NOT installed).** Delivered on `feat/ipsas-accrual-transport`: `scripts/release/ipsasStagedTransport.mjs`, `release/staged-transport-ipsas/`, a 21-case disposable-database proof and a guard test; see `TRANSPORT.md` for identities, the required journal head (the equipment-r1 transport's last entry, hosted id 91) and the ordered owner installation. No Drizzle mirror, journal entry or release-journal registration exists, deliberately: those follow canonical hosted execution.
- **G2 Remaining statements and notes** (cash flows, net assets by component, revenue/grants, receivables, payables, leases, employee benefits, related parties, going concern, events after the period, authorisation). Official issuance blocker list is data: `OFFICIAL_ISSUANCE_BLOCKERS`.
- **G3 Prior-report extraction.** Existing local PDF/OCR proposals and the retained-original function exist; wiring them into the prior-figures capture (page-linked proposal → confirmed figure) is not done. Figures are entered by the preparer and confirmed by a partner; the original document id is validated if supplied.
- **G4 Comparative transitions.** Not implemented. Continuing application, first-time adoption and early adoption remain unresolved, not approved by a dropdown.
- **G5 Grants / revenue by period / transfer expenses.** The inert candidate has a bounded fixed-grant calculator only; no server contract. First remaining blocker for an NGO.
- **G6 IPSAS composition, compiler, approval and frozen issuance.** Every gate in §3 is SME-only. Extending them changes the compiler's transitive closure, which forces a new compiler digest + migration + release plan (`buildStatementCompiler.mjs --check`); it is deliberately **not** done as a side effect here.
- **G7 Requirement register.** Paragraph-level register with an accounting author/reviewer: unassigned.
- **G8 Materiality assessment, units/currency confirmation of prior figures** (the payload carries currency/scale; the server validates shape only), **manual-edit preservation / regeneration diffs for notes**, **performance measurement**, **browser journey on a local Supabase stack**, **hosted verification**: not done.

## 8. Decisions needed from a person (progress continues on independent work)

| ID | Decision | Consequence of waiting |
|---|---|---|
| D1 | Appoint the IPSAS accounting content owner and independent reviewer | Requirement register and any "supported" claim stay blocked; arithmetic and engineering proceed |
| D2 | Authorise a real NGO case, with source files and data-handling approval | Real-world acceptance (A4) and G3 evidence cannot be claimed; synthetic cases continue |
| D3 | Who may confirm management's estimates, and whether a solo owner may self-confirm | Current behaviour: any holder of `review_close`; both actors are recorded. A stricter separation needs a reviewed policy (not inferred from plan or title) |
| D4 | Approve release of this migration (transport, installation, publication) | Remains authored/tested only |

## 9. Hostile-test coverage in this slice
Implemented at the authority boundary (real PostgreSQL): cross-company IDs and payloads; forged confirmation/total/TB/ready fields; revoked membership before write and before replay; twenty-way same request; twenty writers on one revision; changed intent under one request id; units/sign; missing vs verified zero; opening residual with and without evidenced bridge items; register ≡ TB ties; leap/short periods and mid-year disposals (domain, hand-derived); direct table/RPC privilege matrix; append-only history; SME byte-identity. Not applicable to this slice or not yet built: storage interruption, source replacement vs review/issuance, crash around issuance, OCR weakness, manual-note regeneration, AI-absent paths (the chain never calls AI).

## 10. Verification record
Filled in by the PR description with exact-SHA results; this file states no result it cannot support.
