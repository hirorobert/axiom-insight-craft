# Interaction feedback and recovery

Base: `76a0f0ab0ac6549b65b3cb587fe4e4130600aa36` (account layout PR #185).

A page may open instantly. When work is pending, its feedback must describe the real operation, and a financial outcome must come from the server. This change addresses the released account, Trial Balance, Close Review, Financial Statements, sign-off, export and purchase journeys. It does not activate withheld services.

## Findings and implementation

| Surface | Finding at the base | Implementation | Authority and recovery |
|---|---|---|---|
| Lazy routes | Suspense rendered `null` | Labelled page status, delayed decorative skeletons | The actual lazy import mounts/unmounts feedback; no artificial route delay |
| Workspace/reporting access | Some checks rendered `null`; dashboard skeleton had no visible explanation | Visible account/access/workspace status | Existing access and scope guards remain authoritative |
| Portfolio | Text-only pending state | Structured placeholders and activity indicator; invalidate responses on unmount | Server paging, view token and latest-response checks retained |
| Company creation | Pending text existed; no synchronous form lock | Spinner, synchronous lock and disabled fields during submission | Existing `create_entity` request identity, capacity and permission checks retained |
| Company/profile/team settings | Some actions were silent or could be repeated before rendering; exception paths could leave busy set | Shared lock/indicator, pending buttons, protected company dialog, finally cleanup | Existing writers and server access controls retained; no automatic retries |
| Trial Balance intake | Real upload/check state machine and request identities already existed | Existing stages now also register app activity | No invented percentages, parsing stages or new processing requests |
| Finding decisions | Pending text existed; immediate re-entry could race | Synchronous guard and pending button | Existing expected revision and stable request identity retained |
| Close Review | Many controls only disabled; all action groups used render-time state | Visible action feedback and synchronous guards | Existing decision/proposal IDs and server refusal rules retained |
| Statements, notes, schedules, comparatives, comments and roll-forward | Uneven feedback; several comparative actions had none | Shared pending controls and locks, labelled reads | Inputs remain until confirmed success; recorded decisions still require explicit submission |
| Material confirmation | Escape/Cancel could close a submission in progress | Busy confirmation label; Cancel, Escape, reason and acknowledgement disabled during commit | No cancellation is implied; reason retained if the sign-off/policy response is uncertain |
| Sign-off | Hidden read errors; uncertain exceptions described as not recorded | Visible read recovery, truthful uncertainty text, stable policy-attempt identity | Existing saved version, dependency fingerprints, roles and server transaction boundaries unchanged |
| Official pack | Verify/retrieve silent; issue retries generated a new UUID; unfinished issuance hidden | Pending issue/verify/retrieve, stable attempt ID, unfinished issuance visible with Resume | Existing issuance ID resumes; a lost seal answer is reconciled through authenticated retrieval, never a replacement issuance |
| Checkout | Busy spinner existed but uncertain result left the purchase button available; exceptions could strand pending | Pending label/lock, explicit exception recovery, new submission blocked while outcome uncertain | Server/provider verification remains authoritative; no access inferred from a redirect |
| Global activity | No shared activity affordance | Non-blocking top bar driven by registered work and React Query | Concurrent registrations independent; completion/unmount removes each registration; no percentage |

`ActionButton` retains each workbench control's native styling. The styled `Button` exposes explicit `pending` and `pendingLabel` props; disabled is never interpreted as loading. Reduced-motion users receive static feedback. Pending status has accessible text, not colour alone.

## Existing financial safeguards inspected

- Company creation uses `create_entity` and a stable request ID; billing/capacity discovery still resolves before first-run routing.
- Trial Balance uses its existing upload flow reducer, processing attempts, same-request retries, finding revision identity and certification boundary.
- Close Review proposal/decision callers already pass request identities. This change adds local re-entry protection rather than substituting it for server controls.
- `fs_signoff_binding` and `fs_publication_controls` bind saved publications to document/dependency identities. Approval remains a server transition on a saved report version.
- Official issuance uses `issue_official_reporting_pack`; sealing, verification and retrieval continue only through the sanctioned `seal-reporting-pack` function. No browser pack construction or storage writes were added.
- Checkout uses existing provider verification, open-attempt conflict and payment recovery contracts. No provider, price, entitlement, payment state, SQL, Edge Function or live deployment was changed.

These are source findings, not a new certification of hosted configuration or payment acceptance.

## Verification

- New component tests hold promises unresolved, attempt same-tick duplicate submissions, check pending/disabled state, complete them, and verify activity cleanup and concurrent registration.
- Pending status tests cover delayed skeleton decoration, immediate ready content, absence of fake percentage and accessible names.
- Confirmation tests cover blocked Escape/Cancel and retained reason text during commit.
- Official-delivery tests cover stable request IDs, sealed replay, lost-answer reconciliation, existing-issuance resume and refusal without download.
- Checkout regression checks an uncertain result disables further submission and cannot start a second checkout.
- Full local unit run uses synthetic loopback Supabase configuration and a Node network guard that refuses external fetch/TCP before connection. The two full unit-suite CI steps use the same containment. Real-stack CI retains its existing isolated local services and browser journeys.
- Run TypeScript, lint, build and the full suite on the final commit. Required GitHub checks and screenshot artifacts are the release evidence; do not infer publication from their success.

## Boundaries and remaining limitations

- No email notification, browser financial-draft persistence or new background-job engine is introduced. Existing stored attempts, versions, issued packs and payments remain the recovery records.
- The local action lock lasts for the mounted component. Server controls, not that lock, handle multiple tabs and other users.
- Pack request identity survives retries in the mounted page; after refresh, the existing server issuance list exposes unfinished attempts. An expired or conflicting issuance may require a new explicit issuance; Resume never bypasses expiry or byte-integrity checks.
- A background refresh does not automatically block sign-off. The server's exact saved-version/dependency checks remain the approval boundary.
- This is a bounded improvement to the released journeys, not a claim that every legacy or withheld screen has been redesigned.
- Publication is the owner's final step after reviewing the synced Lovable preview.
