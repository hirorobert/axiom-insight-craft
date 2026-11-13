-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261229100000 — Terms-of-Service acceptance is recorded on the checkout intent, once, immutably. AUTHORED, NOT APPLIED to
-- any hosted database. Forward-only; additive; builds on 20261105100000 (the live acquire_checkout_attempt text) and on
-- 20260906083524 (payment_checkout_intents.metadata jsonb NOT NULL DEFAULT '{}').
--
--   WHY (PR #266, commercial handoff §10.8): the server, not the browser, decides which Terms version a purchase accepts, and
--   the accepted version must be bound durably to the authenticated purchaser and the checkout intent, survive retries and
--   webhooks unchanged, and never be written retrospectively onto historical checkouts.
--
--   WHAT IT DOES:
--   (1) acquire_checkout_attempt gains ONE optional trailing parameter, p_terms_version TEXT DEFAULT NULL. The function is
--       re-created from its LIVE text with three anchored replacements (signature; INSERT column list; INSERT value list),
--       each asserted to occur exactly once; every other line is unchanged. The 14-argument function is DROPPED in the same
--       transaction so exactly ONE function of that name exists afterwards: PostgREST and plpgsql resolve a 14-argument call
--       to it through the default (NULL = not recorded), so the deployed (older) Edge Function keeps working unchanged, and no
--       overload ambiguity can arise. Grants are re-stated: EXECUTE for service_role only (as before).
--       When p_terms_version is given, the NEW intent's metadata carries terms_version, terms_accepted_at (the acquisition
--       instant, server clock) and terms_accepted_by_user_id (the authenticated purchaser, already a parameter). A reused or
--       blocking existing intent is returned exactly as before: its recorded acceptance is never touched.
--   (2) A BEFORE UPDATE trigger on payment_checkout_intents refuses ANY change to those three metadata keys — a value edited,
--       removed, or ADDED to a row that had none. Every existing writer merges metadata with ||, so manual_review_reason,
--       failed_reason and the provider's results still land; only the acceptance keys are frozen. This holds for service_role
--       too: the acceptance is written at acquisition and nowhere else.
--   Existing rows are not read or changed (their metadata lacks the keys: NULL = not recorded, never inferred).
--
--   DEPLOYMENT ORDER: apply this migration first (old function code passes 14 arguments → NULL, still valid); then deploy
--   commercial-create-checkout (which refuses a checkout without the current version and passes it here) and
--   commercial-payment-status (shared provider module); then publish the frontend that sends termsVersion — in the same window,
--   because between the function deploy and the Publish an old page's checkout is refused with TERMS_VERSION_REQUIRED and
--   nothing is written (a safe refusal, not a partial state).
--
-- PREFLIGHT: exactly the 14-argument function exists (no 15-argument one), payment_checkout_intents.metadata exists, the
-- trigger is absent; a replay (15-argument present, 14 absent, trigger present) is a no-op. POSTCONDITION: exactly one
-- acquire_checkout_attempt, with 15 arguments and the default; EXECUTE only for service_role; the trigger installed.
-- Idempotent; one DO block (atomic whatever the migrator's transaction mode).
-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
DO $terms_acceptance$
DECLARE
  c_old_sig  constant text := 'public.acquire_checkout_attempt(uuid,uuid,uuid,uuid,text,text,smallint,bigint,text,smallint,text,text,uuid,text)';
  c_new_sig  constant text := 'public.acquire_checkout_attempt(uuid,uuid,uuid,uuid,text,text,smallint,bigint,text,smallint,text,text,uuid,text,text)';
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
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: a 15-argument acquire_checkout_attempt already exists beside the 14-argument one (half-installed state); nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'payment_checkout_intents' AND column_name = 'metadata' AND data_type = 'jsonb') THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: payment_checkout_intents.metadata (jsonb) is absent; nothing was changed' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'payment_checkout_intents_terms_acceptance_guard' AND tgrelid = 'public.payment_checkout_intents'::regclass) THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: the acceptance guard trigger already exists without the 15-argument function (half-installed state); nothing was changed' USING ERRCODE = 'P0001';
  END IF;

  -- (1) the function, from its LIVE text: three anchored replacements, each exactly once.
  v_def := pg_get_functiondef(to_regprocedure(c_old_sig));
  v_from := ARRAY[
    'p_created_by_user_id uuid, p_saff_reference text)',
    E'    created_by_user_id, expires_at\n  ) VALUES (',
    E'    p_created_by_user_id,v_expires_at\n  ) RETURNING id INTO v_new_id;'
  ];
  v_to := ARRAY[
    'p_created_by_user_id uuid, p_saff_reference text, p_terms_version text DEFAULT NULL)',
    E'    created_by_user_id, expires_at, metadata\n  ) VALUES (',
    E'    p_created_by_user_id,v_expires_at,\n'
    || E'    -- [20261229100000] the Terms version the SERVER accepted for this purchase, bound to the purchaser and the moment;\n'
    || E'    -- NULL = not recorded (a 14-argument caller). Frozen by payment_checkout_intents_terms_acceptance_guard.\n'
    || E'    CASE WHEN p_terms_version IS NULL THEN ''{}''::jsonb\n'
    || E'         ELSE jsonb_build_object(''terms_version'', p_terms_version, ''terms_accepted_at'', v_now, ''terms_accepted_by_user_id'', p_created_by_user_id) END\n'
    || E'  ) RETURNING id INTO v_new_id;'
  ];
  FOR i IN 1 .. 3 LOOP
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

  -- (2) the acceptance record is immutable once written, and is never written onto an existing row.
  CREATE OR REPLACE FUNCTION public.payment_checkout_intents_terms_acceptance_guard()
  RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $guard$
  BEGIN
    IF NEW.metadata -> 'terms_version' IS DISTINCT FROM OLD.metadata -> 'terms_version'
       OR NEW.metadata -> 'terms_accepted_at' IS DISTINCT FROM OLD.metadata -> 'terms_accepted_at'
       OR NEW.metadata -> 'terms_accepted_by_user_id' IS DISTINCT FROM OLD.metadata -> 'terms_accepted_by_user_id' THEN
      RAISE EXCEPTION 'TERMS_ACCEPTANCE_IMMUTABLE: the Terms acceptance recorded on checkout intent % cannot be changed, removed or added after acquisition', OLD.id
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
     OR (SELECT p.pronargdefaults FROM pg_proc p WHERE p.oid = to_regprocedure(c_new_sig)) <> 1
     OR position('p_terms_version' IN pg_get_functiondef(to_regprocedure(c_new_sig))) = 0
     OR position('terms_accepted_by_user_id' IN pg_get_functiondef(to_regprocedure(c_new_sig))) = 0
     OR has_function_privilege('authenticated', to_regprocedure(c_new_sig), 'EXECUTE')
     OR has_function_privilege('anon', to_regprocedure(c_new_sig), 'EXECUTE')
     OR NOT has_function_privilege('service_role', to_regprocedure(c_new_sig), 'EXECUTE')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'payment_checkout_intents_terms_acceptance_guard' AND tgrelid = 'public.payment_checkout_intents'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDITION: Terms acceptance recording is not installed exactly as reviewed' USING ERRCODE = 'P0001';
  END IF;

  -- PostgREST: the function signature changed; ask for a schema reload (Supabase's DDL event trigger does this too; harmless twice).
  NOTIFY pgrst, 'reload schema';
END
$terms_acceptance$;
