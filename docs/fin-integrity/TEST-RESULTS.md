# WS-A Financial Integrity — EXECUTED PROOF DETAIL (appendix)

> **This is the detail appendix. The single current status is
> [`docs/redesign-preview/RELEASE-CANDIDATE-STATUS.md`](../redesign-preview/RELEASE-CANDIDATE-STATUS.md).**
> Earlier, now-superseded figures are listed under § Superseded history. Where anything here disagrees with the status file,
> the status file is correct.

**Target:** legacy `statement_sign_offs` authorization. **Runtime:** no Docker/PG locally (embedded-PG fails on this
Windows host), so per the directive every proof runs as a **disposable CI database job** against a **PostgreSQL 17** service
container (GitHub Actions, `.github/workflows/signoff-proof.yml`). Synthetic fixtures only; loopback-only; the production
project ref is refused; no production credentials or data.

**Candidate SQL — byte-identical to what is tested:** the proofs apply the candidate file directly
(`docs/fin-integrity/candidate-migration/20261103100000_signoff_authorization_hardening.sql`) — what runs IS that file.
**sha256 `9c706f5e4a1252e0ec174e63c6d160970b431a9c855dd723435001a5deb4c279`** (identical in branch, proof, and ZIP
`candidate-migration/SHA256SUMS.txt`).

## Production-observed vs fixture-reproduced (distinguished per the directive)
- **Observed on the deployed database** (Lovable read-back, 2026-10-14, PostgreSQL 17): the live `statement_sign_offs` RLS
  policies, the four triggers (incl. the INSERT-only HESABU gate and the un-gated UPDATE that sets `preparer_signed_at`), and
  the over-broad `authenticated` grants (DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN). **Observed, not run by us.**
- **Reproduced in isolation** (CI, PG17): using those exact definitions, each defect is exercised and the candidate repair
  verified. **Fixture reproduction, not a claim of live exploitation** (the live cert-entitlement wall currently confines
  reachability to certification-entitled companies).

## Two proof tiers (both EXECUTED, green)

### 1. Full-chain integration proof — the authoritative §3 evidence
`scripts/db-proof/signoff_integration_proof.mjs` (CI step **INTEGRATION**). Replays the **entire authoritative migration
chain from zero on PostgreSQL 17**, then applies the **EXACT candidate migration**, and exercises the sign-off path through
the **real RLS policies, triggers and capability/entitlement functions** — not stubs (Practice-plan licence →
`STATEMENT_CERTIFICATION`; roles → capabilities). Every assertion green. Coverage:
- **Refused by real policies/triggers:** unauthorized INSERT bypass (A); draft-then-signed-UPDATE (A′); stale/failing
  validation (D); identity substitution (B); out-of-sequence lock (E); cross-tenant write (TENANT); excessive grants
  (TRUNCATE/DELETE) removed.
- **Authorized journey succeeds, records intact:** preparer → **distinct** reviewer → **distinct** approver → locked. Real
  segregation of duties (`enforce_sso_distinct_signers`) enforced; each signature bound to `auth.uid()` by the candidate. (The
  proof initially caught a test that reused one person as reviewer+approver — the real SoD control correctly refused it;
  corrected to three distinct members.)
- **Signing-vs-input-change RACE — two connections, controlled synchronization, BOTH commit orders** (replaces the earlier
  *sequential* stale check):
  - **Order A (input change commits first):** the approver's lock then executes → **refused**; no stale approval persisted.
  - **Order B (approver lock commits first):** approval persisted **sealed + locked**; the input then changes → the record is
    **immutable** and the current validation now **fails**, so the stale approval is **not usable** without re-validation.
  - Persisted approval validity is asserted in both orders.
- **Concurrency:** two independent connections sign the same `(company, period)` — exactly one commits, the other **refused**
  (no duplicate version, no partial state).
- **Replay contract:** a repeated identical request is **refused as a duplicate** (the legacy table has no idempotency key —
  distinct from the `fs_*` path's safe idempotent replay).
- **Locked-record immutability:** the locked, approved record cannot be mutated post-lock.
- **Candidate isolation (Task-4):** applied on the full chain, the repair trigger `enforce_signoff_authorization` binds
  **only** to `statement_sign_offs`, so the app's reachable `fs_*` sign-off/publication path is provably unaffected.

### 2. Focused fixture proof — supplement
`scripts/db-proof/signoff_fixture_proof.mjs`: the REAL `statement_sign_offs` table, the REAL trigger function bodies
(`hesabu_block_signoff`, `enforce_sso_distinct_signers`, `cascade_period_lock`,
`statement_sign_off_certification_wall`), the REAL final capability-split RLS policies (read back from production 2026-10-14),
and capability/entitlement-backed stubs; drives each defect as a simulated PostgREST `authenticated` caller (`SET ROLE` +
`request.jwt.claim.*`). **BEFORE** (no repair → every defect reproduces as the production read-back describes) → **AFTER**
(candidate applied → all five defects closed, over-broad grants contained, historical rows preserved, a legitimate correctly
-sequenced validated sign-off still succeeds). Supplements, does not replace, the integration proof.

## Real-app E2E vs the candidate (Task-4 confirmation)
The CI **Real application end to end (local Supabase stack)** job applies **`supabase/migrations/*` only** to a throwaway
database (ci.yml) — it does **not** apply this `docs/` candidate (deliberately kept out of `supabase/migrations/` to preserve
migration-journal parity). The **affected journey (sign-off) with the candidate applied** is therefore proven by the
full-chain integration proof above, which applies the candidate on the complete chain and runs the sign-off journey through
the real policies/triggers/functions. The candidate-isolation assertion additionally shows the candidate changes nothing on
the app's reachable `fs_*` path, so the E2E's reachable surface is unaffected by applying the candidate.

## Recovery (tested)
Recovery is **containment** — `REVOKE INSERT, UPDATE … FROM authenticated` — after which an authenticated signing write is
refused **and every historical row is preserved**. Recovery never does `DROP TRIGGER` (that would reopen signing) and never
GRANTs direct writes back without the enforcing path.

## Bug caught by the proof (fixed)
The first AFTER run failed — the repair had an invalid `RAISE … USING ERRCODE=…, NEW.upload_id` (format arg after `USING`).
Fixed to `RAISE … , NEW.upload_id USING ERRCODE=…`; re-run green. (A harness cross-run isolation bug — `auth` schema not
cleared between runs — was also fixed.) The MAINTAIN revoke is version-guarded (`server_version_num >= 170000`) so the
candidate also replays on PG16 contract jobs.

## Re-run
```
# CI: push to the branch, or `gh workflow run signoff-authorization-proof`
# Local (where a loopback PG17 exists):
DB_PROOF_CONN=postgres://postgres:postgres@127.0.0.1:5432/signoff_proof \
  SIGNOFF_PROOF_WITHOUT_REPAIR=1 node scripts/db-proof/signoff_fixture_proof.mjs   # demonstrate defects
DB_PROOF_CONN=postgres://postgres:postgres@127.0.0.1:5432/signoff_proof \
  node scripts/db-proof/signoff_fixture_proof.mjs                                  # verify repair
DB_PROOF_CONN=postgres://postgres:postgres@127.0.0.1:5432/signoff_proof \
  node scripts/db-proof/signoff_integration_proof.mjs                             # full chain + candidate + real policies
```

---

## Superseded history (dated — audit trail only, NOT current)
- **head `9dec395` (2026-10-14):** this file previously carried **two conflicting tables** — a fixture "BEFORE 9/9 → AFTER
  12/12" and an enhanced "BEFORE 11/11 → AFTER 17/17" — and described the full-chain integration proof as **"NOT YET RUN"**.
  All three statements are superseded: the fixture counts grew as assertions were added (the "9/9→12/12" was the earliest
  run), the integration proof **is** executed and green, and the stale "concurrency is only the fs_* path's design" caveat is
  replaced by the executed two-connection race above. The exact current assertion counts are whatever the linked CI run
  reports on the head SHA — this appendix no longer hard-codes a count that drifts as the suite grows.
