-- ════════════════════════════════════════════════════════════════════════════
-- Ω∞ PHASE 0A-2R — ACL HARDENING (additive correction, post-live-execution)
--
-- LIVE FINDING: `authenticated` was found holding full arwdDxtm privileges
-- on both public.engine_runs and public.idempotency_keys after the live
-- application of 20260901120000_engine_execution_foundation.sql (Lovable
-- execution identity 20260902052434 — see that file, now a comment-only
-- marker, and MIGRATION_RECONCILIATION.md for the full record).
--
-- ROOT CAUSE (proven, not assumed): the canonical migration's own text —
--   REVOKE ALL ON public.engine_runs FROM PUBLIC, anon;
--   GRANT SELECT ON public.engine_runs TO authenticated;
-- — never named `authenticated` in the REVOKE. This project's
-- pg_default_acl already grants `authenticated` broad privileges at
-- CREATE TABLE time (DEFECT-DEFAULT-ACL-AUTHENTICATED-001, project-wide,
-- still OPEN — NOT addressed here). The GRANT SELECT that followed was
-- therefore additive on top of that inherited grant, not a replacement of
-- it. RLS still blocked unauthorized rows, but the table-level ACL itself
-- did not satisfy the required defence-in-depth invariant.
--
-- SCOPE: this migration touches ONLY the grants on public.engine_runs and
-- public.idempotency_keys. It does not touch ALTER DEFAULT PRIVILEGES
-- (that remains DEFECT-DEFAULT-ACL-AUTHENTICATED-001's separate, future,
-- project-wide remediation), RLS, policies, triggers, columns, constraints,
-- Phase 2A objects, or KINGA/HESABU/MAONO.
--
-- IDEMPOTENT ON REPLAY: every statement below is a plain REVOKE/GRANT,
-- safe to run again — REVOKE on a role with no matching privilege is a
-- no-op, and GRANT is idempotent by nature. Replaying this migration on a
-- fresh database, immediately after 20260901120000, produces the identical
-- final state described below regardless of whatever pg_default_acl that
-- fresh database happens to have — this migration does not depend on
-- Lovable's specific defective default for correctness.
-- ════════════════════════════════════════════════════════════════════════════

SET search_path TO public, pg_catalog;

-- ── engine_runs ───────────────────────────────────────────────────────────────
REVOKE ALL PRIVILEGES ON public.engine_runs FROM PUBLIC;
REVOKE ALL PRIVILEGES ON public.engine_runs FROM anon;
REVOKE ALL PRIVILEGES ON public.engine_runs FROM authenticated;
GRANT SELECT ON public.engine_runs TO authenticated;
-- Explicit normalization, not reliance on whatever service_role inherited —
-- the exact authority Edge Functions require: full read/write.
GRANT ALL PRIVILEGES ON public.engine_runs TO service_role;

-- ── idempotency_keys ─────────────────────────────────────────────────────────
REVOKE ALL PRIVILEGES ON public.idempotency_keys FROM PUBLIC;
REVOKE ALL PRIVILEGES ON public.idempotency_keys FROM anon;
REVOKE ALL PRIVILEGES ON public.idempotency_keys FROM authenticated;
GRANT SELECT ON public.idempotency_keys TO authenticated;
GRANT ALL PRIVILEGES ON public.idempotency_keys TO service_role;

-- Required final state, independent of any default:
--   PUBLIC:        none
--   anon:          none
--   authenticated: SELECT only
--   service_role:  full (required for Edge Function read/write)
--
-- Not touched by this migration: sequences (Phase 0A uses gen_random_uuid()
-- primary keys, not an application-facing sequence requiring its own ACL —
-- confirmed by reading 20260901120000; no sequence ACL statement was
-- invented here), lifecycle trigger functions (already confirmed, via the
-- executable-content equivalence proof against Lovable's live execution, to
-- be SECURITY INVOKER with EXECUTE already revoked from PUBLIC, anon,
-- authenticated, and service_role — no discrepancy exists to correct).
