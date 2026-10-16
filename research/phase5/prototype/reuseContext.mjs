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
 *   - COMPATIBLE: every applicable field is verified equal ⇒ reuse may be PROPOSED.
 *   - UNVERIFIED: an applicable field is missing on one side or otherwise cannot be confirmed ⇒ REOPEN for explicit
 *     confirmation. (A field absent on BOTH sides is consistent absence — "not applicable" — not an unverifiable context.)
 *   - INCOMPATIBLE: an applicable field is present on both sides and DIFFERS (a known change) ⇒ REOPEN.
 * Returns { state, blocking[], reopen[], notApplicable[], period }. `period` is advisory (mappings reuse across periods by
 * design) — recorded, never a reuse blocker.
 */
export function contextCompatible(priorCtx, nowCtx) {
  const blocking = [], reopen = [], notApplicable = [];
  // Entity is natively enforced by the RPC (UPLOAD_COMPANY_MISMATCH + company-scoped account_mappings); a mismatch is fatal.
  if (priorCtx.entity == null || nowCtx.entity == null) reopen.push("entity");
  else if (priorCtx.entity !== nowCtx.entity) blocking.push("ENTITY_CHANGED");

  // An applicable field: absent-on-both = not applicable (consistent); present-both-equal = ok; present-both-differ =
  // a KNOWN change (blocking/reopen); present-on-one-side-only = cannot confirm ⇒ reopen for explicit confirmation.
  const field = (name, priorV, nowV, changeCode) => {
    const pHas = priorV != null, nHas = nowV != null;
    if (!pHas && !nHas) { notApplicable.push(name); return; }
    if (pHas && nHas) { if (priorV !== nowV) blocking.push(changeCode); return; }
    reopen.push(name);                                  // present on one side only — context cannot be confirmed
  };
  field("currency", priorCtx.currency, nowCtx.currency, "CURRENCY_CHANGED");
  field("dimensions", priorCtx.dimensions, nowCtx.dimensions, "DIMENSION_AXES_CHANGED");
  field("rulesetVersion", priorCtx.rulesetVersion, nowCtx.rulesetVersion, "MAPPING_RULESET_VERSION_CHANGED");
  // Period is advisory only: recorded for confirmation, never a reuse blocker (a reusable chart treatment spans periods).
  const period = { prior: priorCtx.period ?? null, now: nowCtx.period ?? null };

  const state = blocking.length > 0 ? "INCOMPATIBLE" : reopen.length > 0 ? "UNVERIFIED" : "COMPATIBLE";
  return { state, compatible: state === "COMPATIBLE", blocking, reopen, notApplicable, period };
}
