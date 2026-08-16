/**
 * mappingMemory.ts — Ω∞ public-sector / framework intelligence engine,
 * Slice 12: audited mapping memory (Section XV).
 *
 * Pure contracts + pure selection logic, READ ONLY — no Supabase I/O. The
 * actual persistence is `account_mapping_memory`
 * (supabase/migrations/20260811000000_account_mapping_memory.sql), an
 * append-only table this session could not apply (no live DB access this
 * session — see Task #106 history). This module is usable and testable
 * regardless of whether that migration has been applied yet; the edge
 * function that would write real rows is a separate, later integration.
 *
 * Mirrors the migration's columns 1:1 (camelCase here, snake_case there) so
 * there is exactly one schema, described in two places, never two designs.
 */

import type {
  AccountNature,
  IpsasPresentationCode,
} from "./museIpsasRulePack";
import type { EvidenceSource, ReportingFramework, SourceSystem } from "./entityContext";

// ── Section XV's priority evidence ladder ────────────────────────────────────

export type AuditStatus =
  | "cag_external_audited" // Tier 1 — highest
  | "saff_professionally_approved" // Tier 2
  | "user_approved_current" // Tier 3
  | "system_rule"; // Tier 4 — lowest

const AUDIT_STATUS_PRIORITY: Record<AuditStatus, number> = {
  cag_external_audited: 4,
  saff_professionally_approved: 3,
  user_approved_current: 2,
  system_rule: 1,
};

/** Higher = more authoritative, per Section XV's literal ordering. */
export function auditStatusPriority(status: AuditStatus): number {
  return AUDIT_STATUS_PRIORITY[status];
}

// ── The record itself ────────────────────────────────────────────────────────

export interface MappingMemoryRecord {
  id?: string;
  companyId: string;
  sourceSystem: SourceSystem;
  naturalAccountCode: string | null;
  normalizedAccountName: string;
  reportingFramework: ReportingFramework;
  accountNature: AccountNature;
  presentationCode: IpsasPresentationCode;
  presentationLabel?: string;
  noteCode?: string;
  cashFlowClass?: string;
  effectivePeriodYear: number;
  evidenceSource: EvidenceSource;
  auditStatus: AuditStatus;
  ruleId?: string;
  ruleVersion?: string;
  confirmedBy?: string;
  confirmedAt?: string;
  createdAt?: string;
}

export interface MappingMemoryValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Client-side mirror of the DB's
 * amm_confirmed_fields_required_when_audited CHECK constraint — the SAME
 * rule enforced in two places (TS pre-flight, DB last-resort) rather than
 * trusted only once. Failing here means the write would also fail at the
 * DB, just faster and with a clearer message.
 */
export function validateMappingMemoryRecord(
  record: MappingMemoryRecord,
): MappingMemoryValidationResult {
  const errors: string[] = [];

  if (record.auditStatus !== "system_rule") {
    if (!record.confirmedBy) {
      errors.push(`audit_status '${record.auditStatus}' requires confirmedBy to be set.`);
    }
    if (!record.confirmedAt) {
      errors.push(`audit_status '${record.auditStatus}' requires confirmedAt to be set.`);
    }
  }

  if (record.effectivePeriodYear < 2000 || record.effectivePeriodYear > 2100) {
    errors.push(`effectivePeriodYear ${record.effectivePeriodYear} is outside the sane range 2000-2100.`);
  }

  return { valid: errors.length === 0, errors };
}

// ── Priority selection (Section XV: "Priority evidence: CAG > SAFF > user > rule") ──

/**
 * Given multiple candidate confirmations for the SAME (company, code,
 * period) — e.g. a system rule fired, then a professional later confirmed
 * it — picks the highest-priority one. Ties (same audit_status) break on
 * most recent confirmedAt/createdAt, so a genuine later correction at the
 * same authority level still wins.
 */
export function selectAuthoritativeMapping(
  candidates: MappingMemoryRecord[],
): MappingMemoryRecord | null {
  if (candidates.length === 0) return null;

  return candidates.reduce((best, candidate) => {
    const bestPriority = auditStatusPriority(best.auditStatus);
    const candidatePriority = auditStatusPriority(candidate.auditStatus);
    if (candidatePriority > bestPriority) return candidate;
    if (candidatePriority < bestPriority) return best;

    const bestTime = best.confirmedAt ?? best.createdAt ?? "";
    const candidateTime = candidate.confirmedAt ?? candidate.createdAt ?? "";
    return candidateTime > bestTime ? candidate : best;
  });
}

// ── Never let a prior period silently become "this year's approval" ──────────

/**
 * Section XV: "Do NOT label automatically imported prior audited mapping as
 * current-year professional approval." Structural enforcement: this filters
 * OUT every record whose effectivePeriodYear differs from the target —
 * there is no code path here that lets a prior-period record satisfy a
 * current-period lookup. (Using a prior period's mapping as EVIDENCE when
 * inferring the current period's is detectEntityContext.ts's job via
 * priorConfirmedFramework — a different, explicitly-labelled input — not
 * this function pretending a prior confirmation already covers this year.)
 */
export function findEffectiveMappingForPeriod(
  records: MappingMemoryRecord[],
  naturalAccountCode: string,
  targetPeriodYear: number,
): MappingMemoryRecord | null {
  const candidates = records.filter(
    (r) => r.naturalAccountCode === naturalAccountCode && r.effectivePeriodYear === targetPeriodYear,
  );
  return selectAuthoritativeMapping(candidates);
}
