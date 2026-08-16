/**
 * comparativeEvidence.ts — Ω∞ public-sector / framework intelligence engine,
 * Slice 7: comparative-period engine (Section XI).
 *
 * Pure contracts + pure resolution logic, READ ONLY — same discipline as
 * every prior slice. Zero Supabase/network I/O; callers supply already-
 * fetched evidence and get back a typed, provenanced result.
 *
 * Scope note (PHASE-0-PUBLIC-SECTOR-REALITY-AUDIT.md §13): a REAL,
 * working comparative engine already exists in this app — `fiscal_periods`
 * + `prior_period_id` chain + `v_period_pairs` view + the
 * `kinga-comparative-engine` edge function (IAS 1 / IPSAS 1-cited). This
 * module does NOT replace or duplicate that — it is the pure CONTRACT layer
 * (evidence-tier hierarchy, explicit KNOWN/MISSING/NOT_APPLICABLE/ZERO
 * states, mapping-drift detection) that a future integration would wire
 * that existing engine through. Duplicating its line-movement/retained-
 * earnings logic here would be exactly the "duplicate authority" Section
 * XXV's gate explicitly checks for.
 */

import type { EvidenceItem, EvidenceSource } from "./entityContext";

// ── Comparative source hierarchy (Section XI) ────────────────────────────────

export type ComparativeSourceTier =
  | "PRIOR_AUDITED_SIGNED_STATEMENTS" // Tier 1 — highest
  | "PRIOR_CERTIFIED_SAFF_CLOSE" // Tier 2
  | "PRIOR_TB_WITH_CONFIRMED_MAPPING" // Tier 3
  | "MANUAL_COMPARATIVE_WITH_PROVENANCE" // Tier 4
  | "UNAVAILABLE"; // Tier 5 — lowest

/**
 * What comparative evidence is actually available for a period, prior to
 * resolving any specific line's amount. Each present key is a ref pointing
 * at the real source (upload id, sign-off id, etc.) — never a boolean flag
 * alone, so the resolver's evidence trail is always traceable (C8).
 */
export interface ComparativeEvidenceAvailability {
  priorAuditedSignedStatements?: { ref: string; detail: string };
  priorCertifiedSaffClose?: { ref: string; detail: string };
  priorTbWithConfirmedMapping?: { ref: string; detail: string };
  manualComparativeWithProvenance?: { ref: string; detail: string };
}

/** Directive Section XI: never require prior TB as a hard prerequisite if audited prior FS exist — this resolver simply picks the highest available tier, in order. */
export function resolveComparativeSourceTier(
  availability: ComparativeEvidenceAvailability,
): ComparativeSourceTier {
  if (availability.priorAuditedSignedStatements) return "PRIOR_AUDITED_SIGNED_STATEMENTS";
  if (availability.priorCertifiedSaffClose) return "PRIOR_CERTIFIED_SAFF_CLOSE";
  if (availability.priorTbWithConfirmedMapping) return "PRIOR_TB_WITH_CONFIRMED_MAPPING";
  if (availability.manualComparativeWithProvenance) return "MANUAL_COMPARATIVE_WITH_PROVENANCE";
  return "UNAVAILABLE";
}

const TIER_TO_EVIDENCE_SOURCE: Record<ComparativeSourceTier, EvidenceSource> = {
  PRIOR_AUDITED_SIGNED_STATEMENTS: "DOCUMENTED_COMPLIANCE_STATEMENT",
  PRIOR_CERTIFIED_SAFF_CLOSE: "PRIOR_PROFESSIONAL_CONFIRMATION",
  PRIOR_TB_WITH_CONFIRMED_MAPPING: "PRIOR_PROFESSIONAL_CONFIRMATION",
  MANUAL_COMPARATIVE_WITH_PROVENANCE: "USER_MANUAL_ENTRY",
  UNAVAILABLE: "UNKNOWN",
};

// ── Comparative amount (C4: explicit KNOWN/MISSING/NOT_APPLICABLE/ZERO) ──────

/**
 * Discriminated union so a MISSING/NOT_APPLICABLE amount structurally has no
 * `value` field to accidentally read as 0 — C4 enforced at the type level,
 * the same pattern Provenance<T> uses in entityContext.ts.
 */
export type ComparativeAmount =
  | { state: "KNOWN"; value: number; source: ComparativeSourceTier; evidence: EvidenceItem[] }
  | { state: "ZERO"; value: 0; source: ComparativeSourceTier; evidence: EvidenceItem[] }
  | { state: "MISSING"; source: ComparativeSourceTier; evidence: EvidenceItem[] }
  | { state: "NOT_APPLICABLE"; evidence: EvidenceItem[] };

export interface ComparativeLineLookup {
  /**
   * Prior-period numeric value for this specific line code, if the resolved
   * tier's source actually contains it. `undefined` means the tier resolved
   * (comparative evidence exists in principle) but this specific line was
   * not found in it — genuinely MISSING, never silently 0.
   */
  find(naturalAccountCode: string): number | undefined;
}

/**
 * Resolve one line's comparative amount. Never fabricates a 0 — an absent
 * lookup result becomes MISSING, not ZERO; an absent tier becomes
 * NOT_APPLICABLE, not MISSING (there's a real difference: MISSING means
 * "we have a comparative source but this line isn't in it"; NOT_APPLICABLE
 * means "we have no comparative source for this period at all").
 */
export function resolveComparativeAmount(
  naturalAccountCode: string,
  tier: ComparativeSourceTier,
  lookup: ComparativeLineLookup,
  sourceRef: string,
): ComparativeAmount {
  const evidenceSource = TIER_TO_EVIDENCE_SOURCE[tier];

  if (tier === "UNAVAILABLE") {
    return {
      state: "NOT_APPLICABLE",
      evidence: [
        {
          source: "UNKNOWN",
          detail: "No comparative source (audited FS, certified close, prior TB, or manual figure) is available for this period.",
        },
      ],
    };
  }

  const found = lookup.find(naturalAccountCode);

  if (found === undefined) {
    return {
      state: "MISSING",
      source: tier,
      evidence: [
        {
          source: evidenceSource,
          detail: `Comparative source tier '${tier}' is available (ref: ${sourceRef}), but natural account code '${naturalAccountCode}' was not found in it.`,
          ref: sourceRef,
        },
      ],
    };
  }

  if (found === 0) {
    return {
      state: "ZERO",
      value: 0,
      source: tier,
      evidence: [
        {
          source: evidenceSource,
          detail: `Comparative source tier '${tier}' (ref: ${sourceRef}) reports a genuine zero balance for '${naturalAccountCode}'.`,
          ref: sourceRef,
        },
      ],
    };
  }

  return {
    state: "KNOWN",
    value: found,
    source: tier,
    evidence: [
      {
        source: evidenceSource,
        detail: `Comparative source tier '${tier}' (ref: ${sourceRef}).`,
        ref: sourceRef,
      },
    ],
  };
}

// ── Mapping drift (Section XI: surface, never silently accept or block) ─────

export interface PeriodMappingSnapshot {
  periodLabel: string;
  naturalAccountCode: string;
  presentationCode: string;
}

export interface MappingDriftFlag {
  naturalAccountCode: string;
  priorPeriodLabel: string;
  priorPresentationCode: string;
  currentPeriodLabel: string;
  currentPresentationCode: string;
  message: string;
}

/**
 * Flags accounts whose presentation changed between two periods. Per
 * Section XI: "Do not automatically block if legitimate; require
 * evidence/reason" — this function only detects and reports, it never
 * throws or blocks. What the caller does with a flag (require a reason,
 * warn, etc.) is a UI/workflow decision outside this pure module.
 */
export function detectMappingDrift(
  prior: PeriodMappingSnapshot[],
  current: PeriodMappingSnapshot[],
): MappingDriftFlag[] {
  const priorByCode = new Map(prior.map((p) => [p.naturalAccountCode, p]));
  const flags: MappingDriftFlag[] = [];

  for (const cur of current) {
    const priorEntry = priorByCode.get(cur.naturalAccountCode);
    if (priorEntry && priorEntry.presentationCode !== cur.presentationCode) {
      flags.push({
        naturalAccountCode: cur.naturalAccountCode,
        priorPeriodLabel: priorEntry.periodLabel,
        priorPresentationCode: priorEntry.presentationCode,
        currentPeriodLabel: cur.periodLabel,
        currentPresentationCode: cur.presentationCode,
        message:
          `Presentation changed from prior audited period: ${priorEntry.periodLabel} account ` +
          `'${cur.naturalAccountCode}' was classified '${priorEntry.presentationCode}', ` +
          `${cur.periodLabel} attempts '${cur.presentationCode}'.`,
      });
    }
  }

  return flags;
}

// ── Presence changes (real-data case: an account exists in one period, not the other) ─

export interface PresenceChange {
  naturalAccountCode: string;
  change: "NEW_THIS_PERIOD" | "ABSENT_THIS_PERIOD";
}

/**
 * An account absent from the current period does NOT mean its prior balance
 * was zero (C4) — it means the account simply doesn't appear this period
 * (closed, reclassified to a different code, or genuinely inactive). Same
 * for a new account with no prior: it has no comparative figure at all,
 * which is NOT_APPLICABLE, never a fabricated 0.
 */
export function detectPresenceChanges(
  priorCodes: string[],
  currentCodes: string[],
): PresenceChange[] {
  const priorSet = new Set(priorCodes);
  const currentSet = new Set(currentCodes);
  const changes: PresenceChange[] = [];

  for (const code of currentSet) {
    if (!priorSet.has(code)) changes.push({ naturalAccountCode: code, change: "NEW_THIS_PERIOD" });
  }
  for (const code of priorSet) {
    if (!currentSet.has(code)) changes.push({ naturalAccountCode: code, change: "ABSENT_THIS_PERIOD" });
  }

  return changes;
}
