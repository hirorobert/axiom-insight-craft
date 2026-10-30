# IPSAS CI recovery

Starting point: PR #229, `8deb7edfca9445f0009d067b2a62a03401c03ad8`.
Isolated branch: `fix/ipsas-ci-recovery`; existing worktrees remain untouched.

Applicable controls: AGENTS.md; charter P1/P2/P6, R13, G5/G8/G9 and sections 11.3-11.5. The charter is proposed, with adoption and accounting appointments unresolved; no exception or release authority is inferred.

Scope:
- Reproduce and repair the repeated shared-mapping review in the disposable fixture, preserving fresh certification checks.
- Make grants journey completion depend on this save's receipt and matching context read-back, not old status text or fixed sleeps.
- Make CDP mouse input use a stable, foreground, hit-tested target and exactly one native press/release; preserve download authorization and byte verification.
- Correct any reproduced false-complete loading state without weakening preparation or review gates.
- Add targeted behavioral regressions, run relevant checks and submit a focused candidate with exact-head CI evidence.

No merge, hosted access/change, installation, deployment, activation, paid service or external message. Inspect remote head before push; never overwrite a concurrent Claude commit.
