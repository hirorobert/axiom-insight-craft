INSERT INTO cfoclose_source_access_release.staged_artifacts(batch, kind, body) VALUES ('source-access-1', 'source', $cfoclose_source_access_stage_be582111440335ae$-- Independent review of #229: findings 2 and 5 (and the re-review of finding 3). Two additive repairs to workspace file access. These are UNAPPLIED candidate
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
--    withdrawn or if the signed link has less than the required margin left at the freshness evaluation (judged last, immediately before the insert), and (d) inserts the decision record. Its COMMIT is the ordering point: a withdrawal that commits
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
--    OWNER IDENTITY. The plan and seat locks are taken for the owner read before the company row is locked. After the company row is locked (an ownership
--    change is an UPDATE of that row, so it now waits for this transaction) the owner is read again; if it differs from the owner whose locks are held, the
--    decision refuses ('unavailable', nothing recorded, retry-safe). It never takes the new owner's locks: doing so after other locks are held is how lock
--    inversions begin. The writer found for an ownership change is a plain UPDATE of companies.user_id guarded by trg_companies_entity_capacity, which takes
--    only the target account's cfoclose.entity_capacity lock - a key the decision never takes, so the two cannot deadlock.
--
--    WHAT A RECORD MEANS. trial_balance_source_download_events records DECISIONS of the function. 'issued': under the locks, authority held and, at
--    freshness_evaluated_at, the link had at least link_min_remaining_seconds left. These facts are kept distinct and none is promoted to another:
--      * the AUTHORIZATION / ISSUANCE DECISION   - outcome, with authority_evaluated_at;
--      * the FRESHNESS EVALUATION                - freshness_evaluated_at and freshness_remaining_ms: the database clock immediately before the insert. It proves the
--                                                  link had that much life THEN. It does not prove validity at commit: a transaction can pause after its last check;
--      * the TRANSACTION COMPLETION              - NOT recorded: it cannot be known inside the transaction and may be later than the freshness evaluation;
--      * the RESPONSE DELIVERY                   - NOT recorded and not observable by this function (the bytes travel from Storage to the browser).
--    A decision may therefore exist without a delivered response. After the commit the function checks freshness once more on its own clock and withholds the
--    link when it has run out (answer link_expired, never "ready" with no time left); the row stays exactly as committed - nothing is updated, because
--    history is immutable. 'denied' = the pre-check refused an authenticated caller who named a real upload of a real company; 'withdrawn_before_issue' = the
--    right was gone at the decision; 'expired_before_issue' = the link had less than the margin left at the freshness evaluation.
--    EXPIRY IS THE SIGNER'S OWN, OR NOTHING IS ISSUED. link_expiry_exact_at is the link's exp (whole seconds, as the token carries it). There is no estimated
--    expiry: Storage may truncate the signing instant to a whole second, which can make the real exp up to a second earlier than "signing start + lifetime", so
--    any estimate built from the signing interval is not reliably conservative once timestamp resolution and clock differences are counted. A link whose exp
--    cannot be read is refused (signing_failed) and no decision is recorded. link_min_remaining_seconds (5 s, chosen by the function) is a POLICY margin for
--    response transit and modest clock differences between Storage and the database; it is not derived from a measured skew, and no skew bound is claimed.
--    The function host's clock readings around signing are recorded for audit; the freshness comparison uses the database clock against the signer's exp.
--    Never a URL, token or object path. Only the two functions below write the table (the service role has SELECT only), so no unconditional insert exists.
--    Append-only; the workspace owner may read the workspace's rows (RLS), nobody else. NOT decided: who else may read (administrators, auditors, the actor),
--    RETENTION, whether other-company or unknown-upload attempts should be recorded, and the clock-skew policy - recorded open decisions, not defaults invented here.

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
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),   -- the database clock when the row was inserted (inside the decision transaction)
  company_id uuid NOT NULL,        -- not FKs: the record must outlive a deleted upload or workspace
  upload_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('issued', 'denied', 'withdrawn_before_issue', 'expired_before_issue')),
  -- Everything below is null for a denial (nothing was signed).
  signing_started_at timestamptz,          -- function-host clock readings around the Storage signing call
  signing_completed_at timestamptz,
  link_lifetime_seconds integer,           -- the lifetime that was REQUESTED from Storage
  link_expiry_exact_at timestamptz,        -- the signer's OWN exp for the link (whole seconds, as the token carries it). There is no estimated expiry: a link whose exp cannot be read is never issued.
  link_min_remaining_seconds integer,      -- the margin the decision required at its freshness evaluation (a policy parameter, see the header)
  authority_evaluated_at timestamptz,      -- database clock, right after authority was judged under the locks
  freshness_evaluated_at timestamptz,      -- database clock, right before the row was inserted: when freshness was judged. NULL when authority was already withdrawn (freshness was not evaluated)
  freshness_remaining_ms bigint,           -- link_expiry_exact_at - freshness_evaluated_at, in ms (negative once passed)
  object_sha256 text CHECK (object_sha256 IS NULL OR object_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_tbsde_denial_has_no_signing CHECK ((outcome = 'denied') = (signing_started_at IS NULL AND signing_completed_at IS NULL AND link_lifetime_seconds IS NULL
    AND link_expiry_exact_at IS NULL AND link_min_remaining_seconds IS NULL AND authority_evaluated_at IS NULL AND freshness_evaluated_at IS NULL AND freshness_remaining_ms IS NULL)),
  CONSTRAINT chk_tbsde_signed_is_complete CHECK (outcome = 'denied' OR (signing_started_at IS NOT NULL AND signing_completed_at IS NOT NULL AND signing_started_at <= signing_completed_at
    AND link_lifetime_seconds BETWEEN 1 AND 3600 AND link_expiry_exact_at IS NOT NULL AND link_min_remaining_seconds BETWEEN 0 AND 30 AND authority_evaluated_at IS NOT NULL)),
  -- Freshness is evaluated exactly when authority held: a withdrawn decision never evaluated it; issued and expired decisions always did, after authority.
  CONSTRAINT chk_tbsde_freshness_shape CHECK ((outcome IN ('issued', 'expired_before_issue')) = (freshness_evaluated_at IS NOT NULL AND freshness_remaining_ms IS NOT NULL)
    AND (freshness_evaluated_at IS NULL OR freshness_evaluated_at >= authority_evaluated_at)),
  CONSTRAINT chk_tbsde_remaining_is_derived CHECK (freshness_evaluated_at IS NULL
    OR freshness_remaining_ms = round(extract(epoch FROM (link_expiry_exact_at - freshness_evaluated_at)) * 1000)),
  -- The outcome follows the margin: issued only with at least the required remaining life at the evaluation; expired otherwise.
  CONSTRAINT chk_tbsde_outcome_follows_margin CHECK (outcome <> 'issued' OR freshness_remaining_ms >= link_min_remaining_seconds * 1000),
  CONSTRAINT chk_tbsde_expired_follows_margin CHECK (outcome <> 'expired_before_issue' OR freshness_remaining_ms < link_min_remaining_seconds * 1000)
);
COMMENT ON TABLE public.trial_balance_source_download_events IS
  'Decisions of trial-balance-source-download, taken inside one database transaction. issued = authority held under the locks and, at freshness_evaluated_at, the link had at least link_min_remaining_seconds left. It is NOT evidence that the transaction completed at that instant (a transaction can pause between its last check and its commit), that a response was delivered, or that a file was downloaded. Never a URL, token or path. Append-only: no later fact (a response withheld because the link had expired, a failed delivery) rewrites a row.';
COMMENT ON COLUMN public.trial_balance_source_download_events.link_expiry_exact_at IS
  'The signer''s own exp for the link. There is no estimated expiry: if exp cannot be read the link is not issued.';
COMMENT ON COLUMN public.trial_balance_source_download_events.freshness_evaluated_at IS
  'Database clock when freshness was judged, immediately before the insert. Not the commit time (unknowable inside the transaction) and not delivery.';
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

-- ── 3. the issuance DECISION: locks, authority, freshness and the record in one transaction ───────────────────────────
-- Outcomes: issued | withdrawn_before_issue | expired_before_issue (each recorded) | unavailable (a lock could not be had in time, or the workspace changed
-- owner while the decision was being taken; nothing recorded, safe to retry) | invalid (the inputs name nothing real; nothing recorded). The caller
-- returns the link ONLY for 'issued'.
-- OWNER IDENTITY. The plan and seat locks are taken for the owner read BEFORE the company row is locked. Once the company row is locked (FOR SHARE: an
-- ownership change is an UPDATE of that row and now waits for this transaction) the owner is read AGAIN; if it differs from the owner whose plan and seat
-- locks are held, the decision refuses ('unavailable'). It never takes the new owner's locks: doing so after other locks are held is how lock inversions
-- begin. A retry starts from the new owner. So every authority input is judged under the locks of the account it is judged for.
-- FRESHNESS is evaluated as late as is practical: after the locks (a decision delayed by a lock wait is judged at its true time), after authority, immediately
-- before the insert. Both instants are recorded. It proves the link had link_min_remaining_seconds left THEN; it does not prove validity at commit.
CREATE FUNCTION public.decide_trial_balance_source_download_issuance(
  p_user_id uuid, p_company_id uuid, p_upload_id uuid,
  p_signing_started_at timestamptz, p_signing_completed_at timestamptz,
  p_link_lifetime_seconds integer, p_link_expiry_exact_at timestamptz, p_min_remaining_seconds integer, p_object_sha256 text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public SET lock_timeout = '5s' AS $$
DECLARE
  v_account uuid; v_locked_owner uuid; v_upload_company uuid; v_outcome text; v_id uuid;
  v_auth_at timestamptz; v_fresh_at timestamptz; v_remaining_ms bigint;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'SOURCE_DOWNLOAD_ISOLATION: authority is re-judged after its locks are taken and needs READ COMMITTED' USING ERRCODE = '25000';
  END IF;
  IF p_user_id IS NULL OR p_company_id IS NULL OR p_upload_id IS NULL OR p_signing_started_at IS NULL OR p_signing_completed_at IS NULL
     OR p_signing_started_at > p_signing_completed_at OR p_link_lifetime_seconds IS NULL OR p_link_lifetime_seconds NOT BETWEEN 1 AND 3600
     OR p_link_expiry_exact_at IS NULL OR p_min_remaining_seconds IS NULL OR p_min_remaining_seconds NOT BETWEEN 0 AND 30
     OR (p_object_sha256 IS NOT NULL AND p_object_sha256 !~ '^[0-9a-f]{64}$')
     -- a signer-reported expiry that outlives the request by more than 30 s is not a link this function issues
     OR p_link_expiry_exact_at > p_signing_completed_at + make_interval(secs => p_link_lifetime_seconds + 30) THEN
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
    SELECT c.user_id INTO v_locked_owner FROM public.companies c WHERE c.id = p_company_id FOR SHARE;
  EXCEPTION WHEN lock_not_available THEN
    RETURN jsonb_build_object('outcome', 'unavailable');
  END;
  IF v_locked_owner IS DISTINCT FROM v_account THEN
    -- the workspace changed owner after the owner was read: the plan and seat locks held are for the previous account. Refuse; do not take more locks.
    RETURN jsonb_build_object('outcome', 'unavailable');
  END IF;
  -- Authority is judged AFTER the locks, on a fresh statement snapshot, so everything committed before the locks were granted is seen and nothing that
  -- changes the answer can commit before this transaction does.
  IF public.workspace_authority_basis(p_user_id, p_company_id, 'manage_source_files') IS NULL THEN
    v_auth_at := clock_timestamp(); v_outcome := 'withdrawn_before_issue';
  ELSE
    v_auth_at := clock_timestamp();
    -- FRESHNESS, as late as practical: judged now, immediately before the insert, on the signer's own exp.
    v_fresh_at := clock_timestamp();
    v_remaining_ms := round(extract(epoch FROM (p_link_expiry_exact_at - v_fresh_at)) * 1000)::bigint;
    v_outcome := CASE WHEN v_remaining_ms >= p_min_remaining_seconds * 1000 THEN 'issued' ELSE 'expired_before_issue' END;
  END IF;
  INSERT INTO public.trial_balance_source_download_events
    (company_id, upload_id, actor_user_id, outcome, signing_started_at, signing_completed_at, link_lifetime_seconds, link_expiry_exact_at,
     link_min_remaining_seconds, authority_evaluated_at, freshness_evaluated_at, freshness_remaining_ms, object_sha256)
  VALUES (p_company_id, p_upload_id, p_user_id, v_outcome, p_signing_started_at, p_signing_completed_at, p_link_lifetime_seconds, p_link_expiry_exact_at,
     p_min_remaining_seconds, v_auth_at, v_fresh_at, v_remaining_ms, p_object_sha256)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('outcome', v_outcome, 'eventId', v_id);
END;
$$;
REVOKE ALL ON FUNCTION public.decide_trial_balance_source_download_issuance(uuid, uuid, uuid, timestamptz, timestamptz, integer, timestamptz, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decide_trial_balance_source_download_issuance(uuid, uuid, uuid, timestamptz, timestamptz, integer, timestamptz, integer, text) TO service_role;

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
$cfoclose_source_access_stage_be582111440335ae$);
