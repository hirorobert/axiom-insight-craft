/** Effective-period routing, not a claim that all requirements in a standard are implemented. */
import { z } from "zod";
import { date, evidenceSchema, periodSchema, scopeSchema, scopedEvidence, refuse, frozen, jsonSnapshot } from "./contracts";

export const profileInput = scopeSchema.extend({
  basis: z.enum(["accrual", "cash"]), jurisdiction: z.string().min(2).max(80),
  jurisdictionEvidence: evidenceSchema, entityEvidence: evidenceSchema,
  functionalCurrency: z.string().regex(/^[A-Z]{3}$/),
  groupAssessment: z.enum(["single-entity-confirmed", "group", "unresolved"]),
  adoption: z.enum(["continuing-accrual", "first-time", "unresolved"]),
  publicBudget: z.enum(["yes", "no", "unresolved"]),
  elections: z.object({
    leases43: evidenceSchema.nullable(), ppe45: evidenceSchema.nullable(),
    measurement46: evidenceSchema.nullable(), heldForSale44: evidenceSchema.nullable(),
    revenue47: evidenceSchema.nullable(), transfers48: evidenceSchema.nullable(),
    concessionary2027: evidenceSchema.nullable(),
  }).strict(),
  initialApplications: z.object({ leases43: date.nullable(), ppe45: date.nullable(), revenue47: date.nullable(), transfers48: date.nullable() }).strict(),
  transition: z.object({
    revenue47: z.enum(["full-retrospective", "cumulative-effect"]).nullable(),
    transfers48: z.enum(["prospective", "retrospective"]).nullable(),
    workpapers: z.object({ leases43: z.string().min(3).max(1000).nullable(), ppe45: z.string().min(3).max(1000).nullable() }).strict(),
    evidence: evidenceSchema.nullable(),
  }).strict(),
  comparative: periodSchema.nullable(),
}).strict();
export type ProfileInput = z.infer<typeof profileInput>;
const SCOPE_FROM = "2024-01-01", SCOPE_BEFORE = "2027-01-01";

export function resolveIpsasProfile(raw: unknown) {
  const p = profileInput.parse(jsonSnapshot(raw)), start = p.period.start;
  scopedEvidence(p, [p.jurisdictionEvidence, p.entityEvidence, ...Object.values(p.elections).filter(x => x !== null), ...(p.transition.evidence ? [p.transition.evidence] : [])]);
  if (p.basis !== "accrual") refuse("ACCRUAL_BASIS_REQUIRED");
  if (start < SCOPE_FROM || start >= SCOPE_BEFORE) refuse("PERIOD_PROFILE_NOT_REVIEWED");
  if (p.functionalCurrency !== p.currency) refuse("FUNCTIONAL_TO_PRESENTATION_TRANSLATION_NOT_IMPLEMENTED");
  if (p.groupAssessment !== "single-entity-confirmed") refuse(p.groupAssessment === "group" ? "GROUP_PREPARATION_NOT_IMPLEMENTED" : "GROUP_ASSESSMENT_REQUIRED");
  if (p.adoption !== "continuing-accrual") refuse(p.adoption === "first-time" ? "FIRST_TIME_ADOPTION_WORKPAPER_REQUIRED" : "ADOPTION_HISTORY_REQUIRED");
  if (p.comparative && p.comparative.end >= start) refuse("COMPARATIVE_OVERLAPS_CURRENT");
  if (p.comparative && new Date(`${p.comparative.end}T00:00:00Z`).getTime() + 86400000 !== new Date(`${start}T00:00:00Z`).getTime()) refuse("COMPARATIVE_PERIOD_ADJACENCY_REQUIRED");
  // The 2027 amendment package is a different profile, not an incidental label or a late numeric version.
  if (p.elections.concessionary2027) refuse("CONCESSIONARY_2027_PROFILE_NOT_IMPLEMENTED");
  const leases43 = start >= "2025-01-01" || !!p.elections.leases43;
  const ppe45 = start >= "2025-01-01" || !!p.elections.ppe45;
  if (p.elections.ppe45 && start < "2025-01-01" && !(leases43 && p.elections.heldForSale44 && p.elections.measurement46)) refuse("PPE_EARLY_APPLICATION_PACKAGE_INCOMPLETE");
  const revenue47 = start >= "2026-01-01" || !!p.elections.revenue47;
  const transfers48 = start >= "2026-01-01" || !!p.elections.transfers48;
  if (transfers48 && !revenue47) refuse("IPSAS48_REQUIRES_IPSAS47");
  const selected = { leases: leases43 ? "IPSAS43" : "IPSAS13", ppe: ppe45 ? "IPSAS45" : "IPSAS17",
    revenue: revenue47 ? ["IPSAS47"] : ["IPSAS9", "IPSAS11", "IPSAS23"], transferExpenses: transfers48 ? "IPSAS48" : "IPSAS3_POLICY_ASSESSMENT" };
  const blockers: string[] = [];
  if (p.publicBudget === "unresolved") blockers.push("BUDGET_APPLICABILITY_REQUIRED");
  if (!p.comparative) blockers.push("COMPARATIVES_OR_FIRST_PERIOD_ASSESSMENT_REQUIRED");
  for (const [key, active, effective] of [["leases43", leases43, "2025-01-01"], ["ppe45", ppe45, "2025-01-01"], ["revenue47", revenue47, "2026-01-01"], ["transfers48", transfers48, "2026-01-01"]] as const) {
    const initial = p.initialApplications[key];
    const issued = key === "leases43" ? "2022-01-31" : "2023-05-26";
    if (initial && initial < issued) refuse("INITIAL_APPLICATION_BEFORE_STANDARD_ISSUED");
    if (initial && initial > start) refuse("INITIAL_APPLICATION_AFTER_REPORTING_START");
    if (!active && initial) refuse("INITIAL_APPLICATION_WITHOUT_SELECTED_STANDARD");
    if (active && !initial) blockers.push(`INITIAL_APPLICATION_DATE_REQUIRED:${key}`);
    if (active && initial && initial < effective && !p.elections[key]) refuse("EARLY_APPLICATION_EVIDENCE_REQUIRED");
    if (active && initial && initial < effective) blockers.push(`EARLY_APPLICATION_REQUIRES_ACCOUNTING_REVIEW:${key}`);
    if (active && initial === start) {
      if (key === "leases43" || key === "ppe45") { if (!p.transition.workpapers[key] || !p.transition.evidence) blockers.push(`REVIEWED_TRANSITION_WORKPAPER_REQUIRED:${key}`); }
      else if (!p.transition[key] || !p.transition.evidence) blockers.push(`TRANSITION_CHOICE_AND_EVIDENCE_REQUIRED:${key}`);
    }
  }
  return frozen({ schema: "ipsas-period-profile/1", period: p.period, comparative: p.comparative, selected,
    budgetComparison: p.publicBudget === "yes" ? "required" : p.publicBudget === "no" ? "not-applicable-by-recorded-assessment" : "unresolved",
    transition: p.transition, blockers, evidence: [p.jurisdictionEvidence, ...Object.values(p.elections).filter(x => x !== null)],
    publicationAuthorized: false as const });
}
