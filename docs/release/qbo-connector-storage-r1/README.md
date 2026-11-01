# QuickBooks Online connector storage (B9), release record r1

**Status: authored and proved on a disposable database; NOT applied to any hosted database; no deployed Edge Function uses it.** Migration:
`supabase/migrations/20261212100000_qbo_connector_storage.sql` (an unapplied candidate; it is listed as `PENDING_HOSTED_APPLY` by `scripts/ci/assertMigrationAuthority.mjs`).
Design: `docs/architecture/QUICKBOOKS_ONLINE_CONNECTOR_PLAN.md` section 12, approved by the owner on 2026-11-01 (decision D3).
Team (charter section 9, row B9): technical owner Hendry R Sawe, CPA; accounting author Humphrey R Sawe, ACPA; independent reviewer Patrick R Sawe, CPA, as confirmed by the owner. The reviewer's independence declaration is still outstanding.
The independent review of this migration and the response to it: **`docs/release/qbo-connector-review-r1/README.md`** (nine findings, each with evidence, severity, correction, test and remaining risk).

## What it adds

| Object | Purpose | Who can touch it |
|---|---|---|
| `qbo_connections` | One live connection per company + QuickBooks company (realm) + environment. The refresh token is stored **only** as an AES-256-GCM envelope; a connection that is not `active` holds no token at all. Carries a short refresh **lease**. | No client role. The service role may read it (the Edge Function opens the envelope) and writes only through the functions. |
| `qbo_oauth_states` | Single-use anti-forgery state, stored as a SHA-256 hash, valid 60 s to 30 min, with the workspace period year the browser returns to. | No client role; functions only. |
| `qbo_pull_intents` | **Append-only, written before the file is stored.** The facts of a fetched report (request, currency, three SHA-256 fingerprints, the actor and the basis of both rights), keyed by the upload reservation. | The workspace owner reads; only `qbo_record_pull_intent` writes. |
| `qbo_pulls` | **Append-only provenance per import**, written from an intent and the upload the reservation itself created. No token, URL or payload; no foreign keys. | The workspace owner reads; only `qbo_complete_pull` writes. |
| `qbo_connector_basis(user, company)` | The one rule: **both** `prepare_trial_balance` and `manage_source_files`, each from `workspace_authority_basis`. Used by every function below. | Nobody (internal) |
| `qbo_start_oauth_state`, `qbo_record_oauth_return`, `qbo_take_oauth_return`, `qbo_store_connection`, `qbo_acquire_refresh_lease`, `qbo_release_refresh_lease`, `qbo_rotate_refresh_token`, `qbo_mark_reconnect_needed`, `qbo_disconnect`, `qbo_record_pull_intent`, `qbo_complete_pull`, `qbo_complete_pending_pulls`, `qbo_housekeeping`, `qbo_provenance_past_retention` | The only writers and maintenance. SECURITY DEFINER, pinned `search_path`, service role only. | Service role |
| `qbo_connection_status(company)` | What a member may see: id, realm, environment, status, expiry. Never an envelope, key id or token. Returns nothing without both rights. | Authenticated, only with both rights |

**Refresh tokens roll over, so two protections:** a lease taken *before* Intuit is called (a second simultaneous import is told "busy" without any call), and a compare-and-swap on the stored envelope when the new token is stored.
The lease has its own id, returned only to the caller that took it, and only that id releases it (an import whose lease lapsed cannot clear the next holder's lease). The rotation is safe to retry (a retry after a lost answer is recognised, not reported as a lost race), and `qbo_mark_reconnect_needed` deletes only the token Intuit actually refused, never a newer one another import has stored (review r2, `docs/release/qbo-connector-review-r1/README.md` §Second pass).
**A connection is stored only for the person who started it** (review r2, S4; design in `docs/release/qbo-connector-review-r1/S4_CALLBACK_BINDING_DESIGN.md`): `qbo_record_oauth_return` parks the authorisation code sealed with the hash of a one-time handoff code (5 minutes), and `qbo_take_oauth_return` hands it back, once, only to that signed-in person while they still hold both rights; every answer, and housekeeping after expiry, deletes the parked code.
**Evidence is written first and linked after:** if the intent cannot be written nothing is stored; if only the link fails the evidence is already complete and `qbo_complete_pending_pulls` finishes it.

## Evidence

`scripts/db-proof/qboConnectorStorage.mjs`: **42 of 42 cases pass** on the full migration chain in a disposable loopback database (synthetic data; no Intuit call; no real token), including a real `reserve_trial_balance_source` -> intent -> `register_trial_balance_upload` -> complete. It runs in CI
(step "QuickBooks connector storage proof") and its result is validated against `qboConnectorStorage.manifest.mjs`.
**Negative controls:** the migration was deliberately broken six ways (the evidence function without the upload right, a lease anyone can take, no append-only guard on intents, linking an upload the reservation did not vouch for, housekeeping that deletes evidence, the shared rule
forgetting the upload right); each failed the proof at the intended case; the migration was restored after each run. Details in the review record.
Three more for the second pass (a release that ignores the lease id, a reconnect mark that ignores which token was refused, a rotation that is not safe to retry): each failed the proof at its new case.
Three for S4 (a take that ignores who started the attempt, a take that can be repeated and keeps the code, housekeeping that keeps expired codes): each was caught (the repeatable take at all three cases that check the code is deleted).

## Not claimed, and for the independent reviewer

- **Nothing is connected to QuickBooks.** No function is deployed, no token has ever been stored by this schema.
- **Not applied hosted.** Applying it needs the repository's release route (a reviewed staged transport and the hosted migrator), which is a separate step that needs the owner's explicit approval. No transport has been generated.
- **Actor identity** (`actor_user_id` plus the basis of each right, not `firm_members.id` as in CLAUDE.md section 4.3): the reasons and the evidence are in the review record, finding 1. **The reviewer's confirmation is still needed.**
- **Retention.** OAuth states and dead tokens are cleaned by `qbo_housekeeping()` (opportunistic, no scheduler). The evidence tables keep seven years and **no purge mechanism ships** (the first row cannot be due before late 2033; a purge must be designed and approved before then). `qbo_provenance_past_retention` only counts.
- **Deleting a workspace** deletes its connections and states (foreign key with cascade) and keeps the evidence tables (no foreign keys, by design; they hold no figure, name, email or token). **Whether that is acceptable is for the lawyer's written conclusion, which is still missing.** The proposed policy and the questions are in the review record, finding 3.
- The token envelope key is held in an Edge Function secret that does not exist yet; creating it is the owner's step and its value is never shared with an agent.
