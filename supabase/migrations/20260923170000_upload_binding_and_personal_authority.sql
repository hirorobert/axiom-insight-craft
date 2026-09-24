-- ════════════════════════════════════════════════════════════════════════════
-- PR #32, part 7: final correction after the independent re-review of fc4cbd4. Forward-only.
--
--   P-02  A workspace upload's binding is immutable. Once a row belongs to a workspace (company_id set), no caller
--         (anon, authenticated, service_role) may change company_id, period_id, period_year, fiscal_year_end,
--         user_id or file_path, in any lifecycle state. A personal row can never be attached to a workspace.
--         So a row cannot be detached, processed outside the workspace controls and re-attached, and cannot leave
--         uq_one_active_upload_per_period. Exactly two internal paths remain, both unreachable from any client or
--         service_role request:
--           * an authorized lifecycle operation: server code running as the function owner with the sanctioned
--             operation marker set;
--           * the database's own ON DELETE SET NULL: a nested (pg_trigger_depth() > 1) change by the table owner
--             that only NULLs company_id / period_id (plus the period fields derived from period_id), and only
--             when the referenced company / fiscal period no longer exists.
--   N-05  '..' is refused only as a complete path segment (traversal), never inside a name such as TB..final.csv.
--   N-06  ONE authority for source-path rules: tbu_path_well_formed / tbu_personal_source_path /
--         tbu_workspace_source_path_shape, used by tbu_source_path_bound (processing: process-trial-balance; cleanup
--         hold: tbu_object_referenced), by tbu_bound_storage_path (the path a discard or cancellation binds), and by
--         the client insert guard. Processing and cleanup can no longer disagree.
--   N-07  The workspace lifecycle ledger never receives an event without a workspace: tbu_log_event is a no-op for
--         company_id NULL, so a lifecycle RPC called on a personal upload answers its canonical 'forbidden' instead
--         of a raw 23502.
--
-- (P-01 is in process-trial-balance: a personal upload is processed only for its own uploader.)
-- Accounting values, certification verdicts, stage locks, the one-active-upload index and audit history are untouched.
-- ════════════════════════════════════════════════════════════════════════════

-- ── N-05 / N-06: the path rules, defined once ────────────────────────────────────────────────
-- Well formed: non-empty; no empty, '.' or '..' segment (so no leading or trailing '/', no '//', no traversal);
-- no backslash; no control character. '..' INSIDE a segment (TB..final.csv) is an ordinary name.
-- Mirrored exactly by supabase/functions/_shared/sourcePath.ts (same corpus: src/lib/workspace/__fixtures__/sourcePathCorpus.json).
CREATE OR REPLACE FUNCTION public.tbu_path_well_formed(p_path text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(
    p_path IS NOT NULL AND p_path <> ''
    AND position(E'\\' IN p_path) = 0
    AND p_path !~ '[[:cntrl:]]'
    AND NOT EXISTS (SELECT 1 FROM unnest(string_to_array(p_path, '/')) AS s(seg) WHERE s.seg IN ('', '.', '..')),
    false);
$$;

-- A personal / legacy source: exactly <uploader>/<name>.
CREATE OR REPLACE FUNCTION public.tbu_personal_source_path(p_path text, p_user_id uuid)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(
    public.tbu_path_well_formed(p_path) AND p_user_id IS NOT NULL
    AND array_length(string_to_array(p_path, '/'), 1) = 2
    AND split_part(p_path, '/', 1) = p_user_id::text,
    false);
$$;

-- The workspace shape: exactly workspaces/<workspace>/<source>/<name>.
CREATE OR REPLACE FUNCTION public.tbu_workspace_source_path_shape(p_path text, p_company_id uuid)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(
    public.tbu_path_well_formed(p_path) AND p_company_id IS NOT NULL
    AND array_length(string_to_array(p_path, '/'), 1) = 4
    AND split_part(p_path, '/', 1) = 'workspaces'
    AND split_part(p_path, '/', 2) = p_company_id::text,
    false);
$$;

-- THE binding predicate (supersedes 20260923150000). Workspace path: the shape, plus the server reservation for
-- exactly this path consumed by exactly this upload in exactly this workspace. Anything else: the personal shape
-- for the row's own uploader.
CREATE OR REPLACE FUNCTION public.tbu_source_path_bound(p_file_path text, p_upload_id uuid, p_company_id uuid, p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN split_part(COALESCE(p_file_path, ''), '/', 1) = 'workspaces' THEN
      public.tbu_workspace_source_path_shape(p_file_path, p_company_id)
      AND EXISTS (SELECT 1 FROM public.trial_balance_source_reservations r
                   WHERE r.object_path = p_file_path AND r.company_id = p_company_id AND r.consumed_by_upload_id = p_upload_id)
    ELSE public.tbu_personal_source_path(p_file_path, p_user_id)
  END;
$$;

-- The path a discard / cancellation may bind for later deletion (supersedes 20260923100000): the row's own bound
-- path, and only while no OTHER bound row names it. Same predicate as processing and the cleanup hold.
CREATE OR REPLACE FUNCTION public.tbu_bound_storage_path(p_upload public.trial_balance_uploads)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE
    WHEN public.tbu_source_path_bound(p_upload.file_path, p_upload.id, p_upload.company_id, p_upload.user_id)
         AND NOT EXISTS (SELECT 1 FROM public.trial_balance_uploads t
                          WHERE t.file_path = p_upload.file_path AND t.id <> p_upload.id
                            AND public.tbu_source_path_bound(t.file_path, t.id, t.company_id, t.user_id))
    THEN p_upload.file_path
  END;
$$;

-- Client insert guard (supersedes 20260923150000): the same personal-path rule.
CREATE OR REPLACE FUNCTION public.trial_balance_upload_client_source_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.file_path IS DISTINCT FROM OLD.file_path OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'Iron Dome: a trial balance upload''s source path and uploader are set by the server only.'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF v_uid IS NULL OR NEW.user_id IS DISTINCT FROM v_uid OR NOT public.tbu_personal_source_path(NEW.file_path, v_uid) THEN
    RAISE EXCEPTION 'Iron Dome: a directly created upload must name a file in your own folder. Workspace sources are registered by the server.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- ── P-02: a workspace upload's binding is immutable ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.trial_balance_upload_workspace_binding_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  -- Server code running as the table/function owner. Never a client role, never service_role.
  v_internal boolean := current_user NOT IN ('anon', 'authenticated', 'service_role');
BEGIN
  IF OLD.company_id IS NULL AND NEW.company_id IS NULL THEN
    RETURN NEW; -- a personal row stays personal (its path and uploader are guarded by the client source guard)
  END IF;
  IF NEW.company_id IS NOT DISTINCT FROM OLD.company_id AND NEW.period_id IS NOT DISTINCT FROM OLD.period_id
     AND NEW.period_year IS NOT DISTINCT FROM OLD.period_year AND NEW.fiscal_year_end IS NOT DISTINCT FROM OLD.fiscal_year_end
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id AND NEW.file_path IS NOT DISTINCT FROM OLD.file_path THEN
    RETURN NEW;
  END IF;
  -- (1) An authorized lifecycle operation (SECURITY DEFINER server code with the sanctioned marker).
  IF v_internal AND COALESCE(current_setting('axiom.tbu_lifecycle_op', true), '') <> '' THEN
    RETURN NEW;
  END IF;
  -- (2) The database's own ON DELETE SET NULL: nested, internal, NULLing only, and the parent really is gone.
  IF v_internal AND pg_trigger_depth() > 1
     AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id AND NEW.file_path IS NOT DISTINCT FROM OLD.file_path
     AND (NEW.company_id IS NOT DISTINCT FROM OLD.company_id
          OR (NEW.company_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = OLD.company_id)))
     AND (NEW.period_id IS NOT DISTINCT FROM OLD.period_id
          OR (NEW.period_id IS NULL AND NOT EXISTS (SELECT 1 FROM public.fiscal_periods f WHERE f.id = OLD.period_id)))
     AND ((NEW.period_year IS NOT DISTINCT FROM OLD.period_year AND NEW.fiscal_year_end IS NOT DISTINCT FROM OLD.fiscal_year_end)
          OR (NEW.period_id IS NULL AND OLD.period_id IS NOT NULL)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Iron Dome: a workspace trial balance upload cannot be detached from its workspace, attached to one, moved to another period, or re-pointed at another file or uploader.'
    USING ERRCODE = '42501';
END;
$$;
DROP TRIGGER IF EXISTS trg_tbu_workspace_binding_immutable ON public.trial_balance_uploads;
-- Named to sort after the period-sync BEFORE triggers, so it judges the row as it would actually be written.
CREATE TRIGGER trg_tbu_workspace_binding_immutable
  BEFORE UPDATE ON public.trial_balance_uploads
  FOR EACH ROW EXECUTE FUNCTION public.trial_balance_upload_workspace_binding_guard();

-- ── N-07: the workspace ledger never receives an event without a workspace ──────────────────
CREATE OR REPLACE FUNCTION public.tbu_log_event(
  p_upload_id uuid, p_company_id uuid, p_engagement_id uuid, p_period_year integer,
  p_from text, p_to text, p_actor_kind text, p_actor_user uuid, p_actor_membership uuid,
  p_basis text, p_capability text, p_outcome text, p_operation_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_company_id IS NULL THEN
    RETURN; -- a personal upload belongs to no workspace; there is no workspace ledger to write it to
  END IF;
  INSERT INTO public.trial_balance_upload_lifecycle_events
    (upload_id, company_id, engagement_id, period_year, from_state, to_state, actor_kind, actor_user_id,
     actor_membership_id, authority_basis, authority_capability, outcome, operation_id, reason)
  VALUES (p_upload_id, p_company_id, p_engagement_id, p_period_year, p_from, p_to, p_actor_kind, p_actor_user,
          p_actor_membership, p_basis, p_capability, p_outcome, p_operation_id, p_reason);
END;
$$;

-- ── Privileges ───────────────────────────────────────────────────────────────────────────────
-- The three path rules are pure (no data access): the client guard runs as the calling client role and uses them.
REVOKE ALL ON FUNCTION public.tbu_path_well_formed(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tbu_personal_source_path(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tbu_workspace_source_path_shape(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tbu_path_well_formed(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tbu_personal_source_path(text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.tbu_workspace_source_path_shape(text, uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.tbu_source_path_bound(text, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_bound_storage_path(public.trial_balance_uploads) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trial_balance_upload_client_source_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.trial_balance_upload_workspace_binding_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tbu_log_event(uuid, uuid, uuid, integer, text, text, text, uuid, uuid, text, text, text, uuid, text) FROM PUBLIC, anon, authenticated;

-- ── Rollback (NOT executed; for reference only; review before use) ──────────────────────────
-- Revert process-trial-balance first, then: DROP TRIGGER trg_tbu_workspace_binding_immutable ON
-- public.trial_balance_uploads; restore the 20260923150000 bodies of tbu_source_path_bound and
-- trial_balance_upload_client_source_guard, the 20260923100000 bodies of tbu_bound_storage_path and tbu_log_event,
-- and drop trial_balance_upload_workspace_binding_guard, tbu_path_well_formed, tbu_personal_source_path and
-- tbu_workspace_source_path_shape.
