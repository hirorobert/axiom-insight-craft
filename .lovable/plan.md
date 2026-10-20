# FS close-out: answers to the three questions (no changes made)

## 1. Backup / point-in-time recovery evidence
- I have no tool that reads backups. The backend tools I can use are status, health, logs, linter, read-only query, data-change SQL, migration, functions and storage settings. None of them lists, timestamps or restores backups, and none reports whether point-in-time recovery is available.
- Documented capability: one automatic database backup per day, kept for about 14 days. No point-in-time recovery. Restores are whole-database and in place only. Storage files are not included.
- Where you can see it: More → Database → Manage → Backups. Each row shows its snapshot time in UTC and has a "Restore to this backup" button. That page is the only source of a real recovery point. RECOVERY_POINT stays UNCONFIRMED until you read the newest UTC timestamp there.

## 2. Migration tool behaviour (from its own definition)
- Input: the full SQL as one text parameter, plus an optional short name. It cannot read a file by path. It refuses transaction-control statements (BEGIN, COMMIT, ROLLBACK) because it manages the transaction itself.
- What it does with that text: everything runs in one transaction. A successful run writes the hosted journal row (hash = SHA-256 of the submitted text) in that same transaction. It also creates the repository mirror (`drizzle/migrations/NNNN_<name>.sql`, `meta/NNNN_snapshot.json`, a `_journal.json` entry) and regenerates the types. This matches what happened with currency-c1 (id 64).
- Not documented anywhere I can see:
  - automatic retries;
  - timeout limits;
  - whether a timeout on the client side can hide a commit that actually happened.
- Practical rule: after any unclear result, read the hosted journal tail and the catalogue before you submit again. Never resubmit just because the result was unclear.
- Each submission may need your approval before it runs.

## 3. Getting a backup or export without exposing credentials
- Supported route: More → Database → Manage → Settings → Export project data → Database → Export → Start export.
  - You get a download link by email, and a copy is also saved under More → Storage.
  - It contains the full schema and data, including user accounts with their password hashes.
  - It does not contain storage files, function code, secrets or sign-in provider settings.
  - Limits: one export per 24 hours, databases up to 15 GB, export files up to 5 GB. The backend must be running.
- No credentials are needed. The service-role key and the database password are not available on Lovable Cloud, and you don't need to reset either.
- Storage files have to be downloaded separately from More → Storage.

## Remaining owner actions
1. Read the newest backup timestamp (UTC) on the Backups page. That is your recovery point.
2. Optionally, take an export before applying the release.
