# Reporting preparation guidance candidate

Base: `5b2f087ba35f898404cea83f839b5eaff8760b15` (PR #200).
Branch: `codex/reporting-preparation-guidance`.

## Scope

Frontend-only preparation guidance and ranked workflow audit. Separate from Claude's #201 classification rules and #202 finding-correction journey. No migration, Edge Function deployment, AI call, hosted mutation, access/payment change, merge or publication.

Implemented:
- Qualify automatic non-applicability for schedules, revenue and tax when composition/presentation is incomplete or unavailable; preserve explicit recorded applicability decisions and edition elections.
- Display the preparation prerequisite on Notes, Schedules and Comparatives, with the existing scoped route builder and preparer permission explanation.
- Add a visible current-account assignment action and target above/below Statements respectively.
- Correct Notes evidence directions to Statements and link to the actual evidence section.
- Do not offer manual applicability decisions for data-decided revenue and tax requirements; server remains the authority.
- Add non-prescriptive, entity-specific policy drafting guidance; no text is generated or prefilled. Keep the desktop editor bounded/sticky.
- Identify version saving as draft creation and distinguish it from REVIEWED/FINAL approval.

Detailed ranked findings and Claude follow-up: [WORKFLOW_AUDIT.md](WORKFLOW_AUDIT.md).

## Verification

- Focused component/next-action suites: 23 passed; five new interaction cases cover applicability qualification, decisions/edition preservation, viewer explanation, no writes, actual link targets, blank policy input and draft semantics. axe checks included.
- Full local suite: 6,445 passed, 10 database-only skipped, 12 todo. Final rerun is recorded in PR evidence; do not count skipped proofs as passed.
- TypeScript: passed. Production build and pack isolation: passed. Existing bundle-size warnings remain.
- Targeted lint: zero errors, one existing SchedulesView fast-refresh warning. Full lint result is recorded in the PR.
- Migration authority: 78 registered entries, nothing pending. Release journal and single-lockfile guards passed.

## Limits

No hosted browser acceptance, function-source attestation or accountant sign-off is established. Component navigation tests do not prove actual browser scrolling or sticky layout. Exact-head CI remains required before merge.

The automatic applicability issue also exists in the server status contract. This candidate qualifies its UI meaning without altering that contract, readiness, requirement counts or financial calculations. A separate reviewed forward migration is needed if changing the server states.

Installed historical migrations are untouched. The known incorrect saved mappings remain until separately corrected through authorized review and reprocessing. Genuine contra treatment and assisted placement/matching remain separate follow-ups.


## Independent review correction

The initial evidence link had the correct scoped href, but router navigation could occur before async statement content existed. Added a bounded workbench anchor/focus effect for only the assignment/evidence targets after successful reads, and focusable section targets. Two additional component tests exercise delayed rendering and reject arbitrary hash targets. Exact-head CI must rerun after this change; earlier green checks do not clear it.
