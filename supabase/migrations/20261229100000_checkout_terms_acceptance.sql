-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261229100000 — The checkout acknowledgement (Terms version + consent to immediate start) is recorded on the checkout intent,
-- once, immutably, and no intent can be created without it. AUTHORED, NOT APPLIED to any hosted database. Forward-only; additive;
-- builds on 20261105100000 (the live acquire_checkout_attempt text) and on 20260906083524 (payment_checkout_intents.metadata jsonb
-- NOT NULL DEFAULT '{}').
--
--   WHY (PR #266, commercial handoff §10.8 / §12.7 / update 2; ETA s.30(5)(d)): the server, not the browser, decides which Terms
--   version a purchase accepts; the accepted version and the customer's separately given consent to an immediate start must be
--   bound durably to the authenticated purchaser and the exact checkout intent, survive retries and webhooks unchanged, never be
--   written retrospectively onto historical checkouts, and no intent may be created without them.
--
--   WHAT IT DOES:
--   (1) acquire_checkout_attempt gains TWO trailing parameters, p_terms_version TEXT DEFAULT NULL and
--       p_immediate_service_consent BOOLEAN DEFAULT NULL. The function is re-created from its LIVE text with four anchored
--       replacements (signature; a refusal inserted immediately before the INSERT; INSERT column list; INSERT value list), each
--       asserted to occur exactly once; every other line is unchanged. The 14-argument function is DROPPED in the same transaction so
--       exactly ONE function of that name exists afterwards (PostgREST and plpgsql cannot be ambiguous). The defaults exist only so
--       that a 14-argument caller resolves to this function and is REFUSED by it (TERMS_ACCEPTANCE_REQUIRED, nothing written) instead
--       of failing on name resolution: after this migration NO intent can be created without the current acknowledgement. The
--       read-only answers for an existing intent (ALREADY_IN_PROGRESS / REUSE_EXISTING / the blocking actions) are unchanged and never
--       touch the existing intent's recorded acknowledgement. Grants are re-stated: EXECUTE for service_role only (as before).
--       A NEW intent's metadata carries terms_version, terms_accepted (true), terms_accepted_at (the acquisition instant, server
--       clock), terms_accepted_by_user_id (the authenticated purchaser, already a parameter) and immediate_service_consent (true).
--   (2) A BEFORE UPDATE trigger on payment_checkout_intents refuses ANY change to those five metadata keys — a value edited, removed,
--       or ADDED to a row that had none. Every existing writer merges metadata with ||, so manual_review_reason, failed_reason and the
--       provider's results still land; only the acknowledgement keys are frozen. This holds for service_role too: the acknowledgement
--       is written at acquisition and nowhere else.
--   Existing rows are not read or changed (their metadata lacks the keys: NULL = not recorded, never inferred, never back-filled).
--
--   DEPLOYMENT ORDER (commercial handoff update 2: migration and function deploy in ONE window): apply this migration, then deploy
--   commercial-create-checkout (which refuses a checkout without the acknowledgement before any RPC and passes it here) and
--   commercial-payment-status (shared provider module), then publish the frontend that sends it. Between the apply and the function
--   deploy, the deployed older function's acquisition is REFUSED by (1) — a safe refusal (nothing written), not a partial state; between
--   the function deploy and the Publish an old page's checkout is refused with TERMS_VERSION_REQUIRED — the same safe refusal.
--
-- PREFLIGHT: exactly the 14-argument function exists (no 16-argument one), payment_checkout_intents.metadata exists, the trigger is
-- absent; a replay (16-argument present, 14 absent, trigger present) is a no-op. POSTCONDITION: exactly one acquire_checkout_attempt,
-- with 16 arguments and two defaults; EXECUTE only for service_role; the trigger installed. Idempotent; one DO block (atomic whatever
-- the migrator's transaction mode).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $terms_acceptance$
DECLARE
  c_old_sig  constant text := 'public.acquire_checkout_attempt(uuid,uuid,uuid,uuid,text,text,smallint,bigint,text,smallint,text,text,uuid,text)';
  c_new_sig  constant text := 'public.acquire_checkout_attempt(uuid,uuid,uuid,uuid,text,text,smallint,bigint,text,smallint,text,text,uuid,text,text,boolean)';
  v_def      text;
  v_from     text[];
  v_to       text[];
  v_n        integer;
  i          integer;
BEGIN
  -- Replay: already installed → nothing to do.
  IF to_regprocedure(c_new_sig) IS NOT NULL AND to_regprocedure(c_old_sig) IS NULL
     AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'payment_checkout_intents_terms_acceptance_guard' AND tgrelid = 'public.payment_checkout_intents'::regclass) THEN
    RETURN;
  END IF;

  -- PREFLIGHT
  IF to_regprocedure(c_old_sig) IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the 14-argument acquire_checkout_attempt (20261105100000) is not installed; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF to_regprocedure(c_new_sig) IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: a 16-argument acquire_checkout_attempt already exists beside the 14-argument one (half-installed state); nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payment_checkout_intents' AND column_name = 'metadata' AND data_type = 'jsonb') THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: payment_checkout_intents.metadata (jsonb) is absent; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'payment_checkout_intents_terms_acceptance_guard' AND tgrelid = 'public.payment_checkout_intents'::regclass) THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the acceptance guard trigger already exists without the 16-argument function (half-installed state); nothing was changed' USING ERRCODE = 'P0001';
  END IF;

  -- (1) the function, from its LIVE text: four anchored replacements, each exactly once.
  v_def := pg_get_functiondef(to_regprocedure(c_old_sig));
  v_from := ARRAY[
    'p_created_by_user_id uuid, p_saff_reference text)',
    E'  INSERT INTO public.payment_checkout_intents (\n    billing_customer_id, commercial_offer_id, plan_id, product_id, market_code,',
    E'    created_by_user_id, expires_at\n  ) VALUES (',
    E'    p_created_by_user_id,v_expires_at\n  ) RETURNING id INTO v_new_id;'
  ];
  v_to := ARRAY[
    'p_created_by_user_id uuid, p_saff_reference text, p_terms_version text DEFAULT NULL, p_immediate_service_consent boolean DEFAULT NULL)',
    E'  -- [20261229100000] no intent is created without the current acknowledgement (the Edge Function verified the version against its\n'
    || E'  -- own constant before calling; a 14-argument caller - the pre-release function - is refused here, writing nothing).\n'
    || E'  IF p_terms_version IS NULL OR p_immediate_service_consent IS DISTINCT FROM true THEN\n'
    || E'    RAISE EXCEPTION ''TERMS_ACCEPTANCE_REQUIRED: a checkout intent needs the accepted Terms version and the consent to an immediate start; nothing was written''\n'
    || E'      USING ERRCODE = ''P0001'';\n'
    || E'  END IF;\n'
    || E'  INSERT INTO public.payment_checkout_intents (\n    billing_customer_id, commercial_offer_id, plan_id, product_id, market_code,',
    E'    created_by_user_id, expires_at, metadata\n  ) VALUES (',
    E'    p_created_by_user_id,v_expires_at,\n'
    || E'    -- [20261229100000] the acknowledgement the SERVER accepted for this purchase, bound to the purchaser and the moment; frozen by\n'
    || E'    -- payment_checkout_intents_terms_acceptance_guard.\n'
    || E'    jsonb_build_object(''terms_version'', p_terms_version, ''terms_accepted'', true, ''terms_accepted_at'', v_now,\n'
    || E'                       ''terms_accepted_by_user_id'', p_created_by_user_id, ''immediate_service_consent'', true)\n'
    || E'  ) RETURNING id INTO v_new_id;'
  ];
  FOR i IN 1 .. 4 LOOP
    v_n := (length(v_def) - length(replace(v_def, v_from[i], ''))) / length(v_from[i]);
    IF v_n <> 1 THEN
      RAISE EXCEPTION 'PREFLIGHT_REFUSED: acquire_checkout_attempt anchor % occurs % times, expected 1 (is 20261105100000 the live text?); nothing was changed', i, v_n USING ERRCODE = 'P0001';
    END IF;
    v_def := replace(v_def, v_from[i], v_to[i]);
  END LOOP;

  EXECUTE 'DROP FUNCTION ' || c_old_sig;
  EXECUTE v_def;
  EXECUTE 'REVOKE ALL ON FUNCTION ' || c_new_sig || ' FROM PUBLIC, anon, authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION ' || c_new_sig || ' TO service_role';

  -- (2) the acknowledgement is immutable once written, and is never written onto an existing row.
  CREATE OR REPLACE FUNCTION public.payment_checkout_intents_terms_acceptance_guard()
  RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $guard$
  BEGIN
    IF NEW.metadata -> 'terms_version' IS DISTINCT FROM OLD.metadata -> 'terms_version'
       OR NEW.metadata -> 'terms_accepted' IS DISTINCT FROM OLD.metadata -> 'terms_accepted'
       OR NEW.metadata -> 'terms_accepted_at' IS DISTINCT FROM OLD.metadata -> 'terms_accepted_at'
       OR NEW.metadata -> 'terms_accepted_by_user_id' IS DISTINCT FROM OLD.metadata -> 'terms_accepted_by_user_id'
       OR NEW.metadata -> 'immediate_service_consent' IS DISTINCT FROM OLD.metadata -> 'immediate_service_consent' THEN
      RAISE EXCEPTION 'TERMS_ACCEPTANCE_IMMUTABLE: the acknowledgement recorded on checkout intent % cannot be changed, removed or added after acquisition', OLD.id
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END;
  $guard$;
  REVOKE ALL ON FUNCTION public.payment_checkout_intents_terms_acceptance_guard() FROM PUBLIC, anon, authenticated;
  CREATE TRIGGER payment_checkout_intents_terms_acceptance_guard
    BEFORE UPDATE ON public.payment_checkout_intents
    FOR EACH ROW EXECUTE FUNCTION public.payment_checkout_intents_terms_acceptance_guard();

  -- POSTCONDITION
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'acquire_checkout_attempt') <> 1
     OR to_regprocedure(c_new_sig) IS NULL
     OR (SELECT p.pronargdefaults FROM pg_proc p WHERE p.oid = to_regprocedure(c_new_sig)) <> 2
     OR position('TERMS_ACCEPTANCE_REQUIRED' IN pg_get_functiondef(to_regprocedure(c_new_sig))) = 0
     OR position('immediate_service_consent' IN pg_get_functiondef(to_regprocedure(c_new_sig))) = 0
     OR has_function_privilege('authenticated', to_regprocedure(c_new_sig), 'EXECUTE')
     OR has_function_privilege('anon', to_regprocedure(c_new_sig), 'EXECUTE')
     OR NOT has_function_privilege('service_role', to_regprocedure(c_new_sig), 'EXECUTE')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'payment_checkout_intents_terms_acceptance_guard' AND tgrelid = 'public.payment_checkout_intents'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION: the checkout acknowledgement is not installed exactly as reviewed' USING ERRCODE = 'P0001';
  END IF;

  -- PostgREST: the function signature changed; ask for a schema reload (Supabase's DDL event trigger does this too; harmless twice).
  NOTIFY pgrst, 'reload schema';
END
$terms_acceptance$;
