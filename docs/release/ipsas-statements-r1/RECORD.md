# IPSAS statement draft: implementation and review record

Date: 2026-10-29. Branch: `feat/ipsas-statement-composition`. Dependency: #216 at `29a4e396b5417356b35a7733b33e754fa233e98d`, not the #224 integration rehearsal. See WORK_PLAN.md for charter requirements, facts and ownership. Charter adoption and accounting appointments remain unrecorded.

## Delivered

- Reuses the existing preparation calculator for financial position, performance, aggregate net assets movements and direct cash flows. Adds the applicable budget statement to one joined, explicitly incomplete report view.
- Separate original/effective comparative columns; balanced, evidence-bound non-cash comparative journals. Result-changing corrections require a matching opening bridge and consume it once. No plug, no posted journal, no cash-flow restatement inference.
- Structured note tables with evidence references, stable semantic ties, note numbering and exact current/comparative reconciliation. One-minor-unit differences and missing figures remain visible tasks.
- Distinct input, accounting-result and provenance hashes. Monetary note values, comparative period, budget basis/period, budget figures and adjustment effects are bound. Narrative-only changes affect provenance. Source snapshots and results are owned and frozen.
- Offline HTML review: internal navigation, note return links, source references, budget reconciliation, comparative audit trail, incomplete watermark and retained release blockers. No scripts, external resources, forms or issuance action. CLI refuses overwriting an existing file.
- A synthetic two-period fixture with a public budget and equipment note, plus hostile cases for company/period mismatches, conflicting evidence identities, duplicate IDs, unbalanced and mislabelled journals, missing bridges, unknown amounts, note discrepancies, unsafe HTML, precision and invariance.

## Validation

Commands use the repository's Bun/Vitest toolchain and loopback-only synthetic unit environment. No paid service or client data is involved.

| Check | Result |
|---|---|
| Candidate calculations and HTML document tests | 45 passed: 42 calculation/contract cases and 3 DOM/accessibility cases |
| Focused candidate/kernel/SME regressions | 174 passed across six files |
| Full suite | 6,791 passed; 10 skipped; 12 TODO; 405 files passed and one skipped. These are local results, not final-SHA GitHub CI |
| Candidate TypeScript; application TypeScript | Passed locally |
| ESLint on all new TypeScript/test files | Passed locally |
| Production Vite build | Passed locally, 22.62 s; existing large-chunk warning retained |
| Pack isolation, single lockfile, migration authority | Passed locally on inherited #216 repository history; this is not a hosted verification |
| Synthetic offline CLI | Produced five statements and ten agreeing displayed reconciliations; refuses existing output path |
| Real browser / hosted / accountant / timed no-coaching | Not performed |
| Final commit GitHub CI | Check PR for actual state; no success is asserted here |

The DOM tests parse the generated document and verify real fragment targets, duplicate IDs, structural WCAG A/AA checks and inactive content. They are not Chrome layout, PDF pagination or signed-in acceptance tests. Synthetic source and confirmation identities do not prove real sign-in, content validity or rights.

Fixture pin: `synthetic-statement-input.json`, SHA-256 `e29cf47c289b5ec95596b68bda98710185526a6f22ce0f18a91285792da6ef49`. Its original source artifacts remain pinned and tested by #216's fixture tests.

## Preserved boundaries

Only new candidate, test and release-document files are added. No edit to Claude's PPE/grants modules, SQL, transports or source-download work. No change to production compiler inputs, old SME canonical identities, runtime framework selection, public claims, permissions, payments, AI, reporting settings or issued history. No hosted reads/writes, migration, deploy, publish, activation or Lovable contact. No paid API/model calls.

## Unfinished platform work — not disguised as acceptance

1. Authenticated server retrieval of source/confirmation revisions and authoritative recalculation; database persistence and stale-dependency handling.
2. Full, period-specific accounting content and applicability universe reviewed by a qualified accounting author and independent reviewer; jurisdiction/eligibility and commercial content rights.
3. Net assets by component, comparative cash-flow corrections, new-account comparative journals and complete standard-specific transitions/first-time adoption. The candidate retains the inherited refusals/blockers.
4. Complete applicable notes and accounting workpapers, authorisation/going concern, supported entity/treatment breadth. A sample equipment note is not all IPSAS notes.
5. Normal signed-in statement UI, permission/review policy integration, approval and immutable frozen issuance; deployment and authenticated real-client verification.
6. Real accountant and no-coaching acceptance, including materially different entities. No compliance assertion or universal NGO/government support is authorized.

## Integration instructions for Claude

Continue the current remediation without changing this branch. Review the new contract and candidate only after providing the remediation's final SHA. This branch depends on #216; accept that foundation first, then reconcile this branch with the accepted fixes. Do not import this candidate into production, set a browser gate to true, or carry the local preview's asserted confirmations into an authoritative report. The next integration needs a server-owned source adapter and recalculation, not a client-side Save wrapper.
