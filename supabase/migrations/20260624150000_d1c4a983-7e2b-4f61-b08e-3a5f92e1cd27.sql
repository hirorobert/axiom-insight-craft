-- ============================================================
-- Fix 4: RESTRICTIVE policy on account_corrections to enforce
-- that upload_id references an upload owned by the authenticated
-- user.
--
-- WHY THIS GAP EXISTS:
--   The existing INSERT policy only checks auth.uid() = user_id
--   on the correction row itself. Because user_id is now set via
--   DEFAULT auth.uid() (Fix 2), that check is always satisfied
--   for any authenticated user — it does not verify that the
--   upload_id foreign key points to an upload belonging to the
--   same user.
--
-- ATTACK SURFACE WITHOUT THIS FIX:
--   Any authenticated user who knows another user's upload UUID
--   can insert a correction row targeting that upload. The row's
--   user_id will be their own (so they can't read the victim's
--   data), but the UNIQUE(upload_id, account_code) constraint
--   means they can occupy a slot and block the upload owner from
--   ever saving a correction for that account code — a targeted
--   denial-of-service against the mapping workflow.
--
-- WHY RESTRICTIVE rather than DROP+RECREATE:
--   Same reasoning as Fix 3. The existing permissive policies are
--   correct and untouched. A RESTRICTIVE policy ANDs independently
--   with all permissive policies so this strictly narrows access
--   without risk of OR-based loosening.
--
-- SCOPE — INSERT and UPDATE only:
--   SELECT and DELETE operate on rows the user already owns
--   (user_id = auth.uid()), which can only have been created
--   through a path that passed this check. No need to re-validate
--   upload_id ownership on read or delete.
-- ============================================================

-- INSERT: block corrections whose upload_id does not belong to
-- the authenticated user.
CREATE POLICY "corrections_upload_ownership_insert"
ON public.account_corrections
AS RESTRICTIVE
FOR INSERT
TO authenticated
WITH CHECK (
  upload_id IN (
    SELECT id FROM public.trial_balance_uploads WHERE user_id = auth.uid()
  )
);

-- UPDATE: block changes that would move a correction to an upload
-- the authenticated user does not own.
CREATE POLICY "corrections_upload_ownership_update"
ON public.account_corrections
AS RESTRICTIVE
FOR UPDATE
TO authenticated
WITH CHECK (
  upload_id IN (
    SELECT id FROM public.trial_balance_uploads WHERE user_id = auth.uid()
  )
);
