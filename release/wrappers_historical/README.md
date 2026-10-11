# Superseded wrappers (never applied; never submit)

| Wrapper | Bytes | SHA-256 | Why |
|---|---|---|---|
| `20261031100000_sandbox_licence_isolation.wrapper.sql` | 50,109 | `36bd80c0950a17d79586cd907b839e33529563ef51f222230bc83f1f17d4baa0` | Submitted once to the hosted database. It failed atomically with `PT422 CANCELLED_LICENCE_IMMUTABLE`; nothing was written and the journal stayed at 53. Superseded by `release/wrappers/20261031110000_sandbox_licence_isolation.wrapper.sql`. |

These files are kept byte for byte as the record of what was submitted. Their hashes are pinned in `scripts/db-proof/lib/parkedMigrations.mjs` (`SUPERSEDED_SUBMISSIONS`). They are not registered submission forms, so a hosted mirror of them fails the migration-authority guard closed.
