SET search_path TO public, pg_catalog;

ALTER VIEW public.v_latest_account_mapping_memory
  SET (security_invoker = on);

REVOKE ALL ON public.account_mapping_memory FROM anon;
REVOKE ALL ON public.v_latest_account_mapping_memory FROM anon;

GRANT SELECT ON public.account_mapping_memory TO authenticated;
GRANT SELECT ON public.v_latest_account_mapping_memory TO authenticated;
GRANT ALL    ON public.account_mapping_memory TO service_role;

COMMENT ON VIEW public.v_latest_account_mapping_memory IS
  'Most recent confirmation per (company, natural_account_code, period) — '
  'consumers read this view, never account_mapping_memory directly, so a '
  'superseding row always wins without any row ever being deleted or updated. '
  'security_invoker=on as of 20260811000001: the view MUST run with the '
  'querying role''s privileges, not its postgres owner''s, or RLS on the '
  'base table is silently bypassed (real incident found in this project '
  'via live anon-key testing — see migration file header).';