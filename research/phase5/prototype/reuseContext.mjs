// Phase 5 prototype — REUSE CONTEXT: reuse compatibility is MORE than a file-hash match.
//
// A prior accepted decision is reusable for a later upload only when the full accounting CONTEXT is compatible, not merely
// when the two files share bytes (they never will) or an account_key. This module models the context the directive requires
// us to confirm: entity, period, currency, dimensions, mapping/ruleset version — and, honestly, which of those the LIVE
// schema actually tracks today versus which are a documented Phase 6 gap.
//
// HONEST SCHEMA REALITY (verified against supabase/migrations):
//   - account_mappings is keyed ONLY on (company_id, account_key) — a GENERATED column COALESCE(account_code, normalized
//     name). It carries NO currency/period/dimension/ruleset column, and the write RPC does not compare context, so TODAY
//     reuse through resolve_account_review_batch is entity + account_key only.
//   - BUT currency and period ARE authoritative elsewhere: fiscal_periods.reporting_currency (FK to currency_registry, no
//     TZS fallback) + explicit dates, reached from an upload via trial_balance_uploads.period_id (20260630100000 /
//     20261009100000). So a Phase 6 reuse-compatibility check can READ currency + period from real authority — they are
//     NOT a schema gap. The genuine remaining gaps are narrower: (a) BINDING the accepting context onto the decision ledger
//     so reuse can compare it, (b) a dimension axis, (c) a ruleset-version axis. See INTERFACE §9 gap #4.
//   - This module models the richer binding and DISCLOSES which fields it could not verify. UNKNOWN is never coerced to
//     "equal": a null field on either side is reported as UNVERIFIED, never assumed to match and never fabricated as a mismatch.

/** Normalize a dimension signature (the set of dimension axis names captured at ingestion) to a stable string. */
export function dimensionSignature(dims) {
  if (dims == null) return null;
  const axes = Array.isArray(dims) ? dims : Object.keys(dims);
  if (axes.length === 0) return "";
  return [...axes].map((d) => String(d).toLowerCase().trim()).sort().join("|");
}

/** The reuse context of an upload. Missing fields are null = UNKNOWN (never assumed, never zero). */
export function reuseContextOf(upload) {
  return {
    entity: upload.company_id ?? null,
    period: upload.period_year ?? null,
    currency: upload.currency ?? null,
    dimensions: dimensionSignature(upload.dimensions_signature ?? upload.dimensions ?? null),
    rulesetVersion: upload.ruleset_version ?? null,
    uploadVersion: upload.upload_version ?? null,
  };
}

/**
 * Compare a prior decision's recorded context with the current upload's context, implementing the Phase 6 first-slice
 * REUSE RULE as three explicit states (never a silent inherit from company_id + account_key alone):
 *   - COMPATIBLE: every relevant field is verified equal (or explicitly NOT APPLICABLE) ⇒ reuse may be PROPOSED.
 *   - UNVERIFIED: a relevant field is UNKNOWN — absent on one side, OR absent on BOTH with no authoritative rule declaring
 *     it not-applicable ⇒ REOPEN for explicit confirmation.
 *   - INCOMPATIBLE: a relevant field is present on both sides and DIFFERS (a known change) ⇒ REOPEN.
 *
 * CRITICAL (per the directive): UNKNOWN ≠ EQUAL ≠ MISMATCH ≠ NOT APPLICABLE. "Absent on both sides" is **UNKNOWN**
 * (requires renewed confirmation) UNLESS an explicit, authoritative rule establishes the field is NOT APPLICABLE for this
 * engagement. `notApplicable` carries those authoritative declarations (e.g. a non-dimensional single-entity engagement
 * explicitly declaring `dimensions` N/A). currency is NEVER declarable N/A — fiscal_periods.reporting_currency is required,
 * so an absent currency is genuinely unknown.
 *
 * Returns { state, blocking[], reopen[], notApplicable[], period }. `period` is advisory via an authoritative rule
 * (mappings reuse across periods by design) — recorded, never a reuse blocker.
 */
const NEVER_NOT_APPLICABLE = new Set(["currency", "entity"]);
export function contextCompatible(priorCtx, nowCtx, notApplicable = new Set()) {
  const na = notApplicable instanceof Set ? notApplicable : new Set(notApplicable || []);
  const blocking = [], reopen = [], declaredNA = [];
  // Entity is natively enforced by the RPC (UPLOAD_COMPANY_MISMATCH + company-scoped account_mappings); a mismatch is fatal;
  // an absent entity is UNKNOWN, never not-applicable.
  if (priorCtx.entity == null || nowCtx.entity == null) reopen.push("entity");
  else if (priorCtx.entity !== nowCtx.entity) blocking.push("ENTITY_CHANGED");

  // present-both-equal = ok; present-both-differ = KNOWN change (incompatible); present-one-side-only = UNKNOWN (reopen);
  // absent-both = UNKNOWN (reopen) UNLESS an explicit authoritative rule declares the field NOT APPLICABLE.
  const field = (name, priorV, nowV, changeCode) => {
    const pHas = priorV != null, nHas = nowV != null;
    if (pHas && nHas) { if (priorV !== nowV) blocking.push(changeCode); return; }
    if (!pHas && !nHas) {
      if (na.has(name) && !NEVER_NOT_APPLICABLE.has(name)) { declaredNA.push(name); return; }
      reopen.push(name);                                // absent on both, not authoritatively N/A ⇒ UNKNOWN ⇒ reopen
      return;
    }
    reopen.push(name);                                  // present on one side only ⇒ UNKNOWN ⇒ reopen
  };
  field("currency", priorCtx.currency, nowCtx.currency, "CURRENCY_CHANGED");
  field("dimensions", priorCtx.dimensions, nowCtx.dimensions, "DIMENSION_AXES_CHANGED");
  field("rulesetVersion", priorCtx.rulesetVersion, nowCtx.rulesetVersion, "MAPPING_RULESET_VERSION_CHANGED");
  // Period is advisory via an authoritative rule: recorded for confirmation, never a reuse blocker (treatments span periods).
  const period = { prior: priorCtx.period ?? null, now: nowCtx.period ?? null };

  const state = blocking.length > 0 ? "INCOMPATIBLE" : reopen.length > 0 ? "UNVERIFIED" : "COMPATIBLE";
  return { state, compatible: state === "COMPATIBLE", blocking, reopen, notApplicable: declaredNA, period };
}
