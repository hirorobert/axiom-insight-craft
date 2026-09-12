#!/usr/bin/env bash
# Ω∞ A+ closure — negative test: the Ω∞ A+ closure migration
# (20260913000000) must ABORT with a named diagnostic when a hostile
# pre-existing duplicate fixture would violate the new
# (billing_customer_id, product_id) partial unique index it adds.
#
# This needs a FRESH database (the main contract-test database has
# already applied 20260913000000, whose own unique index would now
# prevent the hostile fixture from ever being inserted in the first
# place) — a second, throwaway database in the SAME disposable Postgres
# server, never touched again after this script exits.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

NEG_DB="contract_test_negative_preflight"
MIGRATIONS_DIR="supabase/migrations"
LAST_MIGRATION="20260913000000_omega4_checkout_acquisition_hardening.sql"
PG_CRON_FILE="20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql"

psql -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $NEG_DB;"
psql -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $NEG_DB;"

PSQL_NEG=(psql -v ON_ERROR_STOP=1 -q -d "$NEG_DB")
PSQL_NEG_T=(psql -v ON_ERROR_STOP=1 -qtA -d "$NEG_DB")

"${PSQL_NEG[@]}" -f "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"

echo "Applying every migration EXCEPT $LAST_MIGRATION..."
for f in $(ls "$MIGRATIONS_DIR"/*.sql | sort); do
  base="$(basename "$f")"
  [ "$base" = "$LAST_MIGRATION" ] && continue
  if [ "$base" = "$PG_CRON_FILE" ]; then
    sed '/CREATE EXTENSION IF NOT EXISTS pg_cron;/,$d' "$f" | "${PSQL_NEG[@]}"
  else
    "${PSQL_NEG[@]}" -f "$f"
  fi
done

echo "Injecting a hostile pre-existing duplicate fixture..."
HOSTILE_USER=$("${PSQL_NEG_T[@]}" -c "INSERT INTO auth.users (email) VALUES ('ci-hostile@example.test') RETURNING id;")
CFOCLOSE_PRODUCT_ID=$("${PSQL_NEG_T[@]}" -c "SELECT id FROM public.commercial_products WHERE code = 'CFOCLOSE';")
PAID_PLAN_ID=$("${PSQL_NEG_T[@]}" -c "SELECT id FROM public.commercial_plans WHERE code = 'PAID' AND product_id = '$CFOCLOSE_PRODUCT_ID';")
MONTHLY_OFFER_ID=$("${PSQL_NEG_T[@]}" -c "SELECT id FROM public.commercial_offers WHERE offer_code = 'CFOCLOSE_PROFESSIONAL_GLOBAL_USD_MONTHLY';")
ANNUAL_OFFER_ID=$("${PSQL_NEG_T[@]}" -c "SELECT id FROM public.commercial_offers WHERE offer_code = 'CFOCLOSE_PROFESSIONAL_GLOBAL_USD_ANNUAL';")
HOSTILE_BC=$("${PSQL_NEG_T[@]}" -c "INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ('$HOSTILE_USER', '$CFOCLOSE_PRODUCT_ID') RETURNING id;")

# Two OPEN (CREATED/PENDING) intents for the SAME (customer, product) but
# DIFFERENT offer_id — legal under the OLD (customer, offer) unique index
# 20260912100000 created, but exactly what 20260913000000's NEW
# (customer, product) index must refuse to allow through silently.
"${PSQL_NEG[@]}" -c "
  INSERT INTO public.payment_checkout_intents
    (billing_customer_id, commercial_offer_id, plan_id, market_code, expected_amount_minor, currency_code, currency_exponent, billing_interval, billing_interval_count, provider, saff_reference, status, created_by_user_id)
  VALUES
    ('$HOSTILE_BC', '$MONTHLY_OFFER_ID', '$PAID_PLAN_ID', 'GLOBAL', 4900, 'USD', 2, 'MONTHLY', 1, 'FLUTTERWAVE', 'HOSTILE-REF-1', 'CREATED', '$HOSTILE_USER'),
    ('$HOSTILE_BC', '$ANNUAL_OFFER_ID',  '$PAID_PLAN_ID', 'GLOBAL', 49900,'USD', 2, 'ANNUAL',  1, 'FLUTTERWAVE', 'HOSTILE-REF-2', 'PENDING', '$HOSTILE_USER');
"

echo "Attempting to apply $LAST_MIGRATION — expecting it to ABORT with a named diagnostic..."
set +e
OUTPUT=$("${PSQL_NEG[@]}" -f "$MIGRATIONS_DIR/$LAST_MIGRATION" 2>&1)
EXIT_CODE=$?
set -e

psql -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $NEG_DB;"

if [ "$EXIT_CODE" -eq 0 ]; then
  echo "FAIL: expected 20260913000000 to abort against a hostile pre-existing duplicate fixture, but it applied successfully"
  echo "$OUTPUT"
  exit 1
fi
if ! echo "$OUTPUT" | grep -q "PRE_EXISTING_OPEN_INTENT_PRODUCT_DUPLICATES_FOUND"; then
  echo "FAIL: migration aborted, but not with the expected named diagnostic PRE_EXISTING_OPEN_INTENT_PRODUCT_DUPLICATES_FOUND"
  echo "$OUTPUT"
  exit 1
fi

echo "PASS: 20260913000000 aborts with the named diagnostic PRE_EXISTING_OPEN_INTENT_PRODUCT_DUPLICATES_FOUND against a hostile pre-existing duplicate fixture"
echo ""
echo "DB_CONTRACT_TESTS/migration-preflight-negative: PASSED"
