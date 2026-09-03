/**
 * detectEntityContext.ts — Ω∞ public-sector / framework intelligence engine,
 * Slice 2: framework/source-system detection, READ ONLY.
 *
 * Pure function. Takes already-fetched data as plain input — performs no
 * Supabase I/O itself — and returns a proposed EntityAccountingContext with
 * full provenance (C8). Writes NOTHING: no DB mutation, no auto-classification,
 * no confirmation is ever silently assumed. Wiring this into an actual
 * save/confirm UI flow is a later slice (17+).
 *
 * Scope discipline (per PHASE-0-PUBLIC-SECTOR-REALITY-AUDIT.md): today the
 * ONLY real, live signal for reporting framework is
 * companies.reporting_framework — a single manual dropdown, sole writer
 * CompanyManager.tsx, NOT NULL DEFAULT 'ifrs_for_smes'. There is no
 * source-system detector, no MUSE/GFS rule registry, and no audited-mapping
 * memory table yet (those are Slices 4 and 12). Rather than inventing
 * speculative pattern-matching rules not grounded in anything real, this
 * slice builds the evidence-ladder PIPELINE and wires in exactly the
 * evidence that exists today — every other dimension returns UNKNOWN/NONE
 * until its real evidence source ships in a later slice. That is a
 * deliberate, honest scope boundary, not an oversight.
 */

import {
  emptyEntityAccountingContext,
  type EntityAccountingContext,
  type Provenance,
  type ReportingFramework,
  type AccountingBasis,
} from "./entityContext";
import {
  fromCompanyReportingFrameworkDbValue,
  type CompanyReportingFrameworkDbValue,
} from "./frameworkAdapter";

// ── Input contract ────────────────────────────────────────────────────────────

/**
 * Everything this detector is allowed to look at. Deliberately narrow — only
 * fields genuinely read elsewhere in the app today (useWorkspaceData.ts
 * WorkspaceCompany, CompanyManager.tsx). No Supabase client, no network
 * calls: the caller fetches, this function only decides.
 */
export interface DetectionInput {
  jurisdiction?: string;
  /** Raw companies.reporting_framework DB value, exactly as stored today. */
  companyReportingFrameworkDbValue: string | null | undefined;
  /**
   * Forward-compatible hook for Slice 12 (audited mapping memory): when a
   * prior professional confirmation exists, pass it here and it wins over
   * the raw DB value at HIGH confidence. Always undefined today — no store
   * exists yet to read this from.
   */
  priorConfirmedFramework?: {
    framework: ReportingFramework;
    accountingBasis: AccountingBasis;
    confirmedBy: string;
    confirmedAt: string;
    evidenceDetail: string;
  };
}

// ── Detection ──────────────────────────────────────────────────────────────────

/**
 * Detect (never silently decide) the EntityAccountingContext for a company.
 * Every returned dimension carries real provenance — nothing here upgrades a
 * weak signal to HIGH confidence. Downstream UI (Slice 17) is responsible for
 * turning LOW/MEDIUM confidence into an actual confirmation prompt — see
 * confirmationPosture.ts.
 */
export function detectEntityAccountingContext(
  input: DetectionInput,
): EntityAccountingContext {
  const ctx = emptyEntityAccountingContext(input.jurisdiction ?? "UNKNOWN");

  ctx.reportingFramework = detectReportingFramework(input);
  ctx.accountingBasis = detectAccountingBasis(input, ctx.reportingFramework);

  // entityClass, ownershipClass, sourceSystem: deliberately NOT inferred
  // here (C1/C4). No real evidence source exists yet for any of them
  // (audit §1, §3, §16) — returning anything but UNKNOWN would be exactly
  // the "weak lexical signal treated as authority" failure mode Section
  // XVIII prohibits. They stay at emptyEntityAccountingContext's UNKNOWN/
  // NONE default until a later slice adds a real evidence source for each.

  return ctx;
}

function detectReportingFramework(input: DetectionInput): Provenance<ReportingFramework> {
  // Tier 2 (Section III): prior professional confirmation, if supplied.
  if (input.priorConfirmedFramework) {
    const p = input.priorConfirmedFramework;
    return {
      value: p.framework,
      confidence: "HIGH",
      source: "PRIOR_PROFESSIONAL_CONFIRMATION",
      evidence: [{ source: "PRIOR_PROFESSIONAL_CONFIRMATION", detail: p.evidenceDetail }],
      confirmedBy: p.confirmedBy,
      confirmedAt: p.confirmedAt,
    };
  }

  // Tier 3 (Section III): configured engagement context.
  const pair = fromCompanyReportingFrameworkDbValue(input.companyReportingFrameworkDbValue);
  if (!pair) {
    // Absent or outside the known CHECK constraint — genuinely unknown.
    return { value: "UNKNOWN", confidence: "NONE", source: "UNKNOWN", evidence: [] };
  }

  const dbValue = input.companyReportingFrameworkDbValue as CompanyReportingFrameworkDbValue;

  if (dbValue === "ifrs_for_smes") {
    // Phase 1 (SAFF V5 PART IX, reconciled 2026-09-03): companies.reporting_
    // framework no longer has a schema default going forward (migration
    // 20260903100000_companies_reporting_framework_no_default.sql) — a NEW
    // company now persists null until a value is actually chosen, which
    // already hits the `!pair` UNKNOWN/NONE branch above, unchanged.
    // This branch remains, unchanged, for a real reason: existing rows
    // created before that migration may still hold the historical default
    // value, and Phase 1's correction is prospective only (we cannot
    // reconstruct past user intent — see the migration's own header). For
    // those rows, "deliberately IFRS for SMEs" and "never touched the old
    // default" remain genuinely indistinguishable, so LOW confidence is
    // still the honest signal, not a bug to fix here.
    return {
      value: pair.framework,
      confidence: "LOW",
      source: "CONFIGURED_ENGAGEMENT_CONTEXT",
      evidence: [
        {
          source: "CONFIGURED_ENGAGEMENT_CONTEXT",
          detail:
            "companies.reporting_framework equals 'ifrs_for_smes', which was this " +
            "column's schema default before Phase 1 removed it — may reflect a " +
            "deliberate historical choice or may simply have been untouched at the " +
            "time. Do not present as professionally confirmed.",
        },
      ],
    };
  }

  // Any non-default value (full_ifrs, ipsas_accrual, ipsas_cash) can only
  // exist because a preparer actively changed the CompanyManager.tsx
  // dropdown — confirmed sole writer of this column (audit §2). Deliberate,
  // but not yet backed by documentary/audited-FS evidence, so MEDIUM not HIGH.
  return {
    value: pair.framework,
    confidence: "MEDIUM",
    source: "USER_MANUAL_ENTRY",
    evidence: [
      {
        source: "USER_MANUAL_ENTRY",
        detail: `companies.reporting_framework explicitly set to '${dbValue}' via CompanyManager (non-default value).`,
      },
    ],
  };
}

function detectAccountingBasis(
  input: DetectionInput,
  frameworkProvenance: Provenance<ReportingFramework>,
): Provenance<AccountingBasis> {
  if (input.priorConfirmedFramework) {
    const p = input.priorConfirmedFramework;
    return {
      value: p.accountingBasis,
      confidence: "HIGH",
      source: "PRIOR_PROFESSIONAL_CONFIRMATION",
      evidence: [{ source: "PRIOR_PROFESSIONAL_CONFIRMATION", detail: p.evidenceDetail }],
      confirmedBy: p.confirmedBy,
      confirmedAt: p.confirmedAt,
    };
  }

  const pair = fromCompanyReportingFrameworkDbValue(input.companyReportingFrameworkDbValue);
  if (!pair) {
    return { value: "UNKNOWN", confidence: "NONE", source: "UNKNOWN", evidence: [] };
  }

  // accountingBasis inherits the SAME confidence/source/evidence as the
  // framework determination it was derived alongside — they came from
  // identical evidence, so claiming different confidence for one vs the
  // other would misrepresent that evidence (C8).
  return {
    value: pair.accountingBasis,
    confidence: frameworkProvenance.confidence,
    source: frameworkProvenance.source,
    evidence: frameworkProvenance.evidence,
    confirmedBy: frameworkProvenance.confirmedBy,
    confirmedAt: frameworkProvenance.confirmedAt,
  };
}
