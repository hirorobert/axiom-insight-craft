# Reporting preparation: ranked workflow audit and bounded candidate

Date: 26 October 2026. Source baseline: `5b2f087ba35f898404cea83f839b5eaff8760b15` (PR #200 merged).
Scope: IFRS for SMEs 2015, two-year synthetic acceptance fixtures. This is not a full framework-coverage assessment or a completed hosted acceptance.

## Evidence and boundaries

The owner inspected normal preview routes for CFOClose Complete Test, FY2025 with FY2024 comparative. Screenshots show 18 unpresented accounts, no supplied cash-flow/equity evidence, no saved report version, 22 open note requirements, automatic non-applicability labels for PPE/revenue/tax, and manual comparative bridge controls. An open page is not proof of a successful write, approval or issuance.

A prior read-only hosted investigation found incorrect company mappings and certification snapshots for accumulated depreciation and cost of sales; the linked decisions recorded accepted machine suggestions. Bank loan was manually classified as current liabilities. Claude subsequently reported executed fresh-database reproduction of incorrect suggestions. This audit does not independently certify Claude's reproduction or deployed function identity.

PR #201 owns classification-rule correction. PR #202 owns finding-to-account correction and recheck. Both were open draft candidates when inspected. No changes to their files or branches are authorized by this candidate. Their test/CI claims require separate exact-head review. PR #200 owns search and has merged into this baseline.

## Ranked work

| Rank | Issue / evidence | Required user outcome | Ownership and stop point | Verification |
|---|---|---|---|---|
| 1 | Incorrect suggestions became confirmed company mappings; source file amounts are correct | Correct new suggestions; preserve reviewed decisions; explicit correction of existing mappings | #201; function deployment needed after review. No hosted data repair in that PR | Real handler with unchanged two-year fixtures, no mappings, mappings retained, independent expected totals |
| 2 | A finding asks for explanation without leading to the exact classification correction | Finding → scoped account → explicit decision → confirmed reprocessing → refreshed findings → accurate return status | #202; separate review. No automatic acceptance | Real browser/local backend; access revocation, lost response, retry, Back, reload and company/year isolation |
| 3 | PPE/revenue/tax show Not applicable while all assignments are missing | Distinguish missing presentation from genuine absence | This candidate: qualify automatic UI assessments and provide prerequisite action. Server status and readiness unchanged. Server contract improvement remains a separate follow-up | Component interaction tests for incomplete/complete composition, recorded decision preservation, viewer permissions, links and no writes |
| 4 | Statements banner names 18 assignments but the controls are below two empty tables | A visible action reaches the actual assignment section | This candidate: same-page assignment CTA and anchored section; no automatic assignments | Actual rendered href/target, prepare/viewer wording and existing assignment tests |
| 5 | Evidence location instruction on Notes says Sign-off although intake is on Statements | Direct scoped link to evidence intake, preserving selected version | This candidate: fix instruction and link to actual evidence anchor | Component navigation destination; anchor exists on Statements |
| 6 | Draft-save action does not identify draft vs approval | Clearly identify draft creation and remaining approval blockers | This candidate: draft button wording and explicit explanation; save semantics unchanged | Rendered sign-off control and explanation; existing preparation/commit tests |
| 7 | Policies editor is blank and selected title scrolls out of view | Explain expected entity-specific content; keep editor usable while scrolling | This candidate: neutral instructions, no invented policy text; bounded sticky desktop editor. No AI generation | Empty input remains empty; component accessibility; visual scroll/narrow-screen verification still required |
| 8 | Eighteen prior-year bridge controls appear before current presentation is complete | Explain prerequisite; later determine whether unchanged accounts need any bridges | This candidate: prerequisite notice only. Audit matching algorithm before changing it; do not create bridges or restatements | Compare no bridge vs required bridge under complete assignments in a separate reproduction |
| 9 | Accumulated-depreciation class-side credit still raises A01 after correct mapping | Governed contra treatment without changing arithmetic or hiding genuine exceptions | Separate design pending. Generic exemption is insufficient proof of safe treatment support | Request creation, exact bindings, actor authority, invalidation/replay, allowance/contra variants and genuine abnormal balances |
| 10 | Solo-owner policy action appears beside routine preparation | Keep policy changes clearly distinct from report preparation | Source inspection shows existing reason/acknowledgement confirmation dialog: missing-confirmation allegation withdrawn. Optional wording/discoverability follow-up | Existing sign-off policy tests; do not change separation policy |

## Precise changes in this candidate

- A presentation-only qualifier applies to automatic `not_applicable` schedule/revenue/tax results when the server composition is unavailable, has blockers/unpresented accounts, or lacks complete totals for available periods.
- Explicit recorded applicability decisions and edition-election status are not relabelled. Genuine server non-applicability remains visible when presentation is complete.
- Data-decided revenue/tax applicability does not offer manual applicability buttons: the server refuses those writes. Recorded judgment decisions for other conditional requirements remain available.
- The qualifier does not create a new accounting status, change blockers/counts, authorize schedule entry, or mark a requirement satisfied. It explains that the underlying automatic result cannot yet be relied on.
- Notes, Schedules and Comparatives provide a scoped preparation link using the existing route builder. Statements provides an actual assignment-section action. Evidence uses its own anchor.
- Policy guidance requests actual adopted policies and their working-paper source. It does not assert compliance, choose a policy or insert boilerplate.
- Draft saving remains the existing atomic server operation. Only the explanation and button label change.

## Server follow-up that must not be obscured

`fs_notes_status` in `20261111100000_fs_publication_controls.sql` reads composed line amounts for automatic revenue/tax applicability and carrying amounts for schedules. It can return `not_applicable` while presentation is incomplete. Composition/readiness blockers already prevent treating the report as ready, but the status contract itself deserves a separate forward-migration proposal for an explicit unavailable/incomplete assessment. This candidate is a UI mitigation, not a server contract repair. Never edit that installed migration.

The fix must eventually distinguish genuine zero/absence, excluded accounts, incomplete current presentation, incomplete comparatives, unsupported scope and unavailable reads. Do not manufacture a reviewer decision to compensate for absent input.

## Bounded definition of done

1. This candidate's UI tests demonstrate provisional versus final non-applicability, recorded-decision preservation, scoped destinations, no extra writes, viewer wording, blank policy text, evidence routing and draft-save wording.
2. Typecheck, lint, build, pack isolation and full canonical unit suite are run on the exact candidate; CI must independently finish on the final head. Report warnings and skipped checks honestly.
3. No classifier, correction-panel, financial calculation, database schema, API authority, provider model, payment/access setting or historical record changes.
4. No hosted installation, publication, API spending or Lovable agent message. No backend migration is required for this UI candidate.
5. CSS sticky/scroll behavior and real browser navigation remain unverified until an actual browser run; component tests are not substituted for that claim.

## Claude handoff: keep existing candidates bounded

Finish #201 and #202 under their current scopes. Use this audit as the follow-up backlog, not additional scope for classification-r1. Do not reimplement the preparation guidance if this candidate merges. Rebase and independently verify actual merged behavior first.

After those candidates, prioritize (a) server-level applicability-state accuracy and (b) safe assisted statement placement/comparative matching. Require evidence-bound proposals, explicit authorized confirmation, server compatibility validation, conflict handling and preserved historical decisions. Existing identical-account matches should be measured before proposing another matching mechanism. AI is not required for straightforward account identities or compatible-line rules.

Do not claim accountant acceptance, deployed-source attestation, complete IFRS/IPSAS support, or official issuance from this work.

## Owner retest after approved changes are deployed

1. Open the existing FY2025/FY2024 test company; retain both uploads.
2. Correct the reviewed classifications using the approved correction journey; decide loan maturity from the test facts and correct interest income if necessary. Recheck both years.
3. In Statements, use the assignment CTA and explicitly review compatible line assignments. Do not use statement placement to disguise a wrong classification.
4. Revisit Notes/Schedules: automatic applicability must reflect complete presented figures; required notes/schedules remain open until actually supplied.
5. Inspect Comparatives after assignments; bridge only genuinely unmatched or changed identities. Restatement is a distinct accounting action, never a navigation workaround.
6. Supply the approved synthetic supporting files, save a draft and verify amounts against EXPECTED_TOTALS.csv. Use the separate genuine reviewer for approvals. Do not weaken the policy to make testing pass.

No hosted test action has been executed by this candidate.
