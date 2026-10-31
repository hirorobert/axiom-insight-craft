-- Independent review of #229: findings 2 and 5 (and the re-review of finding 3). Two additive repairs to workspace file access. These are UNAPPLIED candidate
-- migrations edited in place under the repository's candidate convention; nothing here rewrites an applied migration (whether any hosted database already holds
-- this file is NOT verified from this repository, and if one does, a forward migration must replace this edit).
--
-- 1. FINDING 2 - removing a team member must end that person's access. The Team panel promises "Remove <name>? Access ends immediately." Member
--    capabilities already end with the membership (trg_firm_members_capability_template), but explicit workspace capability grants
--    (workspace_capability_grants: manage_source_files, prepare_trial_balance, review_close, administer_workspace) are a SEPARATE authority path, deliberately
--    independent of membership (migration 20260923100000: the "grant-only collaborator"), and survived removal: a removed member with manage_source_files
--    could still be issued original-file download links. Independent, non-member access is a supported feature, so it is not removed; what is repaired is
--    the removal itself: the same transaction that removes (or re-points) an ACCEPTED membership revokes that person's open grants in that workspace and
--    records each revocation in workspace_capability_grant_events exactly as revoke_workspace_capability does. It is enforced at the table, so every
--    removal path (the Team panel's DELETE, an RPC, an account deletion cascade) is covered, and it is not a frontend or download-only change. A person
--    who was never a member keeps the grants the owner gave them. Re-inviting a removed person does not resurrect old grants: grants are explicit, and
--    the owner grants again if wanted (the table keeps one open grant per capability; the revoked rows stay as history).
--
-- 2. FINDINGS 3 AND 5 - the ISSUANCE DECISION of a file link, taken atomically with its record.
--    The trial-balance-source-download function reads authority (a plain, advisory read), asks Storage to sign (an external step that cannot share a database
--    transaction and is therefore never held inside one), and then calls decide_trial_balance_source_download_issuance. THAT call is the decision: in ONE
--    transaction it (a) takes the locks below, (b) re-evaluates workspace_authority_basis(user, workspace, 'manage_source_files'), (c) refuses if the right was
--    withdrawn or if the signed link has already expired, and (d) inserts the decision record. Its COMMIT is the ordering point: a withdrawal that commits
--    before it is seen by (b) and wins (no 'issued' record, no link is returned); a withdrawal that has not committed must wait for these locks until the
--    decision commits, so it is ordered after the issuance, and the function may deliver the already-minted link afterwards. An ordinary permission read is
--    NOT an ordering point and nothing here calls one.
--    Writers of the authority inputs and how each is ordered with the decision (found by reading workspace_authority_basis and every function and trigger that
--    changes what it reads):
--      * explicit grant revoked / re-pointed      revoke_workspace_capability, firm_members_revoke_workspace_grants (this file): UPDATE of the open grant row ->
--                                                  the decision holds FOR SHARE on that row to commit, so the UPDATE waits (a revoker already holding the row
--                                                  makes the decision wait, then re-read, and it then sees the revocation)
--      * the workspace's current plan             commercial licence / override writers: cfoclose.plan:<account> advisory lock (exclusive there, shared here)
--      * named-user seats and billing suspension  cfoclose.named_user_seats:<account> advisory lock (exclusive there, shared here; taken after the plan key,
--                                                  the order those writers use)
--      * the workspace owner / the workspace row  companies row, FOR SHARE here (an owner change is an UPDATE of it)
--    Lock order: plan (S) -> seats (S) -> open grant row (S) -> company row (S). revoke_workspace_capability takes the company row (S) and then updates the grant row;
--    the decision takes the grant row (S) and then the company row (S): shared locks do not conflict with each other, so there is no cycle. The membership row is
--    NOT read by the authority predicate and is not locked. lock_timeout (5 s) turns a pathological wait into outcome 'unavailable' (no record, no link, safe to
--    retry); it orders nothing. The decision needs READ COMMITTED and raises 25000 under a stricter level rather than judge on a stale snapshot.
--    NOT covered: a link ALREADY RETURNED stays a bearer credential until its own expiry (Storage cannot revoke one signed URL) - a separate, documented limit; a
--    clock-based expiry of a plan is not a writer; a new writer that touches none of the keys above is not covered.
--
--    WHAT A RECORD MEANS. trial_balance_source_download_events records DECISIONS of the function: 'issued' = an authorised issuance decision was committed (the
--    right held at the commit and the signed link had not expired); it is NOT evidence that the response reached the caller or that the file was downloaded.
--    'denied' = the pre-check refused an authenticated caller who named a real upload of a real company; 'withdrawn_before_issue' = the right was gone at the
--    decision; 'expired_before_issue' = the signed link had expired by the decision. Expiry is the SIGNER's (the signed link's own `exp`, 'signer_token_exp')
--    when it could be read, else an UPPER bound = the moment signing completed + the requested lifetime ('bound_signing_completed_plus_ttl'): the token's exp is
--    fixed by Storage at some instant between signing start and completion, so signing start + lifetime would be the EARLIEST possible expiry, not a bound on
--    the window. Signing start and completion are recorded as the function host's clock readings; the freshness comparison uses the database clock. Never a URL,
--    token or object path. Only the two functions below write the table (the service role has SELECT only), so no unconditional insert exists. Append-only; the
--    workspace owner may read the workspace's rows (RLS), nobody else. NOT decided: who else may read (administrators, auditors, the actor), RETENTION, and
--    whether other-company or unknown-upload attempts should be recorded - recorded open decisions, not defaults invented here.

DO $refuse$
BEGIN
  IF to_regclass('public.workspace_capability_grants') IS NULL OR to_regclass('public.workspace_capability_grant_events') IS NULL
     OR to_regclass('public.firm_members') IS NULL OR to_regclass('public.companies') IS NULL
     OR to_regclass('public.trial_balance_uploads') IS NULL
     OR to_regprocedure('public.tbu_append_only_guard()') IS NULL
     OR to_regprocedure('public.workspace_authority_basis(uuid,uuid,text)') IS NULL
     OR to_regprocedure('public._plan_write_lock(uuid)') IS NULL THEN
    RAISE EXCEPTION 'SOURCE_ACCESS_REPAIRS_PREREQUISITE: the workspace grant tables, the authority predicate, the plan lock and the append-only guard must exist' USING ERRCODE = '55000';
  END IF;
END
$refuse$;

SET search_path TO public, pg_catalog;

-- ── 1. membership removal revokes the person's explicit grants in the same transaction ───────────────────────────────
CREATE OR REPLACE FUNCTION public.firm_members_revoke_workspace_grants()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_row record;
BEGIN
  -- Only an ACCEPTED membership ever gave access; deleting or cancelling a pending invitation removes none.
  IF OLD.accepted_at IS NULL THEN RETURN NULL; END IF;
  -- An UPDATE ends the membership only when it is re-pointed to another workspace or person (the condition under which the capability trigger revokes).
  IF TG_OP = 'UPDATE' AND NEW.company_id IS NOT DISTINCT FROM OLD.company_id AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id THEN RETURN NULL; END IF;
  FOR v_row IN
    UPDATE public.workspace_capability_grants g
       SET revoked_at = now(), revoked_by_user_id = coalesce(auth.uid(), g.granted_by_user_id)
     WHERE g.company_id = OLD.company_id AND g.grantee_user_id = OLD.user_id AND g.revoked_at IS NULL
    RETURNING g.id, g.company_id, g.grantee_user_id, g.capability
  LOOP
    INSERT INTO public.workspace_capability_grant_events (company_id, grantee_user_id, capability, action, outcome, actor_user_id, grant_id)
    VALUES (v_row.company_id, v_row.grantee_user_id, v_row.capability, 'revoke', 'applied', auth.uid(), v_row.id);
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.firm_members_revoke_workspace_grants() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_firm_members_revoke_workspace_grants ON public.firm_members;
CREATE TRIGGER trg_firm_members_revoke_workspace_grants AFTER DELETE OR UPDATE OF company_id, user_id ON public.firm_members
  FOR EACH ROW EXECUTE FUNCTION public.firm_members_revoke_workspace_grants();

-- ── 2. the durable record of file-link issuance decisions ────────────────────────────────────────────────────────────
CREATE TABLE public.trial_balance_source_download_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),   -- the database clock at the decision
  company_id uuid NOT NULL,        -- not FKs: the record must outlive a deleted upload or workspace
  upload_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('issued', 'denied', 'withdrawn_before_issue', 'expired_before_issue')),
  signing_started_at timestamptz,          -- function-host clock readings; null for a denial (nothing was signed)
  signing_completed_at timestamptz,
  link_expires_at timestamptz,             -- the signed link's expiry (see link_expiry_source); null for a denial
  link_expiry_source text CHECK (link_expiry_source IN ('signer_token_exp', 'bound_signing_completed_plus_ttl')),
  object_sha256 text CHECK (object_sha256 IS NULL OR object_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_tbsde_signing_shape CHECK ((outcome = 'denied') = (signing_started_at IS NULL AND signing_completed_at IS NULL AND link_expires_at IS NULL AND link_expiry_source IS NULL)),
  CONSTRAINT chk_tbsde_signing_complete CHECK (outcome = 'denied' OR (signing_started_at IS NOT NULL AND signing_completed_at IS NOT NULL AND link_expires_at IS NOT NULL AND link_expiry_source IS NOT NULL AND signing_started_at <= signing_completed_at))
);
COMMENT ON TABLE public.trial_balance_source_download_events IS
  'Decisions of trial-balance-source-download. issued = an authorised issuance decision was committed (right held at the commit, signed link unexpired); it is NOT evidence that a response was delivered or a file downloaded. Never a URL, token or path. Append-only.';
COMMENT ON COLUMN public.trial_balance_source_download_events.link_expires_at IS
  'The signed link''s expiry: the signer''s own exp when readable, else an upper bound (signing completion + requested lifetime); see link_expiry_source. Not "decision time + lifetime".';
CREATE INDEX idx_tbsde_company_time ON public.trial_balance_source_download_events (company_id, occurred_at DESC);
ALTER TABLE public.trial_balance_source_download_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trial_balance_source_download_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.trial_balance_source_download_events TO authenticated, service_role;   -- reads only: the two functions below are the only writers
CREATE POLICY "Workspace owner reads source download events" ON public.trial_balance_source_download_events FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.companies c WHERE c.id = trial_balance_source_download_events.company_id AND c.user_id = auth.uid()));
CREATE TRIGGER trg_tbsde_append_only BEFORE UPDATE OR DELETE ON public.trial_balance_source_download_events
  FOR EACH ROW EXECUTE FUNCTION public.tbu_append_only_guard();
CREATE OR REPLACE FUNCTION public.trial_balance_source_download_events_no_truncate()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Iron Dome: trial_balance_source_download_events is append-only. TRUNCATE is not permitted.' USING ERRCODE = '23001';
END;
$$;
REVOKE ALL ON FUNCTION public.trial_balance_source_download_events_no_truncate() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_tbsde_no_truncate BEFORE TRUNCATE ON public.trial_balance_source_download_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.trial_balance_source_download_events_no_truncate();

-- ── 3. the issuance DECISION: locks, authority, expiry and the record in one transaction ──────────────────────────────
-- Outcomes: issued | withdrawn_before_issue | expired_before_issue (each recorded) | unavailable (a lock could not be had in time; nothing recorded) |
-- invalid (the inputs name nothing real; nothing recorded). The caller returns the link ONLY for 'issued'.
CREATE FUNCTION public.decide_trial_balance_source_download_issuance(
  p_user_id uuid, p_company_id uuid, p_upload_id uuid,
  p_signing_started_at timestamptz, p_signing_completed_at timestamptz,
  p_link_expires_at timestamptz, p_link_expiry_source text, p_object_sha256 text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public SET lock_timeout = '5s' AS $$
DECLARE v_account uuid; v_upload_company uuid; v_outcome text; v_id uuid;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'SOURCE_DOWNLOAD_ISOLATION: authority is re-judged after its locks are taken and needs READ COMMITTED' USING ERRCODE = '25000';
  END IF;
  IF p_user_id IS NULL OR p_company_id IS NULL OR p_upload_id IS NULL OR p_signing_started_at IS NULL OR p_signing_completed_at IS NULL OR p_link_expires_at IS NULL
     OR p_signing_started_at > p_signing_completed_at OR p_link_expiry_source IS NULL
     OR p_link_expiry_source NOT IN ('signer_token_exp', 'bound_signing_completed_plus_ttl')
     OR (p_object_sha256 IS NOT NULL AND p_object_sha256 !~ '^[0-9a-f]{64}$') THEN
    RETURN jsonb_build_object('outcome', 'invalid');
  END IF;
  SELECT u.company_id INTO v_upload_company FROM public.trial_balance_uploads u WHERE u.id = p_upload_id;
  IF v_upload_company IS DISTINCT FROM p_company_id THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  BEGIN
    SELECT c.user_id INTO v_account FROM public.companies c WHERE c.id = p_company_id;
    IF v_account IS NOT NULL THEN
      PERFORM public._plan_write_lock(v_account);
      PERFORM pg_advisory_xact_lock_shared(hashtextextended('cfoclose.named_user_seats:' || v_account::text, 0));
    END IF;
    PERFORM 1 FROM public.workspace_capability_grants g
     WHERE g.company_id = p_company_id AND g.grantee_user_id = p_user_id AND g.capability = 'manage_source_files' AND g.revoked_at IS NULL FOR SHARE;
    PERFORM 1 FROM public.companies c WHERE c.id = p_company_id FOR SHARE;
  EXCEPTION WHEN lock_not_available THEN
    RETURN jsonb_build_object('outcome', 'unavailable');
  END;
  -- Authority is judged AFTER the locks, on a fresh statement snapshot, so everything committed before the locks were granted is seen and nothing that
  -- changes the answer can commit before this transaction does.
  IF public.workspace_authority_basis(p_user_id, p_company_id, 'manage_source_files') IS NULL THEN v_outcome := 'withdrawn_before_issue';
  ELSIF p_link_expires_at <= clock_timestamp() THEN v_outcome := 'expired_before_issue';
  ELSE v_outcome := 'issued';
  END IF;
  INSERT INTO public.trial_balance_source_download_events
    (company_id, upload_id, actor_user_id, outcome, signing_started_at, signing_completed_at, link_expires_at, link_expiry_source, object_sha256)
  VALUES (p_company_id, p_upload_id, p_user_id, v_outcome, p_signing_started_at, p_signing_completed_at, p_link_expires_at, p_link_expiry_source, p_object_sha256)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', v_outcome, 'eventId', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.decide_trial_balance_source_download_issuance(uuid, uuid, uuid, timestamptz, timestamptz, timestamptz, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decide_trial_balance_source_download_issuance(uuid, uuid, uuid, timestamptz, timestamptz, timestamptz, text, text) TO service_role;

-- A refusal of a caller who failed the pre-check. Nothing was signed, so nothing is ordered with anything; it is a record of the refusal only.
CREATE FUNCTION public.record_trial_balance_source_download_denial(p_user_id uuid, p_company_id uuid, p_upload_id uuid, p_object_sha256 text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE v_upload_company uuid; v_id uuid;
BEGIN
  IF p_user_id IS NULL OR p_company_id IS NULL OR p_upload_id IS NULL OR (p_object_sha256 IS NOT NULL AND p_object_sha256 !~ '^[0-9a-f]{64}$') THEN
    RETURN jsonb_build_object('outcome', 'invalid');
  END IF;
  SELECT u.company_id INTO v_upload_company FROM public.trial_balance_uploads u WHERE u.id = p_upload_id;
  IF v_upload_company IS DISTINCT FROM p_company_id THEN RETURN jsonb_build_object('outcome', 'invalid'); END IF;
  INSERT INTO public.trial_balance_source_download_events (company_id, upload_id, actor_user_id, outcome, object_sha256)
  VALUES (p_company_id, p_upload_id, p_user_id, 'denied', p_object_sha256) RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', 'denied', 'eventId', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.record_trial_balance_source_download_denial(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_trial_balance_source_download_denial(uuid, uuid, uuid, text) TO service_role;
