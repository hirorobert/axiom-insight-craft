-- ============================================================
-- Kinga Phase 2 — firm_members: Role-Based Company Membership
--
-- Migration: 20260625130000_7a1e4d92-2f8b-4c3e-b056-f9a2d7e14b83
-- Date: 2026-06-26
-- Depends on: 20260625100000_b3e5c891-* (companies table)
--
-- Creates:
--   public.firm_members                  — company membership and roles
--   public.get_member_company_ids()      — RLS helper (SECURITY DEFINER)
--
-- Trigger functions created (5 total):
--   create_owner_firm_member()           — AFTER INSERT on companies
--   prevent_unauthorized_owner_insert()  — BEFORE INSERT on firm_members
--   prevent_last_owner_delete()          — BEFORE DELETE on firm_members
--   prevent_last_owner_demote()          — BEFORE UPDATE on firm_members
--   update_updated_at_column()           — pre-existing; wired here for firm_members
--
-- Architecture invariants enforced:
--   Access control table: triggers are MORE warranted here than on
--   canonical_financial_records. A compromised service-role write to
--   firm_members grants unauthorized access to all company data.
--   Two-layer enforcement (RLS + triggers) applies to all critical paths.
--
-- Sentinel variable pattern:
--   create_owner_firm_member() uses SET LOCAL firm_members.allow_owner_insert
--   to authorize exactly one role='owner' INSERT per company-creation
--   transaction. The BEFORE INSERT trigger consumes this sentinel
--   immediately after verification, preventing reuse within the same
--   transaction. SET LOCAL resets automatically on COMMIT/ROLLBACK.
--
-- Owner auto-creation race condition: none possible.
--   The AFTER INSERT trigger on companies fires within the same
--   transaction as the companies INSERT. The companies row is visible
--   to the firm_members FK check within T1 regardless of isolation
--   level. See architecture review Item 4 §race-condition for full trace.
--
-- PURELY ADDITIVE. Adds a trigger to the pre-existing companies table.
-- ============================================================

BEGIN;

-- ════════════════════════════════════════════════════════════
-- SECTION 0 — RLS HELPER FUNCTION
-- ════════════════════════════════════════════════════════════

-- get_member_company_ids()
-- Returns the set of company UUIDs the current user has access to,
-- either as an active firm_members member or as the company creator.
--
-- SECURITY DEFINER: breaks the recursive RLS reference.
-- Any SELECT policy on firm_members that queries firm_members itself
-- to determine access creates a recursive RLS evaluation.
-- A SECURITY DEFINER function bypasses RLS on firm_members when called
-- from within a firm_members RLS policy, resolving the recursion.
--
-- STABLE: result is consistent within a single query; the planner
-- may cache it across multiple RLS evaluations in one statement.

CREATE OR REPLACE FUNCTION public.get_member_company_ids()
RETURNS SETOF UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
-- LANGUAGE plpgsql (not sql): SQL functions validate table references at
-- creation time. firm_members does not exist yet when this function is
-- created (table is created in Section 2). plpgsql defers validation to
-- execution time, allowing the function to be defined before its dependencies.
BEGIN
  RETURN QUERY
    SELECT fm.company_id
    FROM   public.firm_members fm
    WHERE  fm.user_id     = auth.uid()
      AND  fm.accepted_at IS NOT NULL
    UNION
    SELECT c.id
    FROM   public.companies c
    WHERE  c.user_id = auth.uid();
END;
$$;


-- ════════════════════════════════════════════════════════════
-- SECTION 1 — TRIGGER FUNCTIONS
-- ════════════════════════════════════════════════════════════

-- ── 1a. create_owner_firm_member ─────────────────────────────────────────
--
-- Fires AFTER INSERT ON companies.
-- Creates exactly one role='owner' firm_members row for the new company.
--
-- SECURITY DEFINER required: the authenticated INSERT policy on
-- firm_members blocks role='owner' inserts. This trigger runs as the
-- function definer (postgres/service role) so it can insert the owner row.
--
-- Sentinel: SET LOCAL firm_members.allow_owner_insert = 'true' authorizes
-- exactly one role='owner' insert in this transaction. The BEFORE INSERT
-- trigger on firm_members (prevent_unauthorized_owner_insert) reads and
-- consumes this sentinel. SET LOCAL ensures the variable resets on
-- COMMIT/ROLLBACK with no manual cleanup.
--
-- ON CONFLICT DO NOTHING: if a (company_id, user_id) row already exists
-- (migration replay, unusual pre-existing state), skip silently.
-- The existing row is correct by definition.

CREATE OR REPLACE FUNCTION public.create_owner_firm_member()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config('firm_members.allow_owner_insert', 'true', true);

  INSERT INTO public.firm_members (
    company_id,
    user_id,
    role,
    invited_by,
    accepted_at
  ) VALUES (
    NEW.id,
    NEW.user_id,
    'owner',
    NULL,    -- owner row is self-created via company creation, not invited
    now()    -- owner is immediately active; no acceptance step required
  )
  ON CONFLICT (company_id, user_id) DO NOTHING;

  RETURN NEW;
END;
$$;


-- ── 1b. prevent_unauthorized_owner_insert ────────────────────────────────
--
-- Fires BEFORE INSERT ON firm_members WHEN (NEW.role = 'owner').
-- Guards against any caller — including service role — inserting a
-- role='owner' row outside the create_owner_firm_member() flow.
--
-- Mechanism: reads the sentinel set by create_owner_firm_member().
-- If the sentinel is absent or false, the insert is rejected with a
-- clear error. If the sentinel is present, it is consumed immediately
-- to prevent reuse within the same transaction.
--
-- SECURITY DEFINER: this trigger must run with elevated privileges
-- to read the session-local configuration variable reliably and to
-- be consistent with the rest of the trigger security model.
--
-- current_setting(name, missing_ok = true): returns '' if the variable
-- has never been set in this session, rather than raising an error.

CREATE OR REPLACE FUNCTION public.prevent_unauthorized_owner_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('firm_members.allow_owner_insert', true)
       IS DISTINCT FROM 'true'
  THEN
    RAISE EXCEPTION
      'role ''owner'' may only be assigned via company creation. '
      'Use the company creation flow; direct insertion of owner rows '
      'is not permitted for any caller, including service role. '
      '(company_id: %, user_id: %)',
      NEW.company_id, NEW.user_id
    USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Consume the sentinel immediately.
  -- Prevents a single create_owner_firm_member() execution from
  -- authorizing more than one role='owner' insert in the same transaction.
  PERFORM set_config('firm_members.allow_owner_insert', 'false', true);

  RETURN NEW;
END;
$$;


-- ── 1c. prevent_last_owner_delete ────────────────────────────────────────
--
-- Fires BEFORE DELETE ON firm_members WHEN (OLD.role = 'owner').
-- Prevents a company from being left without an owner row.
--
-- SECURITY DEFINER: queries firm_members to count remaining owners.
-- Running as the definer ensures the count is not filtered by the
-- deleting user's RLS context.

CREATE OR REPLACE FUNCTION public.prevent_last_owner_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   public.firm_members
    WHERE  company_id = OLD.company_id
      AND  role       = 'owner'
      AND  id        != OLD.id
  ) THEN
    RAISE EXCEPTION
      'Cannot delete the last owner of company %. '
      'Promote another member to owner before removing this row. '
      '(firm_member id: %)',
      OLD.company_id, OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN OLD;
END;
$$;


-- ── 1d. prevent_last_owner_demote ────────────────────────────────────────
--
-- Fires BEFORE UPDATE ON firm_members
--   WHEN (OLD.role = 'owner' AND NEW.role IS DISTINCT FROM OLD.role).
-- Prevents the last owner's role from being changed to a non-owner role.
-- The WHEN clause fires only when the role field is actually changing,
-- eliminating trigger overhead for all other UPDATE operations on owner rows
-- (e.g., accepted_at updates, updated_at refreshes).
--
-- SECURITY DEFINER: same reasoning as prevent_last_owner_delete.

CREATE OR REPLACE FUNCTION public.prevent_last_owner_demote()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   public.firm_members
    WHERE  company_id = OLD.company_id
      AND  role       = 'owner'
      AND  id        != OLD.id
  ) THEN
    RAISE EXCEPTION
      'Cannot demote the last owner of company % from ''owner'' to ''%''. '
      'Promote another member to owner first. '
      '(firm_member id: %)',
      OLD.company_id, NEW.role, OLD.id
    USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NEW;
END;
$$;


-- ════════════════════════════════════════════════════════════
-- SECTION 2 — firm_members TABLE
-- ════════════════════════════════════════════════════════════

CREATE TABLE public.firm_members (
  id           UUID         NOT NULL DEFAULT gen_random_uuid(),
  company_id   UUID         NOT NULL,
  user_id      UUID         NOT NULL,
  role         TEXT         NOT NULL,
  invited_by   UUID         NULL,
  -- UUID of the user who created this membership row.
  -- NULL for the company owner's self-created row (no inviter exists).
  accepted_at  TIMESTAMPTZ  NULL,
  -- NULL = invitation pending (user has not accepted yet).
  -- NOT NULL = active member.
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT firm_members_pk
    PRIMARY KEY (id),

  CONSTRAINT fk_firm_member_company
    FOREIGN KEY (company_id)
    REFERENCES public.companies(id)
    ON DELETE CASCADE,
    -- CASCADE: removing a company removes all its memberships.
    -- A deleted company has no meaningful existence; RESTRICT would
    -- require pre-deletion membership cleanup with no security benefit.

  CONSTRAINT fk_firm_member_user
    FOREIGN KEY (user_id)
    REFERENCES auth.users(id)
    ON DELETE CASCADE,
    -- CASCADE: a deleted auth user's memberships have no value.
    -- RESTRICT would block auth user deletion while memberships exist.

  CONSTRAINT fk_firm_member_inviter
    FOREIGN KEY (invited_by)
    REFERENCES auth.users(id)
    ON DELETE SET NULL,
    -- SET NULL: inviter may be deleted or may have left the company.
    -- The membership record remains valid. Audit detail degrades
    -- (invited_by becomes NULL) but the member's access is unaffected.

  CONSTRAINT uq_firm_member
    UNIQUE (company_id, user_id),
    -- One membership row per user per company.
    -- Role changes are UPDATEs to this row, not new rows.
    -- Also serves as the B-tree index for the partner sign-off
    -- eligibility join on (company_id + user_id).

  CONSTRAINT chk_firm_member_role
    CHECK (role IN ('owner', 'partner', 'preparer', 'viewer')),

  CONSTRAINT chk_owner_accepted
    CHECK (role != 'owner' OR accepted_at IS NOT NULL)
    -- Owners are always immediately active.
    -- A pending owner row is meaningless: the owner created the company
    -- and is active from the moment of creation.
    -- This constraint enforces that invariant at the DB level.
);

ALTER TABLE public.firm_members ENABLE ROW LEVEL SECURITY;


-- ════════════════════════════════════════════════════════════
-- SECTION 3 — TRIGGERS
-- ════════════════════════════════════════════════════════════

-- Auto-create the owner firm_members row when a company is created.
-- AFTER INSERT: the companies row must be written before the firm_members
-- FK check runs. BEFORE INSERT would fail the FK check because the
-- companies row is not yet in table storage at that point.
CREATE TRIGGER trg_create_owner_firm_member
AFTER INSERT ON public.companies
FOR EACH ROW
EXECUTE FUNCTION public.create_owner_firm_member();

-- Guard: role='owner' inserts require the sentinel from create_owner_firm_member.
-- WHEN clause: only fires when NEW.role = 'owner', avoiding overhead for
-- the vast majority of firm_members inserts (non-owner roles).
CREATE TRIGGER trg_prevent_unauthorized_owner_insert
BEFORE INSERT ON public.firm_members
FOR EACH ROW
WHEN (NEW.role = 'owner')
EXECUTE FUNCTION public.prevent_unauthorized_owner_insert();

-- Guard: cannot delete the last owner of a company.
-- WHEN clause: only fires when the row being deleted is an owner row.
CREATE TRIGGER trg_prevent_last_owner_delete
BEFORE DELETE ON public.firm_members
FOR EACH ROW
WHEN (OLD.role = 'owner')
EXECUTE FUNCTION public.prevent_last_owner_delete();

-- Guard: cannot demote the last owner of a company.
-- WHEN clause: only fires when role is changing away from 'owner'.
-- All other UPDATE operations on firm_members (e.g., accepting an
-- invitation, updating updated_at) bypass this trigger entirely.
CREATE TRIGGER trg_prevent_last_owner_demote
BEFORE UPDATE ON public.firm_members
FOR EACH ROW
WHEN (OLD.role = 'owner' AND NEW.role IS DISTINCT FROM OLD.role)
EXECUTE FUNCTION public.prevent_last_owner_demote();

-- Standard updated_at maintenance.
-- Reuses update_updated_at_column() SECURITY DEFINER function confirmed
-- present in baseline migration 20251208084402_1a9b9732-*.
CREATE TRIGGER update_firm_members_updated_at
BEFORE UPDATE ON public.firm_members
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();


-- ════════════════════════════════════════════════════════════
-- SECTION 4 — RLS POLICIES
-- ════════════════════════════════════════════════════════════

-- SELECT
-- Active members of a company can see all its members.
-- Any user can always see their own row, including pending invitations,
-- so they can view and accept invitations before becoming an active member.
-- get_member_company_ids() (SECURITY DEFINER) resolves the recursive
-- reference: a firm_members SELECT policy cannot query firm_members
-- directly without potential infinite recursion.
CREATE POLICY "firm_members_select"
ON public.firm_members FOR SELECT TO authenticated
USING (
  company_id IN (SELECT public.get_member_company_ids())
  OR user_id = auth.uid()
  -- OR user_id = auth.uid() confirmed product decision:
  -- invitees can see their own pending row before accepting.
);

-- INSERT (PERMISSIVE)
-- Company owner adds non-owner members.
-- role != 'owner' in WITH CHECK is the first guard against unauthorized
-- owner grants. prevent_unauthorized_owner_insert trigger is the second,
-- service-role-proof guard.
CREATE POLICY "firm_members_insert"
ON public.firm_members FOR INSERT TO authenticated
WITH CHECK (
  company_id IN (SELECT id FROM public.companies WHERE user_id = auth.uid())
  AND role != 'owner'
);

-- INSERT (RESTRICTIVE)
-- Defense-in-depth: ANDs unconditionally with the PERMISSIVE policy above.
-- Even if a future PERMISSIVE policy is added with looser conditions,
-- this RESTRICTIVE policy cannot be overridden or bypassed via policy union.
CREATE POLICY "firm_members_insert_restrictive"
ON public.firm_members AS RESTRICTIVE FOR INSERT TO authenticated
WITH CHECK (
  company_id IN (SELECT id FROM public.companies WHERE user_id = auth.uid())
  AND role != 'owner'
);

-- UPDATE — two separate PERMISSIVE policies covering distinct scenarios.
-- They OR together: a row is updatable if either policy matches.

-- UPDATE (by company owner): owner updates any member's details or role.
-- WITH CHECK role != 'owner': prevents owner from granting 'owner' role
-- via the UPDATE path (mirrors the INSERT restriction).
CREATE POLICY "firm_members_update_by_owner"
ON public.firm_members FOR UPDATE TO authenticated
USING (
  company_id IN (SELECT id FROM public.companies WHERE user_id = auth.uid())
)
WITH CHECK (
  company_id IN (SELECT id FROM public.companies WHERE user_id = auth.uid())
  AND role != 'owner'
);

-- UPDATE (accept invitation): invited member accepts their own pending row.
-- USING: can only target their own row while it is still pending.
-- WITH CHECK: post-update state must have accepted_at set.
-- This policy deliberately cannot be used to un-accept (set accepted_at
-- back to NULL): the WITH CHECK requires accepted_at IS NOT NULL.
CREATE POLICY "firm_members_update_accept_invitation"
ON public.firm_members FOR UPDATE TO authenticated
USING (
  user_id     = auth.uid()
  AND accepted_at IS NULL
)
WITH CHECK (
  user_id     = auth.uid()
  AND accepted_at IS NOT NULL
);

-- DELETE (by company owner): owner removes any member.
-- prevent_last_owner_delete trigger enforces that the last owner
-- cannot be removed, even through this policy.
CREATE POLICY "firm_members_delete_by_owner"
ON public.firm_members FOR DELETE TO authenticated
USING (
  company_id IN (SELECT id FROM public.companies WHERE user_id = auth.uid())
);

-- DELETE (self-resign): non-owner member removes themselves.
-- role != 'owner': owners cannot resign. They must transfer ownership
-- first (not yet in scope — requires a separate, explicitly designed flow).
-- Blocking owner self-delete prevents accidental company orphaning where
-- the owner bypasses the last-owner guard by acting on their own row.
CREATE POLICY "firm_members_delete_self_resign"
ON public.firm_members FOR DELETE TO authenticated
USING (
  user_id = auth.uid()
  AND role != 'owner'
);


-- ════════════════════════════════════════════════════════════
-- SECTION 5 — INDEXES
-- ════════════════════════════════════════════════════════════

-- uq_firm_member UNIQUE(company_id, user_id) creates its own B-tree index.
-- This covers the partner sign-off eligibility query:
--   WHERE company_id = X AND user_id = Y AND role IN ('owner', 'partner')
-- No separate compound index is needed.

-- user_id lookup: get_member_company_ids(), pending invitation list per user,
-- and the self-resign DELETE policy USING clause.
CREATE INDEX idx_firm_members_user_id
ON public.firm_members (user_id);

-- Pending invitations dashboard: company owner reviewing outstanding invites.
-- Partial index covers only the minority of rows where accepted_at IS NULL.
-- Once invitations are accepted or expire, they fall outside this index.
CREATE INDEX idx_firm_members_pending
ON public.firm_members (company_id)
WHERE accepted_at IS NULL;


COMMIT;

-- ============================================================
-- Post-migration verification queries (run separately):
--
-- -- 1. Table, RLS, and trigger functions
-- SELECT tablename, rowsecurity
-- FROM pg_tables
-- WHERE schemaname = 'public' AND tablename = 'firm_members';
-- Expected: 1 row, rowsecurity = true.
--
-- SELECT proname, prosecdef
-- FROM pg_proc
-- WHERE proname IN (
--   'get_member_company_ids',
--   'create_owner_firm_member',
--   'prevent_unauthorized_owner_insert',
--   'prevent_last_owner_delete',
--   'prevent_last_owner_demote'
-- );
-- Expected: 5 rows, all prosecdef = true.
--
-- -- 2. Triggers wired
-- SELECT event_object_table, trigger_name, event_manipulation, action_timing
-- FROM information_schema.triggers
-- WHERE trigger_schema = 'public'
--   AND (event_object_table = 'firm_members'
--        OR (event_object_table = 'companies'
--            AND trigger_name = 'trg_create_owner_firm_member'))
-- ORDER BY event_object_table, trigger_name;
-- Expected: 5 rows:
--   companies  / trg_create_owner_firm_member       / INSERT / AFTER
--   firm_members / trg_prevent_unauthorized_owner_insert / INSERT / BEFORE
--   firm_members / trg_prevent_last_owner_delete         / DELETE / BEFORE
--   firm_members / trg_prevent_last_owner_demote          / UPDATE / BEFORE
--   firm_members / update_firm_members_updated_at          / UPDATE / BEFORE
--
-- -- 3. Sentinel behavior smoke test (run as service role):
-- INSERT INTO public.companies (id, user_id, ...)
--   VALUES (gen_random_uuid(), auth.uid(), ...);
-- -- Expected: succeeds + exactly one firm_members row with role='owner'
-- -- is auto-created for the new company.
--
-- SELECT * FROM public.firm_members
-- WHERE company_id = <new_company_id>;
-- Expected: 1 row, role = 'owner', accepted_at IS NOT NULL,
--   invited_by IS NULL.
--
-- -- 4. Sentinel rejection test (run as service role):
-- INSERT INTO public.firm_members (company_id, user_id, role, accepted_at)
-- VALUES (<any_company_id>, <any_user_id>, 'owner', now());
-- Expected: ERROR — insufficient_privilege:
--   "role 'owner' may only be assigned via company creation."
--
-- -- 5. RLS policies
-- SELECT policyname, permissive, cmd
-- FROM pg_policies
-- WHERE schemaname = 'public' AND tablename = 'firm_members'
-- ORDER BY permissive DESC, cmd;
-- Expected: 7 policy rows.
-- ============================================================
