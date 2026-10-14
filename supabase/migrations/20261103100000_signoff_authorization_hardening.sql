-- ============================================================================
-- CANDIDATE REPAIR — legacy statement_sign_offs authorization hardening
-- Branch: fix/signoff-authorization-20261014   Base: dfd4098
--
-- STATUS: NOT APPLIED. UNVERIFIED. Requires replay + proof on an isolated
--         loopback PostgreSQL 16 (scripts/db-proof/signoff_authorization_proof.mjs)
--         BEFORE use in any environment. No runtime proof is claimed.
--
-- Closes five DB-layer defects on the LEGACY statement_sign_offs table
-- (the newer financial_statement_publications / fs_set_publication_state path
--  is unaffected and already hardened):
--   A (CRITICAL) INSERT bypasses the HESABU gate AND the approver-tier gate
--   B (HIGH)     signer identity client-supplied, unbound to auth.uid()
--   C (MEDIUM)   locked rows mutable by approvers (no locked_at IS NULL guard)
--   D (HIGH)     stale validation accepted; sign-off not bound to signed content
--   E (MEDIUM)   tier sequence not enforced in the DB
--
-- Approach: a single fail-closed BEFORE INSERT OR UPDATE trigger that is a
-- no-op for a correctly-behaving caller. Additive only — no column or data
-- change. Defensive beside existing RLS; covers INSERT, which RLS does not
-- tier-gate, and UPDATE, which the old hesabu trigger never fired on.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enforce_signoff_authorization()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor        UUID := auth.uid();
  v_latest       public.hesabu_validations%ROWTYPE;
  v_signs_prep   BOOLEAN;
  v_signs_rev    BOOLEAN;
  v_signs_appr   BOOLEAN;
  v_locks        BOOLEAN;
  v_any_sig      BOOLEAN;
BEGIN
  -- ── C. Locked rows are immutable (forward-only corrections = new rows) ──
  -- Allow the service_role correction path to bypass (edge functions only).
  IF TG_OP = 'UPDATE' AND OLD.locked_at IS NOT NULL
     AND current_setting('request.jwt.claim.role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION
      'SIGN-OFF LOCKED: this sign-off is locked and immutable; corrections must create a new version'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Which signature/lock fields are being newly set by THIS write?
  v_signs_prep := NEW.preparer_signed_at IS NOT NULL
                  AND (TG_OP = 'INSERT' OR OLD.preparer_signed_at IS NULL);
  v_signs_rev  := NEW.reviewer_signed_at IS NOT NULL
                  AND (TG_OP = 'INSERT' OR OLD.reviewer_signed_at IS NULL);
  v_signs_appr := NEW.approver_signed_at IS NOT NULL
                  AND (TG_OP = 'INSERT' OR OLD.approver_signed_at IS NULL);
  v_locks      := NEW.locked_at IS NOT NULL
                  AND (TG_OP = 'INSERT' OR OLD.locked_at IS NULL);
  v_any_sig    := v_signs_prep OR v_signs_rev OR v_signs_appr OR v_locks;

  IF NOT v_any_sig THEN
    RETURN NEW;  -- draft/metadata write with no new signature — nothing to gate here
  END IF;

  -- An anonymous/service write that sets a signature has no human actor to bind.
  IF v_actor IS NULL
     AND current_setting('request.jwt.claim.role', true) IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'SIGN-OFF: no authenticated actor' USING ERRCODE = 'restrict_violation';
  END IF;

  -- ── E. Tier sequence: preparer → reviewer → approver → locked ──
  IF v_signs_rev AND NEW.preparer_signed_at IS NULL THEN
    RAISE EXCEPTION 'SIGN-OFF SEQUENCE: reviewer cannot sign before preparer'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF v_signs_appr AND NEW.reviewer_signed_at IS NULL THEN
    RAISE EXCEPTION 'SIGN-OFF SEQUENCE: approver cannot sign before reviewer'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF v_locks AND NEW.approver_signed_at IS NULL THEN
    RAISE EXCEPTION 'SIGN-OFF SEQUENCE: cannot lock before approver sign-off'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- ── B. Identity binding: each signer id must BE the acting user, and the
  --        firm_member must belong to THIS company. No client impersonation. ──
  IF v_signs_prep THEN
    IF NEW.preparer_id IS DISTINCT FROM v_actor
       OR NOT EXISTS (SELECT 1 FROM public.firm_members fm
                      WHERE fm.id = NEW.preparer_firm_member_id
                        AND fm.company_id = NEW.company_id
                        AND fm.user_id = v_actor) THEN
      RAISE EXCEPTION 'SIGN-OFF IDENTITY: preparer must be the authenticated member of this company'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF v_signs_rev THEN
    IF NEW.reviewer_id IS DISTINCT FROM v_actor
       OR NOT EXISTS (SELECT 1 FROM public.firm_members fm
                      WHERE fm.id = NEW.reviewer_firm_member_id
                        AND fm.company_id = NEW.company_id
                        AND fm.user_id = v_actor) THEN
      RAISE EXCEPTION 'SIGN-OFF IDENTITY: reviewer must be the authenticated member of this company'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  IF v_signs_appr THEN
    IF NEW.approver_id IS DISTINCT FROM v_actor
       OR NOT EXISTS (SELECT 1 FROM public.firm_members fm
                      WHERE fm.id = NEW.approver_firm_member_id
                        AND fm.company_id = NEW.company_id
                        AND fm.user_id = v_actor) THEN
      RAISE EXCEPTION 'SIGN-OFF IDENTITY: approver must be the authenticated member of this company'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- ── A. Tier capability for reviewer/approver/lock on BOTH insert & update
  --        (RLS tier-gates UPDATE only; INSERT was ungated). ──
  IF (v_signs_rev OR v_signs_appr OR v_locks)
     AND NOT public.workspace_capability_allowed(NEW.company_id, v_actor, 'approve_certification') THEN
    RAISE EXCEPTION 'SIGN-OFF AUTHORIZATION: approve_certification capability required'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- ── A + D. HESABU gate on ANY signature/lock (not only preparer), bound to
  --            the LATEST validation run for the upload (stale pass rejected). ──
  SELECT * INTO v_latest
  FROM public.hesabu_validations
  WHERE upload_id = NEW.upload_id
  ORDER BY validated_at DESC
  LIMIT 1;

  IF v_latest.id IS NULL THEN
    RAISE EXCEPTION 'HESABU GATE: upload % has no validation run; validate before signing', NEW.upload_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF v_latest.gate_satisfied IS NOT TRUE THEN
    RAISE EXCEPTION 'HESABU GATE: latest validation run (%) did not pass; resolve and re-validate before signing', v_latest.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- ── D. Non-repudiation: statements_hash must be present at lock. ──
  IF v_locks AND (NEW.statements_hash IS NULL OR length(NEW.statements_hash) <> 64) THEN
    RAISE EXCEPTION 'SIGN-OFF BINDING: a 64-char statements_hash is required to lock'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_signoff_authorization() FROM PUBLIC, anon, authenticated;

-- Fire on INSERT and UPDATE (the old hesabu_gate_before_signoff was INSERT-only).
DROP TRIGGER IF EXISTS enforce_signoff_authorization ON public.statement_sign_offs;
CREATE TRIGGER enforce_signoff_authorization
  BEFORE INSERT OR UPDATE ON public.statement_sign_offs
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_signoff_authorization();

-- ── Over-broad grant containment (confirmed by the 2026-10-14 production
--    read-back: `authenticated` held SELECT, INSERT, UPDATE, DELETE, TRUNCATE,
--    REFERENCES, TRIGGER, MAINTAIN on this table). Keep only the three verbs the
--    client legitimately uses (SELECT/INSERT/UPDATE — themselves gated by RLS +
--    the trigger above); remove the rest. This is NOT disabling a legitimate
--    write path — SELECT/INSERT/UPDATE remain. DELETE has no RLS policy (already
--    fails closed); TRUNCATE is not row-level and would let any grantee wipe all
--    sign-off history across tenants, so it must not be held by `authenticated`.
--    service_role (edge functions) retains ALL. ──
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.statement_sign_offs FROM authenticated;

-- ============================================================================
-- PREFERRED HARD-DISABLE ALTERNATIVE (commented — enable instead of/alongside
-- the trigger if verification cannot complete before use; "disabling the
-- affected operation is preferable to restoring a vulnerable policy").
-- Removes the direct browser/PostgREST write path entirely. The sole browser
-- writer (KingaTaxPanel, in the un-offered TZ jurisdiction pack) is not
-- customer-reachable at dfd4098, so impact is minimal. Writes would then have
-- to go through a SECURITY DEFINER RPC (to be authored, mirroring
-- fs_set_publication_state) that performs all checks server-side.
--
--   REVOKE INSERT, UPDATE ON public.statement_sign_offs FROM authenticated;
--
-- RECOVERY RULE: never GRANT these back without the enforcing RPC in place.
-- Recovery must leave the gate at least as strict; existing sign-off rows and
-- hesabu_validations are never deleted or back-dated.
-- ============================================================================
