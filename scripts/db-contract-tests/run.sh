#!/usr/bin/env bash
# Ω∞ A+ closure — disposable-Postgres CI contract test harness entry point.
#
# Never runs against Supabase staging/production — PGHOST/PGPORT/PGUSER/
# PGPASSWORD/PGDATABASE all point at a throwaway `postgres:16` service
# container that exists only for the lifetime of this CI job.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

HARNESS_DIR="scripts/db-contract-tests"
MIGRATIONS_DIR="supabase/migrations"

# The only migration in the full chain that depends on pg_cron (a
# scheduled integrity scan wholly unrelated to Ω3-CHECKOUT), which is not
# installed in the vanilla postgres:16 CI container (no
# shared_preload_libraries entry, no extension binary). This strips ONLY
# that migration's pg_cron tail in-memory for THIS disposable database —
# the real migration file on disk is never touched. Nothing later in the
# chain references anything this tail creates (verified by inspection:
# the tail is purely `CREATE EXTENSION pg_cron` + `cron.schedule(...)`,
# self-contained at the end of the file).
PG_CRON_FILE="20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql"

PSQL=(psql -v ON_ERROR_STOP=1 -q)

echo "== Step 1/5: bootstrap roles + auth/storage shims =="
"${PSQL[@]}" -f "$HARNESS_DIR/00_bootstrap_roles_and_shims.sql"

echo "== Step 2/5: apply full migration chain ($(ls "$MIGRATIONS_DIR"/*.sql | wc -l) files) =="
for f in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
  base="$(basename "$f")"
  if [ "$base" = "$PG_CRON_FILE" ]; then
    echo "  - $base (pg_cron scheduling tail stripped for this disposable DB — see comment above)"
    sed '/CREATE EXTENSION IF NOT EXISTS pg_cron;/,$d' "$f" | "${PSQL[@]}"
  else
    echo "  - $base"
    "${PSQL[@]}" -f "$f"
  fi
done
echo "All $(ls "$MIGRATIONS_DIR"/*.sql | wc -l) migrations applied successfully to a clean disposable database."

echo "== Step 3/5: static contract assertions (signatures, grants, offer bindings, matrix, RLS write-blocking) =="
"${PSQL[@]}" -f "$HARNESS_DIR/10_static_contract_assertions.sql"

echo "== Step 4/5: concurrency tests (real concurrent sessions) =="
bash "$HARNESS_DIR/20_concurrency_tests.sh"

echo "== Step 5/5: migration-failure-on-hostile-fixture negative test =="
bash "$HARNESS_DIR/30_migration_preflight_negative_test.sh"

echo ""
echo "=================================================="
echo "DB_CONTRACT_TESTS: ALL PASSED"
echo "=================================================="
