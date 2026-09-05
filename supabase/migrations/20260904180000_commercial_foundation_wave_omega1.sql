-- ════════════════════════════════════════════════════════════════════════════
-- Ω∞ WAVE Ω1 — PROVIDER-NEUTRAL COMMERCIAL FOUNDATION
-- Billing + entitlement authority, strictly orthogonal to accounting authority.
--
-- CREATED, NOT APPLIED. This migration is not run against any live database
-- from this environment. Apply only after independent certification.
--
-- Constitutional laws frozen for this wave:
--   1. Commercial authority never grants accounting authority. Nothing in this
--      file writes trial_balance_uploads, account_mappings, tax_computations,
--      account_review_decisions, or any HESABU/KINGA/MAONO/SAFISHA table.
--   2. No payment provider is integrated. `payment_events.provider` and
--      `external_event_id` are nullable and unused until Ω2.
--   3. UNKNOWN != NOT_ENTITLED != ENTITLED. get_effective_entitlement() and
--      _resolve_entitlement_for_owner() return a tri-state status, and every
--      caller must fail closed (treat UNKNOWN the same as NOT_ENTITLED for
--      any privileged action) — UNKNOWN is a distinct, loggable diagnostic
--      state, never silently coerced to a boolean.
--   4. Ordinary authenticated users cannot write commercial_licences,
--      payment_events, entitlement_overrides, or billing_audit_events
--      directly. The only writers are: the one companies trigger below
--      (SYSTEM_DEFAULT_FREE provisioning) and the four SECURITY DEFINER RPCs
--      gated on commercial_admins membership (admin_grant_commercial_licence,
--      admin_transition_licence_status, admin_grant_entitlement_override,
--      admin_revoke_entitlement_override).
--   5. Server-authoritative timestamps only (`now()`), never client-supplied
--      "current time".
--
-- Identity model (why billing_customers keys on auth.users, not firm_members):
--   This repository has no firm/organization table above `companies` — grepped
--   across supabase/migrations, zero matches for CREATE TABLE ... firms /
--   organizations. firm_members.user_id is scoped UNIQUE(company_id, user_id)
--   — membership is per-company, not a grouping that spans a user's companies.
--   The live marketing copy (src/constants/copy.ts PRICING_TABLE, confirmed
--   live on cfoclose.com in the prior commercial audit) states "Annual firm
--   licence — unlimited companies, unlimited periods" — i.e. ONE licence
--   covers ALL of a signed-up user's companies. The only existing, stable
--   identity that spans a user's companies is companies.user_id itself
--   (= auth.users.id, the company OWNER). billing_customers therefore anchors
--   to owner_user_id, and is its own explicit entity (own id, own table) —
--   never reused directly as an accounting actor identity anywhere. This is
--   NOT a re-use of auth.users.id as accounting authority (forbidden by
--   CLAUDE.md §4.3/§10) — commercial identity and accounting actor identity
--   (firm_members.id) are deliberately different authorities answering
--   different questions.
--
-- FLAGGED DESIGN DECISIONS REQUIRING HUMAN/PRODUCT CONFIRMATION BEFORE THIS
-- MIGRATION IS EVER APPLIED TO PRODUCTION (see final report §"Flagged
-- decisions" for full detail — not resolved unilaterally here):
--   (a) MULTI_COMPANY_PREMIUM_POLICY_DEFERRED_TO_Ω2_PRODUCT_DECISION — Ω1-R
--       deliberately does NOT gate a 2nd+ company behind MULTI_COMPANY
--       entitlement. An earlier candidate (daf8692) wired a BEFORE INSERT
--       trigger enforcing this; Codex review correctly flagged that the
--       commercial policy backing it (how many companies FREE gets) was
--       never product-approved, so shipping the trigger would silently
--       change live company-creation behavior for every existing user the
--       moment this migration is applied. The trigger and its function are
--       REMOVED in this repair. MULTI_COMPANY remains a valid, readable
--       feature code (in the registry, in commercial_plans.feature_codes,
--       and resolvable via get_effective_entitlement) — the architecture is
--       fully capable of enforcing it — but nothing in this migration
--       enforces it today. Company creation is unchanged from pre-Ω1
--       behavior. Wiring enforcement is a future, explicitly product-owned
--       decision, not a side effect of this commercial-foundation wave.
--   (b) FREE plan feature set is assumed to be {SAFISHA_PREVIEW,
--       HESABU_REPORTING}; PAID plan is assumed to include all 7 registry
--       features. This is a placeholder business decision, not a certified
--       price list — see commercial_plans seed rows below.
--   (c) GRACE licence status is treated as still-entitled (same as ACTIVE).
--   (d) COMMERCIAL_IDENTITY_V1_USER_OWNER_BRIDGE — LIMITED_BUT_NONDESTRUCTIVE.
--       billing_customers.owner_user_id is the CURRENT billing-owner
--       identity bridge (one auth user = one billing customer today), not a
--       permanent architectural claim that "auth user = firm". No code or
--       constraint in this file treats owner_user_id as firm identity for
--       any purpose beyond billing anchoring. A future organization/firm
--       billing entity can be introduced additively (a new table plus a new
--       FK from billing_customers, or a new join table), without rewriting
--       accounting identity (firm_members) or any historical payment_events
--       / billing_audit_events row — those rows key on billing_customer_id,
--       which is stable and would not need to change.
-- ════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- btree_gist: required for the EXCLUDE USING gist constraint on
-- commercial_licences below (a UUID equality term combined with a range
-- overlap term in one GiST index needs btree_gist's operator classes for
-- the UUID column). Standard, widely-used Postgres contrib extension,
-- available on Supabase.
CREATE EXTENSION IF NOT EXISTS btree_gist;

SET search_path TO public, pg_catalog;

-- ════════════════════════════════════════════════════════════════════════════
-- TABLE: commercial_admins — minimal platform-level commercial authority
-- allowlist. Distinct from firm_members.role (which is per-company
-- accounting authority) and from auth.users (which is bare identity).
-- No seed rows: a real founder/operator user_id cannot be fabricated here.
-- A human with production access must INSERT the first row manually.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.commercial_admins (
  id          UUID        NOT NULL DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL,
  granted_by  UUID        NULL,
  active      BOOLEAN     NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT commercial_admins_pk PRIMARY KEY (id),
  CONSTRAINT uq_commercial_admins_user UNIQUE (user_id),
  CONSTRAINT fk_ca_user FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ca_granted_by FOREIGN KEY (granted_by) REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.commercial_admins IS
  'Ω1: minimal allowlist of platform commercial administrators. Checked '
  'inside every commercial write RPC. Never overloads firm_members.role, '
  'which is per-company accounting authority, not platform commercial '
  'authority. No seed data and no bootstrap RPC exists anywhere in this '
  'migration — ordinary authenticated users can never self-escalate into '
  'this table. BOOTSTRAP PROCEDURE: the first row must be inserted directly '
  'against the database by someone holding service_role or database-owner '
  'credentials (e.g. via the Supabase SQL editor or a one-off service-role '
  'script run outside the application), naming a real, already-existing '
  'auth.users.id: '
  'INSERT INTO public.commercial_admins (user_id, active) VALUES (''<uuid>'', true); '
  'There is no public/authenticated path to this table beyond SELECT.';

ALTER TABLE public.commercial_admins ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ca_select_self_or_admin" ON public.commercial_admins
  FOR SELECT USING (
    user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.commercial_admins ca WHERE ca.user_id = auth.uid() AND ca.active)
  );

REVOKE ALL ON public.commercial_admins FROM anon;
GRANT SELECT ON public.commercial_admins TO authenticated;
GRANT ALL    ON public.commercial_admins TO service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- TABLE: commercial_products / commercial_plans — small, stable catalog.
-- Public plan metadata only (no private commercial state) — readable by
-- anon and authenticated per Ω1 directive §"RLS" allowance.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.commercial_products (
  id         UUID        NOT NULL DEFAULT gen_random_uuid(),
  code       TEXT        NOT NULL,
  name       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT commercial_products_pk PRIMARY KEY (id),
  CONSTRAINT uq_commercial_products_code UNIQUE (code)
);

ALTER TABLE public.commercial_products ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cprod_select_public" ON public.commercial_products FOR SELECT USING (true);

REVOKE ALL ON public.commercial_products FROM anon, authenticated;
GRANT SELECT ON public.commercial_products TO anon, authenticated;
GRANT ALL    ON public.commercial_products TO service_role;

CREATE TABLE public.commercial_plans (
  id            UUID        NOT NULL DEFAULT gen_random_uuid(),
  product_id    UUID        NOT NULL,
  code          TEXT        NOT NULL,
  name          TEXT        NOT NULL,
  feature_codes TEXT[]      NOT NULL DEFAULT '{}',
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT commercial_plans_pk PRIMARY KEY (id),
  CONSTRAINT fk_cp_product FOREIGN KEY (product_id) REFERENCES public.commercial_products(id) ON DELETE CASCADE,
  CONSTRAINT uq_commercial_plans_code UNIQUE (product_id, code),

  -- Single canonical feature vocabulary, mirrored in
  -- src/lib/commercial/featureRegistry.ts. DB-enforced, not just TS-trusted.
  CONSTRAINT chk_cp_feature_codes CHECK (feature_codes <@ ARRAY[
    'SAFISHA_PREVIEW','SAFISHA_CERTIFY','HESABU_REPORTING','HESABU_EXPORT',
    'MAONO_INTELLIGENCE','MULTI_COMPANY','MULTI_PERIOD'
  ]::TEXT[])
);

ALTER TABLE public.commercial_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cplan_select_public" ON public.commercial_plans FOR SELECT USING (is_active);

REVOKE ALL ON public.commercial_plans FROM anon, authenticated;
GRANT SELECT ON public.commercial_plans TO anon, authenticated;
GRANT ALL    ON public.commercial_plans TO service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- TABLE: billing_customers — the commercial identity anchor.
-- One row per company-owning auth user (see identity-model comment above).
-- owner_user_id is the CURRENT billing-owner identity bridge, not a
-- permanent "auth user = firm" invariant — see flagged design decision (d).
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.billing_customers (
  id            UUID        NOT NULL DEFAULT gen_random_uuid(),
  owner_user_id UUID        NOT NULL,
  product_id    UUID        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT billing_customers_pk PRIMARY KEY (id),
  CONSTRAINT uq_billing_customers_owner UNIQUE (owner_user_id),
  CONSTRAINT fk_bc_owner FOREIGN KEY (owner_user_id) REFERENCES auth.users(id) ON DELETE CASCADE,
  CONSTRAINT fk_bc_product FOREIGN KEY (product_id) REFERENCES public.commercial_products(id) ON DELETE RESTRICT
);

COMMENT ON TABLE public.billing_customers IS
  'Ω1: commercial identity, one row per company-owning auth user. '
  'owner_user_id is the CURRENT billing-owner bridge (COMMERCIAL_IDENTITY_V1_'
  'USER_OWNER_BRIDGE, LIMITED_BUT_NONDESTRUCTIVE) — not a claim that an auth '
  'user permanently equals a firm. A future organization/firm billing entity '
  'can be introduced additively without rewriting this table''s id or any '
  'row that references billing_customer_id (payment_events, '
  'entitlement_overrides, billing_audit_events, commercial_licences). '
  'Explicitly separate from firm_members (per-company accounting membership) '
  'and never used as accounting actor identity. Written only by '
  'provision_billing_customer_for_company() (system default) and read by '
  'the owner or a commercial_admin.';

ALTER TABLE public.billing_customers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bc_select_owner_or_admin" ON public.billing_customers
  FOR SELECT USING (
    owner_user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.commercial_admins ca WHERE ca.user_id = auth.uid() AND ca.active)
  );

-- No authenticated INSERT/UPDATE/DELETE policy — the only writer is the
-- companies trigger below, executing SECURITY DEFINER as the function owner
-- (same convention as trg_create_owner_firm_member / resolve_account_review_batch).
REVOKE ALL ON public.billing_customers FROM anon;
GRANT SELECT ON public.billing_customers TO authenticated;
GRANT ALL    ON public.billing_customers TO service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- TABLE: commercial_licences — real state machine, not a boolean, with a
-- DATABASE-ENFORCED invariant that overlapping authoritative licence
-- periods for the same billing customer cannot exist.
--
-- Status semantics:
--   PENDING   — created but not yet a commitment (e.g. a payment awaiting
--               confirmation in Ω2). Never entitles, regardless of dates.
--               Does not participate in the overlap invariant below, so any
--               number of PENDING quotes/offers can coexist freely.
--   ACTIVE    — authoritative and entitling while now() is inside
--               [effective_start, effective_end). A row with a FUTURE
--               effective_start is a genuine "future licence" / scheduled
--               renewal: it is already the authoritative row for that
--               future window (no separate status is needed for "future"),
--               it simply does not entitle until effective_start arrives —
--               a pure read-time computation, no scheduled job required.
--   GRACE     — authoritative and entitling, identical to ACTIVE for
--               entitlement purposes (flagged design decision (c)) —
--               distinct status kept for future dunning/grace-period UX.
--   SUSPENDED — authoritative-in-history but NEVER entitling. Reachable
--               only via admin_transition_licence_status on an existing
--               row (never a fresh grant). Excluded from the overlap
--               invariant, so a suspended row can coexist with whatever
--               replaces it.
--   CANCELLED — terminal, never entitling. Same overlap-exemption as above.
--   EXPIRED   — terminal, never entitling; administrative bookkeeping only
--               (the resolver's own date-window check already stops an
--               ACTIVE/GRACE row past its effective_end from entitling,
--               with or without this status being explicitly set).
--
-- Renewal / replacement / plan-transition semantics: a row is NEVER
-- overwritten to represent a new period. admin_grant_commercial_licence()
-- INSERTs a new row for the new period and, if an existing ACTIVE/GRACE row
-- would otherwise overlap it, first UPDATEs that row's effective_end to the
-- new row's effective_start (closing it, not deleting it) — history is
-- fully preserved as a chain of abutting, non-overlapping rows. Status
-- transitions (suspend/reactivate/cancel/expire) UPDATE the existing row's
-- status in place via admin_transition_licence_status(), which is what
-- actually removes a row from ACTIVE/GRACE — never a second inserted row.
--
-- DATABASE INVARIANT (not mere ORDER BY tie-breaking): excl_cl_no_overlap_
-- ping_authoritative_periods below is a PostgreSQL EXCLUDE USING gist
-- constraint over (billing_customer_id, effective_range) restricted to
-- status IN ('ACTIVE','GRACE'). Postgres itself refuses any INSERT or
-- UPDATE that would create two simultaneously-effective authoritative
-- periods for the same billing customer — including the same effective_start
-- (a zero-width overlap between two '[)' ranges beginning at an identical
-- instant is still an overlap) and including a currently-open-ended row
-- (effective_end IS NULL is an unbounded upper range bound, so it correctly
-- conflicts with anything starting after its effective_start). This is
-- structural, DB-level prevention — not application-level discipline, and
-- not resolved by picking a tie-break order.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.commercial_licences (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid(),
  billing_customer_id UUID        NOT NULL,
  plan_id             UUID        NOT NULL,
  status              TEXT        NOT NULL,
  source              TEXT        NOT NULL,
  -- 'SYSTEM_DEFAULT_FREE' | 'MANUAL_ADMIN_GRANT' | future provider codes (Ω2).
  effective_start     TIMESTAMPTZ NOT NULL,
  effective_end       TIMESTAMPTZ NULL,
  -- NULL = open-ended (FREE default, or an admin grant with no defined expiry).
  -- Never treated as "unlimited" implicitly — only NULL + status=ACTIVE/GRACE
  -- is read as currently entitled; NULL never means "forever" on its own.
  effective_range     TSTZRANGE GENERATED ALWAYS AS (
    tstzrange(effective_start, effective_end, '[)')
  ) STORED,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT commercial_licences_pk PRIMARY KEY (id),
  CONSTRAINT fk_cl_billing_customer FOREIGN KEY (billing_customer_id) REFERENCES public.billing_customers(id) ON DELETE CASCADE,
  CONSTRAINT fk_cl_plan FOREIGN KEY (plan_id) REFERENCES public.commercial_plans(id) ON DELETE RESTRICT,
  CONSTRAINT chk_cl_status CHECK (status IN ('PENDING','ACTIVE','GRACE','SUSPENDED','CANCELLED','EXPIRED')),
  CONSTRAINT chk_cl_effective_window CHECK (effective_end IS NULL OR effective_end > effective_start),

  -- THE licence-authority invariant. No two ACTIVE/GRACE rows for the same
  -- billing_customer may have overlapping effective ranges — see the table
  -- comment above for the full reasoning.
  CONSTRAINT excl_cl_no_overlapping_authoritative_periods
    EXCLUDE USING gist (
      billing_customer_id WITH =,
      effective_range WITH &&
    ) WHERE (status IN ('ACTIVE','GRACE'))
);

CREATE INDEX idx_cl_current_window
  ON public.commercial_licences (billing_customer_id, effective_start DESC);

ALTER TABLE public.commercial_licences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cl_select_owner_or_admin" ON public.commercial_licences
  FOR SELECT USING (
    billing_customer_id IN (SELECT id FROM public.billing_customers WHERE owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.commercial_admins ca WHERE ca.user_id = auth.uid() AND ca.active)
  );

-- No authenticated write policy at all. Writers: the companies trigger
-- (FREE provisioning), admin_grant_commercial_licence() (new periods), and
-- admin_transition_licence_status() (status transitions on an existing row).
REVOKE ALL ON public.commercial_licences FROM anon;
GRANT SELECT ON public.commercial_licences TO authenticated;
GRANT ALL    ON public.commercial_licences TO service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- TABLE: payment_events — append-only, provider-neutral ledger.
-- No provider exists yet (Ω1 forbids integrating one). Shaped now for
-- future idempotent webhook ingestion: idempotency_key is always required
-- and always unique; (provider, external_event_id) is a second, partial
-- unique index for the provider's own event identity once Ω2 exists.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.payment_events (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid(),
  billing_customer_id UUID        NOT NULL,
  licence_id          UUID        NULL,
  provider            TEXT        NULL,
  external_event_id   TEXT        NULL,
  idempotency_key     TEXT        NOT NULL,
  event_type          TEXT        NOT NULL,
  amount              NUMERIC(18,2) NULL,
  currency            TEXT        NULL,
  event_time          TIMESTAMPTZ NOT NULL,
  recorded_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by         UUID        NULL,
  metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT payment_events_pk PRIMARY KEY (id),
  CONSTRAINT fk_pe_billing_customer FOREIGN KEY (billing_customer_id) REFERENCES public.billing_customers(id) ON DELETE CASCADE,
  CONSTRAINT fk_pe_licence FOREIGN KEY (licence_id) REFERENCES public.commercial_licences(id) ON DELETE SET NULL,
  CONSTRAINT fk_pe_recorded_by FOREIGN KEY (recorded_by) REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT uq_pe_idempotency_key UNIQUE (idempotency_key),
  CONSTRAINT chk_pe_event_type CHECK (event_type IN (
    'PAYMENT_INITIATED','PAYMENT_CONFIRMED','PAYMENT_FAILED','REFUND','CHARGEBACK',
    'RENEWAL','CANCELLATION','MANUAL_INVOICE_CONFIRMED'
  ))
);

CREATE UNIQUE INDEX uq_pe_provider_external_event
  ON public.payment_events (provider, external_event_id)
  WHERE provider IS NOT NULL AND external_event_id IS NOT NULL;

CREATE INDEX idx_pe_billing_customer ON public.payment_events (billing_customer_id, event_time DESC);

COMMENT ON TABLE public.payment_events IS
  'Ω1: append-only, provider-neutral payment event ledger. No provider is '
  'integrated in this wave — provider/external_event_id stay NULL. Designed '
  'for Ω2 idempotent webhook ingestion: idempotency_key is mandatory and '
  'unique today; the (provider, external_event_id) partial unique index is '
  'ready for a real provider without a future migration.';

CREATE OR REPLACE FUNCTION public.payment_events_immutable()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Iron Dome: payment_events is append-only. % is not permitted. [id=%]',
    TG_OP, COALESCE(OLD.id::TEXT, 'N/A')
    USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER trg_payment_events_immutable
  BEFORE UPDATE OR DELETE ON public.payment_events
  FOR EACH ROW EXECUTE FUNCTION public.payment_events_immutable();

ALTER TABLE public.payment_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pe_select_owner_or_admin" ON public.payment_events
  FOR SELECT USING (
    billing_customer_id IN (SELECT id FROM public.billing_customers WHERE owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.commercial_admins ca WHERE ca.user_id = auth.uid() AND ca.active)
  );

-- No authenticated write policy. Ω1 has no writer for this table at all
-- (no provider, no manual-invoice RPC built yet) — it exists so the schema
-- and idempotency contract are proven and stable ahead of Ω2.
REVOKE ALL ON public.payment_events FROM anon, authenticated;
GRANT SELECT ON public.payment_events TO authenticated;
GRANT ALL    ON public.payment_events TO service_role;

REVOKE ALL ON FUNCTION public.payment_events_immutable() FROM PUBLIC, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- TABLE: entitlement_overrides — manual admin grants, explicitly distinct
-- from paid entitlement. Mandatory reason, effective period, revocable,
-- fully audited. Never alters accounting truth.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.entitlement_overrides (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid(),
  billing_customer_id UUID        NOT NULL,
  feature_code        TEXT        NOT NULL,
  granted_by          UUID        NOT NULL,
  reason              TEXT        NOT NULL,
  effective_start     TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_end       TIMESTAMPTZ NULL,
  revoked_at          TIMESTAMPTZ NULL,
  revoked_by          UUID        NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT entitlement_overrides_pk PRIMARY KEY (id),
  CONSTRAINT fk_eo_billing_customer FOREIGN KEY (billing_customer_id) REFERENCES public.billing_customers(id) ON DELETE CASCADE,
  CONSTRAINT fk_eo_granted_by FOREIGN KEY (granted_by) REFERENCES auth.users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_eo_revoked_by FOREIGN KEY (revoked_by) REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT chk_eo_window CHECK (effective_end IS NULL OR effective_end > effective_start),
  CONSTRAINT chk_eo_feature_code CHECK (feature_code IN (
    'SAFISHA_PREVIEW','SAFISHA_CERTIFY','HESABU_REPORTING','HESABU_EXPORT',
    'MAONO_INTELLIGENCE','MULTI_COMPANY','MULTI_PERIOD'
  )),
  CONSTRAINT chk_eo_reason_not_blank CHECK (length(trim(reason)) > 0)
);

CREATE INDEX idx_eo_active
  ON public.entitlement_overrides (billing_customer_id, feature_code)
  WHERE revoked_at IS NULL;

ALTER TABLE public.entitlement_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "eo_select_owner_or_admin" ON public.entitlement_overrides
  FOR SELECT USING (
    billing_customer_id IN (SELECT id FROM public.billing_customers WHERE owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.commercial_admins ca WHERE ca.user_id = auth.uid() AND ca.active)
  );

REVOKE ALL ON public.entitlement_overrides FROM anon, authenticated;
GRANT SELECT ON public.entitlement_overrides TO authenticated;
GRANT ALL    ON public.entitlement_overrides TO service_role;

-- ════════════════════════════════════════════════════════════════════════════
-- TABLE: billing_audit_events — immutable audit trail for every commercial
-- administrative action.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE public.billing_audit_events (
  id                  UUID        NOT NULL DEFAULT gen_random_uuid(),
  billing_customer_id UUID        NOT NULL,
  actor_user_id       UUID        NULL,
  -- NULL = system-initiated (e.g. FREE_LICENCE_AUTO_PROVISIONED), never a
  -- guessed actor.
  action              TEXT        NOT NULL,
  previous_state      JSONB       NULL,
  new_state           JSONB       NULL,
  reason              TEXT        NULL,
  correlation_id      UUID        NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT billing_audit_events_pk PRIMARY KEY (id),
  CONSTRAINT fk_bae_billing_customer FOREIGN KEY (billing_customer_id) REFERENCES public.billing_customers(id) ON DELETE CASCADE,
  CONSTRAINT fk_bae_actor FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX idx_bae_billing_customer ON public.billing_audit_events (billing_customer_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.billing_audit_events_immutable()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'Iron Dome: billing_audit_events is append-only. % is not permitted. [id=%]',
    TG_OP, COALESCE(OLD.id::TEXT, 'N/A')
    USING ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER trg_billing_audit_events_immutable
  BEFORE UPDATE OR DELETE ON public.billing_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.billing_audit_events_immutable();

ALTER TABLE public.billing_audit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "bae_select_owner_or_admin" ON public.billing_audit_events
  FOR SELECT USING (
    billing_customer_id IN (SELECT id FROM public.billing_customers WHERE owner_user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.commercial_admins ca WHERE ca.user_id = auth.uid() AND ca.active)
  );

REVOKE ALL ON public.billing_audit_events FROM anon, authenticated;
GRANT SELECT ON public.billing_audit_events TO authenticated;
GRANT ALL    ON public.billing_audit_events TO service_role;

REVOKE ALL ON FUNCTION public.billing_audit_events_immutable() FROM PUBLIC, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- SEED DATA — small, stable catalog. Product tiers are real and intentional
-- (FREE / PAID), not fabricated financial claims. Feature splits are a
-- placeholder business decision — see flagged design decision (b) above.
-- ════════════════════════════════════════════════════════════════════════════

INSERT INTO public.commercial_products (code, name)
VALUES ('SAFF_ERP', 'SAFF ERP')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.commercial_plans (product_id, code, name, feature_codes)
SELECT id, 'FREE', 'Free', ARRAY['SAFISHA_PREVIEW','HESABU_REPORTING']::TEXT[]
FROM public.commercial_products WHERE code = 'SAFF_ERP'
ON CONFLICT (product_id, code) DO NOTHING;

INSERT INTO public.commercial_plans (product_id, code, name, feature_codes)
SELECT id, 'PAID', 'Firm Licence', ARRAY[
  'SAFISHA_PREVIEW','SAFISHA_CERTIFY','HESABU_REPORTING','HESABU_EXPORT',
  'MAONO_INTELLIGENCE','MULTI_COMPANY','MULTI_PERIOD'
]::TEXT[]
FROM public.commercial_products WHERE code = 'SAFF_ERP'
ON CONFLICT (product_id, code) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- FUNCTION: _resolve_entitlement_for_owner(...) — internal resolver.
-- Single source of truth for entitlement logic, called both by the public
-- get_effective_entitlement()/get_my_billing_summary() RPCs and by the
-- companies BEFORE INSERT trigger (which has no company_id yet to resolve
-- through, only the prospective owner's user_id).
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public._resolve_entitlement_for_owner(
  p_owner_user_id UUID,
  p_feature_code  TEXT
) RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  STABLE
  SET search_path = public, pg_catalog
AS $$
DECLARE
  v_billing_customer_id UUID;
  v_override            RECORD;
  v_licence             RECORD;
BEGIN
  IF p_feature_code IS NULL OR p_feature_code NOT IN (
    'SAFISHA_PREVIEW','SAFISHA_CERTIFY','HESABU_REPORTING','HESABU_EXPORT',
    'MAONO_INTELLIGENCE','MULTI_COMPANY','MULTI_PERIOD'
  ) THEN
    RETURN jsonb_build_object(
      'status','UNKNOWN','reason','UNKNOWN_FEATURE_CODE',
      'licence_status',NULL,'plan_code',NULL,'source',NULL
    );
  END IF;

  IF p_owner_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'status','UNKNOWN','reason','NO_OWNER_IDENTITY',
      'licence_status',NULL,'plan_code',NULL,'source',NULL
    );
  END IF;

  SELECT id INTO v_billing_customer_id
    FROM public.billing_customers
   WHERE owner_user_id = p_owner_user_id
   LIMIT 1;

  IF v_billing_customer_id IS NULL THEN
    -- A real owner with no billing_customers row is a known, definitive
    -- fact (provisioning has not run for them yet) — NOT_ENTITLED, not
    -- UNKNOWN: absence of commercial enrollment is not uncertainty.
    RETURN jsonb_build_object(
      'status','NOT_ENTITLED','reason','NO_BILLING_CUSTOMER',
      'licence_status',NULL,'plan_code',NULL,'source',NULL
    );
  END IF;

  -- 1. A manual admin override, if active, wins over the licence.
  SELECT * INTO v_override
    FROM public.entitlement_overrides eo
   WHERE eo.billing_customer_id = v_billing_customer_id
     AND eo.feature_code = p_feature_code
     AND eo.revoked_at IS NULL
     AND eo.effective_start <= now()
     AND (eo.effective_end IS NULL OR eo.effective_end > now())
   ORDER BY eo.created_at DESC
   LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'status','ENTITLED','reason','ADMIN_OVERRIDE_ACTIVE',
      'licence_status',NULL,'plan_code',NULL,'source','ADMIN_OVERRIDE'
    );
  END IF;

  -- 2. Otherwise resolve via the current licence period + its plan's features.
  --    excl_cl_no_overlapping_authoritative_periods (on commercial_licences)
  --    guarantees AT MOST ONE row with status IN ('ACTIVE','GRACE') can ever
  --    match this date-window predicate for a given billing_customer_id — so
  --    ORDER BY ... LIMIT 1 here is defense-in-depth for an outcome the
  --    schema already makes structurally impossible to violate, not a
  --    tie-break masking real ambiguity.
  SELECT cl.status AS licence_status, cp.code AS plan_code, cp.feature_codes AS feature_codes
    INTO v_licence
    FROM public.commercial_licences cl
    JOIN public.commercial_plans cp ON cp.id = cl.plan_id
   WHERE cl.billing_customer_id = v_billing_customer_id
     AND cl.status IN ('ACTIVE','GRACE')
     AND cl.effective_start <= now()
     AND (cl.effective_end IS NULL OR cl.effective_end > now())
   ORDER BY cl.effective_start DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'status','NOT_ENTITLED','reason','NO_CURRENT_LICENCE_PERIOD',
      'licence_status',NULL,'plan_code',NULL,'source',NULL
    );
  END IF;

  -- GRACE is treated as still-entitled (flagged design decision (c) above).
  IF v_licence.licence_status NOT IN ('ACTIVE','GRACE') THEN
    RETURN jsonb_build_object(
      'status','NOT_ENTITLED','reason','LICENCE_NOT_ACTIVE',
      'licence_status',v_licence.licence_status,'plan_code',v_licence.plan_code,'source',NULL
    );
  END IF;

  IF v_licence.feature_codes @> ARRAY[p_feature_code]::TEXT[] THEN
    RETURN jsonb_build_object(
      'status','ENTITLED','reason','ACTIVE_LICENCE_INCLUDES_FEATURE',
      'licence_status',v_licence.licence_status,'plan_code',v_licence.plan_code,'source','ACTIVE_LICENCE'
    );
  ELSE
    RETURN jsonb_build_object(
      'status','NOT_ENTITLED','reason','PLAN_DOES_NOT_INCLUDE_FEATURE',
      'licence_status',v_licence.licence_status,'plan_code',v_licence.plan_code,'source',NULL
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public._resolve_entitlement_for_owner(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- FUNCTION: get_effective_entitlement(...) — the server-authoritative reader.
-- Caller must be an accepted firm_member of p_company_id, or a
-- commercial_admin. React must never treat any client-side mirror of this
-- result as authoritative — this RPC (or an Edge Function that calls the
-- equivalent SQL) is the only real gate.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_effective_entitlement(
  p_company_id   UUID,
  p_feature_code TEXT
) RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  STABLE
  SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id       UUID := auth.uid();
  v_owner_user_id UUID;
  v_is_admin      BOOLEAN;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.commercial_admins ca WHERE ca.user_id = v_user_id AND ca.active
  ) INTO v_is_admin;

  IF NOT v_is_admin THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.firm_members fm
       WHERE fm.user_id = v_user_id
         AND fm.company_id = p_company_id
         AND fm.accepted_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'NOT_A_MEMBER_OF_COMPANY' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT c.user_id INTO v_owner_user_id FROM public.companies c WHERE c.id = p_company_id;

  IF v_owner_user_id IS NULL THEN
    RETURN jsonb_build_object(
      'status','UNKNOWN','reason','COMPANY_NOT_FOUND',
      'licence_status',NULL,'plan_code',NULL,'source',NULL
    );
  END IF;

  RETURN public._resolve_entitlement_for_owner(v_owner_user_id, p_feature_code);
END;
$$;

REVOKE ALL ON FUNCTION public.get_effective_entitlement(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_effective_entitlement(UUID, TEXT) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- FUNCTION: get_my_billing_summary() — minimal owner-facing reader for the
-- Settings → Plan/Licence UI. No company_id needed: billing identity is
-- already at the auth.uid() (owner) level.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_my_billing_summary()
  RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  STABLE
  SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id             UUID := auth.uid();
  v_billing_customer_id UUID;
  v_result              JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  SELECT id INTO v_billing_customer_id
    FROM public.billing_customers WHERE owner_user_id = v_user_id;

  IF v_billing_customer_id IS NULL THEN
    RETURN jsonb_build_object(
      'has_billing_customer', false, 'plan_code', NULL, 'licence_status', NULL,
      'effective_start', NULL, 'effective_end', NULL, 'entitlements', '[]'::jsonb
    );
  END IF;

  SELECT jsonb_build_object(
    'has_billing_customer', true,
    'plan_code', cp.code,
    'licence_status', cl.status,
    'effective_start', cl.effective_start,
    'effective_end', cl.effective_end,
    'entitlements', to_jsonb(cp.feature_codes)
  ) INTO v_result
    FROM public.commercial_licences cl
    JOIN public.commercial_plans cp ON cp.id = cl.plan_id
   WHERE cl.billing_customer_id = v_billing_customer_id
     AND cl.effective_start <= now()
     AND (cl.effective_end IS NULL OR cl.effective_end > now())
   ORDER BY cl.effective_start DESC
   LIMIT 1;

  IF v_result IS NULL THEN
    RETURN jsonb_build_object(
      'has_billing_customer', true, 'plan_code', NULL, 'licence_status', NULL,
      'effective_start', NULL, 'effective_end', NULL, 'entitlements', '[]'::jsonb
    );
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_billing_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_billing_summary() TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- FUNCTION: admin_grant_commercial_licence(...) — creates a NEW licence
-- period (initial grant, renewal, or plan transition). Never overwrites an
-- existing row's identity — if an existing ACTIVE/GRACE row for this
-- billing customer would otherwise overlap the requested window, that row
-- is closed (effective_end set to the new period's start) in the SAME
-- transaction as the new INSERT, so excl_cl_no_overlapping_authoritative_
-- periods is satisfied by construction and history is preserved, never
-- deleted. At most one existing ACTIVE/GRACE row can ever overlap a given
-- new range — if two did, they would necessarily overlap each other too,
-- which the exclusion constraint already forbids — so the lookup below is
-- provably unambiguous, not a best-effort guess.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.admin_grant_commercial_licence(
  p_billing_customer_id UUID,
  p_plan_code           TEXT,
  p_effective_start     TIMESTAMPTZ,
  p_effective_end       TIMESTAMPTZ,
  p_reason              TEXT
) RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id    UUID := auth.uid();
  v_product_id UUID;
  v_plan_id    UUID;
  v_licence_id UUID;
  v_prior      RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_user_id AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF p_effective_start IS NULL THEN
    RAISE EXCEPTION 'EFFECTIVE_START_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF p_effective_end IS NOT NULL AND p_effective_end <= p_effective_start THEN
    RAISE EXCEPTION 'EFFECTIVE_END_MUST_BE_AFTER_START' USING ERRCODE = '22023';
  END IF;

  SELECT product_id INTO v_product_id FROM public.billing_customers WHERE id = p_billing_customer_id;
  IF v_product_id IS NULL THEN
    RAISE EXCEPTION 'BILLING_CUSTOMER_NOT_FOUND' USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_plan_id
    FROM public.commercial_plans
   WHERE product_id = v_product_id AND code = p_plan_code AND is_active;
  IF v_plan_id IS NULL THEN
    RAISE EXCEPTION 'UNKNOWN_OR_INACTIVE_PLAN_CODE: %', p_plan_code USING ERRCODE = '22023';
  END IF;

  -- Renewal/plan-transition semantics: close out whichever existing
  -- ACTIVE/GRACE row would otherwise overlap the new period.
  SELECT id, effective_start, effective_end
    INTO v_prior
    FROM public.commercial_licences
   WHERE billing_customer_id = p_billing_customer_id
     AND status IN ('ACTIVE','GRACE')
     AND effective_range && tstzrange(p_effective_start, p_effective_end, '[)')
   LIMIT 1;

  IF FOUND THEN
    IF p_effective_start <= v_prior.effective_start THEN
      RAISE EXCEPTION
        'NEW_EFFECTIVE_START_MUST_BE_AFTER_EXISTING_PERIOD_START (existing licence %, starts %)',
        v_prior.id, v_prior.effective_start
        USING ERRCODE = '22023';
    END IF;

    UPDATE public.commercial_licences
       SET effective_end = p_effective_start, updated_at = now()
     WHERE id = v_prior.id;
  END IF;

  INSERT INTO public.commercial_licences (
    billing_customer_id, plan_id, status, source, effective_start, effective_end
  ) VALUES (
    p_billing_customer_id, v_plan_id, 'ACTIVE', 'MANUAL_ADMIN_GRANT', p_effective_start, p_effective_end
  ) RETURNING id INTO v_licence_id;

  INSERT INTO public.billing_audit_events (
    billing_customer_id, actor_user_id, action, previous_state, new_state, reason
  ) VALUES (
    p_billing_customer_id, v_user_id, 'LICENCE_GRANTED',
    CASE WHEN v_prior.id IS NOT NULL
      THEN jsonb_build_object('closed_prior_licence_id', v_prior.id, 'closed_effective_end', p_effective_start)
      ELSE NULL
    END,
    jsonb_build_object(
      'licence_id', v_licence_id, 'plan_code', p_plan_code,
      'effective_start', p_effective_start, 'effective_end', p_effective_end
    ),
    p_reason
  );

  RETURN jsonb_build_object(
    'licence_id', v_licence_id, 'plan_code', p_plan_code,
    'closed_prior_licence_id', v_prior.id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_grant_commercial_licence(UUID,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_grant_commercial_licence(UUID,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- FUNCTION: admin_transition_licence_status(...) — the sole write path for
-- changing an EXISTING licence period's status in place (SUSPEND/
-- REACTIVATE/CANCEL/EXPIRE, or a manual GRACE transition). Never creates a
-- new row — see admin_grant_commercial_licence() for new periods. Locks the
-- row (FOR UPDATE) so a concurrent transition on the same row serializes
-- rather than races; if a REACTIVATE would recreate an overlap with some
-- other ACTIVE/GRACE row, excl_cl_no_overlapping_authoritative_periods
-- rejects the UPDATE and this function's exception propagates unchanged.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.admin_transition_licence_status(
  p_licence_id UUID,
  p_new_status TEXT,
  p_reason     TEXT
) RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_row     RECORD;
  v_new_end TIMESTAMPTZ;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_user_id AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF p_new_status NOT IN ('PENDING','ACTIVE','GRACE','SUSPENDED','CANCELLED','EXPIRED') THEN
    RAISE EXCEPTION 'INVALID_STATUS: %', p_new_status USING ERRCODE = '22023';
  END IF;

  SELECT id, billing_customer_id, status, effective_start, effective_end
    INTO v_row
    FROM public.commercial_licences
   WHERE id = p_licence_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'LICENCE_NOT_FOUND' USING ERRCODE = '22023';
  END IF;

  v_new_end := v_row.effective_end;
  IF p_new_status IN ('CANCELLED','EXPIRED') AND (v_row.effective_end IS NULL OR v_row.effective_end > now()) THEN
    v_new_end := now();
  END IF;

  UPDATE public.commercial_licences
     SET status = p_new_status,
         effective_end = v_new_end,
         updated_at = now()
   WHERE id = p_licence_id;

  INSERT INTO public.billing_audit_events (
    billing_customer_id, actor_user_id, action, previous_state, new_state, reason
  ) VALUES (
    v_row.billing_customer_id, v_user_id, 'LICENCE_STATUS_TRANSITIONED',
    jsonb_build_object('licence_id', p_licence_id, 'status', v_row.status, 'effective_end', v_row.effective_end),
    jsonb_build_object('licence_id', p_licence_id, 'status', p_new_status, 'effective_end', v_new_end),
    p_reason
  );

  RETURN jsonb_build_object('licence_id', p_licence_id, 'status', p_new_status);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_transition_licence_status(UUID,TEXT,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_transition_licence_status(UUID,TEXT,TEXT) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- FUNCTIONS: admin_grant_entitlement_override / admin_revoke_entitlement_override
-- The manual-override path — explicitly distinguishable from paid
-- entitlement (source='ADMIN_OVERRIDE' vs 'ACTIVE_LICENCE' in the resolver
-- result), mandatory reason, optional effective_end, fully audited, revocable.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.admin_grant_entitlement_override(
  p_billing_customer_id UUID,
  p_feature_code        TEXT,
  p_reason              TEXT,
  p_effective_end       TIMESTAMPTZ
) RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id     UUID := auth.uid();
  v_override_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_user_id AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;

  IF p_feature_code NOT IN (
    'SAFISHA_PREVIEW','SAFISHA_CERTIFY','HESABU_REPORTING','HESABU_EXPORT',
    'MAONO_INTELLIGENCE','MULTI_COMPANY','MULTI_PERIOD'
  ) THEN
    RAISE EXCEPTION 'UNKNOWN_FEATURE_CODE: %', p_feature_code USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.billing_customers WHERE id = p_billing_customer_id) THEN
    RAISE EXCEPTION 'BILLING_CUSTOMER_NOT_FOUND' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.entitlement_overrides (
    billing_customer_id, feature_code, granted_by, reason, effective_start, effective_end
  ) VALUES (
    p_billing_customer_id, p_feature_code, v_user_id, p_reason, now(), p_effective_end
  ) RETURNING id INTO v_override_id;

  INSERT INTO public.billing_audit_events (
    billing_customer_id, actor_user_id, action, previous_state, new_state, reason
  ) VALUES (
    p_billing_customer_id, v_user_id, 'ENTITLEMENT_OVERRIDE_GRANTED', NULL,
    jsonb_build_object('override_id', v_override_id, 'feature_code', p_feature_code, 'effective_end', p_effective_end),
    p_reason
  );

  RETURN jsonb_build_object('override_id', v_override_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_revoke_entitlement_override(
  p_override_id UUID,
  p_reason      TEXT
) RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id             UUID := auth.uid();
  v_billing_customer_id UUID;
  v_feature_code        TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_user_id AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;

  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED' USING ERRCODE = '22023';
  END IF;

  SELECT billing_customer_id, feature_code INTO v_billing_customer_id, v_feature_code
    FROM public.entitlement_overrides
   WHERE id = p_override_id AND revoked_at IS NULL;

  IF v_billing_customer_id IS NULL THEN
    RAISE EXCEPTION 'OVERRIDE_NOT_FOUND_OR_ALREADY_REVOKED' USING ERRCODE = '22023';
  END IF;

  UPDATE public.entitlement_overrides
     SET revoked_at = now(), revoked_by = v_user_id
   WHERE id = p_override_id;

  INSERT INTO public.billing_audit_events (
    billing_customer_id, actor_user_id, action, previous_state, new_state, reason
  ) VALUES (
    v_billing_customer_id, v_user_id, 'ENTITLEMENT_OVERRIDE_REVOKED',
    jsonb_build_object('override_id', p_override_id, 'feature_code', v_feature_code),
    NULL, p_reason
  );

  RETURN jsonb_build_object('override_id', p_override_id, 'revoked', true);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_grant_entitlement_override(UUID,TEXT,TEXT,TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_grant_entitlement_override(UUID,TEXT,TEXT,TIMESTAMPTZ) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_revoke_entitlement_override(UUID,TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_revoke_entitlement_override(UUID,TEXT) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- FUNCTION: admin_billing_lookup(...) — minimal support/admin read boundary.
-- Read-only visibility into billing identity, licence/entitlement status,
-- and the latest upload's safe diagnostic fields. No giant admin dashboard
-- is built for Ω1 — this RPC is the contract; a UI surface is deferred.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.admin_billing_lookup(p_company_id UUID)
  RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  STABLE
  SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user_id             UUID := auth.uid();
  v_owner_user_id        UUID;
  v_billing_customer_id  UUID;
  v_result               JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED' USING ERRCODE = '28000';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.commercial_admins WHERE user_id = v_user_id AND active) THEN
    RAISE EXCEPTION 'NOT_A_COMMERCIAL_ADMIN' USING ERRCODE = '42501';
  END IF;

  SELECT c.user_id INTO v_owner_user_id FROM public.companies c WHERE c.id = p_company_id;
  IF v_owner_user_id IS NULL THEN
    RAISE EXCEPTION 'COMPANY_NOT_FOUND' USING ERRCODE = '22023';
  END IF;

  SELECT id INTO v_billing_customer_id FROM public.billing_customers WHERE owner_user_id = v_owner_user_id;

  SELECT jsonb_build_object(
    'company_id', p_company_id,
    'billing_customer_id', v_billing_customer_id,
    'current_licence', (
      SELECT jsonb_build_object(
               'status', cl.status, 'plan_code', cp.code,
               'effective_start', cl.effective_start, 'effective_end', cl.effective_end
             )
        FROM public.commercial_licences cl
        JOIN public.commercial_plans cp ON cp.id = cl.plan_id
       WHERE cl.billing_customer_id = v_billing_customer_id
         AND cl.effective_start <= now()
         AND (cl.effective_end IS NULL OR cl.effective_end > now())
       ORDER BY cl.effective_start DESC LIMIT 1
    ),
    'active_overrides', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('feature_code', eo.feature_code, 'effective_end', eo.effective_end)), '[]'::jsonb)
        FROM public.entitlement_overrides eo
       WHERE eo.billing_customer_id = v_billing_customer_id
         AND eo.revoked_at IS NULL
         AND eo.effective_start <= now()
         AND (eo.effective_end IS NULL OR eo.effective_end > now())
    ),
    'latest_upload', (
      SELECT jsonb_build_object(
               'id', tbu.id, 'status', tbu.status,
               'period_year', tbu.period_year, 'uploaded_at', tbu.uploaded_at
             )
        FROM public.trial_balance_uploads tbu
       WHERE tbu.company_id = p_company_id
       ORDER BY tbu.uploaded_at DESC LIMIT 1
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_billing_lookup(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_billing_lookup(UUID) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- TRIGGER on public.companies — auto-provision only. Mirrors the existing
-- trg_create_owner_firm_member AFTER INSERT convention.
--
-- Ω1-R deliberately does NOT gate company creation on MULTI_COMPANY
-- entitlement — see flagged design decision (a),
-- MULTI_COMPANY_PREMIUM_POLICY_DEFERRED_TO_Ω2_PRODUCT_DECISION, in the
-- migration header. Company creation behavior is unchanged from pre-Ω1.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.provision_billing_customer_for_company()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_catalog
AS $$
DECLARE
  v_billing_customer_id UUID;
  v_product_id          UUID;
  v_free_plan_id        UUID;
BEGIN
  SELECT id INTO v_billing_customer_id
    FROM public.billing_customers WHERE owner_user_id = NEW.user_id LIMIT 1;

  IF v_billing_customer_id IS NULL THEN
    SELECT id INTO v_product_id FROM public.commercial_products WHERE code = 'SAFF_ERP' LIMIT 1;

    INSERT INTO public.billing_customers (owner_user_id, product_id)
    VALUES (NEW.user_id, v_product_id)
    ON CONFLICT (owner_user_id) DO NOTHING;

    SELECT id INTO v_billing_customer_id
      FROM public.billing_customers WHERE owner_user_id = NEW.user_id LIMIT 1;
  END IF;

  IF v_billing_customer_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.commercial_licences WHERE billing_customer_id = v_billing_customer_id)
  THEN
    SELECT cp.id INTO v_free_plan_id
      FROM public.commercial_plans cp
      JOIN public.billing_customers bc ON bc.product_id = cp.product_id
     WHERE bc.id = v_billing_customer_id AND cp.code = 'FREE'
     LIMIT 1;

    IF v_free_plan_id IS NOT NULL THEN
      INSERT INTO public.commercial_licences (
        billing_customer_id, plan_id, status, source, effective_start, effective_end
      ) VALUES (
        v_billing_customer_id, v_free_plan_id, 'ACTIVE', 'SYSTEM_DEFAULT_FREE', now(), NULL
      );

      INSERT INTO public.billing_audit_events (
        billing_customer_id, actor_user_id, action, previous_state, new_state, reason
      ) VALUES (
        v_billing_customer_id, NULL, 'FREE_LICENCE_AUTO_PROVISIONED', NULL,
        jsonb_build_object('plan_code', 'FREE', 'status', 'ACTIVE'),
        'Automatic FREE-plan enrollment on first company creation'
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- AFTER INSERT: mirrors trg_create_owner_firm_member's own justification —
-- billing_customers/commercial_licences have no FK dependency on the
-- companies row, but running after keeps this trigger consistent with the
-- established convention and avoids any ordering assumption with the
-- owner-firm-member trigger also firing on this same event.
CREATE TRIGGER trg_provision_billing_customer
AFTER INSERT ON public.companies
FOR EACH ROW
EXECUTE FUNCTION public.provision_billing_customer_for_company();

REVOKE ALL ON FUNCTION public.provision_billing_customer_for_company() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._resolve_entitlement_for_owner(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════════
-- BACKFILL — every EXISTING company owner gets a billing_customer + FREE
-- licence, so this migration does not silently strip existing users of
-- base access the moment it is applied. Idempotent (ON CONFLICT DO NOTHING /
-- NOT EXISTS guard) — safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

INSERT INTO public.billing_customers (owner_user_id, product_id)
SELECT DISTINCT c.user_id, (SELECT id FROM public.commercial_products WHERE code = 'SAFF_ERP')
FROM public.companies c
ON CONFLICT (owner_user_id) DO NOTHING;

INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, effective_end)
SELECT bc.id,
       (SELECT cp.id FROM public.commercial_plans cp WHERE cp.product_id = bc.product_id AND cp.code = 'FREE'),
       'ACTIVE', 'SYSTEM_DEFAULT_FREE', now(), NULL
FROM public.billing_customers bc
WHERE NOT EXISTS (SELECT 1 FROM public.commercial_licences cl WHERE cl.billing_customer_id = bc.id);

-- ── Rollback (NOT executed — for reference only) ─────────────────────────────
-- DROP TRIGGER IF EXISTS trg_provision_billing_customer ON public.companies;
-- DROP FUNCTION IF EXISTS public.provision_billing_customer_for_company();
-- DROP FUNCTION IF EXISTS public.admin_billing_lookup(UUID);
-- DROP FUNCTION IF EXISTS public.admin_revoke_entitlement_override(UUID, TEXT);
-- DROP FUNCTION IF EXISTS public.admin_grant_entitlement_override(UUID, TEXT, TEXT, TIMESTAMPTZ);
-- DROP FUNCTION IF EXISTS public.admin_transition_licence_status(UUID,TEXT,TEXT);
-- DROP FUNCTION IF EXISTS public.admin_grant_commercial_licence(UUID,TEXT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT);
-- DROP FUNCTION IF EXISTS public.get_my_billing_summary();
-- DROP FUNCTION IF EXISTS public.get_effective_entitlement(UUID, TEXT);
-- DROP FUNCTION IF EXISTS public._resolve_entitlement_for_owner(UUID, TEXT);
-- DROP TRIGGER IF EXISTS trg_billing_audit_events_immutable ON public.billing_audit_events;
-- DROP FUNCTION IF EXISTS public.billing_audit_events_immutable();
-- DROP TABLE IF EXISTS public.billing_audit_events CASCADE;
-- DROP TABLE IF EXISTS public.entitlement_overrides CASCADE;
-- DROP TRIGGER IF EXISTS trg_payment_events_immutable ON public.payment_events;
-- DROP FUNCTION IF EXISTS public.payment_events_immutable();
-- DROP TABLE IF EXISTS public.payment_events CASCADE;
-- DROP TABLE IF EXISTS public.commercial_licences CASCADE;
-- DROP TABLE IF EXISTS public.billing_customers CASCADE;
-- DROP TABLE IF EXISTS public.commercial_plans CASCADE;
-- DROP TABLE IF EXISTS public.commercial_products CASCADE;
-- DROP TABLE IF EXISTS public.commercial_admins CASCADE;
