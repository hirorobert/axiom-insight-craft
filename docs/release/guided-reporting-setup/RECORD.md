# Guided reporting setup and first beta enrollment

## Release scope

Fix the demonstrated new-company enrollment deadlock and consolidate the period/upload/access handoff. Based on main e745f788 (PR #198 merged). Existing signed-in roles, approvals, framework support, company allowlist and assistant spending remain separate authorities.

- An authenticated workspace manager with current access and `manage_members` can read accepted-member enrollment and explicitly enroll the first accepted owner/member. Prior beta enrollment is no longer required to administer enrollment.
- Enrollment locks the actor/target membership rows in deterministic order. Concurrent/repeated requests converge to one enrollment and one event per effective change. Re-enrollment after revocation requires a fresh explicit command; a removed or pending member is refused. Anonymous and service-role execution remain revoked.
- Installation changes only the two function definitions/privileges. It enrolls nobody, opens no company, releases no master switch, grants no role, changes no seat allowance, spends no AI and mutates no financial records.
- Overview explains unavailable reporting and offers the owner enrollment action in context. Team errors no longer silently hide the feature. The admin list provides a company-specific Team link for zero-enrollment companies; the requested company must be among server-listed owned companies.
- Practice & team starts with the originating/explicitly requested company, retains the selection through Refresh and remembers it per signed-in account for navigation only. Server-owned company lists still constrain selection; late member reads cannot cross company scopes.
- When a comparative period is linked, Trial Balance shows current and prior-year panels, saved dates/currency and the actual prior file/review status from the canonical snapshot reader. The explicit prior-year action uses the existing idempotent service-opening command then navigates into that year; no implicit upload relocation or automatic acceptance. A comparative year does not demand another prior-year upload merely because it has no earlier link.
- Workspace Refresh waits for its snapshot, engagement, mounted reporting-access, period and enrollment readers, coalesces double clicks, preserves mounted drafts and shows progress/success/incomplete feedback. It does not reload application code or claim to refresh every independent report editor. Upload read failures retain the existing snapshot instead of manufacturing an empty period.
- A selected filename that mentions another FY gets an advisory warning; filenames never determine accounting dates or move data.

## Verification

Local full suite: 6,439 passed; 10 PostgreSQL-only cases skipped; 12 existing todo. Focused mounted tests exercise enrollment recovery, double clicks, stale-company response refusal, team company continuity, current/prior destinations and refresh/draft preservation. TypeScript, production build, pack isolation and migration authority passed. Full lint: zero errors, 180 warnings (177 baseline plus three explicit sequence-cleanup warnings). CI must prove the final committed candidate.

New whole-chain PostgreSQL proof: `scripts/db-proof/internalBetaTeamBootstrap.mjs`. It reproduces the old zero-enrollment refusal before installing the migration, then covers new-owner success, permission/cross-company/pending-member refusal, privileges, twelve concurrent requests, replay/audit counts, explicit re-enrollment, removed-member denial and preservation of financial/commercial/policy state. Registered in the existing disposable-database CI job; the proof step passed on the initial candidate in run 40268002995. That run did not fully pass because its exact-file guard needed the new proof filename registered; the registration was corrected and final-head CI remains authoritative. Native PostgreSQL cannot start under this local container's root/user restrictions; that local attempt is NOT a passed proof. Hosted execution and genuine signed-in verification are not completed by unit tests.

## Installation handoff — pending, no hosted write executed

Exactly one new authored migration is pending; no existing journal entry is replayed or edited:

`20261204100000_internal_beta_team_bootstrap.sql`

Bytes: 3148

SHA-256: `238d8b0664b253cd665c8e9b9532326486e86ad087f1a76dda56846cc0a0edb8`

After independent review and owner merge authorization: sync the accepted SHA, apply that exact file through the native registered migration path, verify the stored bytes, restricted privileges and unchanged historical binding baseline, and register the actual hosted mirror/history. Expected next hosted entry is 88 only if a fresh read still shows predecessor 87; stop on drift. No source is marked applied in this candidate.

Publish the matching frontend after backend installation. No Edge Function redeployment or paid provider evaluation is required for this change. No Lovable agent was contacted to prepare it.

Owner acceptance: open Complete Test Overview, enroll the existing owner, use reporting settings to explicitly add only the intended company (preserving other intended selections), return to the workspace and Refresh. Both trial-balance files remain in their existing periods. Confirm Statements appears only when the server permits it. Repeat with a separate authorized reviewer; the two-person approval policy is unchanged.

## Remaining boundaries

The separate bank-loan classification suggestion, accounting treatment/coverage expansion, live deployed-function attestation, production data approvals and AI quality evaluation are not resolved here. No claim of full IFRS/IPSAS support, full production release or completed live acceptance is made.

## Installation — applied 2026-10-26

Hosted journal entry 88 (predecessor 87, hash `4d10e4d9…`, verified before apply). Applied through the native registered migrator as Drizzle `0087_internal_beta_team_bootstrap`; the mirror is byte-identical to the source (3,148 bytes, SHA-256 `238d8b0664b253cd665c8e9b9532326486e86ad087f1a76dda56846cc0a0edb8`, also the hosted journal hash). Privileges: both functions executable by `authenticated` only (anon and service_role refused). Preservation: `fs_publication_bindings` 2 rows, digest `de1e521b…8642` unchanged; active enrollments 19 (unchanged). No function deployed, no access activated, nothing published. Migration authority: no pending sources.
