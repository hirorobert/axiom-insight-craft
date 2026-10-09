# Reporting r5: statement sign-off policy, shared-catalogue classification, r4 closed

Demo company `659daa94-116c-4803-99f8-157e0bdd4c62`. Reporting stays demo-only. The figures are synthetic, and the
accounting is **not independently validated**. Version 6 stays FINAL and sealed (and stale after J9, by design).

## 1. r4 print defect: CLOSED

Hosted verification, `REPORTING_R4_PRINT_VERIFICATION_39b8e06.md`, on the preview at `39b8e06`:

| Artifact | SHA-256 | Independent check |
|---|---|---|
| `FY2025-v6-final-r4.pdf` (button) | `659f6bce1e4598ef91a8b511979f8b343db19b1c087c7f826f4f2b90f3f5d7fc` | 5 pages; no workspace text; content `ca9c61fe…b016d6` and dependencies `27eb64df…cc1242f` complete; "Approval disclosures" present |
| `FY2025-v6-final-r4-browser-print.pdf` (browser print) | `9ce24a53f7995eca0143a35c3b398e4874432fc23cbbefa1e4a5833f333c1693` | Same |

Both hashes in each PDF equal version 6's seal. Leaving Exports printed the normal page (the print host was removed).
Nothing was uploaded, saved or re-signed.

**Limit kept.** Hosting exposes no live commit SHA, so the live publish is not proven to the commit.

## 2. The three shared-catalogue warnings: INTENTIONAL, read-only framework definitions

These are the three permissive read policies added by the reporting release. Each has `USING (true)`, for signed-in
users only:

| Table | Policy | Source | Holds |
|---|---|---|---|
| `fs_presentation_lines` | `fspl_read` | `20261018100000` | IFRS for SMEs presentation lines: `pack_family, lines_version, line_id, statement, label, requirement_id, natures, position, sort_order` |
| `fs_pack_requirements` | `fspr_read` | `20261019100000` | IFRS for SMEs requirements: `pack_family, pack_version, requirement_id, kind, statement, applicability, blocking, sort_order` |
| `fs_schedule_definitions` | `fssd_read` | `20261019100000` | Schedule definitions: `pack_family, schedule_id, requirement_id, label, line_ids, movements, prior_period_required, sort_order` |

Evidence on real PostgreSQL, full chain (`scripts/db-proof/signoffPolicy.mjs`, catalogue group). For each table:
- **No tenant or person data:** no column names a company, user, member, actor, owner, email or creator.
- **RLS:** enabled, with exactly one policy (`SELECT`, role `authenticated`, qual `true`).
- **Grants:** `authenticated: SELECT` only. `anon` has nothing.
- **Behaviour:**
  - another workspace's owner reads the shared rows;
  - INSERT, UPDATE and DELETE by `authenticated` are refused (`42501`);
  - SELECT by `anon` is refused (`42501`).
- **Writers:** only migrations seed them. No RPC or Edge Function writes them.

**Disposition.** Mark all three **intentional / accepted** in the Security view, with this reason: "Shared, read-only
IFRS for SMEs framework definitions; no tenant or personal data; SELECT for signed-in users only; no client write."
No per-user predicate is added (every workspace must read the same definitions), and nothing is described as fixed.

The scan is outdated/incomplete as Lovable reported. This classification covers these three policies, not the scan as
a whole. `ai_consent_versions.aicv_read` was classified separately (intentional), and the commercial catalogues
earlier.

## 3. Statement sign-off policy (`20261024100000`)

**Before.** Statement sign-off had no separation rule. One owner recorded both REVIEWED and FINAL on version 6, and
the pack named only the final approver. The Close Review adjustment policy (`two_person` / `owner_self_approval`)
governs adjustments only and is unchanged.

**Now:**

| | |
|---|---|
| **Default: separate approvers** | Also when no policy is recorded. A FINAL by the person who recorded REVIEWED is refused (`SIGNOFF_SEPARATE_APPROVERS_REQUIRED`, nothing recorded). |
| **Solo owner** | The company's owner may record both, only under a recorded `solo_owner` policy. The policy is set by a member who manages members, with a reason (8–1000 characters) and the exact confirmation: "I confirm that the owner of this company may both review and approve its financial statements, and that this is disclosed in every pack it signs." A non-owner still cannot approve their own review. |
| **Recording** | The policy lives in the append-only `fs_signoff_policy_events`, readable by members only. It is set through `fs_set_signoff_policy` (replay-safe per request) and read through `fs_signoff_policy`. Enforcement is in `fs_bind_publication`, the one place every REVIEWED/FINAL is bound. Each new binding records `signoff_policy`, its event, and on FINAL `same_approver`. |
| **Disclosure, new versions only** | A sign-off recorded under the policy prints both approvers in the seal ("FINAL — reviewed by … on …; signed off by … on …"). The approval disclosures name both ("separate approvers"), or state that the same person reviewed and approved under the recorded solo-owner policy, with its date and reason. |
| **Version 6 preserved** | Bindings recorded before the policy keep NULL in the new columns and are not rewritten. Their pack renders byte for byte as before; nothing is inferred for them. |

**UI.** Sign-off shows the policy in force. A member who manages members changes it through the confirmation dialog
(a reason; for solo owner, the confirmation checkbox).

**Proof.** `scripts/db-proof/signoffPolicy.mjs`, 22/22, through the exact hosted artifacts. It covers:
- a pack sealed before the policy by one owner, byte-identical afterwards;
- default refusal; separate approvers both disclosed;
- who may set the policy; the confirmation and reason checks; replay; append-only; member-only reads;
- solo owner recorded and disclosed; a non-owner refused; the revert.

The self-checking wrapper proof (batch `reporting-r5`) passes 32/32. The browser journey asserts the two-approver seal
and disclosure.

## 4. Hosted steps (Lovable)

This release has **one migration** and a **frontend publish**.

1. **Preflight.** Run `docs/release/reporting-r5/preflight.sql` (read-only). Expect `PREFLIGHT OK`, and **record** the
   listed sign-offs (version 6's REVIEWED and FINAL).
2. **Apply.** Apply `release/wrappers/20261024100000_fs_signoff_approval_policy.wrapper.sql` as **one** migration,
   byte for byte (its final LF removed is also accepted). A refusal changes nothing.
3. **Postcondition.** Run `docs/release/reporting-r5/postcondition.sql` (read-only). Expect `POSTCONDITION OK.`; the
   sign-offs are identical to step 1, with the new columns NULL.
4. **Reload the API schema cache.** Run `NOTIFY pgrst, 'reload schema';`.
5. **Publish** the frontend at the release commit and hard-reload.
6. **Verify, read-only.** No new version or sign-off.
   - Sign-off shows "Sign-off policy: Separate approvers … (Default.)".
   - Exports › version 6 prints exactly as the r4 PDFs: the same seal text "FINAL — signed off by Humphrey (owner) …",
     with no reviewer line.
7. **Security view.** Mark `fspl_read`, `fspr_read` and `fssd_read` intentional with the §2 reason. Report the scan's
   status and date as shown.

**Not done here, and not to be done:**
- setting the solo-owner policy for the demo;
- re-signing anything;
- any new acceptance journey.

A demo with one identity can no longer finish a FINAL without either a second approver or a recorded solo-owner policy.
That is the intended effect, and a product/owner decision.

**Recovery.** The wrapper is atomic. Do not drop the policy: it is forward-only. To stop reporting, use
`docs/release/sql/04_deactivate_company.sql` or `05_kill_switch.sql`.

## 5. Limits retained

- **Live build identity:** not provable to a commit; hosted checks run on the preview.
- **J11 cross-workspace:** not run (no genuine second account).
- **Stale-result refusal** of a non-final version: proven only in automation.
- **Version 6:** its same-person approval stays as recorded; it is not retro-disclosed (it predates the policy).
- **Independent accounting validation:** outstanding. No compliance claim. General customer reporting stays off.
- **`DEFECT-REPORTING-PACK-SEAL-RACE-001`:** open; not reachable from the reporting routes.
