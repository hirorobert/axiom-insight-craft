#!/usr/bin/env bash
# Real-PostgreSQL proof for 20261105100000_checkout_open_session_conflict.sql (acquire_checkout_attempt).
# Loads the migration's function verbatim against a minimal shim of payment_checkout_intents and checks:
#   P1 same plan, open lease  -> REUSE_EXISTING, nothing written
#   P2 other plan while PENDING -> OPEN_CHECKOUT_BLOCKS_NEW_ATTEMPT, row unchanged (still PENDING, metadata untouched)
#   P3 same plan, local lease passed -> OPEN_CHECKOUT_BLOCKS_NEW_ATTEMPT, row unchanged (no MANUAL_REVIEW stranding)
#   P4 16 simultaneous acquisitions for 3 plans on an empty customer -> exactly one intent created
#   P5 after a provider-verified EXPIRED closes the order -> a new plan can start
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MIG="$HERE/../../supabase/migrations/20261105100000_checkout_open_session_conflict.sql"
D="$(mktemp -d)"; PORT=55439
initdb -D "$D/data" -U postgres >/dev/null
pg_ctl -D "$D/data" -o "-p $PORT -k $D -c listen_addresses=''" -l "$D/log" start -w >/dev/null
trap 'pg_ctl -D "$D/data" stop -m immediate >/dev/null 2>&1; rm -rf "$D"' EXIT
Q() { psql -X -q -t -A -v ON_ERROR_STOP=1 -h "$D" -p $PORT -U postgres -d postgres "$@"; }
Q <<'SQL'
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE public.payment_checkout_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), billing_customer_id uuid, commercial_offer_id uuid, plan_id uuid,
  product_id uuid, market_code text, expected_amount_minor bigint, currency_code text, currency_exponent smallint,
  billing_interval text, billing_interval_count smallint, provider text, provider_environment text, saff_reference text,
  status text, creation_token uuid, creation_lease_expires_at timestamptz, created_by_user_id uuid, expires_at timestamptz,
  provider_checkout_url text, completed_at timestamptz, metadata jsonb NOT NULL DEFAULT '{}', created_at timestamptz DEFAULT clock_timestamp());
CREATE UNIQUE INDEX uq_one_open ON public.payment_checkout_intents (billing_customer_id, product_id)
  WHERE status IN ('CREATING','PROVIDER_CREATING','PENDING','MANUAL_REVIEW');
CREATE FUNCTION public.assert_platform_state_permits(text, uuid) RETURNS void LANGUAGE sql AS $$ SELECT $$;
SQL
Q -f "$MIG"
C=11111111-1111-1111-1111-111111111111; P=22222222-2222-2222-2222-222222222222; U=33333333-3333-3333-3333-333333333333
SOLO=aaaaaaaa-0000-0000-0000-000000000001; FIRM=aaaaaaaa-0000-0000-0000-000000000003; PRAC=aaaaaaaa-0000-0000-0000-000000000002
acq() { Q -c "SELECT acquire_checkout_attempt('$1','$P','$2','$2','GLOBAL','USD',2::smallint,49000::bigint,'ANNUAL',1::smallint,'POLAR','production','$U','$3')->>'action'"; }
fail() { echo "FAIL $*"; exit 1; }
Q -c "INSERT INTO payment_checkout_intents (billing_customer_id,commercial_offer_id,plan_id,product_id,provider,provider_environment,saff_reference,status,expires_at,provider_checkout_url)
      VALUES ('$C','$SOLO','$SOLO','$P','POLAR','production','SAFF-SOLO','PENDING',now()+interval '1 hour','https://polar.example/s')"
snap() { Q -c "SELECT status||'|'||metadata::text||'|'||count(*) OVER () FROM payment_checkout_intents WHERE billing_customer_id='$C'"; }
B=$(snap)
[ "$(acq $C $SOLO R1)" = REUSE_EXISTING ] || fail P1; [ "$(snap)" = "$B" ] || fail P1-write; echo "P1 ok"
[ "$(acq $C $FIRM R2)" = OPEN_CHECKOUT_BLOCKS_NEW_ATTEMPT ] || fail P2; [ "$(snap)" = "$B" ] || fail P2-write; echo "P2 ok"
Q -c "UPDATE payment_checkout_intents SET expires_at=now()-interval '1 minute' WHERE saff_reference='SAFF-SOLO'"; B=$(snap)
[ "$(acq $C $SOLO R3)" = OPEN_CHECKOUT_BLOCKS_NEW_ATTEMPT ] || fail P3; [ "$(snap)" = "$B" ] || fail P3-write; echo "P3 ok"
C2=44444444-4444-4444-4444-444444444444
for i in $(seq 1 16); do case $((i%3)) in 0) o=$SOLO;; 1) o=$PRAC;; *) o=$FIRM;; esac; acq $C2 $o "R4-$i" > "$D/r$i" & done; wait
n=$(Q -c "SELECT count(*) FROM payment_checkout_intents WHERE billing_customer_id='$C2'"); [ "$n" = 1 ] || fail "P4 intents=$n"
[ "$(cat "$D"/r* | grep -c NEW_ATTEMPT)" = 1 ] || fail P4-new; echo "P4 ok (16 concurrent, 1 intent)"
Q -c "UPDATE payment_checkout_intents SET status='EXPIRED', completed_at=now() WHERE saff_reference='SAFF-SOLO'"
[ "$(acq $C $FIRM R5)" = NEW_ATTEMPT ] || fail P5; echo "P5 ok"
echo "checkoutOpenSessionConflict: 5/5 PASS"
