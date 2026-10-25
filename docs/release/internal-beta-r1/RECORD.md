# Internal beta candidate — 2026-10-25

## Actual status

Normal-page assistant integration is implemented as a candidate. It is NOT activated or published.
Hosted journal remains **83**, hash `7be675f1066aa17090007d039a412b70a2c120fa8fab008d7bfd0ceee1b3523f`.
Reporting global kill switch is engaged. Only the existing acceptance company is enabled underneath it.
Original binding rows seq **1,2** remain exactly `de1e521b8731b1fc5f30ee4a15c17a0834838fb0530335696aceb5fda8f78642`.
This proves those binding rows, not every historical table.

Read-only inventory: 16 auth users, 19 companies, 19 accepted memberships; every company currently has just its owner.
Public signup hosted setting remains UNVERIFIED. The candidate's enrollment snapshot prevents future signup from
self-enrolling, regardless of that setting. No email-domain guesses or privilege promotion.

## Actual source-path refusal

Adding `supabase/migrations/20261202100000_internal_beta_policy.sql` through the file tool returned:

> Files under supabase/migrations/ are managed by the migration system and can't be edited, added, or copied directly.
> Apply schema changes through the database migration tool (tool name: supabase--migration), which runs the SQL and writes the migration file for you.

The available native `lov_database--migration` accepts SQL text and **applies immediately**, writing a Drizzle mirror;
it has no prepare-only authored-file operation. It was NOT invoked to bypass the source-path refusal. No unregistered SQL
was submitted and no journal was hand-edited.

## Concrete Codex repository handoff — owner need not engineer transport

1. Promote **byte-identically** `release/candidates/internal-beta/20261202100000_internal_beta_policy.sql` to
   `supabase/migrations/20261202100000_internal_beta_policy.sql` in the repository environment that permits authored files.
   Source is 20,177 UTF-8 bytes, SHA-256 `4497f7cf23d3bc650e6c5ad847110b339e5f5cb3a0cf17a29dc0c51adc14e726`.
2. Existing assistant controls are unchanged: `supabase/migrations/20261201100000_assistant_controls.sql`, 38,510 bytes,
   SHA-256 `84695443fc325657b68b159f753a788c16249fac92b0e78176e9876a4994fd3f`.
3. `scripts/release/internalBetaStagedTransport.mjs` and **five generated SQL files** under
   `release/staged-transport-beta/` already exist. Source commit pinned there is `5e4603de1c443612d1c8446c4907a84975440a5f`.
   After promotion, change the beta artifact path to its authored path, pin the final committed source and regenerate
   literal form hashes. Register its forms in `scripts/ci/releaseJournal.mjs` and add mirror verification there BEFORE
   native submission. Current generated hashes are candidate-only, not canonical registration.
4. Run the two provided loopback PostgreSQL proofs and relevant/full release checks on that exact final SHA.
   Do not mistake candidate mirror checking for RELEASE_JOURNAL registration. No pending reporting source is replayed.
5. Canonical install order: private bootstrap → byte-verified inert staging → assistant controls → beta policy →
   postcondition/history readback → matching functions/frontend → explicitly audited bounded activation.

## Policy and spend

Candidate separates beta approvals from production: production evaluation/data-handling timestamps remain unset.
Existing owners/accepted members are snapshotted; new members require explicit `internal_beta_enroll_member` by an
enrolled holder of manage_members after normal invitation acceptance. Current access is re-derived at each reservation.
Reporting's original rollout, membership/capability, review separation and server compilation gates remain conjuncts.

USD **5 total**, including prior conservative USD **1.3414** = maximum **USD 3.6586 remaining**, not confirmed provider
credit. Database global lock serializes reservations across companies. Unknown costs consume the reservation; any overrun
stops new reservations. Live requests use exact operator-recorded synthetic composition hashes, existing validator and
fact renderer, at most two provider calls, 20,000 input / 1,200 output tokens and 30 seconds. No free-form prompt or
browser-supplied figures. No live calls made in this work.

Secure Anthropic key exists. Current available provider credit/billing reconciliation and current model prices remain
UNVERIFIED; no approval timestamps are invented. Live spending must remain disabled until verified.

## Normal reviewer steps

Owner signs in normally → Settings → Firm & Team → select company → Invite member → Partner → send invitation.
Reviewer opens invitation and signs in with their OWN account; Dashboard accepts the invitation through the existing
server function. Verify actual review_close/approve_certification grants; display title alone is not authority.
The current product has no separate beta-enrollment button yet: after migration registration/install, wire
`internal_beta_enroll_member` into this normal team row (owner reason required). Do not use a tester page or solo_owner.
One owner membership currently means second-person browser acceptance remains UNTESTED.

## Reporting acceptance retained

Keep original v6 and seq1/2 immutable; use a new same-lineage successor. Test staleness on an EDITABLE draft before FINAL:
change permitted input → confirm stale/readiness refusal → save/rebind new version → invoke compile-financial-report →
read `fs_server_compilations` → readiness must satisfy `ready === true` and empty blockers (authority is also returned).
Only then normal review/FINAL; independently verify original FINAL refuses editing. Official artifact verification hashes
the sealed JSON's actual `content_sha256`; PDF/CSV need independent export checks. Nonmember behavior remains UNTESTED
without a genuinely authenticated nonmember. Source attestation UNRESOLVED, owner-authorized limited-beta nonblocker.

Activation requires verifying ALL enabled company rows while global switch is ON, configure company allowlists using
`fs_set_company_rollout(company,true,reason,operator_label)`, verify, disengage `fs_set_kill_switch(false,reason,operator)` LAST.
Closure engages `fs_set_kill_switch(true,reason,operator)` FIRST, then disables company rows. It stops access, not committed
record rollback; reconcile new compilations/publications/authority events/issuances/storage exactly. No automatic TTL.

## Checks

- 12/12 isolated PostgreSQL policy checks and 12/12 transport success/interruption/retry/rollback checks passed.
- Assistant deterministic tests passed; these do not demonstrate model improvement or accountant approval.
- Full repository check results are in `/tmp/beta-checks` during this session; sandbox-prohibited Git-mutating fixture
  suites must run on final repository CI. Bounded results are not full clearance.