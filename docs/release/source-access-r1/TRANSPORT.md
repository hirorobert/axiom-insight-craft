# Source-access exact-byte transport (20261211100000)

**Status: INSTALLED on 2026-10-31 as hosted ids 98 (bootstrap) and 99 (apply); see `HOSTED_RECORD.md` for what was observed.** This file
describes the transport as prepared; it was written before the install and is kept for the rules it states. The download function was
deployed separately afterwards, and customer visibility is a separate decision.

## What it installs

`supabase/migrations/20261211100000_source_access_authority_repairs.sql` (25,437 B, SHA-256 `be582111...b344`), which:

- adds a trigger on `firm_members` that ends a removed member's explicit workspace grants in the same transaction;
- adds the append-only `trial_balance_source_download_events` table;
- adds the two service-role-only functions `decide_trial_balance_source_download_issuance` and `record_trial_balance_source_download_denial`.

## Steps, in order (each is ONE file, run as ONE statement, byte for byte)

| Step | File | Journal id it needs / creates |
|---|---|---|
| 1 | `release/staged-transport-source-access/00_source_access_staged_transport.sql` (bootstrap) | needs head 97; becomes 98 |
| 2 | `release/staged-transport-source-access/stage/1_source-access-1.source.sql` (stage the source) | none: a plain INSERT, no journal entry |
| 3 | `release/staged-transport-source-access/10_source_access_1_staged_apply.sql` (apply) | needs head 98; becomes 99 |

The staging INSERT must run through a connection that owns the private schema `cfoclose_source_access_release` (an application role is
refused by design). The database accepts only a body of exactly 25,437 bytes with the pinned hash; a wrong copy is refused and stores nothing.

## Why head 97 is accepted in four forms

Hosted id 97 is not the reviewed statement-review wrapper: it has one extra space on one line (docs/release/ipsas-accrual-chain-r1/HOSTED_RECORD.md,
decision pending the reviewer). The bootstrap therefore accepts the reviewed wrapper and the installed variant, each with and without the
migrator's final LF, and requires exactly ONE of them at id 97. The hash actually recorded is `023484a1...7c17`.

## What the apply refuses (and rolls back)

Wrong or extra journal head; a missing prerequisite (`workspace_authority_basis`, `_plan_write_lock`, `tbu_append_only_guard`, the grant and
membership tables); ANY of the objects it creates already existing; a staged body that differs by one byte; a changed preserved row (earlier
IPSAS records, rollout and settings, and, because it adds a trigger to `firm_members` and acts on grants, grants, grant events and memberships);
an unexpected privilege on the installed objects.

## Two properties specific to this source

- It sets its own `SET search_path TO public, pg_catalog;`. The apply restores the ORIGINAL path at SESSION level afterwards; a
  transaction-local restore would let that SET outlive the commit on the migrator's connection (the proof demonstrates the leak and the fix).
  Because the source sets its own path first, the transport's pin cannot change how its unqualified `gen_random_uuid()` binds: the
  installation equals a direct application under every session path, which is what is proved.
- Install by submitting each file's bytes UNCHANGED. The previous install drifted by one space when an agent re-typed a wrapper; before
  approving any prompt, hash the SQL shown and compare it with the committed file.

## Evidence

`scripts/db-proof/sourceAccessTransport.mjs` (26 cases, disposable loopback database, real predecessor chain) and
`src/lib/__tests__/sourceAccessStagedTransport.test.ts`. Hosted applicability was NOT re-verified when this was prepared: the transport itself
refuses unless the hosted journal head is exactly one of the four recorded forms of id 97.
