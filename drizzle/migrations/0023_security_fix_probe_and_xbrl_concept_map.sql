-- Fix 1: _pr34_probe is a leftover release-verification table. Lock it down entirely:
-- enable RLS with no policies so no client role can read or write it.
ALTER TABLE public._pr34_probe ENABLE ROW LEVEL SECURITY;

-- Fix 2: xbrl_concept_map is reference data meant to be readable by signed-in users,
-- but the blanket USING (true) policy is flagged. Replace it with an explicit
-- authenticated-only predicate.
DROP POLICY IF EXISTS xbrl_concept_map_read ON public.xbrl_concept_map;
CREATE POLICY xbrl_concept_map_read ON public.xbrl_concept_map
  FOR SELECT TO authenticated
  USING (auth.uid() IS NOT NULL);