#!/usr/bin/env bash
# Ω∞ A+ closure — real concurrent-session concurrency tests.
#
# Every "concurrent" test below launches two genuinely separate psql
# connections in parallel (backgrounded shell processes, not sequential
# calls in one session) so the advisory-lock serialization inside
# acquire_checkout_attempt / commit_verified_commercial_payment is
# actually exercised across real, separate Postgres backends — the same
# condition two simultaneous browser tabs or a double-click produce.
set -euo pipefail

PSQL_T=(psql -v ON_ERROR_STOP=1 -qtA) # tuples-only, unaligned, for single-value captures

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

sql() { "${PSQL_T[@]}" -c "$1"; }

echo "-- Seeding fixtures --"
CUSTOMER_USER=$(sql "INSERT INTO auth.users (email) VALUES ('ci-concurrency@example.test') RETURNING id;")
sql "UPDATE public.commercial_platform_state SET state = 'CUSTOMER_PAYMENTS_ENABLED' WHERE id = true;" >/dev/null

CFOCLOSE_PRODUCT_ID=$(sql "SELECT id FROM public.commercial_products WHERE code = 'CFOCLOSE';")
PAID_PLAN_ID=$(sql "SELECT id FROM public.commercial_plans WHERE code = 'PAID' AND product_id = '$CFOCLOSE_PRODUCT_ID';")
MONTHLY_OFFER_ID=$(sql "SELECT id FROM public.commercial_offers WHERE offer_code = 'CFOCLOSE_PROFESSIONAL_GLOBAL_USD_MONTHLY';")
ANNUAL_OFFER_ID=$(sql "SELECT id FROM public.commercial_offers WHERE offer_code = 'CFOCLOSE_PROFESSIONAL_GLOBAL_USD_ANNUAL';")

BILLING_CUSTOMER_ID=$(sql "INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ('$CUSTOMER_USER', '$CFOCLOSE_PRODUCT_ID') RETURNING id;")

acquire() {
  local offer_id="$1" ref="$2"
  "${PSQL_T[@]}" -c "SELECT acquire_checkout_attempt(
    '$BILLING_CUSTOMER_ID'::uuid, '$CFOCLOSE_PRODUCT_ID'::uuid, '$PAID_PLAN_ID'::uuid, '$offer_id'::uuid,
    'GLOBAL', 'USD', 2::smallint, 4900::bigint, 'MONTHLY', 1::smallint, 'FLUTTERWAVE', 'production', '$CUSTOMER_USER'::uuid, '$ref'
  )::text;"
}

# ── Test 1: two simultaneous MONTHLY acquisitions for the same
#    customer+product -> exactly one NEW_ATTEMPT.
echo "-- Test 1: two simultaneous identical acquisitions --"
acquire "$MONTHLY_OFFER_ID" "CI-T1-A" > "$TMP_DIR/t1a" &
acquire "$MONTHLY_OFFER_ID" "CI-T1-B" > "$TMP_DIR/t1b" &
wait
NEW_COUNT=$(grep -c '"action": "NEW_ATTEMPT"' "$TMP_DIR/t1a" "$TMP_DIR/t1b" | awk -F: '{s+=$2} END {print s+0}')
if [ "$NEW_COUNT" != "1" ]; then
  echo "FAIL: expected exactly 1 NEW_ATTEMPT across two simultaneous identical acquisitions, got $NEW_COUNT"
  cat "$TMP_DIR/t1a" "$TMP_DIR/t1b"
  exit 1
fi
echo "PASS: two simultaneous identical acquisitions converge to exactly one NEW_ATTEMPT"

# Clean up test 1's winner so test 2 starts from a clean slate.
sql "UPDATE public.payment_checkout_intents SET status = 'CANCELLED' WHERE billing_customer_id = '$BILLING_CUSTOMER_ID' AND status IN ('CREATING','PENDING');" >/dev/null

# ── Test 2: MONTHLY + ANNUAL simultaneously -> exactly one NEW_ATTEMPT,
#    the other an explicit CONFLICT_DIFFERENT_INTERVAL (never a second
#    payable attempt for the same product).
echo "-- Test 2: simultaneous MONTHLY + ANNUAL for the same product --"
acquire "$MONTHLY_OFFER_ID" "CI-T2-MONTHLY" > "$TMP_DIR/t2m" &
acquire "$ANNUAL_OFFER_ID" "CI-T2-ANNUAL" > "$TMP_DIR/t2a" &
wait
NEW_COUNT=$(grep -c '"action": "NEW_ATTEMPT"' "$TMP_DIR/t2m" "$TMP_DIR/t2a" | awk -F: '{s+=$2} END {print s+0}')
CONFLICT_COUNT=$(grep -c 'CONFLICT_DIFFERENT_INTERVAL' "$TMP_DIR/t2m" "$TMP_DIR/t2a" | awk -F: '{s+=$2} END {print s+0}')
if [ "$NEW_COUNT" != "1" ] || [ "$CONFLICT_COUNT" != "1" ]; then
  echo "FAIL: expected exactly one NEW_ATTEMPT and one CONFLICT_DIFFERENT_INTERVAL, got NEW=$NEW_COUNT CONFLICT=$CONFLICT_COUNT"
  cat "$TMP_DIR/t2m" "$TMP_DIR/t2a"
  exit 1
fi
echo "PASS: simultaneous MONTHLY + ANNUAL never both become payable — one wins, the other gets an explicit conflict"

sql "UPDATE public.payment_checkout_intents SET status = 'CANCELLED' WHERE billing_customer_id = '$BILLING_CUSTOMER_ID' AND status IN ('CREATING','PENDING');" >/dev/null

# ── Test 3: two browser tabs (identical offer) -> one payable URL. Winner
#    proceeds through persist_checkout_provider_result; loser never
#    reaches it.
echo "-- Test 3: two tabs, one payable URL --"
RESULT_A=$(acquire "$MONTHLY_OFFER_ID" "CI-T3-A")
RESULT_B=$(acquire "$MONTHLY_OFFER_ID" "CI-T3-B") # sequential here; concurrency already proven in Test 1
if echo "$RESULT_A" | grep -q NEW_ATTEMPT; then WINNER="$RESULT_A"; else WINNER="$RESULT_B"; fi
INTENT_ID=$(echo "$WINNER" | sed -n 's/.*"intent_id": "\([a-f0-9-]*\)".*/\1/p')
TOKEN=$(echo "$WINNER" | sed -n 's/.*"creation_token": "\([a-f0-9-]*\)".*/\1/p')
PERSIST_RESULT=$(sql "SELECT persist_checkout_provider_result('$INTENT_ID'::uuid, '$TOKEN'::uuid, 'flw-ref-t3', 'https://checkout.example.test/t3')::text;")
if ! echo "$PERSIST_RESULT" | grep -q '"persisted": true'; then
  echo "FAIL: expected the winning attempt to persist successfully. Got: $PERSIST_RESULT"
  exit 1
fi
PENDING_COUNT=$(sql "SELECT count(*) FROM public.payment_checkout_intents WHERE billing_customer_id = '$BILLING_CUSTOMER_ID' AND status = 'PENDING';")
if [ "$PENDING_COUNT" != "1" ]; then
  echo "FAIL: expected exactly 1 PENDING (payable) intent, found $PENDING_COUNT"
  exit 1
fi
echo "PASS: exactly one payable URL exists after two acquisition attempts for the same offer"

# ── Test 4: stale creation token is rejected by the CAS. ────────────────────
echo "-- Test 4: stale creation token rejected --"
STALE_RESULT=$(sql "SELECT persist_checkout_provider_result('$INTENT_ID'::uuid, gen_random_uuid(), 'flw-ref-stale', 'https://checkout.example.test/stale')::text;")
if ! echo "$STALE_RESULT" | grep -q '"persisted": false'; then
  echo "FAIL: expected persisted:false for a stale/wrong creation_token. Got: $STALE_RESULT"
  exit 1
fi
echo "PASS: a stale/wrong creation_token is rejected by the compare-and-swap"

sql "UPDATE public.payment_checkout_intents SET status = 'CANCELLED' WHERE billing_customer_id = '$BILLING_CUSTOMER_ID' AND status IN ('CREATING','PENDING');" >/dev/null

# ── Test 5: MANUAL_REVIEW is never automatically superseded; admin
#    resolution is the only deterministic exit.
echo "-- Test 5: MANUAL_REVIEW blocks new attempts until explicitly resolved --"
UNCERTAIN_SOURCE=$(acquire "$MONTHLY_OFFER_ID" "CI-T5-UNCERTAIN")
INTENT_ID_5=$(echo "$UNCERTAIN_SOURCE" | sed -n 's/.*"intent_id": "\([a-f0-9-]*\)".*/\1/p')
TOKEN_5=$(echo "$UNCERTAIN_SOURCE" | sed -n 's/.*"creation_token": "\([a-f0-9-]*\)".*/\1/p')
sql "SELECT mark_checkout_attempt_uncertain('$INTENT_ID_5'::uuid, '$TOKEN_5'::uuid, 'CI harness simulated network timeout');" >/dev/null
BLOCKED_RESULT=$(acquire "$MONTHLY_OFFER_ID" "CI-T5-BLOCKED")
if ! echo "$BLOCKED_RESULT" | grep -q 'MANUAL_REVIEW_BLOCKS_NEW_ATTEMPT'; then
  echo "FAIL: expected MANUAL_REVIEW_BLOCKS_NEW_ATTEMPT while an unresolved MANUAL_REVIEW intent exists. Got: $BLOCKED_RESULT"
  exit 1
fi
ADMIN_ID=$(sql "INSERT INTO auth.users (email) VALUES ('ci-t5-admin@example.test') RETURNING id;")
sql "INSERT INTO public.commercial_admins (user_id, active) VALUES ('$ADMIN_ID', true);" >/dev/null
RESOLVE_RESULT=$("${PSQL_T[@]}" -c "
  SET ROLE authenticated;
  SELECT set_config('request.jwt.claim.sub', '$ADMIN_ID', false);
  SELECT admin_resolve_manual_review_intent('$INTENT_ID_5'::uuid, 'CONFIRMED_UNCHARGED_CANCEL', 'CI harness resolution')::text;
  RESET ROLE;
" | tail -1)
if ! echo "$RESOLVE_RESULT" | grep -q '"resolved": true'; then
  echo "FAIL: admin_resolve_manual_review_intent did not resolve the intent. Got: $RESOLVE_RESULT"
  exit 1
fi
RECOVERED_RESULT=$(acquire "$MONTHLY_OFFER_ID" "CI-T5-RECOVERED")
if ! echo "$RECOVERED_RESULT" | grep -q 'NEW_ATTEMPT'; then
  echo "FAIL: expected a new acquisition to succeed after explicit admin resolution. Got: $RECOVERED_RESULT"
  exit 1
fi
echo "PASS: MANUAL_REVIEW is never automatically superseded; deterministic recovery only via explicit admin resolution"

sql "UPDATE public.payment_checkout_intents SET status = 'CANCELLED' WHERE billing_customer_id = '$BILLING_CUSTOMER_ID' AND status IN ('CREATING','PENDING');" >/dev/null

# ── Test 6: different customers never serialize against each other. ────────
echo "-- Test 6: different customers acquire independently --"
OTHER_USER=$(sql "INSERT INTO auth.users (email) VALUES ('ci-other-customer@example.test') RETURNING id;")
OTHER_BILLING_CUSTOMER=$(sql "INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ('$OTHER_USER', '$CFOCLOSE_PRODUCT_ID') RETURNING id;")
acquire "$MONTHLY_OFFER_ID" "CI-T6-A" > "$TMP_DIR/t6a" &
"${PSQL_T[@]}" -c "SELECT acquire_checkout_attempt(
    '$OTHER_BILLING_CUSTOMER'::uuid, '$CFOCLOSE_PRODUCT_ID'::uuid, '$PAID_PLAN_ID'::uuid, '$MONTHLY_OFFER_ID'::uuid,
    'GLOBAL', 'USD', 2::smallint, 4900::bigint, 'MONTHLY', 1::smallint, 'FLUTTERWAVE', 'production', '$OTHER_USER'::uuid, 'CI-T6-B'
  )::text;" > "$TMP_DIR/t6b" &
wait
NEW_COUNT=$(grep -c '"action": "NEW_ATTEMPT"' "$TMP_DIR/t6a" "$TMP_DIR/t6b" | awk -F: '{s+=$2} END {print s+0}')
if [ "$NEW_COUNT" != "2" ]; then
  echo "FAIL: expected BOTH different customers to get NEW_ATTEMPT (no unnecessary serialization), got $NEW_COUNT"
  cat "$TMP_DIR/t6a" "$TMP_DIR/t6b"
  exit 1
fi
echo "PASS: different customers acquire independently — no unnecessary cross-customer serialization"

echo ""
echo "DB_CONTRACT_TESTS/concurrency: ALL PASSED"
