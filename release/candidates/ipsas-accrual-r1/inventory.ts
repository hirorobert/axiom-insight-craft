/** Screening inventory, deliberately NOT an exhaustive paragraph-level compliance register. */
import { z } from "zod";
import { evidenceSchema, identifier, refuse } from "./contracts";

export const TOPICS = [
  ["presentation", "IPSAS1", "Statement set, classification, aggregation and comparatives", true],
  ["going_concern", "IPSAS1", "Going concern and material uncertainties", true],
  ["policies_errors", "IPSAS3", "Policies, estimates, errors and opening bridges", true],
  ["cash_flow", "IPSAS2", "Cash perimeter, activity classification and cash reconciliation", true],
  ["foreign_currency", "IPSAS4", "Transactions, balances and currency judgments", false],
  ["borrowing_costs", "IPSAS5", "Borrowing costs and the entity's policy", false],
  ["exchange_revenue", "IPSAS9/11/47", "Exchange revenue and construction arrangements by period", false],
  ["grants", "IPSAS23/47", "Donations, enforceability, obligations, satisfaction and grant disclosures", false],
  ["in_kind", "IPSAS23/47", "Donated goods, services in-kind and recognition policy", false],
  ["transfers", "IPSAS3/48", "Transfers to beneficiaries or other entities", false],
  ["inventories", "IPSAS12", "Inventory valuation, distribution and write-downs", false],
  ["investment_property", "IPSAS16", "Investment-property classification, measurement and disclosures", false],
  ["equipment", "IPSAS17/45/46", "PPE recognition, measurement, components, depreciation and movements", false],
  ["leases", "IPSAS13/43", "Lease identification, lessee/lessor measurement and disclosures", false],
  ["events_after", "IPSAS14", "Events after the reporting period and authorisation", true],
  ["segments", "IPSAS18", "Segment reporting applicability and presentation", false],
  ["provisions", "IPSAS19", "Provisions, contingent liabilities and contingent assets", false],
  ["related_parties", "IPSAS20", "Related-party identification, relationships and disclosures", true],
  ["impairment_service", "IPSAS21", "Non-cash-generating asset impairment", false],
  ["impairment_cash", "IPSAS26", "Cash-generating asset impairment", false],
  ["budget", "IPSAS24", "Public budget applicability, comparable actuals, bridges and material explanations", false],
  ["agriculture", "IPSAS27", "Biological assets and agricultural produce", false],
  ["financial_instruments", "IPSAS28/30/41", "Classification, measurement, credit losses, presentation and risks", false],
  ["intangibles", "IPSAS31", "Intangible assets and their movements", false],
  ["service_concessions", "IPSAS32", "Service-concession arrangements", false],
  ["first_adoption", "IPSAS33", "Accrual adoption and transitional reliefs", false],
  ["interests_other_entities", "IPSAS34-38", "Control, separate/group statements and interests in other entities", true],
  ["employee_benefits", "IPSAS39", "Leave, gratuity, pensions and other employee benefits", false],
  ["combinations", "IPSAS40", "Public-sector combinations", false],
  ["social_benefits", "IPSAS42", "Social-benefit scheme applicability", false],
  ["held_for_sale", "IPSAS44", "Held-for-sale assets and discontinued operations", false],
  ["retirement_plans", "IPSAS49", "Retirement-benefit plan reporting", false],
  ["hyperinflation", "IPSAS10", "Hyperinflation applicability", false],
  ["government_sector", "IPSAS22", "General government sector disclosure applicability", false],
  ["fund_reporting", "ENTITY/JURISDICTION/DONOR", "Fund restrictions and supplementary donor/project reporting", true],
] as const;
export const assessmentSchema = z.object({ topicId: identifier, status: z.enum(["applicable", "not-applicable", "unresolved"]),
  basis: z.string().min(8).max(2000), evidence: evidenceSchema, workpaperReference: z.string().min(3).max(1000).nullable() }).strict();
export type Assessment = z.infer<typeof assessmentSchema>;
export function preparationTasks(assessments: readonly Assessment[]) {
  const seen = new Set<string>();
  for (const a of assessments) {
    if (seen.has(a.topicId)) refuse("DUPLICATE_TOPIC_ASSESSMENT");
    seen.add(a.topicId);
    if (!TOPICS.some(t => t[0] === a.topicId)) refuse("UNKNOWN_TOPIC_ASSESSMENT");
    if (a.status === "not-applicable" && TOPICS.some(t => t[0] === a.topicId && t[3])) refuse("MANDATORY_TOPIC_CANNOT_BE_WAIVED");
  }
  return TOPICS.map(([id, standards, label]) => {
    const a = assessments.find(a => a.topicId === id);
    return { id, standards, label, applicability: a?.status ?? "unresolved",
      evidence: a?.evidence ?? null, workpaperReference: a?.workpaperReference ?? null,
      nextAction: !a || a.status === "unresolved" ? "Record applicability with evidence" : a.status === "not-applicable" ? "Retain the applicability assessment for review"
        : a.workpaperReference ? "Review the workpaper, confirmed figures, reconciliation and disclosures against individual requirements" : "Complete the applicable preparation and link its evidence",
      accountingValidation: "NOT_ASSESSED" as const };
  });
}
