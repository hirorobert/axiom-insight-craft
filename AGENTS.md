# Project implementation rules

External accounting resources: before adopting third-party IFRS/taxonomy code, content or skills, read [the adoption register](docs/research/EXTERNAL_REFERENCE_REGISTER.md). Preserve its source-verification, licensing, framework and deferred-scope boundaries. Reference the applicable decision in the plan and PR; do not silently install or embed a resource.

## Development charter — required reading

Before changing CFOClose, read [the development charter](docs/architecture/CFOCLOSE_DEVELOPMENT_CHARTER.md). Reference applicable requirements in the work plan and PR. Do not silently deviate. Any exception must identify the requirement, reason, affected controls and tests, and obtain the required approval through a recorded amendment.

The charter records target requirements, not proof of implementation or framework compliance. Its adoption and accounting review status must remain explicit. Existing repository controls remain in force pending recorded adoption; unresolved conflicts must be reported, not silently resolved by assuming an exception. No charter instruction grants permission to spend credits, merge, deploy, publish or activate hosted features.

- Keep pricing and public plan features in the existing catalogue/matrix mirror, and render them through one reusable catalogue; the database remains the authority for entitlements, while page selection is temporary, because there is no checkout or saved plan selection.
- Decide first-run setup only after the existing workspace-discovery read and both billing/capacity reads have resolved; keep all historical workspaces reachable when a plan ends, because an absent plan must not erase archive access.
- Expose fixture-only account-state previews exclusively behind development-only routes, with no customer reads or writes, because visual acceptance must not mutate or expose live financial data.
- Release SQL too large for the hosted migrator is staged byte-verified as inert data in the private cfoclose_release schema and executed by a small registered per-batch migration (one transport module per release under scripts/release/*StagedTransport.mjs; journalled transports are never edited, a new release gets its own private schema); bootstrap function revokes target only its three newly-created helper signatures, because the migrator must keep owning the journal without changing existing application privileges.
- Account-home "Continue where you left off" is chosen only from server-listed engagements and their persisted workspace state (src/lib/workspace/continueEngagement.ts), because route visits or browser storage must never become progress truth.
- Data-router roots use the shared app recovery screen as errorElement; route failures are intercepted before the outer React boundary, and retry reloads the document to recover failed lazy imports.
- Normal reporting pages expose advisory assistant presentation; internal-beta authorization and aggregate reservations use a separate server-enforced policy/ledger, never production approval timestamps or browser authority. Inert release candidates stay under release/candidates until authored migration creation and canonical registration succeed.
