# IPSAS journey recovery record

Baseline: #229 at `8deb7edfca9445f0009d067b2a62a03401c03ad8`. All preceding F1-F5 repairs and #227 authority ordering remain inherited. Independent accounting/release acceptance remains outstanding.

## Findings and changes

1. **Disposable fixture invalidated its own prior-year certification.** `serveIpsas.mjs` reviewed company-wide mapping for each year. It now reviews once, certifies both sources, and explicitly verifies that both authoritative certifications remain available. No accounting SQL, certification predicate or financial expected value was relaxed.
2. **Save completion could refer to the previous operation.** The grants journey used persistent saved text plus 300ms. It now observes exactly one native UI-triggered save, its request identity/receipt, a context read with the same new revision, and that revision rendered by React. It does not invent a receipt, change an RPC response or retry a click. The observer is restored even if input fails.
3. **Coordinate input could use moving or disappeared targets.** The shared CDP driver called scrollIntoView without overriding CSS smooth scrolling and could press old coordinates if re-location returned null. It now foregrounds the page, uses instant scrolling, requires consecutive stable hit-tested enabled positions, and emits one native press/release pair. Covered/disappeared/disabled/never-settled targets are refused. The specific cause of each historical trusted-click failure is not independently reproduced in native Chrome here; actual download acceptance must be established by final-head CI, with existing one-click/one-POST/one-GET/exact-byte assertions unchanged.
4. **Loading was conflated with no open grant tasks.** Reproduced with a held context read: the child reported null before any answer, allowing the parent to display no open matters. It now distinguishes unknown/loading (undefined) from assessed/no-task (null), including unreadable or missing current assessments. A pending grants task cannot produce a completed preparation message. The reload journey waits on the authoritative task rather than an arbitrary delay.

## Local evidence and limits

- Loading regression reproduced before correction (expected not-null, observed null). Targeted regressions cover pending/error reads, pending-to-missing-register, stale banners, old context replies, matching network replies before render, one-save identity, observer restoration, and disabled/covered/disappeared/moving click targets.
- The existing actor/scope save and page-boundary tests are retained. SQL sources, staged transports, lock helpers, authority-ordering proof and financial expected outputs are unchanged from baseline.
- Build, typecheck, changed-file lint and exact-base inertness tests passed during implementation; final exact-head CI remains required.
- Contained local full suite: 6,991 passed, 10 skipped, 12 TODO (423 passed files, 1 skipped). Final focused suite after the last edit: 80 passed in 9 files. Exact-base inertness plus base-validation tests: 31 passed, zero skipped. These are different scopes, not additive acceptance counts.
- Full local test execution without the canonical CI environment was stopped by automatic approval review because existing tests could address an external Supabase host. No hosted effects are claimed verified. A materially safer run uses the existing CI configuration: synthetic credentials, `http://127.0.0.1:54321` and `scripts/ci/unitNetworkGuard.cjs`, which blocks external TCP/fetch. Results are reported separately; no uncontained run is accepted as proof.
- Disposable PostgreSQL cannot start as root here, and the container refuses runuser group changes. Downloaded local Chrome starts far enough to report version 156.0.8078.79 but cannot create its singleton socket (`Operation not permitted`). Consequently no local native-browser or native-DB pass is claimed. The CI jobs use their existing disposable services and headless Chrome; no workflow bypass or hosted fallback is introduced.

## Release boundary

No merge, installation, deployment, publication, activation, hosted read/write or paid service. Stage C is not started. The 160-scenario acceptance package has not been executed. Final-head CI and independent technical re-review are necessary before integration; accounting, hosted verification and official IPSAS issuance remain separate unfinished work.
