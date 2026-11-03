# QuickBooks readiness r2 — canonical release package

Status: authored and registered, **not installed or deployed**. Customer activation remains off.

Source controls merged in PR #247 at `8d00f99bb4df9e2f825c97344389a88a77cf67df`; all nine automated jobs passed on its tested head. The original 17,890-byte candidate remains unchanged, SHA-256 `00cb216ee96596fb1bb81a27e652d8ef701ac0b175bca25ca3bda206da1cca7f`. Its manifest describes the historical inert candidate, not the promoted migration.

The new canonical source is `supabase/migrations/20261214100000_qbo_readiness_controls.sql`. Run `node scripts/release/qboReadinessPromotion.mjs --check` to verify deterministic promotion. The PostgreSQL lexer identifies and preserves every non-transaction statement verbatim. The candidate's outer BEGIN/COMMIT become one canonical DO envelope; a late failure rolls back all earlier statements. `SUBMISSION_FORMS` registers only the exact 20,040-byte source (SHA-256 `6ac1c74c46171138915d936191beff45d26ca92abb6f7a820d0d73aadf0ddcd8`) and its single-final-LF-removed form. Do not submit the original candidate or reconstruct SQL in a query editor. No installed migration or journal mirror is edited.

Applicable charter targets: P1/P6 and R14, immutable provenance and server-owned authorization. Charter remains proposed and unadopted; this release is not accounting certification.

## Execution order

1. Verify this package's exact-head CI, including the native PostgreSQL readiness proof. That proof now applies the canonical envelope, injects a late failure to prove rollback, refuses accidental replay, and exercises the existing authorization/concurrency/provenance cases. Obtain current DB and Storage recovery evidence before hosted installation.
2. Through the canonical journalled migrator, read the current hosted journal and verify the installed CF-03 and QBO storage fingerprints. They are already installed; **never apply them again**. Capture historical upload/provenance, publication bindings, pack issuances and sign-off counts/digests. Verify readiness objects are absent. If present or journal outcome is ambiguous, inspect first; do not retry installation blindly.
3. Submit only the registered readiness source through that migrator, preserving its atomic transaction with the journal receipt. Verify journal bytes/hash and resulting schema. Use the existing README's postchecks: RLS/private token material, service-only writers, authenticated own-actor pending identities, full-import lease, immutable fiscal provenance and unchanged historical evidence.
4. Only after SQL verification, deploy the five functions and their shared closures from `deployment-manifest.json`. `supabase/config.toml` explicitly pins JWT verification: callback false; connect, finish, pull and disconnect true. Handlers independently authenticate/validate state. Manifest hashes prove prepared source, not deployed source. Download deployed bundles and compare when the deployment system supports this; otherwise record unavailable attestation.
5. Publish the matching frontend. Exercise signed-out refusal, forged URL no-op, authorized connection management, stable pending-revoke retry, identity change, confirmed fiscal period import, and import/disconnect races against the sandbox. Compare a fresh import independently with an Intuit source export. Preserve original import history.
6. Production activation is a separate boundary: Intuit assessment approval and production credentials, legal/data retention decisions, registered URLs and completed acceptance evidence. Do not enable the customer flag merely because source merged or sandbox SQL installed.

## Access at preparation time

No Lovable AI request was used for this package. This session has no authenticated Supabase deployment tool, `SUPABASE_ACCESS_TOKEN`, database password or canonical migrator connection. The GitHub connector can merge source but cannot install hosted SQL or deploy Edge Functions. Frontend publishing alone would leave those dependencies unfinished, so publication is not used as a substitute.
