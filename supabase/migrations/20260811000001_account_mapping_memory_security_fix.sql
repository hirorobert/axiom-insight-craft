-- ════════════════════════════════════════════════════════════════════════════
-- Ω∞ SLICE 12 SECURITY FIX — v_latest_account_mapping_memory RLS bypass
--
-- FINDING (live verification via Lovable Cloud, not caught by static SQL
-- review — this project's ALTER DEFAULT PRIVILEGES grants ALL on new public
-- objects to anon/authenticated, which this session had no way to see
-- without a live database):
--
--   GET /rest/v1/v_latest_account_mapping_memory?select=id
--   -> HTTP 200, returned rows for a company the requester has no
--      membership in, using ONLY the public anon key. No auth required.
--
-- ROOT CAUSE: the view is owned by `postgres` and was created without
-- security_invoker, so PostgreSQL evaluates it with the OWNER's privileges
-- — which bypass RLS entirely — rather than the querying role's privileges.
-- Combined with this project's default-privilege grants handing `anon`
-- implicit SELECT on new objects (overriding the migration's intended
-- `GRANT SELECT ... TO authenticated` only), every company's confirmed
-- mapping decisions were readable by anyone holding the public key.
--
-- The base table itself was NOT directly exploitable the same way — an
-- anon SELECT against account_mapping_memory failed with "permission
-- denied for table firm_members" (the RLS policy's EXISTS subquery hit a
-- missing grant on firm_members and errored instead of evaluating to
-- false). That is an ACCIDENTAL protection, not a deliberate one — this
-- fix also explicitly revokes anon's access to the base table directly,
-- so nothing here depends on an incidental permission error elsewhere.
--
-- FIX:
--   1. security_invoker = on -> the view now runs with the QUERYING
--      user's privileges, so the base table's RLS policy (firm-membership
--      scoped) is actually enforced when read through the view.
--   2. Explicit REVOKE ALL FROM anon on both the table and the view,
--      independent of this project's default-privilege configuration —
--      never rely on defaults for a financial table again.
--
-- Verify after applying: an anon-key GET against
-- v_latest_account_mapping_memory must now return 401/empty, matching the
-- base table's existing (if accidental) behavior — this time deliberately.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path TO public, pg_catalog;

ALTER VIEW public.v_latest_account_mapping_memory
  SET (security_invoker = on);

REVOKE ALL ON public.account_mapping_memory FROM anon;
REVOKE ALL ON public.v_latest_account_mapping_memory FROM anon;

-- Re-assert the intended grants explicitly (belt-and-braces against this
-- project's default-privilege behavior recurring on a future object).
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
