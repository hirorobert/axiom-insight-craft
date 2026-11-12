# Read-only evidence (2026-11-12 UTC)

Backend: ref bvyivmmfjejbmqoydezk, managed, not paused, Tiny instance.

## Edge Function deployment status / last-update timestamp
compile-financial-report, rfr-check-books, maono-cashflow, maono-risk, safisha-categorize,
safisha-efdms-ingest, safisha-score, process-trial-balance, trial-balance-layout, layout-assist,
safisha-pdf-extract: NOT VERIFIED (all 11). The available tools expose no function list,
version, status or updated_at metadata; no deployment-metadata read was possible.

## Secret SAFISHA_PDF_WORKER_URL
ABSENT. Read from the secret inventory (names only, 20 secrets); this name is not listed.

## Backups / PITR
NOT VERIFIED. No tool reads the backup inventory. Per documented platform behaviour, PITR is
not offered; daily snapshots are visible only in More → Database → Manage → Backups (UTC).
Most recent snapshot timestamp: NOT VERIFIED.

No changes made.
