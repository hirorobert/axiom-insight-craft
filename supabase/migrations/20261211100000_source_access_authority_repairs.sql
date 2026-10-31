-- Independent review of #229: findings 2 and 5. Two forward-only, additive repairs to workspace file access. Nothing here rewrites an applied migration.
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
-- 2. FINDING 5 - a durable record of file-link ISSUANCE decisions. trial_balance_source_download_events records, per decision of the
--    trial-balance-source-download function: issued (a link was returned), denied (an authenticated caller naming a real upload of a real company lacked the
--    right) and withdrawn_before_issue (the right was withdrawn while the link was being signed and the link was discarded). Columns: who, which company and
--    upload, the outcome, the link's expiry and the recorded fingerprint - never a URL, token or object path. It is written by the function (service role)
--    BEFORE a link is returned, and a link is never returned if the record could not be written. It does NOT record that the file was transferred: bytes
--    travel from Storage to the browser, which the function cannot observe. Append-only (no update, delete or truncate); the workspace owner may read it
--    (RLS), nobody else; no row is removed with an upload or a workspace. RETENTION is not set: no existing requirement fixes one, so rows are kept until the
--    owner decides a retention period, which is a recorded open decision rather than a default invented here.

DO $refuse$
BEGIN
  IF to_regclass('public.workspace_capability_grants') IS NULL OR to_regclass('public.workspace_capability_grant_events') IS NULL
     OR to_regclass('public.firm_members') IS NULL OR to_regclass('public.companies') IS NULL
     OR to_regprocedure('public.tbu_append_only_guard()') IS NULL THEN
    RAISE EXCEPTION 'SOURCE_ACCESS_REPAIRS_PREREQUISITE: the workspace grant tables and the append-only guard (20260923100000) must exist' USING ERRCODE = '55000';
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
  occurred_at timestamptz NOT NULL DEFAULT now(),
  company_id uuid NOT NULL,        -- not FKs: the record must outlive a deleted upload or workspace
  upload_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('issued', 'denied', 'withdrawn_before_issue')),
  link_expires_at timestamptz,
  object_sha256 text CHECK (object_sha256 IS NULL OR object_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT chk_tbsde_expiry_only_when_issued CHECK ((outcome = 'issued') = (link_expires_at IS NOT NULL))
);
CREATE INDEX idx_tbsde_company_time ON public.trial_balance_source_download_events (company_id, occurred_at DESC);
ALTER TABLE public.trial_balance_source_download_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trial_balance_source_download_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.trial_balance_source_download_events TO authenticated;
GRANT SELECT, INSERT ON public.trial_balance_source_download_events TO service_role;
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
