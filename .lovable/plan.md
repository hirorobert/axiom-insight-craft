# Execute the tester-only release

## Verified starting point
- Source: `40c488d6`. Hosted journal: **83**. Reporting migrations will not be repeated.
- Global reporting switch is closed. The demo company is the only enabled company.
- Original seq 1/2 digest matches `de1e521b8731b1fc5f30ee4a15c17a0834838fb0530335696aceb5fda8f78642`.
- Bounded full suite: **6,338 passes**; two fixture suites require Git mutations blocked by the sandbox. Lint: **0 errors**, 177 warnings.

## Build and execute
1. Add a narrowly scoped assistant QA authority for the demo company and explicitly enrolled authenticated testers. QA sends synthetic fixtures only, has its own spend ceiling and results, and never records production evaluation/data-handling approval.
2. Register and test the assistant migration’s exact-byte transport, then install through the native journalled migrator. Preserve existing reporting history and keep production AI disabled.
3. Freeze prompt-v2 development configuration and results. Evaluate only with confirmed remaining provider credits and current prices; conservatively account for prior usage, unlogged probes and interrupted requests within the original **USD 5 total** budget.
4. Deploy checked functions and publish the matching tester frontend only after checks pass. Verify tester access and denied nonmember access through authenticated execution.
5. Run every available demo reporting check: new marked draft, stale refusal, save/recompile/readiness, distinct reviewer/approver, successor to v6, and sealed JSON byte hash. Reconcile exact new artifacts; close global reporting access first after supervised testing.

## Unavoidable access dependencies
- The identified demo owner’s managed test-session mint requires approval, but that approval is unavailable in this tool context. Normal owner sign-in or supported mint approval is needed for hosted browser execution.
- No second accepted demo member exists. Enroll one genuine test account with review authority; do not change the two-person policy.
- A secure API key exists, but the provider’s remaining credit balance is not established. No spending until available credits are confirmed.

## Technical constraints
- Server-enforced tester scope; no browser-storage permission checks, forged identities, customer financial context or production approval bypass.
- Native journalled exact-byte migrations only. No manual journals or installed reporting migration changes.
- Deployment-source attestation stays **UNRESOLVED** for public release; it does not block this owner-authorized limited test.
- No automatic expiry claim, payment changes, history deletion or independent accounting-approval claim.