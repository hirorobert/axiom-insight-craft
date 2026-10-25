# Internal beta candidate — 2026-10-25

## Installation result (2026-10-25, from main `dd4d5710`)

- Predecessor rechecked: hosted id 83 / `7be675f1…`. Applied through the native migrator: id 84 bootstrap
  (`a2286d7f…` = generated `bdbd0020…` + one final LF), id 85 assistant controls (`de36c590…`), id 86 beta policy
  (`80b961a8…`). Both sources staged and accepted by the byte guard (38,510 B `84695443…`; 22,030 B `a8297d57…`), both consumed.
- Postconditions: beta reporting and AI off, assistant settings off, 19 enrollments snapshotted, binding seq1/2 digest
  `de1e521b…8642` unchanged, zero issued packs. Mirrors 0083–0085 registered; migration authority OK, nothing pending.
- `assistant-explain` deployed (submitted source SHA-256 `142453b8…6629`; live bundle not independently verified).
- Frontend publish requested from the same tree.
- NOT activated: `internal_beta_configure` requires a signed-in commercial admin; the reporting kill switch stays engaged.
  AI cannot be enabled: the policy requires recorded credit and pricing confirmations, which are unverified.
- Observed: `commercial_platform_state` reads `CUSTOMER_PAYMENTS_ENABLED` (pre-existing, not changed here).

## Actual status

Normal-page assistant integration is implemented as a candidate. It is NOT activated or published.
Hosted journal remains **83**, hash `7be675f1066aa17090007d039a412b70a2c120fa8fab008d7bfd0ceee1b3523f`.
Reporting global kill switch is engaged. Only the existing acceptance company is enabled underneath it.
Original binding rows seq **1,2** remain exactly `de1e521b8731b1fc5f30ee4a15c17a0834838fb0530335696aceb5fda8f78642`.
This proves those binding rows, not every historical table.

Read-only inventory: 16 auth users, 19 companies, 19 accepted memberships; every company currently has just its owner.
Public signup hosted setting remains UNVERIFIED. The candidate's enrollment snapshot prevents future signup from
self-enrolling, regardless of that setting. No email-domain guesses or privilege promotion.

## Repository completion (Codex, no Lovable agent usage)

The protected-editor limitation is resolved in the Git repository. Authored source now exists at
`supabase/migrations/20261202100000_internal_beta_policy.sql`, pinned by the transport to source commit
`18bd63b621317b8c9a608db27264bed213ceb146`. The earlier file in `release/candidates/` is an inert historical draft;
it is not an installation source. The authored version also closes default API-role table mutation/TRUNCATE grants,
adds manager-authorized accepted-team enrollment status, and preserves the pre-existing reporting rollout when beta is disabled.
When beta reporting is enabled, its enrollment requirement is additional to existing rollout and capability checks.

Normal Settings → Firm & Team now shows accepted members' beta enrollment to an authorized manager. The manager can
explicitly enroll an accepted colleague; this grants no financial capability. The server checks membership and
`manage_members` at execution. An older or unauthorized backend exposes no enrollment action.

`internalBetaStagedTransport.mjs` pins committed authored bytes and generates five exact-byte files. The canonical
release guard recognizes `beta_staged_transport` mirrors, verifies their literal SHA-256 and their source bytes,
and rejects any changed form. No hosted rows 84–86 are registered as applied in advance.

Expected install order (hosted predecessor must still be id 83 and its recorded hash):

1. Native canonical migrator applies `00_internal_beta_staged_transport.sql` (expected id 84).
2. Load the two generated `stage/*.source.sql` files as inert, fingerprint-checked data.
3. Native canonical migrator applies assistant controls (`10_...`, expected id 85), then beta policy (`20_...`, expected id 86).
4. Read back exact journal/mirror identities, source consumption, disabled-state postconditions and original bindings.
5. Register only the actual canonical mirror files/rows, deploy matching `assistant-explain`, sync/publish matching frontend.
6. Configure and activate the authorized internal beta with bounded spending; run real authenticated journeys.

The connector available to this Codex session supports database queries and website publication, but exposes neither
Lovable's native journalled migration operation nor Edge Function deployment. The AI-agent message operation was NOT
used because the owner requested no Lovable AI-credit consumption. Generic SQL was not substituted for canonical
migration application, and an incompatible frontend was not published. Repository completion alone is not live readiness.

## Verification for this candidate

The migration authority guard passes with precisely two pending authored sources (assistant controls and beta policy).
Five generated transport files pass exact-byte verification. Focused canonical registration/source-tamper tests pass.
The CI database job now includes isolated policy/transport rehearsals and extends the existing real-chain assistant proof
with beta Team enrollment, tenant denial, preserved capabilities and service-role budget/history denial.
Final unit/build/typecheck results and CI outcome must be attached to the actual candidate SHA; preparation is not
hosted or browser acceptance. No Claude API requests were made and no Lovable AI-agent credits were consumed.

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
The normal Team panel includes the enrollment action, backed by `internal_beta_enroll_member` after installation.
The action records a fixed explicit audit reason; existing capabilities remain unchanged. Do not use a tester page or solo_owner.
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

## Earlier candidate checks (historical; not final-candidate clearance)

- 12/12 isolated PostgreSQL policy checks and 12/12 transport success/interruption/retry/rollback checks passed.
- Assistant deterministic tests passed; these do not demonstrate model improvement or accountant approval.
- Full suite on `97e8c0e016d98ed406f56f2da9a273b6c9f60dd9`: **6,346 passed**, 48 skipped, 12 todo;
  two Git-mutating suites failed because `git add` is prohibited. Full clearance **FAIL**, not PASS.
  Full lint: **0 errors, 177 warnings**. Migration authority, compiler generation and candidate transport byte checks PASS.
  Later added one explicit FAKE-handler success regression; rerun focused results are separate from that full-suite SHA.
- Preview build telemetry: build OK. Browser normal `/auth` shows the sign-in form; protected workspace redirects there,
  zero page errors. No managed session restored or minted. Authenticated reporting/AI acceptance NOT TESTED.
- No backend migration/function deployment/publication/activation occurred. Hosted journal and original digest unchanged.
## Activation from a normal administrator account (2026-10-25, migration `20261203100000`)

Why a migration was needed: after hosted 84–86 the activation still could not be done from an administrator account.
`internal_beta_configure` needs the policy revision, which no administrator could read; the reporting master switch and the
company allowlist (`fs_set_kill_switch`, `fs_set_company_rollout`, 20260919100000) and synthetic-scope recording are
service-role operator controls only. `20261203100000_internal_beta_admin_activation.sql` adds five admin-only, audited
definer functions (see CLAUDE.md §9.5). It is a plain forward migration: no staged transport; its hosted mirror is accepted
by the ordinary mirror rule (checked by simulating a `0086` mirror locally). It changes no table, policy, capability, budget
rule or financial record, and installing it changes no state.

Order after this commit is green on GitHub:
1. Lovable applies `20261203100000_internal_beta_admin_activation.sql` with its native migrator (expected hosted id 87) — the
   one backend step; a GitHub sync never applies a migration. No Edge Function changes.
2. Lovable syncs the same commit and Publish publishes the matching frontend.
3. The owner signs in normally → Settings → Commercial administration → **Internal beta** (or
   `/commercial/admin?tab=internal-beta`): choose the acceptance company (only companies with an enrolled member can be
   chosen), give a reason, Confirm and open. One transaction: allowlist exactly that company → beta reporting on → master
   switch released last. **Close reporting now** engages the master switch first and empties the allowlist.
4. AI, separately and only after checking the provider's current prices and remaining credit: with reporting open, record the
   synthetic data (company + year; the database computes the hash), then enter the model and prices and confirm both checks.
   The screen shows each request's reservation and how many fit the remaining allowance. **Stop assistant spending** needs no
   revision.

Proof: `scripts/db-proof/internalBetaActivation.mjs` (full chain, real certification engine): 36/36 locally.

## Installation of `20261203100000` (2026-10-25, from main `576782fe`)

- Predecessor: hosted id 86 (`80b961a8…`); entries 84–86 not repeated. Preflight state: master switch engaged, allowlist =
  `659daa94-116c-4803-99f8-157e0bdd4c62` only, beta policy revision 1 with reporting and AI off, admin functions absent.
- Applied through the native migrator as hosted id **87**, mirror `drizzle/migrations/0086_internal_beta_admin_activation.sql`,
  hash `4d10e4d9732c28488a457b8ed02fe4b7f20941726eda156894abca9e8cb40e92`. Its own preflight and postcondition passed.
- **Not byte-identical to the source** (`61b8ca42…de46`, 19,971 bytes): the submitted SQL has one fewer leading space on line
  141 (indentation inside `internal_beta_admin_open_reporting`). No token differs; behaviour is identical. The applied mirror
  is not edited. MIGRATION_AUTHORITY: OK (77 entries, PENDING_HOSTED_APPLY: none).
- After: 5 admin functions present; master switch still engaged; allowlist unchanged; policy revision 1, reporting and AI off;
  sign-off bindings 2 rows, digest `de1e521b8731b1fc5f30ee4a15c17a0834838fb0530335696aceb5fda8f78642` unchanged.
- No function deployment, publication, activation, AI call or payment change in this step.
