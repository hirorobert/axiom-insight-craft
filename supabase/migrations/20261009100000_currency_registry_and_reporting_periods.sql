-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- I1-A (workbench A1): currency registry and explicit reporting periods.
--
--   1. currency_registry (currency-registry/1) — the verified ISO 4217 monetary currencies the exact amount engine
--      supports, recorded with their source and version. Funds codes and non-monetary units are excluded.
--        Source:    ISO 4217 Maintenance Agency (SIX), List One: https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml
--        Version:   iso4217-list-one-2026-09-17 (published 2026-09-17; file SHA-256 33139b438657d1cee116ba737807ea71d19d6de4b90f799a09c56f0cc6a1b0ff); 155 currencies.
--   2. fiscal_periods:
--        · reporting_currency: no default any more (no TZS fallback); must be a registry code (foreign key).
--        · explicit dates: start ≤ end; a TECHNICAL ceiling (public.reporting_period_max_months(), 36 months — a
--          data-entry guard, not an accounting rule and not a limit on historical data); no two dated periods of a
--          company overlap (exclusion constraint — concurrency-safe).
--        · dates_basis records how dates were set: 'confirmed' (a person stated them) or 'v1_calendar_convention'
--          (written by the legacy setup RPC). Existing rows are NOT backfilled: their provenance cannot be proven, so
--          they stay unconfirmed (NULL) until confirmed with public.confirm_period_dates.
--        · only server code sets currency, dates, provenance or the prior link (direct client writes are refused).
--        · PROCESSING LOCK: once any trial balance of the period has been processed, its currency and dates are fixed
--          for every role (service role included). The one exception is step 6.
--   3. fiscal_period_events — append-only history of period setup actions.
--   4. public.open_engagement_with_period — explicit start/end, currency, optional prior period (adjacent).
--      public.open_engagement_with_scope (v1) is retained, unchanged in behaviour, for existing callers.
--   5. public.confirm_period_dates — confirm or state the dates of a period nothing has been processed in yet
--      (prepare_close).
--   6. public.complete_legacy_period_dates — the separate, audited operation that completes the dates of a LEGACY
--      period (dates not confirmed, or set by the v1 calendar convention) that already has processed history:
--      review_close, a stated reason, never the currency, never already-confirmed dates. When the dates change, every
--      result in force for the period's trial balances is invalidated (tb_certification_invalidations,
--      reason 'period_dates_completed') in the same transaction, so nothing computed before stays authoritative.
--   Authorization: v2 setup and date confirmation need prepare_close (the preparer completes intake); granting a
--   service other than FINANCIAL_STATEMENTS through v2 still needs review_close, as in v1. v1 is unchanged.
--
-- PREFLIGHT: incompatible existing data makes this migration REFUSE (nothing is changed or repaired):
--   an unsupported or malformed currency, start after end, a period longer than the technical ceiling, or two dated
--   periods of one company that overlap. The offending ids are named in the error.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ── 1. Currency registry ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.currency_registry (
  code             TEXT        NOT NULL,
  exponent         INTEGER     NOT NULL,
  name             TEXT        NOT NULL,
  registry_version TEXT        NOT NULL DEFAULT 'iso4217-list-one-2026-09-17',
  CONSTRAINT currency_registry_pkey PRIMARY KEY (code),
  CONSTRAINT chk_cr_code CHECK (code ~ '^[A-Z]{3}$'),
  CONSTRAINT chk_cr_exponent CHECK (exponent BETWEEN 0 AND 4),
  CONSTRAINT chk_cr_version CHECK (registry_version = 'iso4217-list-one-2026-09-17')
);
COMMENT ON TABLE public.currency_registry IS
  'currency-registry/1: verified ISO 4217 monetary currencies supported by the exact amount engine. Source: ISO 4217 Maintenance Agency (SIX), List One: https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists/list-one.xml; version iso4217-list-one-2026-09-17 (file SHA-256 33139b438657d1cee116ba737807ea71d19d6de4b90f799a09c56f0cc6a1b0ff). Changing it is a reviewed migration.';
INSERT INTO public.currency_registry (code, exponent, name) VALUES
  ('AED', 2, 'UAE Dirham'),
  ('AFN', 2, 'Afghani'),
  ('ALL', 2, 'Lek'),
  ('AMD', 2, 'Armenian Dram'),
  ('AOA', 2, 'Kwanza'),
  ('ARS', 2, 'Argentine Peso'),
  ('AUD', 2, 'Australian Dollar'),
  ('AWG', 2, 'Aruban Florin'),
  ('AZN', 2, 'Azerbaijan Manat'),
  ('BAM', 2, 'Convertible Mark'),
  ('BBD', 2, 'Barbados Dollar'),
  ('BDT', 2, 'Taka'),
  ('BHD', 3, 'Bahraini Dinar'),
  ('BIF', 0, 'Burundi Franc'),
  ('BMD', 2, 'Bermudian Dollar'),
  ('BND', 2, 'Brunei Dollar'),
  ('BOB', 2, 'Boliviano'),
  ('BRL', 2, 'Brazilian Real'),
  ('BSD', 2, 'Bahamian Dollar'),
  ('BTN', 2, 'Ngultrum'),
  ('BWP', 2, 'Pula'),
  ('BYN', 2, 'Belarusian Ruble'),
  ('BZD', 2, 'Belize Dollar'),
  ('CAD', 2, 'Canadian Dollar'),
  ('CDF', 2, 'Congolese Franc'),
  ('CHF', 2, 'Swiss Franc'),
  ('CLP', 0, 'Chilean Peso'),
  ('CNY', 2, 'Yuan Renminbi'),
  ('COP', 2, 'Colombian Peso'),
  ('CRC', 2, 'Costa Rican Colon'),
  ('CUP', 2, 'Cuban Peso'),
  ('CVE', 2, 'Cabo Verde Escudo'),
  ('CZK', 2, 'Czech Koruna'),
  ('DJF', 0, 'Djibouti Franc'),
  ('DKK', 2, 'Danish Krone'),
  ('DOP', 2, 'Dominican Peso'),
  ('DZD', 2, 'Algerian Dinar'),
  ('EGP', 2, 'Egyptian Pound'),
  ('ERN', 2, 'Nakfa'),
  ('ETB', 2, 'Ethiopian Birr'),
  ('EUR', 2, 'Euro'),
  ('FJD', 2, 'Fiji Dollar'),
  ('FKP', 2, 'Falkland Islands Pound'),
  ('GBP', 2, 'Pound Sterling'),
  ('GEL', 2, 'Lari'),
  ('GHS', 2, 'Ghana Cedi'),
  ('GIP', 2, 'Gibraltar Pound'),
  ('GMD', 2, 'Dalasi'),
  ('GNF', 0, 'Guinean Franc'),
  ('GTQ', 2, 'Quetzal'),
  ('GYD', 2, 'Guyana Dollar'),
  ('HKD', 2, 'Hong Kong Dollar'),
  ('HNL', 2, 'Lempira'),
  ('HTG', 2, 'Gourde'),
  ('HUF', 2, 'Forint'),
  ('IDR', 2, 'Rupiah'),
  ('ILS', 2, 'New Israeli Sheqel'),
  ('INR', 2, 'Indian Rupee'),
  ('IQD', 3, 'Iraqi Dinar'),
  ('IRR', 2, 'Iranian Rial'),
  ('ISK', 0, 'Iceland Krona'),
  ('JMD', 2, 'Jamaican Dollar'),
  ('JOD', 3, 'Jordanian Dinar'),
  ('JPY', 0, 'Yen'),
  ('KES', 2, 'Kenyan Shilling'),
  ('KGS', 2, 'Som'),
  ('KHR', 2, 'Riel'),
  ('KMF', 0, 'Comorian Franc '),
  ('KPW', 2, 'North Korean Won'),
  ('KRW', 0, 'Won'),
  ('KWD', 3, 'Kuwaiti Dinar'),
  ('KYD', 2, 'Cayman Islands Dollar'),
  ('KZT', 2, 'Tenge'),
  ('LAK', 2, 'Lao Kip'),
  ('LBP', 2, 'Lebanese Pound'),
  ('LKR', 2, 'Sri Lanka Rupee'),
  ('LRD', 2, 'Liberian Dollar'),
  ('LSL', 2, 'Loti'),
  ('LYD', 3, 'Libyan Dinar'),
  ('MAD', 2, 'Moroccan Dirham'),
  ('MDL', 2, 'Moldovan Leu'),
  ('MGA', 2, 'Malagasy Ariary'),
  ('MKD', 2, 'Denar'),
  ('MMK', 2, 'Kyat'),
  ('MNT', 2, 'Tugrik'),
  ('MOP', 2, 'Pataca'),
  ('MRU', 2, 'Ouguiya'),
  ('MUR', 2, 'Mauritius Rupee'),
  ('MVR', 2, 'Rufiyaa'),
  ('MWK', 2, 'Malawi Kwacha'),
  ('MXN', 2, 'Mexican Peso'),
  ('MYR', 2, 'Malaysian Ringgit'),
  ('MZN', 2, 'Mozambique Metical'),
  ('NAD', 2, 'Namibia Dollar'),
  ('NGN', 2, 'Naira'),
  ('NIO', 2, 'Cordoba Oro'),
  ('NOK', 2, 'Norwegian Krone'),
  ('NPR', 2, 'Nepalese Rupee'),
  ('NZD', 2, 'New Zealand Dollar'),
  ('OMR', 3, 'Rial Omani'),
  ('PAB', 2, 'Balboa'),
  ('PEN', 2, 'Sol'),
  ('PGK', 2, 'Kina'),
  ('PHP', 2, 'Philippine Peso'),
  ('PKR', 2, 'Pakistan Rupee'),
  ('PLN', 2, 'Zloty'),
  ('PYG', 0, 'Guarani'),
  ('QAR', 2, 'Qatari Rial'),
  ('RON', 2, 'Romanian Leu'),
  ('RSD', 2, 'Serbian Dinar'),
  ('RUB', 2, 'Russian Ruble'),
  ('RWF', 0, 'Rwanda Franc'),
  ('SAR', 2, 'Saudi Riyal'),
  ('SBD', 2, 'Solomon Islands Dollar'),
  ('SCR', 2, 'Seychelles Rupee'),
  ('SDG', 2, 'Sudanese Pound'),
  ('SEK', 2, 'Swedish Krona'),
  ('SGD', 2, 'Singapore Dollar'),
  ('SHP', 2, 'Saint Helena Pound'),
  ('SLE', 2, 'Leone'),
  ('SOS', 2, 'Somali Shilling'),
  ('SRD', 2, 'Surinam Dollar'),
  ('SSP', 2, 'South Sudanese Pound'),
  ('STN', 2, 'Dobra'),
  ('SVC', 2, 'El Salvador Colon'),
  ('SYP', 2, 'Syrian Pound'),
  ('SZL', 2, 'Lilangeni'),
  ('THB', 2, 'Baht'),
  ('TJS', 2, 'Somoni'),
  ('TMT', 2, 'Turkmenistan New Manat'),
  ('TND', 3, 'Tunisian Dinar'),
  ('TOP', 2, 'Pa’anga'),
  ('TRY', 2, 'Turkish Lira'),
  ('TTD', 2, 'Trinidad and Tobago Dollar'),
  ('TWD', 2, 'New Taiwan Dollar'),
  ('TZS', 2, 'Tanzanian Shilling'),
  ('UAH', 2, 'Hryvnia'),
  ('UGX', 0, 'Uganda Shilling'),
  ('USD', 2, 'US Dollar'),
  ('UYU', 2, 'Peso Uruguayo'),
  ('UZS', 2, 'Uzbekistan Sum'),
  ('VED', 2, 'Bolívar Soberano'),
  ('VES', 2, 'Bolívar Soberano'),
  ('VND', 0, 'Dong'),
  ('VUV', 0, 'Vatu'),
  ('WST', 2, 'Tala'),
  ('XAF', 0, 'CFA Franc BEAC'),
  ('XCD', 2, 'East Caribbean Dollar'),
  ('XCG', 2, 'Caribbean Guilder'),
  ('XOF', 0, 'CFA Franc BCEAO'),
  ('XPF', 0, 'CFP Franc'),
  ('YER', 2, 'Yemeni Rial'),
  ('ZAR', 2, 'Rand'),
  ('ZMW', 2, 'Zambian Kwacha'),
  ('ZWG', 2, 'Zimbabwe Gold');
ALTER TABLE public.currency_registry ENABLE ROW LEVEL SECURITY;
CREATE POLICY cr_read ON public.currency_registry FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.currency_registry FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.currency_registry TO authenticated;
GRANT SELECT ON public.currency_registry TO service_role;

-- ── 2. Technical period ceiling (configuration point) ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reporting_period_max_months()
RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 36 $$;
COMMENT ON FUNCTION public.reporting_period_max_months() IS
  'Technical data-entry guard: the longest single reporting period accepted (months). Not an accounting rule; framework period-length rules come from the reporting pack. Not a limit on historical data.';

-- ── Preflight: refuse incompatible existing data ─────────────────────────────────────────────────────────────────────
DO $preflight$
DECLARE
  v_bad TEXT;
BEGIN
  SELECT string_agg(fp.id::text || ' (' || coalesce(fp.reporting_currency, 'NULL') || ')', ', ' ORDER BY fp.id) INTO v_bad
    FROM (SELECT id, reporting_currency FROM public.fiscal_periods
           WHERE reporting_currency IS NULL OR reporting_currency NOT IN (SELECT code FROM public.currency_registry)
           ORDER BY id LIMIT 20) fp;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: fiscal periods with an unsupported or malformed reporting currency: %', v_bad USING ERRCODE = '55000';
  END IF;
  SELECT string_agg(id::text, ', ' ORDER BY id) INTO v_bad FROM (SELECT id FROM public.fiscal_periods
    WHERE reporting_start IS NOT NULL AND reporting_end IS NOT NULL AND reporting_start > reporting_end ORDER BY id LIMIT 20) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: fiscal periods whose start is after their end: %', v_bad USING ERRCODE = '55000';
  END IF;
  SELECT string_agg(id::text, ', ' ORDER BY id) INTO v_bad FROM (SELECT id FROM public.fiscal_periods
    WHERE reporting_start IS NOT NULL AND reporting_end IS NOT NULL
      AND reporting_end >= reporting_start + make_interval(months => public.reporting_period_max_months()) ORDER BY id LIMIT 20) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: fiscal periods longer than the technical ceiling (% months): %', public.reporting_period_max_months(), v_bad USING ERRCODE = '55000';
  END IF;
  SELECT string_agg(x.a_id::text || '/' || x.b_id::text, ', ' ORDER BY x.a_id, x.b_id) INTO v_bad FROM (
    SELECT a.id AS a_id, b.id AS b_id FROM public.fiscal_periods a JOIN public.fiscal_periods b
      ON a.company_id = b.company_id AND a.id < b.id
     AND a.reporting_start IS NOT NULL AND a.reporting_end IS NOT NULL AND b.reporting_start IS NOT NULL AND b.reporting_end IS NOT NULL
     AND daterange(a.reporting_start, a.reporting_end, '[]') && daterange(b.reporting_start, b.reporting_end, '[]')
     ORDER BY a.id, b.id LIMIT 20) x;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT_REFUSED: overlapping dated fiscal periods (pairs): %', v_bad USING ERRCODE = '55000';
  END IF;
END
$preflight$;

-- ── fiscal_periods: currency, dates, provenance ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.fiscal_periods ALTER COLUMN reporting_currency DROP DEFAULT;
ALTER TABLE public.fiscal_periods
  ADD CONSTRAINT fk_fp_reporting_currency FOREIGN KEY (reporting_currency) REFERENCES public.currency_registry (code);
ALTER TABLE public.fiscal_periods
  ADD COLUMN IF NOT EXISTS dates_basis TEXT NULL,
  ADD COLUMN IF NOT EXISTS dates_confirmed_by UUID NULL REFERENCES public.firm_members (id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS dates_confirmed_at TIMESTAMPTZ NULL;
ALTER TABLE public.fiscal_periods
  ADD CONSTRAINT chk_fp_dates_basis CHECK (dates_basis IS NULL OR dates_basis IN ('confirmed', 'v1_calendar_convention')),
  ADD CONSTRAINT chk_fp_dates_basis_dated CHECK (dates_basis IS NULL OR (reporting_start IS NOT NULL AND reporting_end IS NOT NULL)),
  ADD CONSTRAINT chk_fp_confirmed_by CHECK ((dates_basis = 'confirmed') = (dates_confirmed_at IS NOT NULL) OR (dates_basis IS NULL AND dates_confirmed_at IS NULL)),
  ADD CONSTRAINT chk_fp_dates_order CHECK (reporting_start IS NULL OR reporting_end IS NULL OR reporting_start <= reporting_end),
  ADD CONSTRAINT chk_fp_dates_ceiling CHECK (reporting_start IS NULL OR reporting_end IS NULL
                                             OR reporting_end < reporting_start + make_interval(months => public.reporting_period_max_months())),
  ADD CONSTRAINT ex_fp_no_overlap EXCLUDE USING gist (company_id WITH =, daterange(reporting_start, reporting_end, '[]') WITH &&)
    WHERE (reporting_start IS NOT NULL AND reporting_end IS NOT NULL);

-- ── Period setup history (append-only) ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.fiscal_period_events (
  id               UUID        NOT NULL DEFAULT gen_random_uuid(),
  period_id        UUID        NOT NULL REFERENCES public.fiscal_periods (id) ON DELETE RESTRICT,
  company_id       UUID        NOT NULL,
  action           TEXT        NOT NULL,
  detail           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  actor_member_id  UUID        NULL REFERENCES public.firm_members (id) ON DELETE RESTRICT,
  actor_user_id    UUID        NULL,
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fiscal_period_events_pkey PRIMARY KEY (id),
  CONSTRAINT chk_fpe_action CHECK (action IN ('created', 'dates_confirmed', 'prior_linked', 'legacy_dates_completed'))
);
CREATE INDEX idx_fpe_period ON public.fiscal_period_events (period_id, occurred_at);
CREATE OR REPLACE FUNCTION public.fiscal_period_events_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Iron Dome: fiscal_period_events is append-only. % is not permitted.', TG_OP USING ERRCODE = '42501';
END;
$$;
CREATE TRIGGER trg_fpe_append_only BEFORE UPDATE OR DELETE ON public.fiscal_period_events
  FOR EACH ROW EXECUTE FUNCTION public.fiscal_period_events_append_only();
ALTER TABLE public.fiscal_period_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY fpe_workspace_read ON public.fiscal_period_events FOR SELECT TO authenticated
  USING (public.can_access_workspace(company_id));
REVOKE ALL ON public.fiscal_period_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.fiscal_period_events TO authenticated;
GRANT SELECT, INSERT ON public.fiscal_period_events TO service_role;

-- ── Fence: only server code sets currency, dates, provenance or the prior link ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fiscal_periods_setup_fence()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_marker BOOLEAN := coalesce(current_setting('axiom.period_writer', true), '') = txid_current()::text;
BEGIN
  -- Direct client writes (the authenticated or anon roles, through PostgREST) never set these fields; the setup RPCs
  -- (SECURITY DEFINER) and the service role do.
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      RAISE EXCEPTION 'PERIOD_SETUP_FENCED: a reporting period is created only by the setup functions' USING ERRCODE = '42501';
    END IF;
    IF NEW.reporting_currency IS DISTINCT FROM OLD.reporting_currency OR NEW.reporting_start IS DISTINCT FROM OLD.reporting_start
       OR NEW.reporting_end IS DISTINCT FROM OLD.reporting_end OR NEW.prior_period_id IS DISTINCT FROM OLD.prior_period_id
       OR NEW.dates_basis IS DISTINCT FROM OLD.dates_basis OR NEW.dates_confirmed_by IS DISTINCT FROM OLD.dates_confirmed_by
       OR NEW.dates_confirmed_at IS DISTINCT FROM OLD.dates_confirmed_at THEN
      RAISE EXCEPTION 'PERIOD_SETUP_FENCED: currency, dates and the prior link change only through the setup functions' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  -- Provenance is written only by the setup functions themselves.
  IF (TG_OP = 'INSERT' AND NEW.dates_basis IS NOT NULL AND NOT v_marker)
     OR (TG_OP = 'UPDATE' AND (NEW.dates_basis IS DISTINCT FROM OLD.dates_basis OR NEW.dates_confirmed_at IS DISTINCT FROM OLD.dates_confirmed_at) AND NOT v_marker) THEN
    RAISE EXCEPTION 'PERIOD_SETUP_FENCED: date provenance is recorded only by the setup functions' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_fp_setup_fence BEFORE INSERT OR UPDATE ON public.fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION public.fiscal_periods_setup_fence();

-- ── Processing lock: currency and dates are fixed once anything in the period has been processed ──────────────────────
-- The trial balances of a period: linked by period_id, or (legacy rows without a period link) by company and year.
CREATE OR REPLACE FUNCTION public._period_has_processing(p_period_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.fiscal_periods p
      JOIN public.trial_balance_uploads t
        ON t.period_id = p.id
        OR (t.period_id IS NULL AND t.company_id = p.company_id AND t.period_year = EXTRACT(YEAR FROM p.fiscal_year_end)::integer)
     WHERE p.id = p_period_id
       AND (coalesce(t.processing_attempt, 0) > 0 OR EXISTS (SELECT 1 FROM public.tb_certifications c WHERE c.upload_id = t.id)));
$$;
REVOKE ALL ON FUNCTION public._period_has_processing(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.fiscal_periods_processing_lock()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_legacy BOOLEAN := coalesce(current_setting('axiom.legacy_period_dates', true), '') = txid_current()::text;
BEGIN
  IF NEW.reporting_currency IS NOT DISTINCT FROM OLD.reporting_currency
     AND NEW.reporting_start IS NOT DISTINCT FROM OLD.reporting_start
     AND NEW.reporting_end IS NOT DISTINCT FROM OLD.reporting_end THEN
    RETURN NEW;
  END IF;
  IF NOT public._period_has_processing(OLD.id) THEN
    RETURN NEW;
  END IF;
  -- The only change allowed after processing: complete_legacy_period_dates completing a legacy period's dates
  -- (never the currency, never dates that were already confirmed).
  IF v_legacy AND NEW.reporting_currency IS NOT DISTINCT FROM OLD.reporting_currency
     AND OLD.dates_basis IS DISTINCT FROM 'confirmed' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PERIOD_LOCKED_BY_PROCESSING: the currency and dates of a period are fixed once a trial balance in it has been processed. [period=%]', OLD.id
    USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER trg_fp_processing_lock BEFORE UPDATE OF reporting_currency, reporting_start, reporting_end ON public.fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION public.fiscal_periods_processing_lock();
REVOKE ALL ON FUNCTION public.fiscal_periods_processing_lock() FROM PUBLIC, anon, authenticated;

-- Results invalidated by completing a legacy period's dates are recorded with their own reason.
ALTER TABLE public.tb_certification_invalidations DROP CONSTRAINT tb_certification_invalidations_reason_check;
ALTER TABLE public.tb_certification_invalidations
  ADD CONSTRAINT tb_certification_invalidations_reason_check CHECK (reason IN ('reprocess_requested', 'period_dates_completed'));

REVOKE ALL ON FUNCTION public.fiscal_periods_setup_fence(), public.fiscal_period_events_append_only() FROM PUBLIC, anon, authenticated;

-- ── v1, unchanged in behaviour (explicit TZS; provenance recorded) ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.open_engagement_with_scope(p_company_id uuid, p_period_year integer, p_capabilities text[], p_engagement_type text DEFAULT 'composite'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_member   UUID;
  v_period   UUID;
  v_eng      UUID;
  v_created  BOOLEAN := false;
  v_cap      TEXT;
  v_caps     TEXT[];
  v_granted  TEXT[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: an authenticated session is required' USING ERRCODE = '42501';
  END IF;
  IF p_period_year IS NULL OR p_period_year < 2000 OR p_period_year > 2100 THEN
    RAISE EXCEPTION 'INVALID: reporting year out of range' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT c ORDER BY c) INTO v_caps FROM unnest(COALESCE(p_capabilities, ARRAY[]::TEXT[])) c;
  IF v_caps IS NULL OR array_length(v_caps, 1) = 0 THEN
    RAISE EXCEPTION 'INVALID: choose at least one service' USING ERRCODE = '22023';
  END IF;
  FOREACH v_cap IN ARRAY v_caps LOOP
    IF v_cap NOT IN ('FINANCIAL_STATEMENTS', 'TAX_COMPUTATION', 'COMPLIANCE_REVIEW', 'FILING_PREPARATION', 'MONITORING') THEN
      RAISE EXCEPTION 'INVALID: unknown service %', v_cap USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- 1. authorise from the session (never from the request)
  SELECT fm.id INTO v_member FROM public.firm_members fm
   WHERE fm.user_id = auth.uid() AND fm.company_id = p_company_id AND fm.accepted_at IS NOT NULL AND public.named_user_access_active(fm.company_id, fm.user_id)
     AND public.workspace_capability_allowed(fm.company_id, fm.user_id, 'review_close') LIMIT 1;
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: choosing services needs the review_close capability in this workspace and a current plan' USING ERRCODE = '42501';
  END IF;
  FOREACH v_cap IN ARRAY v_caps LOOP PERFORM public.assert_capability_available(v_cap); END LOOP;

  -- 2. serialise on the company × year identity: every concurrent request for the same workspace queues here
  PERFORM pg_advisory_xact_lock(hashtextextended('open_engagement:' || p_company_id::text || ':' || p_period_year::text, 0));

  -- 3. the reporting period of record (earliest wins; the (company, year-end) UNIQUE key is the backstop)
  SELECT p.id INTO v_period FROM public.fiscal_periods p
   WHERE p.company_id = p_company_id
     AND EXTRACT(YEAR FROM COALESCE(p.reporting_end, p.fiscal_year_end))::INTEGER = p_period_year
   ORDER BY p.created_at, p.id LIMIT 1;
  IF v_period IS NULL THEN
    -- Legacy v1 path (retained unchanged in behaviour until the workbench setup replaces it): TZS is now stated
    -- explicitly here — the column no longer has a default — and the provenance of the calendar-year dates is recorded.
    PERFORM set_config('axiom.period_writer', txid_current()::text, true);
    INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, reporting_start, reporting_end, period_label, created_by, reporting_currency, dates_basis)
    VALUES (p_company_id, make_date(p_period_year, 12, 31), make_date(p_period_year, 1, 1), make_date(p_period_year, 12, 31), 'FY' || p_period_year::text, auth.uid(), 'TZS', 'v1_calendar_convention')
    ON CONFLICT (company_id, fiscal_year_end) DO NOTHING
    RETURNING id INTO v_period;
    PERFORM set_config('axiom.period_writer', '', true);
    IF v_period IS NULL THEN
      SELECT p.id INTO v_period FROM public.fiscal_periods p
       WHERE p.company_id = p_company_id AND p.fiscal_year_end = make_date(p_period_year, 12, 31);
    END IF;
  END IF;

  -- 4. the open engagement, or exactly one new one (uq_engagements_one_open_per_period is the invariant)
  SELECT g.id INTO v_eng FROM public.engagements g WHERE g.fiscal_period_id = v_period AND g.status = 'open';
  IF v_eng IS NULL THEN
    INSERT INTO public.engagements (fiscal_period_id, company_id, engagement_type, created_by_member_id)
    VALUES (v_period, p_company_id, COALESCE(p_engagement_type, 'composite'), v_member)
    RETURNING id INTO v_eng;
    v_created := true;
  END IF;

  -- 5. grants: only what is missing (each goes through the validated, jurisdiction-aware command)
  FOREACH v_cap IN ARRAY v_caps LOOP
    IF NOT EXISTS (
      SELECT 1 FROM (
        SELECT DISTINCT ON (e.capability) e.action FROM public.engagement_mandate_events e
         WHERE e.engagement_id = v_eng AND e.capability = v_cap ORDER BY e.capability, e.sequence_no DESC
      ) l WHERE l.action = 'GRANT'
    ) THEN
      PERFORM public.grant_engagement_capability(v_eng, v_cap, 'Selected when the workspace was set up');
    END IF;
  END LOOP;

  SELECT COALESCE(array_agg(x.capability ORDER BY x.capability), ARRAY[]::TEXT[]) INTO v_granted FROM (
    SELECT DISTINCT ON (e.capability) e.capability, e.action FROM public.engagement_mandate_events e
     WHERE e.engagement_id = v_eng ORDER BY e.capability, e.sequence_no DESC
  ) x WHERE x.action = 'GRANT';

  RETURN jsonb_build_object('engagementId', v_eng, 'periodId', v_period, 'created', v_created, 'granted', to_jsonb(v_granted));
END;
$function$;

-- ── v2: explicit period, currency and optional adjacent prior period ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.open_engagement_with_period(
  p_company_id uuid, p_period_start date, p_period_end date, p_reporting_currency text, p_capabilities text[],
  p_engagement_type text DEFAULT 'composite', p_prior_start date DEFAULT NULL, p_prior_end date DEFAULT NULL,
  p_prior_currency text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE
  v_member   UUID;
  v_period   UUID;
  v_prior    UUID;
  v_eng      UUID;
  v_created  BOOLEAN := false;
  v_cap      TEXT;
  v_caps     TEXT[];
  v_granted  TEXT[];
  v_row      public.fiscal_periods%ROWTYPE;
  v_cur      TEXT := upper(btrim(coalesce(p_reporting_currency, '')));
  v_pcur     TEXT := upper(btrim(coalesce(p_prior_currency, p_reporting_currency, '')));
  v_year     INTEGER;
  v_reviewer BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: an authenticated session is required' USING ERRCODE = '42501';
  END IF;
  -- Input (no silent defaults: dates and currency are required).
  IF p_period_start IS NULL OR p_period_end IS NULL THEN
    RAISE EXCEPTION 'INVALID: the period start and end dates are required' USING ERRCODE = '22023';
  END IF;
  IF p_period_start > p_period_end THEN
    RAISE EXCEPTION 'INVALID: the period starts after it ends' USING ERRCODE = '22023';
  END IF;
  IF p_period_end >= p_period_start + make_interval(months => public.reporting_period_max_months()) THEN
    RAISE EXCEPTION 'INVALID: PERIOD_TOO_LONG — a single reporting period may not exceed % months (technical guard)', public.reporting_period_max_months() USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.currency_registry WHERE code = v_cur) THEN
    RAISE EXCEPTION 'INVALID: CURRENCY_UNSUPPORTED — % is not a supported monetary currency', nullif(v_cur, '') USING ERRCODE = '22023';
  END IF;
  IF (p_prior_start IS NULL) <> (p_prior_end IS NULL) THEN
    RAISE EXCEPTION 'INVALID: give both prior-period dates or neither' USING ERRCODE = '22023';
  END IF;
  IF p_prior_start IS NOT NULL THEN
    IF p_prior_start > p_prior_end OR p_prior_end >= p_prior_start + make_interval(months => public.reporting_period_max_months()) THEN
      RAISE EXCEPTION 'INVALID: the prior period dates are not valid' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.currency_registry WHERE code = v_pcur) THEN
      RAISE EXCEPTION 'INVALID: CURRENCY_UNSUPPORTED — % is not a supported monetary currency', nullif(v_pcur, '') USING ERRCODE = '22023';
    END IF;
  END IF;
  v_year := EXTRACT(YEAR FROM p_period_end)::integer;
  IF v_year < 2000 OR v_year > 2100 THEN
    RAISE EXCEPTION 'INVALID: reporting year out of range' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT c ORDER BY c) INTO v_caps FROM unnest(COALESCE(p_capabilities, ARRAY[]::TEXT[])) c;
  IF v_caps IS NULL OR array_length(v_caps, 1) = 0 THEN
    RAISE EXCEPTION 'INVALID: choose at least one service' USING ERRCODE = '22023';
  END IF;
  FOREACH v_cap IN ARRAY v_caps LOOP
    IF v_cap NOT IN ('FINANCIAL_STATEMENTS', 'TAX_COMPUTATION', 'COMPLIANCE_REVIEW', 'FILING_PREPARATION', 'MONITORING') THEN
      RAISE EXCEPTION 'INVALID: unknown service %', v_cap USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- Authorise from the session: prepare_close (the preparer completes intake), an active named user and a current plan.
  SELECT fm.id INTO v_member FROM public.firm_members fm
   WHERE fm.user_id = auth.uid() AND fm.company_id = p_company_id AND fm.accepted_at IS NOT NULL AND public.named_user_access_active(fm.company_id, fm.user_id)
     AND public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close') LIMIT 1;
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: setting up a reporting period needs the prepare_close capability in this workspace and a current plan' USING ERRCODE = '42501';
  END IF;
  -- Choosing services is a scope decision (review_close, as in v1). A preparer may set up the period with the trial
  -- balance service only; anything else is refused before any write.
  v_reviewer := public.workspace_capability_allowed(p_company_id, auth.uid(), 'review_close');
  IF NOT v_reviewer AND EXISTS (SELECT 1 FROM unnest(v_caps) c WHERE c <> 'FINANCIAL_STATEMENTS') THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'SCOPE_REQUIRES_REVIEWER');
  END IF;
  FOREACH v_cap IN ARRAY v_caps LOOP PERFORM public.assert_capability_available(v_cap); END LOOP;

  -- Serialise every period change of this company (periods of different years can overlap, so the lock is per company).
  PERFORM pg_advisory_xact_lock(hashtextextended('fiscal_periods:' || p_company_id::text, 0));

  -- The current period: reuse an identical one; refuse a different period for the same reporting year (the workspace
  -- route is keyed by the year the period ends) or an unconfirmed legacy period of that year.
  SELECT * INTO v_row FROM public.fiscal_periods p
   WHERE p.company_id = p_company_id AND EXTRACT(YEAR FROM COALESCE(p.reporting_end, p.fiscal_year_end))::INTEGER = v_year
   ORDER BY p.created_at, p.id LIMIT 1;
  IF v_row.id IS NOT NULL THEN
    IF v_row.reporting_start IS NULL OR v_row.reporting_end IS NULL THEN
      RETURN jsonb_build_object('outcome', 'refused', 'code', 'PERIOD_DATES_UNCONFIRMED', 'periodId', v_row.id);
    END IF;
    IF v_row.reporting_start <> p_period_start OR v_row.reporting_end <> p_period_end THEN
      RETURN jsonb_build_object('outcome', 'refused', 'code', 'PERIOD_YEAR_TAKEN', 'periodId', v_row.id);
    END IF;
    IF v_row.reporting_currency <> v_cur THEN
      RETURN jsonb_build_object('outcome', 'refused', 'code', 'CURRENCY_DIFFERS_FROM_EXISTING', 'periodId', v_row.id);
    END IF;
    v_period := v_row.id;
  ELSE
    BEGIN
      PERFORM set_config('axiom.period_writer', txid_current()::text, true);
      INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, reporting_start, reporting_end, period_label, created_by,
                                         reporting_currency, dates_basis, dates_confirmed_by, dates_confirmed_at)
      VALUES (p_company_id, p_period_end, p_period_start, p_period_end, 'FY' || v_year::text, auth.uid(), v_cur, 'confirmed', v_member, now())
      RETURNING id INTO v_period;
      PERFORM set_config('axiom.period_writer', '', true);
    EXCEPTION WHEN exclusion_violation THEN
      PERFORM set_config('axiom.period_writer', '', true);
      RETURN jsonb_build_object('outcome', 'refused', 'code', 'PERIOD_OVERLAP');
    END;
    INSERT INTO public.fiscal_period_events (period_id, company_id, action, detail, actor_member_id, actor_user_id)
    VALUES (v_period, p_company_id, 'created', jsonb_build_object('start', p_period_start, 'end', p_period_end, 'currency', v_cur), v_member, auth.uid());
  END IF;

  -- The prior period: must end the day before the current period starts.
  IF p_prior_start IS NOT NULL THEN
    IF p_prior_end <> p_period_start - 1 THEN
      RETURN jsonb_build_object('outcome', 'refused', 'code', 'PRIOR_NOT_ADJACENT');
    END IF;
    SELECT * INTO v_row FROM public.fiscal_periods p
     WHERE p.company_id = p_company_id AND EXTRACT(YEAR FROM COALESCE(p.reporting_end, p.fiscal_year_end))::INTEGER = EXTRACT(YEAR FROM p_prior_end)::INTEGER
     ORDER BY p.created_at, p.id LIMIT 1;
    IF v_row.id IS NOT NULL THEN
      IF v_row.reporting_start IS NULL OR v_row.reporting_end IS NULL THEN
        RETURN jsonb_build_object('outcome', 'refused', 'code', 'PRIOR_DATES_UNCONFIRMED', 'periodId', v_row.id);
      END IF;
      IF v_row.reporting_start <> p_prior_start OR v_row.reporting_end <> p_prior_end THEN
        RETURN jsonb_build_object('outcome', 'refused', 'code', 'PRIOR_YEAR_TAKEN', 'periodId', v_row.id);
      END IF;
      v_prior := v_row.id;
    ELSE
      BEGIN
        PERFORM set_config('axiom.period_writer', txid_current()::text, true);
        INSERT INTO public.fiscal_periods (company_id, fiscal_year_end, reporting_start, reporting_end, period_label, created_by,
                                           reporting_currency, dates_basis, dates_confirmed_by, dates_confirmed_at)
        VALUES (p_company_id, p_prior_end, p_prior_start, p_prior_end, 'FY' || EXTRACT(YEAR FROM p_prior_end)::text, auth.uid(), v_pcur, 'confirmed', v_member, now())
        RETURNING id INTO v_prior;
        PERFORM set_config('axiom.period_writer', '', true);
      EXCEPTION WHEN exclusion_violation THEN
        PERFORM set_config('axiom.period_writer', '', true);
        RETURN jsonb_build_object('outcome', 'refused', 'code', 'PERIOD_OVERLAP');
      END;
      INSERT INTO public.fiscal_period_events (period_id, company_id, action, detail, actor_member_id, actor_user_id)
      VALUES (v_prior, p_company_id, 'created', jsonb_build_object('start', p_prior_start, 'end', p_prior_end, 'currency', v_pcur, 'as_prior_of', v_period), v_member, auth.uid());
    END IF;
    SELECT * INTO v_row FROM public.fiscal_periods WHERE id = v_period;
    IF v_row.prior_period_id IS NOT NULL AND v_row.prior_period_id <> v_prior THEN
      RETURN jsonb_build_object('outcome', 'refused', 'code', 'PRIOR_LINK_CONFLICT');
    END IF;
    IF v_row.prior_period_id IS NULL THEN
      UPDATE public.fiscal_periods SET prior_period_id = v_prior, updated_at = now() WHERE id = v_period;
      INSERT INTO public.fiscal_period_events (period_id, company_id, action, detail, actor_member_id, actor_user_id)
      VALUES (v_period, p_company_id, 'prior_linked', jsonb_build_object('prior_period_id', v_prior), v_member, auth.uid());
    END IF;
  END IF;

  -- The open engagement, or exactly one new one; grants only what is missing (as v1).
  PERFORM pg_advisory_xact_lock(hashtextextended('open_engagement:' || p_company_id::text || ':' || v_year::text, 0));
  SELECT g.id INTO v_eng FROM public.engagements g WHERE g.fiscal_period_id = v_period AND g.status = 'open';
  IF v_eng IS NULL THEN
    INSERT INTO public.engagements (fiscal_period_id, company_id, engagement_type, created_by_member_id)
    VALUES (v_period, p_company_id, COALESCE(p_engagement_type, 'composite'), v_member)
    RETURNING id INTO v_eng;
    v_created := true;
  END IF;
  FOREACH v_cap IN ARRAY v_caps LOOP
    IF NOT EXISTS (
      SELECT 1 FROM (
        SELECT DISTINCT ON (e.capability) e.action FROM public.engagement_mandate_events e
         WHERE e.engagement_id = v_eng AND e.capability = v_cap ORDER BY e.capability, e.sequence_no DESC
      ) l WHERE l.action = 'GRANT'
    ) THEN
      IF v_reviewer THEN
        PERFORM public.grant_engagement_capability(v_eng, v_cap, 'Selected when the workspace was set up');
      ELSE
        -- A preparer's period setup: the trial balance service only (checked above), recorded with the preparer as actor.
        PERFORM public.assert_capability_available(v_cap);
        INSERT INTO public.engagement_mandate_events (engagement_id, capability, action, sequence_no, actor_member_id, reason)
        VALUES (v_eng, v_cap, 'GRANT', public.next_engagement_sequence(v_eng), v_member, 'Selected when the reporting period was set up');
      END IF;
    END IF;
  END LOOP;
  SELECT COALESCE(array_agg(x.capability ORDER BY x.capability), ARRAY[]::TEXT[]) INTO v_granted FROM (
    SELECT DISTINCT ON (e.capability) e.capability, e.action FROM public.engagement_mandate_events e
     WHERE e.engagement_id = v_eng ORDER BY e.capability, e.sequence_no DESC
  ) x WHERE x.action = 'GRANT';

  RETURN jsonb_build_object('outcome', 'opened', 'engagementId', v_eng, 'periodId', v_period, 'priorPeriodId', v_prior,
                            'periodYear', v_year, 'created', v_created, 'granted', to_jsonb(v_granted));
END;
$function$;
REVOKE ALL ON FUNCTION public.open_engagement_with_period(uuid, date, date, text, text[], text, date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.open_engagement_with_period(uuid, date, date, text, text[], text, date, date, text) TO authenticated;

-- ── Confirm or state the dates of an existing period ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.confirm_period_dates(p_period_id uuid, p_start date, p_end date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE
  v_row    public.fiscal_periods%ROWTYPE;
  v_member UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: an authenticated session is required' USING ERRCODE = '42501';
  END IF;
  IF p_period_id IS NULL OR p_start IS NULL OR p_end IS NULL THEN
    RAISE EXCEPTION 'INVALID: the period and both dates are required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM public.fiscal_periods WHERE id = p_period_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT fm.id INTO v_member FROM public.firm_members fm
   WHERE fm.user_id = auth.uid() AND fm.company_id = v_row.company_id AND fm.accepted_at IS NOT NULL AND public.named_user_access_active(fm.company_id, fm.user_id)
     AND public.workspace_capability_allowed(fm.company_id, fm.user_id, 'prepare_close') LIMIT 1;
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002'; -- no existence leak to non-members
  END IF;
  IF p_start > p_end OR p_end >= p_start + make_interval(months => public.reporting_period_max_months()) THEN
    RAISE EXCEPTION 'INVALID: the dates are not a valid reporting period' USING ERRCODE = '22023';
  END IF;
  IF p_end <> v_row.fiscal_year_end THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'END_DIFFERS_FROM_YEAR_END');
  END IF;
  IF v_row.dates_basis = 'confirmed' AND v_row.reporting_start = p_start AND v_row.reporting_end = p_end THEN
    RETURN jsonb_build_object('outcome', 'confirmed', 'periodId', p_period_id, 'changed', false);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fiscal_periods:' || v_row.company_id::text, 0));
  -- After processing, only complete_legacy_period_dates (review_close, audited, invalidating) may change dates.
  IF public._period_has_processing(p_period_id) THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'PERIOD_LOCKED_BY_PROCESSING', 'periodId', p_period_id);
  END IF;
  BEGIN
    PERFORM set_config('axiom.period_writer', txid_current()::text, true);
    UPDATE public.fiscal_periods
       SET reporting_start = p_start, reporting_end = p_end, dates_basis = 'confirmed', dates_confirmed_by = v_member, dates_confirmed_at = now(), updated_at = now()
     WHERE id = p_period_id;
    PERFORM set_config('axiom.period_writer', '', true);
  EXCEPTION WHEN exclusion_violation THEN
    PERFORM set_config('axiom.period_writer', '', true);
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'PERIOD_OVERLAP');
  END;
  INSERT INTO public.fiscal_period_events (period_id, company_id, action, detail, actor_member_id, actor_user_id)
  VALUES (p_period_id, v_row.company_id, 'dates_confirmed',
          jsonb_build_object('start', p_start, 'end', p_end, 'previous_start', v_row.reporting_start, 'previous_end', v_row.reporting_end, 'previous_basis', v_row.dates_basis),
          v_member, auth.uid());
  RETURN jsonb_build_object('outcome', 'confirmed', 'periodId', p_period_id, 'changed', true);
END;
$function$;
REVOKE ALL ON FUNCTION public.confirm_period_dates(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_period_dates(uuid, date, date) TO authenticated;

-- ── Complete the dates of a legacy period that already has processed history (separate, audited) ─────────────────────
CREATE OR REPLACE FUNCTION public.complete_legacy_period_dates(p_period_id uuid, p_start date, p_end date, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $function$
DECLARE
  v_row      public.fiscal_periods%ROWTYPE;
  v_member   UUID;
  v_changed  BOOLEAN;
  v_op       UUID := gen_random_uuid();
  v_ids      UUID[] := ARRAY[]::UUID[];
  r          RECORD;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'FORBIDDEN: an authenticated session is required' USING ERRCODE = '42501';
  END IF;
  IF p_period_id IS NULL OR p_start IS NULL OR p_end IS NULL THEN
    RAISE EXCEPTION 'INVALID: the period and both dates are required' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 OR length(p_reason) > 500 OR p_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'INVALID: state why these dates are right (10 to 500 characters)' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_row FROM public.fiscal_periods WHERE id = p_period_id;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  SELECT fm.id INTO v_member FROM public.firm_members fm
   WHERE fm.user_id = auth.uid() AND fm.company_id = v_row.company_id AND fm.accepted_at IS NOT NULL AND public.named_user_access_active(fm.company_id, fm.user_id)
     AND public.workspace_capability_allowed(fm.company_id, fm.user_id, 'review_close') LIMIT 1;
  IF v_member IS NULL THEN
    RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002'; -- no existence leak; preparers use confirm_period_dates
  END IF;
  IF p_start > p_end OR p_end >= p_start + make_interval(months => public.reporting_period_max_months()) THEN
    RAISE EXCEPTION 'INVALID: the dates are not a valid reporting period' USING ERRCODE = '22023';
  END IF;
  IF p_end <> v_row.fiscal_year_end THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'END_DIFFERS_FROM_YEAR_END');
  END IF;
  IF v_row.dates_basis = 'confirmed' THEN
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'NOT_A_LEGACY_PERIOD', 'periodId', p_period_id);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fiscal_periods:' || v_row.company_id::text, 0));
  -- The period's trial balances, locked (L4) in a stable order; a check running now is refused, not raced.
  FOR r IN
    SELECT t.id, t.current_engine_run_id FROM public.trial_balance_uploads t
     WHERE t.period_id = p_period_id
        OR (t.period_id IS NULL AND t.company_id = v_row.company_id AND t.period_year = EXTRACT(YEAR FROM v_row.fiscal_year_end)::integer)
     ORDER BY t.id FOR UPDATE
  LOOP
    IF EXISTS (SELECT 1 FROM public.engine_runs er WHERE er.id = r.current_engine_run_id AND er.status = 'running' AND er.lease_expires_at > now()) THEN
      RETURN jsonb_build_object('outcome', 'refused', 'code', 'IN_PROGRESS', 'periodId', p_period_id);
    END IF;
  END LOOP;
  v_changed := v_row.reporting_start IS DISTINCT FROM p_start OR v_row.reporting_end IS DISTINCT FROM p_end;
  BEGIN
    PERFORM set_config('axiom.period_writer', txid_current()::text, true);
    PERFORM set_config('axiom.legacy_period_dates', txid_current()::text, true);
    UPDATE public.fiscal_periods
       SET reporting_start = p_start, reporting_end = p_end, dates_basis = 'confirmed', dates_confirmed_by = v_member, dates_confirmed_at = now(), updated_at = now()
     WHERE id = p_period_id;
    PERFORM set_config('axiom.legacy_period_dates', '', true);
    PERFORM set_config('axiom.period_writer', '', true);
  EXCEPTION WHEN exclusion_violation THEN
    PERFORM set_config('axiom.legacy_period_dates', '', true);
    PERFORM set_config('axiom.period_writer', '', true);
    RETURN jsonb_build_object('outcome', 'refused', 'code', 'PERIOD_OVERLAP');
  END;
  -- Dates that change invalidate every result in force for the period's trial balances (any engine generation).
  IF v_changed THEN
    FOR r IN
      SELECT DISTINCT ON (c.upload_id) c.id, c.company_id, c.upload_id
        FROM public.tb_certifications c
        JOIN public.trial_balance_uploads t ON t.id = c.upload_id
       WHERE t.period_id = p_period_id
          OR (t.period_id IS NULL AND t.company_id = v_row.company_id AND t.period_year = EXTRACT(YEAR FROM v_row.fiscal_year_end)::integer)
       ORDER BY c.upload_id, c.sequence_no DESC
    LOOP
      IF NOT EXISTS (SELECT 1 FROM public.tb_certification_invalidations i WHERE i.certification_id = r.id) THEN
        INSERT INTO public.tb_certification_invalidations (certification_id, company_id, upload_id, reason, operation_id, actor_user_id)
        VALUES (r.id, r.company_id, r.upload_id, 'period_dates_completed', v_op, auth.uid());
        v_ids := v_ids || r.id;
      END IF;
    END LOOP;
  END IF;
  INSERT INTO public.fiscal_period_events (period_id, company_id, action, detail, actor_member_id, actor_user_id)
  VALUES (p_period_id, v_row.company_id, 'legacy_dates_completed',
          jsonb_build_object('start', p_start, 'end', p_end, 'previous_start', v_row.reporting_start, 'previous_end', v_row.reporting_end,
                             'previous_basis', v_row.dates_basis, 'reason', btrim(p_reason), 'operation_id', v_op,
                             'invalidated_certifications', to_jsonb(v_ids)),
          v_member, auth.uid());
  RETURN jsonb_build_object('outcome', 'completed', 'periodId', p_period_id, 'changed', v_changed, 'invalidated', to_jsonb(v_ids));
END;
$function$;
REVOKE ALL ON FUNCTION public.complete_legacy_period_dates(uuid, date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_legacy_period_dates(uuid, date, date, text) TO authenticated;
