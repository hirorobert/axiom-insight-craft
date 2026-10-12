-- READ-ONLY PURCHASING-AUTHORITY GATE for commercial-p4. Run at P4-1 (before anything) and at P4-7 (after Publish).
-- Writes nothing; raises if any condition fails, naming every failure at once.
--
-- It separates HISTORICAL OFFERS from PURCHASING AUTHORITY:
--   - every TZS or TZ offer row is LISTED (section 2) and left exactly as it is: an active but non-purchasable legacy row
--     (for example SANDBOX-TEST-PAID-TZ and SANDBOX-TEST-PAID-GLOBAL under the legacy plan PAID) is a record, not a price;
--   - any TZS or TZ offer that is PURCHASABLE is refused, whatever the platform state — payments being disabled does not
--     excuse it, because checkout opening later would expose it at once;
--   - payments must independently be disabled (commercial_platform_state = PAYMENTS_DISABLED);
--   - the public price list must carry no TZS or TZ price.
-- Snippe customer checkout being unavailable is a property of the deployed code (SNIPPE_CUSTOMER_CHECKOUT_ENABLED = false),
-- confirmed separately at P4-7 by the signed-in checkout read, not by this database query.
DO $gate$
DECLARE
  v_state TEXT;
  v_purchasable TEXT;
  v_public INTEGER;
  v_failures TEXT[] := ARRAY[]::TEXT[];
BEGIN
  SELECT state INTO v_state FROM public.commercial_platform_state WHERE id = true;
  IF v_state IS DISTINCT FROM 'PAYMENTS_DISABLED' THEN
    v_failures := v_failures || format('commercial_platform_state is %s, not PAYMENTS_DISABLED', coalesce(v_state, 'missing'));
  END IF;
  SELECT string_agg(format('%s (%s, plan %s, %s %s)', co.offer_code, co.id, cp.code, co.market_code, co.currency_code), '; ' ORDER BY co.created_at)
    INTO v_purchasable
    FROM public.commercial_offers co JOIN public.commercial_plans cp ON cp.id = co.plan_id
   WHERE (co.currency_code = 'TZS' OR co.market_code = 'TZ') AND co.is_purchasable;
  IF v_purchasable IS NOT NULL THEN
    v_failures := v_failures || format('purchasable TZS/TZ offer(s): %s', v_purchasable);
  END IF;
  SELECT count(*) INTO v_public
    FROM jsonb_array_elements(COALESCE(public.get_public_plan_prices()->'offers', '[]'::jsonb)) o
   WHERE o->>'currency_code' = 'TZS' OR o->>'market_code' = 'TZ';
  IF v_public > 0 THEN
    v_failures := v_failures || format('the public price list carries %s TZS/TZ price(s)', v_public);
  END IF;
  IF cardinality(v_failures) > 0 THEN
    RAISE EXCEPTION 'PURCHASING_GATE_REFUSED: %', array_to_string(v_failures, ' | ');
  END IF;
  RAISE NOTICE 'PURCHASING GATE OK: payments disabled; no TZS/TZ offer is purchasable; no TZS/TZ public price.';
END
$gate$;

-- 2. Every TZS or TZ offer row, reported as a historical record (never changed by this release).
SELECT co.id, co.offer_code, cp.code AS plan_code, co.market_code, co.currency_code, co.amount_minor, co.currency_exponent,
       co.billing_interval, co.is_active, co.is_purchasable, co.effective_start, co.effective_end, co.created_at,
       md5(to_jsonb(co)::text) AS row_md5
  FROM public.commercial_offers co JOIN public.commercial_plans cp ON cp.id = co.plan_id
 WHERE co.currency_code = 'TZS' OR co.market_code = 'TZ'
 ORDER BY co.created_at, co.id;

-- 3. The platform state, as read.
SELECT state AS platform_state FROM public.commercial_platform_state WHERE id = true;
