# Usable no-spend assistant tester

- Replace access-only QA with an owner-authenticated, synthetic-only SIMULATED mode using the existing assistant handler, validator and fact renderer with a deterministic fake provider.
- Expose explanation, editable draft, stale-context, access-loss and invalid-answer cases; preserve request identity on uncertain responses and explicit replay.
- Keep customer AI, paid provider calls and reporting access disabled. Test caps and isolation without production approvals or financial writes.
- Verify relevant tests, repository lint and preview. Complete available transport/reporting preparation, report exact unsupported operations and normal reviewer setup steps.

## Technical details

Simulation uses isolated in-memory reservation infrastructure only; it cannot call production reservation RPCs. Cross-worker replay is deterministic recomputation, not a durable ledger. Paid mode remains unavailable until its independently journalled QA authority and spend ledger are installed.