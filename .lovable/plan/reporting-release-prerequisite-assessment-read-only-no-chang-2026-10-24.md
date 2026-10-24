# Reporting release: prerequisite assessment (read-only, no changes made)

## Observed in this checkout
- HEAD = `09e6cf50f9d78af864c3d5ec50a36e2b9b0dea6b` (PR #193 merge).
- `supabase/migrations/` has none of `20261123100000`–`20261126100000`.
- `supabase/functions/compile-financial-report/` does not exist; `seal-reporting-pack/` exists.
- Last repository mirror is `0074_tb_decision_catalogue_read_predicate.sql`.
- Conclusion: the four migrations and the compile function arrive with #190/#192. Nothing can be identified, hashed or staged until those merge and this project syncs.

## 1. Recovery point
- No tool here lists, timestamps or restores backups, or reports PITR. PITR is not offered: daily snapshots, about 14 days kept, whole-database restore in place, storage files not included.
- Last owner-supplied evidence: a backup at Oct 22, 2026 01:23:39 UTC, from a screenshot. It is older than the release and is not a fresh point.
- Fresh point: UNCONFIRMED. The owner reads the newest UTC row at More → Database → Manage → Backups, and can optionally export first.

## 2. Tools available
- Migrations: the canonical journalled migrator (`lov_database--migration`). Text SQL in one transaction, no BEGIN/COMMIT. It writes the hosted journal row and the repository mirror. It cannot read a file by path, so large SQL uses the existing private staged transport (`scripts/release/stagedTransport.mjs` precedent): byte-verified inert stage plus a small per-batch apply.
- Read-only checks: query, linter, function logs, `functionClosure.mjs` for local closure digests.
- Functions: deploy by name, and invoke or curl for behaviour probes.

## 3. Blockers
- Not yet merged/synced: the 4 migrations and `compile-financial-report`. The exact bytes, hashes, stage forms and release-journal registration don't exist yet.
- Fresh recovery point: needs the owner to read the Backups page.
- Deployed-bundle verification: no supported download or attestation is available. A source-closure match plus a behaviour probe is the most that can be shown. Treat it as unavailable and owner-accepted, never as passed.
- Staged-transport stage rows for the new SQL must be created and byte-verified, as was done for the TB batches, before each apply.
- Each migrator submission may need owner approval. After any unclear result, re-read the journal tail before retrying.
- The reporting kill switch and rollout stay untouched; read-only checks confirm this before and after.

## Next owner actions
1. Merge #190/#192, then let the project sync.
2. Report the newest backup UTC timestamp.
3. Confirm the deployed-source exception is accepted again for these two functions.
