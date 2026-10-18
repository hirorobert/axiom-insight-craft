# Unlimited team members on Solo, Practice and Firm

- **Owner decision, 2026-10-18:** Solo, Practice and Firm include unlimited team members. This replaces the named-user allowance (one included user) and the proposed USD 200-per-year additional-user charge on Practice and Firm. That charge was never sold online.
- **Unchanged:** subscription prices, active-entity capacities, 12-month terms and renewal conditions. Enterprise remains subject to agreed terms.
- **Status:** draft PR only.
  - Migration `20261110100000_unlimited_team_members.sql` is **authored and pending hosted application**. It is not applied anywhere.
  - Nothing is merged, published or deployed. No Edge Function changes.

## 1. How membership was limited before (traced)

| Piece | Where | Role |
|---|---|---|
| A named user | `_account_named_users` | The account holder, plus accepted memberships, plus invitations that are pending and still valid (they reserve a seat), plus active workspace capability grants. Billing-suspended people are never counted. There is no separate service-account concept: every member is a person with their own sign-in. |
| Allowance | `_seat_capacity_for_account` | `included_seats` (1) + `commercial_licences.additional_seats`, or a larger `NAMED_USER_SEATS` override. No current plan means the account holder only. |
| Enforcement | `named_user_seat_wall` (trigger on `firm_members` and `workspace_capability_grants`) | Refuses a new reservation or acceptance beyond the allowance (`SEAT_LIMIT_REACHED`), under a per-account advisory lock. Also enforces invitation validity and suspension. |
| Other readers | `seat_check_for_invitation` (used by `invite-firm-member` before any email), `get_workspace_seat_capacity`, `_named_user_roster`, `choose_active_named_users`, `reconcile_named_user_allowance`, `_account_named_user_access_active` (inside RLS), `named_user_billing_suspensions_guard`, `admin_set_licence_additional_seats`, `_resolve_entitlement_for_owner` | Each one compared a count with `allowed_named_users`. |
| Price | `commercial_additional_seat_prices` (4 rows: Practice/Firm, USD 20 per month and USD 200 per year, `is_purchasable = false`) and the frontend `ADDITIONAL_SEAT_PRICE` | Display only; never sold. |

## 2. The enforcement change (exact)

**Unlimited is an explicit boolean.** It is never a large number, and NULL never means unlimited (Iron Dome §4.1).

- **Plans.** `commercial_plans.members_unlimited BOOLEAN NOT NULL DEFAULT false`. It is set `true` for the CFOClose Solo, Practice and Firm plans, which also get `additional_seats_purchasable = false`. Two CHECKs:
  - `chk_cp_members_unlimited_plans`: only Solo, Practice and Firm may carry the flag.
  - `chk_cp_members_unlimited_no_seat_sales`: an unlimited plan never sells seats.
- **Capacity.** `_seat_capacity_for_account` answers `{unlimited: true, determined: true, allowed_named_users: null, source: 'PLAN_UNLIMITED_TEAM_MEMBERS'}` for those plans. Every other answer carries `unlimited: false` and is otherwise identical.
- **Consumers.** Each consumer tests the flag explicitly before comparing a count. Without that test, a null allowance would silently pass some checks and deny access in `_account_named_user_access_active`.
  - **Seat wall:** under unlimited, it skips only the count. Invitation validity, suspension and the advisory lock above it still run.
  - **Activity predicate (RLS):** under unlimited, every non-suspended member is active.
  - **Pre-invitation check:** `ALLOWED`, `unlimited: true`.
  - **Seat state, roster:** never over allowance under unlimited. The roster version changes when the allowance does.
  - **Reconciliation:** nobody is suspended for capacity under unlimited. Losing the plan still suspends everyone but the holder.
  - **Suspension lift:** allowed without a count under unlimited. The history stays append-only.
  - **Account holder's selection:** under unlimited it only *reactivates* the people it names, through the internal helper `_lift_named_user_suspensions_unlimited`, and never suspends anyone. It is unchanged under a numeric allowance (Enterprise).
  - **Purchased seats:** cannot be raised on an unlimited plan (`PLAN_HAS_UNLIMITED_TEAM_MEMBERS`). They can be lowered, which is recorded and audited.
  - **Entitlement resolver:** identical, except that a capacity answer also returns `unlimited`.
- **Price.** The four proposed seat-price rows are set `is_active = false` and kept.
- **No Edge Function change.** `invite-firm-member` already proceeds on `ALLOWED`.

Every redefined function is generated from its **current** definition, with the edits marked. The migration's preflight refuses a second application and refuses to run without the authority it extends.

## 3. What did not change

- **Who may invite, accept, revoke or hold a role.** `manage_members` is still required (Edge Function and RLS). Members cannot change their own title (`ACCEPTANCE_ONLY`) and cannot grant themselves a capability. A preparer or viewer membership confers no `review_close`, `approve_certification` or `manage_members`. Review and approval come only from a title the inviter explicitly chooses (owner or partner) or an explicit grant. Membership never confers reviewer or approver authority.
- **The invitation lifecycle:** a bounded reservation window, expiry, cancellation, and acceptance only while valid.
- **Billing suspension:** append-only, and lifted only by the account holder. **Loss of the plan:** the account falls back to the holder only.
- **Active-entity limits, tenant isolation, RLS and audit history.**
- **Usage, storage, processing and invitation-rate controls.** None of them is a seat count.

## 4. Existing customers, licences and paid-seat records

- **Access is preserved and only widened.** Every current member of a Solo, Practice or Firm account stays active. Nobody loses access.
- **People already billing-suspended under the old model stay suspended** until the account holder reactivates them. The migration does not lift suspensions automatically, because some were deliberate owner selections.
- **Records are kept exactly:**
  - `commercial_licences.additional_seats` (purchased seats), `commercial_plans.included_seats`, `NAMED_USER_SEATS` overrides, suspensions, and every `billing_audit_events` row are unchanged. The proof verifies this.
  - Seat counts on unlimited plans are reported but no longer bound membership.
- **No refund, credit or agreement change is made.** See §6.
- **Enterprise keeps its agreed numeric allowance** (entitlement overrides).

## 5. Evidence

All of this is local. Nothing ran against a hosted environment.

| Check | Result |
|---|---|
| `scripts/db-proof/unlimitedTeamMembers.mjs` (embedded PostgreSQL 16, full chain, fixtures created under the old model) | **28/28** |
| Seat, commercial and authority proofs over the chain including the migration: `entitlements` 67, `planCapabilities` 112, `paidTermPreservation` 18, `paymentProviders` 47, `annualTerm` 91, `sandboxLicenceIsolation` 45, `snippeLedger` 30, `verifiedChargeOutcomes` 28, `paymentReversalAuthority` 38, `setupAuthority` 63, `serviceEnquiries` 274, `serviceWithholding`, `uploadLifecycle` 207, `run` 279, and the trial-balance, reconciliation, close-review, statement and sign-off proofs | all pass |
| `billingSuspension.mjs` | **63/63.** It now stops before this migration, because its fixtures are Practice and Firm accounts with a numeric allowance. It still proves the numeric model, which governs Enterprise and the no-plan fallback, and the new proof re-proves those cases after the change. |
| Vitest (catalogue mirror, seat state, roster, landing, plans, payment screens, migration registries, `databaseInert`) | pass. See the PR for the full-suite run. |

**What the new proof shows:**
- Before the change, Solo refused a second member (`seat_limit_reached`).
- After it, each of Solo, Practice and Firm admits a second member, then eight more.
- 12 concurrent invitations and 12 concurrent acceptances all succeed, and every member is active.
- Ordinary members cannot invite, retitle themselves or grant themselves anything.
- Cross-tenant invitations are refused, and an outsider reads nothing.
- A revoked member loses access, their capabilities end, and they see no members.
- Expired and cancelled invitations cannot be accepted.
- A previously suspended person stays suspended until reactivated, and no one else is touched.
- Losing the plan falls back to the holder.
- Solo still cannot add a second entity.
- Enterprise still refuses its third member.
- Purchased seats can be lowered but not raised.
- History is byte-identical.

**Screenshots** (`screenshots/`) were taken with the frontend built against the staging project only (no production reference in the bundle), at 1280 and 375 px:
- `before-pricing-*.png` and `after-pricing-*.png`: `/pricing`.
- `before-landing-plans-*.png` and `after-landing-plans-*.png`: the landing capacity table.

Prices, entities and actions are identical. Only the team-member wording changes, and there is no horizontal scroll at 375 px.

## 6. Remaining commercial decisions (not made here)

1. **Recorded purchased seats.** Do any live licences carry `additional_seats > 0`? This has not been checked against the hosted database. If any do, decide whether those payments are credited, refunded or simply superseded. Nothing is changed or refunded by this PR.
2. **Renewal and upgrade placement with paid seats.** `_commercial_licence_placement` still sends an upgrade over paid additional named users to review (`BLOCKED_SEATS`). Under unlimited membership those seats protect nothing. Keeping the review is the conservative default, pending decision 1. The checkout copy about "additional named users" on an existing term is unchanged for the same reason.
3. **Reactivating people suspended under the old model.** The default is a manual reactivation by the account holder. Decide whether to lift those suspensions in bulk, with a recorded reason.
4. **Terms and invoice wording** that mention named users or additional seats (outside this repository: Polar product descriptions, `/terms`). Update them separately.
5. **Enterprise contracts** keep their agreed numbers. Decide whether to offer them unlimited members.

## 7. Hosted application (owner, later)

Only after the current hosted release verification is complete, through the authorised journal process:
1. Apply `20261110100000` (forward-only).
2. Publish the frontend.

No Edge Function deploy is needed.
