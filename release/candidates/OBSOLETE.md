# OBSOLETE: do not apply anything in this folder

**Handoff r5 (`release-handoff-20261005-r5`) and these candidate files are void as of 2026-10-05.**

## Why
Lovable applied a different migration as hosted journal entry **0027**: the account-review digest fix
`supabase/migrations/20261003100000_account_review_digest_schema_qualification.sql`. It has hash `2776fc2b…` and
when `1791137643914`.

r5 proposed its own `0027_apply_20261004100000_…` and `0028_apply_20261005100000_…` entries after hosted 0026. Two
things no longer hold:
- **The numbering is taken:** hosted 0027 is now the digest fix.
- **The inspection would refuse:** `inspect_release_2026_10.sql` is anchored on 0026 being the latest pre-release row,
  so it would now read INCONSISTENT.

## Status
- `20261004100000` (reconciliation server authority) and `20261005100000` (SAFISHA ingestion authority) remain
  **parked**: authored and pending hosted apply (`PENDING_HOSTED_APPLY`), not part of the Trial balance review release.
- The files here, `scripts/release/guardedEntry.mjs`, and the proofs `scripts/db-proof/hostedExecutorRelease.mjs` and
  `migratorRelease.mjs` are kept unchanged for reference only. The proofs are **retired from CI**.
- **Not renamed, not rebuilt, not applied.** If the reconciliation work is resumed, it needs a new reviewed handoff
  against the hosted journal as it is then. That handoff must renumber after the latest hosted entry and re-anchor the
  inspection on it.
