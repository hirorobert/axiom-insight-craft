# QuickBooks Online connector storage (B9), release record r1

**Status: authored and proved on a disposable database; NOT applied to any hosted database; no Edge Function uses it yet.** Migration:
`supabase/migrations/20261212100000_qbo_connector_storage.sql` (an unapplied candidate; it is listed as `PENDING_HOSTED_APPLY` by `scripts/ci/assertMigrationAuthority.mjs`).
Design: `docs/architecture/QUICKBOOKS_ONLINE_CONNECTOR_PLAN.md` section 12, approved by the owner on 2026-11-01 (decision D3).
Team (charter section 9, row B9): technical owner Hendry R Sawe, CPA; accounting author Humphrey R Sawe, ACPA; independent reviewer Patrick R Sawe, CPA, as confirmed by the owner. The reviewer's independence declaration is still outstanding.

## What it adds

| Object | Purpose | Who can touch it |
|---|---|---|
| `qbo_connections` | One live connection per company + QuickBooks company (realm) + environment. The refresh token is stored **only** as an AES-256-GCM envelope; a connection that is not `active` holds no token at all. | No client role. The service role may read it (the Edge Function opens the envelope) and writes only through the functions. |
| `qbo_oauth_states` | Single-use anti-forgery state, stored as a SHA-256 hash, valid 60 s to 30 min. | No client role; functions only. |
| `qbo_pulls` | Append-only provenance per import: request parameters, currency, and the SHA-256 of the raw response, the canonical file and the normalised result. No token, URL or payload; no foreign keys. | The workspace owner reads; only `qbo_record_pull` writes. |
| `qbo_start_oauth_state`, `qbo_consume_oauth_state`, `qbo_store_connection`, `qbo_rotate_refresh_token`, `qbo_mark_reconnect_needed`, `qbo_disconnect`, `qbo_record_pull` | The only writers. SECURITY DEFINER, pinned `search_path`, service role only. Each judges the actor with `workspace_authority_basis(actor, company, 'prepare_trial_balance')`. | Service role |
| `qbo_connection_status(company)` | What a member may see: id, realm, environment, status, expiry. Never an envelope, key id or token. | Authenticated, only with the right |

Rotation is a compare-and-swap on the stored envelope: two concurrent refreshes cannot both win.

## Evidence

`scripts/db-proof/qboConnectorStorage.mjs`: **24 of 24 cases pass** on the full migration chain in a disposable loopback database (synthetic data; no Intuit call; no real token). It runs in CI
(step "QuickBooks connector storage proof") and its result is validated against `qboConnectorStorage.manifest.mjs`.
**Negative control:** with the migration deliberately weakened (clients granted SELECT on `qbo_connections` and INSERT on `qbo_oauth_states`, the `qbo_pulls` append-only trigger dropped), exactly three
cases fail (`clients.cannot-read-or-write...`, `pull.is-append-only...`, `structure.row-level-security...`); the migration was then restored byte for byte.

## Not claimed, and for the independent reviewer

- **Nothing is connected to QuickBooks.** No connect or pull Edge Function, no browser flow, no token has ever been stored by this schema.
- **Not applied hosted.** Applying it needs the repository's release route (a reviewed staged transport and the hosted migrator), which is a separate step that needs the owner's explicit approval. No transport has been generated.
- **Actor identity.** The actor is `actor_user_id` judged through `workspace_authority_basis`, as in `trial_balance_source_download_events`, not `firm_members.id` as in CLAUDE.md section 4.3. This follows the current workspace-authority model; the reviewer should confirm that is the intended convention for B9.
- **Cleanup of expired OAuth states** is not implemented (an expired state is refused and harmless, but rows accumulate); a retention job is a later, separate change.
- **Deleting a workspace deletes its connections and states** (foreign key with cascade) but keeps `qbo_pulls` (no foreign keys, by design). Whether provenance should survive workspace deletion is a policy the owner and lawyer may revisit.
- **Retention of `qbo_pulls`** follows the owner-approved 7-year recommendation only when a retention job exists; none does yet.
- The token envelope key is held in an Edge Function secret that does not exist yet; creating it is the owner's step and its value is never shared with an agent.
