# PR #34 — authorization: capabilities versus job titles (P-08 review)

Scope: every remaining check that authorizes by `firm_members.role` after PR #34, found by reading the effective
definitions on a database built from every migration (`pg_get_functiondef`, `pg_policies`) plus the Edge Functions and
the frontend. PR #34 adds **no** role check. Its own authority (`_authorize_paid_action`, the walls, named-user seats,
suspension, Reporting Pack issuance) is capability- and account-based, proven in `scripts/db-proof/entitlements.mjs`
and `scripts/db-proof/billingSuspension.mjs` ("no occupational title changes anything").

**Update (20260925140000):** the recommendation below is now implemented in this PR. Every title check listed as an
occupational assumption was replaced by an explicit, stored workspace capability (`prepare_close`, `review_close`,
`approve_certification`, `issue_reporting_pack`, `manage_members`; `manage_billing` = the account holder). Titles are
display metadata and a starting template. The unreachable `manager` / `reviewer` / `approver` branches were dropped.
Remaining title reads: the four `firm_members` owner-integrity policies and last-owner guards (not authorization) and
the display ordering in `financial_statements_workspace_access`. Proven by `scripts/db-proof/planCapabilities.mjs`.
The original review follows for the record.

## The role column

`firm_members.role` is constrained to `owner | partner | preparer | viewer` (`chk_firm_member_role`). `owner` is
created only by company creation (`create_owner_firm_member`, guarded by `prevent_unauthorized_owner_insert`) and is
the workspace-creation authority. It is a legitimate authority label, not a job title.

**Unreachable branches.** 21 RLS policies and 5 functions also test for `'manager'` and / or `'reviewer'`. The CHECK
constraint makes both values impossible, so those branches are dead code. They grant nothing today. They show that the
policies were written against an occupational vocabulary, not the stored authority.

## Legitimate authority checks (keep)

| Check | Where | Authority it expresses |
|---|---|---|
| `role = 'owner'` | `invite-firm-member` (who may invite), `FirmManagementPanel` (owner row not removable), last-owner guards | May manage named users / administer the workspace (the workspace creator) |
| `role <> 'viewer'` | `fs_actor_member_id`, `financial_statements_workspace_access` (read-only hint) | May write financial-statement data (viewer = read-only access level) |
| `companies.user_id = auth.uid()` | `grant_workspace_capability`, `cancel_workspace_invitation`, `choose_active_named_users`, entity capacity | Account holder: billing, named users, capability grants |
| `workspace_capability_grants.capability` | `workspace_authority_basis`, `tbu_*` | Explicit capabilities: `manage_source_files`, `prepare_trial_balance`, `review_close`, `administer_workspace` |
| `commercial_admins` | admin RPCs | Platform commercial administration |

## Occupational assumptions (flagged, not changed)

| Check | Where | Assumption | Capability it should become |
|---|---|---|---|
| `role IN ('partner','owner')` for reviewer / approver / lock tiers | `PeriodCloseManager.tsx` (UI), `sso_update_partner_owner`, `aje_update_partner_owner` | "Partners review and approve" | May certify (sign off / approve / lock) |
| `role IN ('owner','partner')` | `fs_set_publication_state` (REVIEWED / FINAL), `account_pl_mapping_update/_delete` | "Partners publish" | May publish; may administer mappings |
| `role IN ('owner','partner','manager')` | `assert_engagement_write_authority`, `open_engagement_with_scope`, `set_company_filing_jurisdiction`, `engagements` INSERT/UPDATE ("Senior members"), `variance_budgets.budget_approve`, `variance_materiality_write`, `useEngagementMandate` (`SENIOR_ROLES`) | "Seniority decides scope" | May administer the workspace |
| `role IN ('owner','partner','manager','preparer')` | journal entries, capital allowances, tax losses / payments, `statement_sign_offs` INSERT, `record_engagement_data_start` | "Everyone but viewers prepares" | May prepare (write) |
| `role IN ('manager','preparer')` | `aje_update_draft_preparer`, `sso_update_preparer` | "Preparers edit drafts" | May prepare |
| `role IN ('owner','partner','preparer')` | `management_inputs` | as above | May prepare |
| `resolve_account_review_batch` role tiers | account review | "Partners decide" | May review classification |
| Tax-panel sign-off tiers | `KingaTaxPanel.tsx` | "Partners sign tax computations" | May certify |
| Role picker offers `partner` | `FirmManagementPanel.tsx`, `invite-firm-member` | job-title vocabulary shown to customers | Capability names |

`platform_staff_grant` checks a `manager` staff role in the separate platform-staff table (the service-enquiry queue).
That is platform operations, not customer workspace authority, and is out of scope.

## Recommendation (separate task)

Map the four stored roles onto explicit capabilities once: `owner` → administer workspace + manage named users + certify
+ publish + prepare; `partner` → certify + publish + prepare; `preparer` → prepare; `viewer` → read. Then replace each
flagged `role IN (...)` with a capability test (the existing `workspace_capability_grants` vocabulary already has
`review_close` and `administer_workspace`), and drop the unreachable `manager` / `reviewer` branches. This touches
Lovable-applied RLS policies and certification gates, so it needs its own migration, proofs and owner approval. PR #34
deliberately does not do it.
