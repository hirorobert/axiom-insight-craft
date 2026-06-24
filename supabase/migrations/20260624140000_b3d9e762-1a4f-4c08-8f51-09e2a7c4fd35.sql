-- ============================================================
-- Fix 3: RESTRICTIVE policy on trial_balance_uploads to enforce
-- that company_id, when set, references a company owned by the
-- authenticated user.
--
-- WHY RESTRICTIVE rather than DROP+RECREATE of existing policies:
--   The four existing permissive policies on trial_balance_uploads
--   ("Users can view/insert/update/delete their own uploads") are
--   already correct and battle-tested. Dropping and recreating them
--   to add a company_id condition would risk introducing an accidental
--   OR-based loosening if a second permissive policy were ever added
--   later — Postgres grants access if ANY single permissive policy
--   passes. A RESTRICTIVE policy ANDs with all permissive policies:
--   a row is only accessible if at least one permissive policy passes
--   AND every restrictive policy passes. This strictly narrows what
--   is allowed without touching the existing policies at all, keeping
--   the changeset minimal and the existing auth.uid() = user_id
--   checks completely undisturbed.
--
-- SCOPE — INSERT and UPDATE only:
--   SELECT and DELETE do not need this check. A user can only
--   SELECT/DELETE rows they already own (enforced by the existing
--   permissive policies), and by the time a row exists its company_id
--   was already validated on INSERT/UPDATE.
--
-- NULL handling: company_id is nullable (optional association).
--   The condition explicitly allows NULL so uploads with no company
--   are not blocked.
-- ============================================================

-- INSERT: block any attempt to associate an upload with a company
-- the authenticated user does not own.
CREATE POLICY "uploads_company_ownership_insert"
ON public.trial_balance_uploads
AS RESTRICTIVE
FOR INSERT
TO authenticated
WITH CHECK (
  company_id IS NULL
  OR company_id IN (
    SELECT id FROM public.companies WHERE user_id = auth.uid()
  )
);

-- UPDATE: block any attempt to change company_id to a company the
-- authenticated user does not own. WITH CHECK validates the post-update
-- value; the pre-update row is already constrained to the user's own
-- rows by the existing permissive UPDATE policy.
CREATE POLICY "uploads_company_ownership_update"
ON public.trial_balance_uploads
AS RESTRICTIVE
FOR UPDATE
TO authenticated
WITH CHECK (
  company_id IS NULL
  OR company_id IN (
    SELECT id FROM public.companies WHERE user_id = auth.uid()
  )
);
