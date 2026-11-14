# IPSAS joined statement draft

An inert extension of #216's existing preparation calculator. **Not the hosted statement engine, a complete IPSAS implementation, authenticated evidence, or approval/issuance.** No production source imports this directory.

## Run

After the repository's normal frozen-lockfile installation:

```sh
bun run test -- src/lib/frameworkPacks/ipsasStatementSetCandidate.test.ts src/lib/frameworkPacks/ipsasStatementReview.test.ts
bunx tsc --noEmit -p release/candidates/ipsas-statements-r1/tsconfig.json
bun run release/candidates/ipsas-statements-r1/demo.ts docs/release/ipsas-statements-r1/synthetic-statement-input.json /tmp/ipsas-statements.html
```

The CLI creates a new local HTML file and refuses to overwrite one. Open it locally to inspect the four primary statements, applicable current-period budget comparison, original/adjusted comparatives, notes, figure references, adjustment trail, reconciliation results and remaining tasks. It loads no scripts or external assets. Printing retains the incomplete label. Use only authorized source records; the review artifact contains financial information and evidence identifiers.

## Contract

`composeIpsasStatements(unknown)` validates and owns the entire JSON snapshot, then reuses `prepareNgo`. Money is exact signed minor-unit strings; output formatting never converts monetary values to JavaScript floating-point numbers. The input/provenance and normalized accounting-result fingerprints are separate. Narrative-only changes change provenance, not the accounting-result hash. Note figures, budget figures and comparative effects are included in the accounting-result hash.

Comparative journals are separately evidenced, balanced debit/credit deltas over existing accounts. Original amounts remain intact. Result-changing corrections require an exact named opening bridge and consume that bridge once. Pure presentation reclassifications cannot change total net assets. The output retains the journal evidence and original/effective comparative. These entries are **proposed local preparation inputs**, not posted or approved journals.

Unsupported: new comparative accounts, comparative cash-flow restatements, first-time adoption, groups, periods outside the inherited reviewed routing window, functional-to-presentation currency translation, automated standard-specific transition relief. No commercial or legal framework eligibility is inferred from NGO, government or other entity names. The same single-entity contracts apply after the inherited eligibility assessment.

Structured notes contain bounded narrative, evidence-linked figures and explicit row-to-caption reconciliations. Unknown figures remain unknown. A supplied `supported` label or workpaper link never grants publication authority. The requirement checklist is not a complete, accountant-reviewed requirement register. Net-assets component workpapers remain an explicit blocker; aggregate arithmetic is not component disclosure.

## Integration boundary for Claude

This branch owns only new statement-candidate files, tests and `docs/release/ipsas-statements-r1/`. It changes no PPE/grants component, server function, migration, transport, production compiler, public claim or setting. It is based on #216 only, independently of #217–#225. Keep Claude's remediation in its own branch. After the foundation and fixes are accepted, integrate through a new authenticated server adapter that retrieves immutable approved source revisions and recalculates this result. Never accept a browser `publicationAuthorized`, confirmation identity, hash or gate flag as authority.

Do not wire this directly to the normal signed-in page or issue a report from it. Persistence, permissions, review policy, standard-specific transition decisions, full notes/workpapers, dependency invalidation and frozen issuance need separate server integration and qualified accountant acceptance. Existing issued SME output must remain unchanged.
