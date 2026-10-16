// Phase 5 prototype — REUSE CONTEXT: reuse compatibility is MORE than a file-hash match.
//
// A prior accepted decision is reusable for a later upload only when the full accounting CONTEXT is compatible, not merely
// when the two files share bytes (they never will) or an account_key. This module models the context the directive requires
// us to confirm: entity, period, currency, dimensions, mapping/ruleset version — and, honestly, which of those the LIVE
// schema actually tracks today versus which are a documented Phase 6 gap.
//
// HONEST SCHEMA REALITY (verified against supabase/migrations):
//   - account_mappings is keyed ONLY on (company_id, account_key) — a GENERATED column COALESCE(account_code, normalized
//     name). It carries NO period, NO currency, NO dimension axis, NO ruleset-version column. So production reuse is, today,
//     entity + account_key only.
//   - Therefore period/currency/dimensions/ruleset compatibility CANNOT be enforced by the live RPC; this module models the
//     richer binding and DISCLOSES which fields it could not independently verify. UNKNOWN is never coerced to "equal":
//     a null currency on either side is reported as UNVERIFIED, never assumed to match and never fabricated as a mismatch.

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
 * Compare a prior decision's recorded context with the current upload's context.
 * Returns { compatible, blocking[], unverified[] }:
 *   - blocking: a KNOWN, material difference that makes reuse unsafe (entity/currency/dimensions/ruleset changed).
 *   - unverified: a field that could not be compared because the live schema does not track it (null on either side).
 * `compatible` is true only when there is NO blocking difference; unverified fields are disclosed, not treated as a mismatch.
 */
export function contextCompatible(priorCtx, nowCtx) {
  const blocking = [], unverified = [];
  // Entity is natively enforced by the RPC (UPLOAD_COMPANY_MISMATCH + company-scoped account_mappings); a mismatch is fatal.
  if (priorCtx.entity == null || nowCtx.entity == null) unverified.push("entity");
  else if (priorCtx.entity !== nowCtx.entity) blocking.push("ENTITY_CHANGED");

  const pair = (field, priorV, nowV, code) => {
    if (priorV == null || nowV == null) unverified.push(field);
    else if (priorV !== nowV) blocking.push(code);
  };
  pair("currency", priorCtx.currency, nowCtx.currency, "CURRENCY_CHANGED");
  pair("dimensions", priorCtx.dimensions, nowCtx.dimensions, "DIMENSION_AXES_CHANGED");
  pair("rulesetVersion", priorCtx.rulesetVersion, nowCtx.rulesetVersion, "MAPPING_RULESET_VERSION_CHANGED");
  // Period is CONFIRMED and recorded but is intentionally NOT a reuse blocker: a mapping is reused across periods by design
  // (that is the point of a reusable chart treatment). It is surfaced for confirmation, never silently ignored.
  if (priorCtx.period == null || nowCtx.period == null) unverified.push("period");

  return { compatible: blocking.length === 0, blocking, unverified };
}
