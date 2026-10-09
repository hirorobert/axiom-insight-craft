# Reporting r4: export print layout, and the r3 hosted acceptance reconciled

Demo company `659daa94-116c-4803-99f8-157e0bdd4c62`. Report `fsr-2025-…`: versions 1–5 DRAFT, **version 6 FINAL**
(sealed; stale after the J9 wording change, by design). Nothing in this release touches the demo, version 6, its
evidence or its bindings. **Frontend only:** publish required. No migration, no Edge Function, no data change.
Reporting stays demo-only. The figures are synthetic, and the accounting is **not independently validated**.

## 1. Defect corrected: the printed export included the workspace

`FY2025-v6-final.pdf` (hosted, 2 pages) had two problems:

- **Workspace chrome printed.** Its first page held the navigation (Overview … Sign-off & Exports), the next-action
  text ("Version 6 is signed off · Export the sealed report"), the version links and the buttons.
- **Report clipped.** The report was cut off after the first statement, because the on-screen preview frame (70vh)
  printed as a clipped box. The seal's 64-character hashes were truncated at the right edge.

**Cause.** The browser prints the page it shows. Only the button printed the frame's own document. Printing from the
browser printed the workspace.

**Correction.**
- `src/lib/exports/printHost.ts` and `ExportsView.tsx`: the pack is printed from a host placed directly under
  `<body>`, outside the application root, with the pack in a shadow root.
- While the Exports page is open, a print rule hides every other child of `<body>`. The button now calls
  `window.print()`, so both ways of printing give the same result: only the full pack.
- The host is removed when the user leaves Exports, so other pages print as before.
- The pack's banner wraps long hashes (`overflow-wrap:anywhere`).

**Note on HTML bytes.** The rendered pack HTML changes by that one CSS rule, so a re-downloaded HTML file will not
byte-match the earlier one. The seal's content and dependency hashes are of the stored document and binding, and are
unchanged.

**Verified** (headless Chrome, the real Exports page, `reportingJourney.mjs`: 20/20):
- Under print media, only the host is displayed. The workspace root is not.
- The pack text contains none of the workspace strings. It has the full seal with both 64-character hashes, the last
  statement, and the "Approval disclosures" section.
- The page PDF has exactly the page count of the pack printed on its own: **5 pages**, against the hosted 2.
- Independent extraction of the page PDF (pypdf) found no workspace text, two complete hashes, the disclosures and
  total comprehensive income.
- Leaving Exports removes the host.

**Why the earlier proof missed it.** It printed the pack's HTML in a fresh page, never the Exports page itself. It now
does both.

## 2. Approvals and the configured policy

| Point | Fact | Classification |
|---|---|---|
| What the "solo-owner" policy governs | `close_review_approval_policy_events` (`two_person` / `owner_self_approval`, `20261015100000`) governs **Close Review adjustments only**: who may approve an adjustment. It does not govern statement sign-off. | Scope fact |
| Adjustment disclosures | The demo approved no adjustment. The pack's "No adjustment was approved or revalidated by its own proposer" is accurate. A self-approved or self-revalidated adjustment would be listed by number, amount and reason. | Satisfied |
| Sign-off authority | REVIEWED needs `review_close`. FINAL needs `approve_certification`, only after REVIEWED, only for the latest version, and FINAL is immutable (`fs_set_publication_state`). The owner holds both. Each binding records the authenticated approver (user, membership, role, the display name on record), and the seal names the FINAL approver ("Humphrey (owner)"). | Satisfied |
| Same person for REVIEWED and FINAL | The server has **no rule** requiring different people for REVIEWED and FINAL, and the pack shows only the FINAL approver. The fact that one person did both is recorded in the bindings, but **not disclosed in the pack**. | **Design gap, not a defect.** Requires a product decision: (a) require separation, (b) allow it under a recorded solo-owner sign-off policy, or (c) at minimum disclose a same-person REVIEWED/FINAL in the pack's approval disclosures. Not changed here. |

Read-only confirmation for the hosted record:

```sql
SELECT policy, override_multiple_approvers, reason, created_at FROM public.close_review_approval_policy_events
 WHERE company_id = '659daa94-116c-4803-99f8-157e0bdd4c62' ORDER BY seq;
SELECT report_version, state, approver_user_id, approver_role, approver_display_name, approved_at FROM public.fs_publication_bindings
 WHERE report_id = 'fsr-2025-659daa94-116c-4803-99f8-157e0bdd4c62' ORDER BY approved_at;
SELECT count(*) AS adjustments FROM public.close_review_adjustments WHERE company_id = '659daa94-116c-4803-99f8-157e0bdd4c62';
```

## 3. Evidence for J9, as two separate items

| Item | Hosted (r3 close-out) | Automated proof |
|---|---|---|
| **Stale warning on a signed version.** A later change leaves FINAL sealed but stale, and the next action is "Save a new report version". | **Observed.** v6 shows `REPORTING_DEPENDENCIES_STALE`, the next action matches, and the v6 fingerprint is unchanged. | `reportingWorkbench.mjs`, `reportingJourney.mjs` ("a later change…") |
| **FINAL immutability.** A FINAL version cannot be re-signed. | **Observed.** REVIEWED on v6 → `409 PT409 CONFLICT: a FINAL report version is immutable`. | `signoffBinding.mjs` |
| **Stale-result refusal.** Signing a non-final version whose dependencies changed is refused by name. | **Not exercised on the hosted app.** The refusal observed was immutability, not staleness. | `readinessReadOnly.mjs` (REVIEWED on a stale draft refused, naming `REPORTING_DEPENDENCIES_STALE`); `acceptanceFixtures.mjs` (refused); `cashPerimeterScope.mjs` (after a mapping change, no new version is saved on the stale authority) |

## 4. Hosted journey reconciled with the automated proofs

| Hosted step (r1–r3) | Hosted result | Automated proof |
|---|---|---|
| J1 navigation (reporting groups, Close Review › Findings) | PASS | `activation.test.ts` |
| J2–J3 statements, notes, schedules, comparatives | PASS | `reportingWorkbench.mjs`, `reportingJourney.mjs`, `acceptanceFixtures.mjs` |
| A5 readiness readable (D-2) | PASS after `20261023100000` | `readinessReadOnly.mjs` |
| J4 Close Review gate | PASS | `readinessReadOnly.mjs`, `acceptanceFixtures.mjs` |
| J5 findings explained | PASS | `closeReviewAuthority.mjs` |
| J6 figures (D-3 fixed; all 10 rows) | PASS | `cashPerimeterScope.mjs`, `acceptanceFixtures.mjs` |
| J7 REVIEWED + FINAL | PASS, same owner (§2) | `signoffBinding.mjs` (by role) |
| J8 exports | PASS for content and seal. **FAIL for print layout** (corrected here) | `reportingJourney.mjs` (page print) |
| J9 | Stale warning and immutability PASS; stale-refusal not exercised (§3) | §3 |
| J10 non-enabled company | PASS | `activation.test.ts`, `acceptanceFixtures.mjs` |
| J11 cross-workspace | **NOT RUN** (no genuine second account) | `reportingWorkbench.mjs`, `reportingJourney.mjs` (another workspace refused) |

## 5. Remaining hosted limits

- **Live build identity.** The live site exposes no commit SHA, and the reporting code is a lazy chunk. The r3 journey
  ran on the preview at exactly `1c215eb`. The live publish is not proven to the commit.
- **J11 not run.** It needs a genuine second account.
- **Stale-result refusal** of a non-final version: proven only in automation.
- **Same-person REVIEWED/FINAL:** undisclosed in the pack (§2). Needs a product decision.
- **Independent accounting validation:** outstanding. No compliance claim. General customer reporting stays off.
- `DEFECT-REPORTING-PACK-SEAL-RACE-001`: open, and not reachable from the reporting routes.

## Hosted steps (Lovable). No uploads, no new version, no data change.

1. Publish the frontend at the release commit named in the package.
2. Hard-reload the app. As the demo owner, open Sign-off & Exports › Exports for **version 6**.
3. Use **"Print / save as PDF"** and save the PDF. Then also try the browser's own print (Ctrl+P / Cmd+P).
   **Expected**, both ways:
   - page 1 starts with the FINAL seal;
   - there is no navigation, button, version list or next-action text;
   - both 64-character hashes are complete;
   - the whole report through "Approval disclosures" is present (about 5 pages).
4. Optionally run §2's read-only SQL and attach the output.
