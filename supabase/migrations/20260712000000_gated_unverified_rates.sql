-- Migration: 20260712000000_gated_unverified_rates.sql
-- PURPOSE: Register three rate placeholders in statutory_rules whose primary-source
--          citations are unresolved. verified_at = NULL intentionally — the
--          enforce_verified_statutory_rule trigger will BLOCK any engine from using
--          these rows until a human sets verified_at with a confirmed ITA citation.
-- STOP: Do not set verified_at on any of these rows until the specific ITA provision,
--       rate, and R.E.2023 page reference are confirmed against the primary source text.
--
-- SCHEMA NOTE: chk_rate_or_threshold previously required every row to carry a
-- real rate-bearing value (rate_is_threshold=true, rate_pct, or flat_tax_tzs)
-- regardless of verification status — a genuinely unverified, rate-pending
-- placeholder (all three fields NULL) could not exist at all. The constraint
-- is widened below to also accept verified_at IS NULL, so a registered-but-
-- unconfirmed rule can be recorded without fabricating a rate. Once verified_at
-- is set non-NULL, the constraint still requires a real rate-bearing value —
-- a verified rule with no rate remains rejected, so this does not weaken
-- verified-rule enforcement. These three rows also remain blocked from
-- findings-engine consumption until a human sets verified_at, via the
-- pre-existing enforce_verified_statutory_rule trigger and the findings
-- engine's own verified_at IS NOT NULL query filter — neither of which is
-- touched by this migration.

ALTER TABLE public.statutory_rules
  DROP CONSTRAINT chk_rate_or_threshold;

ALTER TABLE public.statutory_rules
  ADD CONSTRAINT chk_rate_or_threshold
  CHECK (
    verified_at IS NULL
    OR rate_is_threshold = TRUE
    OR rate_pct IS NOT NULL
    OR flat_tax_tzs IS NOT NULL
  );

INSERT INTO public.statutory_rules (
  trigger_category,
  statute,
  obligation,
  rate_pct,
  threshold_amount,
  rate_is_threshold,
  jurisdiction,
  industry_pack,
  effective_from,
  effective_to,
  verified_at,
  verified_by,
  notes
) VALUES
(
  'min_tax',
  'Income Tax Act Cap.332 First Schedule para 3(3)',
  'Alternative Minimum Tax: 1% of turnover when entity has unrelieved losses in current and preceding 2 years. Exempt: agriculture, health, education, tea processing.',
  NULL,  -- rate_pct: NULL — GATED pending primary-source verification
  NULL,  -- threshold_amount: NULL — GATED
  false,
  'TZ',
  'general',
  '2024-07-01',
  NULL,
  NULL,  -- verified_at: NULL — must not be set until primary source confirmed
  NULL,  -- verified_by: NULL
  'GATED pending primary-source verification — see kinga-tax-engine gating diff 2026-07-12. ' ||
  'Rate commonly cited as 1% of turnover but ITA section reference unconfirmed: engine used ' ||
  '"First Schedule para 3(3)"; original query used "s.65" — discrepancy unresolved. ' ||
  'Do NOT set verified_at until exact ITA provision and rate are confirmed against current R.E.2023 text.'
),
(
  'thin_cap',
  'Income Tax Act Cap.332 s.12(2)',
  'Thin capitalisation: interest disallowance on debt exceeding 7:3 debt-to-equity ratio for exempt-controlled resident entities (25%+ non-resident/exempt ownership). Local bank debt excluded by s.12(5)(ii).',
  NULL,  -- rate_pct: NULL — GATED pending primary-source verification
  NULL,  -- threshold_amount: NULL — GATED
  false,
  'TZ',
  'general',
  '2024-07-01',
  NULL,
  NULL,  -- verified_at: NULL
  NULL,  -- verified_by: NULL
  'GATED pending primary-source verification — see kinga-tax-engine gating diff 2026-07-12. ' ||
  'Ratio commonly cited as 7:3 (2.333:1) per ITA s.12(2) R.E.2023. ' ||
  'Engine previously carried s.24A reference which does not exist in ITA Cap.332 — corrected to s.12(2). ' ||
  'Do NOT set verified_at until exact ratio confirmed against current R.E.2023 text and FA2026 reviewed for amendments.'
),
(
  'mgmt_fee_cap',
  'Income Tax Act Cap.332 s.33',
  'Management and professional fee cap: fees paid to foreign related parties deductible only up to specified percentage of gross income.',
  NULL,  -- rate_pct: NULL — GATED pending primary-source verification
  NULL,  -- threshold_amount: NULL — GATED
  false,
  'TZ',
  'general',
  '2024-07-01',
  NULL,
  NULL,  -- verified_at: NULL
  NULL,  -- verified_by: NULL
  'GATED pending primary-source verification — see kinga-tax-engine gating diff 2026-07-12. ' ||
  'Rate disputed: engine used 1% of gross income citing ITA Cap.332 R.E.2023; some summaries cite 2%. ' ||
  'Engine comment stated "A 2% figure circulates in some summaries but the Act specifies 1%" — unverified claim. ' ||
  'Do NOT set verified_at until rate confirmed against ITA s.33 R.E.2023 primary source text.'
)
ON CONFLICT (trigger_category, jurisdiction, industry_pack)
  WHERE effective_to IS NULL
DO NOTHING;
