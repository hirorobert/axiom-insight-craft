/**
 * comparativePeriodAdapter.ts — Ω∞ Phase 4 Slice 1: comparative period adapter.
 *
 * PURE FUNCTIONS ONLY. No Supabase, no DB, no network, no timestamps, no
 * random ids. Reuses the certified comparativeEvidence.ts contracts
 * (ComparativeEvidenceAvailability, ComparativeLineLookup,
 * resolveComparativeSourceTier, resolveComparativeAmount,
 * detectMappingDrift, detectPresenceChanges) without redefining any of
 * them.
 *
 * Certified by the Phase 4 Contract Gate: `v_period_pairs`
 * (supabase/migrations/20260630100000_phase5a_period_registry.sql) proves
 * ONLY that a prior-period relationship exists — it proves nothing about
 * comparative source authority (no audit-opinion metadata, no join to
 * statement_sign_offs or tb_certifications exists in that view). This
 * module therefore keeps three concerns structurally separate:
 *
 *   1. PeriodPairFacts       — safe to build directly from a v_period_pairs row.
 *   2. ComparativeSourceAuthorityFacts — caller-resolved, already-proven
 *      facts (from separately-queried statement_sign_offs /
 *      tb_certifications). Never inferred from a period or upload id alone.
 *   3. ComparativeLineRow[]  — raw comparative line data, validated and
 *      deduplicated here, fail-closed.
 *
 * Two source tiers are deliberately unreachable through this adapter:
 *   - priorAuditedSignedStatements: no repository infrastructure proves an
 *     independent audit occurred (statement_sign_offs is an internal
 *     Preparer/Reviewer/Approver chain, not an audit opinion).
 *   - manualComparativeWithProvenance: no table or mechanism for manual
 *     comparative entry exists anywhere in this repository today.
 * Neither field exists on ComparativeSourceAuthorityFacts or is settable
 * through buildComparativeEvidenceAvailability -- this is enforced by the
 * type shape itself, not by runtime discipline alone.
 */

import type { ComparativeEvidenceAvailability, ComparativeLineLookup } from "./comparativeEvidence";

// ── Period pairing facts (safe: proves only that a period pairing exists) ──

/** Minimum subset of a real v_period_pairs row this adapter actually needs. */
export interface PeriodPairRow {
  current_period_id: string;
  company_id: string;
  prior_period_id: string | null;
  prior_label: string | null;
  prior_year_end: string | null;
}

export interface PeriodPairFacts {
  currentPeriodId: string;
  companyId: string;
  priorPeriodId: string | null;
  priorPeriodLabel: string | null;
  priorYearEnd: string | null;
}

/**
 * Translates a v_period_pairs row into PeriodPairFacts. Establishes period
 * RELATIONSHIP facts only -- never a comparative evidence tier.
 * `prior_period_id !== null` (or a non-null active_upload_id, which this
 * shape doesn't even carry) must never be read by a caller as proof of
 * audited statements, certified close, confirmed mapping, or manual
 * provenance; those are separate, independently-provable facts (see
 * ComparativeSourceAuthorityFacts below).
 */
export function fromPeriodPairRow(row: PeriodPairRow): PeriodPairFacts {
  return {
    currentPeriodId: row.current_period_id,
    companyId: row.company_id,
    priorPeriodId: row.prior_period_id,
    priorPeriodLabel: row.prior_label,
    priorYearEnd: row.prior_year_end,
  };
}

// ── Comparative source authority facts (caller-resolved, never inferred) ───

/**
 * Only the two tiers this repository can currently prove. Each field must
 * be populated by the caller from its OWN already-resolved, separately
 * queried evidence (statement_sign_offs.status = 'locked' for
 * priorStatementsLocked; tb_certifications.is_blocking = false AND
 * requires_review = false for priorCertificationNonBlocking) -- never
 * derived inside this pure module, which has no DB access at all.
 */
export interface ComparativeSourceAuthorityFacts {
  priorStatementsLocked?: { ref: string; detail: string };
  priorCertificationNonBlocking?: { ref: string; detail: string };
}

/**
 * Builds the certified ComparativeEvidenceAvailability shape from
 * already-proven authority facts only. priorAuditedSignedStatements and
 * manualComparativeWithProvenance are never set -- there is no field on
 * ComparativeSourceAuthorityFacts to source them from.
 */
export function buildComparativeEvidenceAvailability(
  authority: ComparativeSourceAuthorityFacts,
): ComparativeEvidenceAvailability {
  return {
    priorCertifiedSaffClose: authority.priorStatementsLocked,
    priorTbWithConfirmedMapping: authority.priorCertificationNonBlocking,
  };
}

// ── Comparative line lookup (fail closed on malformed/duplicate input) ─────

export interface ComparativeLineRow {
  naturalAccountCode: string;
  amount: number;
}

/**
 * Builds a ComparativeLineLookup from raw rows. naturalAccountCode is the
 * existing certified Phase 4 identity contract (the same key
 * detectMappingDrift/detectPresenceChanges already use) -- reused, not
 * reinvented. This does NOT establish economic continuity across a code
 * change; a genuine split/merge/remapping remains unsupported and
 * surfaces honestly through the existing presence-change functions rather
 * than being silently merged or guessed here.
 *
 * Fails closed, deterministically, on construction (not on lookup) for:
 *   - a non-finite amount (NaN/Infinity/-Infinity/non-number) -- bad
 *     evidence must never silently become MISSING evidence.
 *   - a duplicate naturalAccountCode -- no repository semantics authorize
 *     picking first/last, summing, or averaging duplicates.
 */
export function lineLookupFromRows(rows: ComparativeLineRow[]): ComparativeLineLookup {
  const byCode = new Map<string, number>();

  for (const row of rows) {
    if (typeof row.amount !== "number" || !Number.isFinite(row.amount)) {
      throw new Error(
        `comparativePeriodAdapter: non-finite amount for natural account code '${row.naturalAccountCode}' (received: ${String(row.amount)}). Bad evidence must not silently become MISSING evidence.`,
      );
    }
    if (byCode.has(row.naturalAccountCode)) {
      throw new Error(
        `comparativePeriodAdapter: duplicate natural account code '${row.naturalAccountCode}' in comparative line rows. Repository semantics do not authorize picking first/last, summing, or discarding duplicates.`,
      );
    }
    byCode.set(row.naturalAccountCode, row.amount);
  }

  return {
    find(naturalAccountCode: string): number | undefined {
      return byCode.get(naturalAccountCode);
    },
  };
}
