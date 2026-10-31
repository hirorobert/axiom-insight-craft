/** Bounded preparation calculations over explicit, evidenced inputs. No accounting judgment is inferred from names. */
import { z } from "zod";
import { currency, date, evidenceSchema, frozen, identifier, minor, nonNegativeMinor, roundRatio, scopeSchema, scopedEvidence, sum, refuse, jsonSnapshot } from "./contracts";
import { profileInput, resolveIpsasProfile } from "./profile";

const obligation = z.object({ id: identifier, allocatedMinor: nonNegativeMinor, satisfiedMinor: nonNegativeMinor, evidenceId: identifier }).strict();
export const grantInput = z.object({
  profile: profileInput, grantId: identifier, evidence: z.array(evidenceSchema).min(1).max(100),
  classification: z.enum(["restriction-only", "enforceable-condition", "binding-arrangement", "without-binding-with-present-obligation", "without-binding-no-present-obligation", "unresolved"]),
  considerationMinor: nonNegativeMinor, recognisedResourcesMinor: nonNegativeMinor,
  priorCumulativeRevenueMinor: nonNegativeMinor, obligations: z.array(obligation).max(100),
  complexities: z.object({ variableConsideration: z.boolean(), financing: z.boolean(), agent: z.boolean(), nonCash: z.boolean(), modification: z.boolean(), creditLoss: z.boolean() }).strict(),
}).strict();

/** Fully funded, fixed monetary transfer only; satisfaction amounts are evidenced inputs, NOT inferred from spending. */
export function prepareFixedGrant(raw: unknown) {
  const g = grantInput.parse(jsonSnapshot(raw)), profile = resolveIpsasProfile(g.profile);
  scopedEvidence(g.profile, g.evidence);
  const evidenceIds = new Set(g.evidence.map(e => e.id));
  if (g.classification === "unresolved") refuse("GRANT_TERMS_ASSESSMENT_REQUIRED");
  if (Object.values(g.complexities).some(Boolean)) refuse("COMPLEX_GRANT_WORKPAPER_REQUIRED");
  if (g.considerationMinor !== g.recognisedResourcesMinor) refuse("NOT_FULLY_FUNDED_GRANT_WORKPAPER_REQUIRED");
  const uses47 = profile.selected.revenue[0] === "IPSAS47";
  if (uses47 ? ["restriction-only", "enforceable-condition"].includes(g.classification)
    : !["restriction-only", "enforceable-condition"].includes(g.classification)) refuse("GRANT_CLASSIFICATION_PERIOD_MISMATCH");
  const hasObligation = ["enforceable-condition", "binding-arrangement", "without-binding-with-present-obligation"].includes(g.classification);
  const ids = new Set<string>();
  for (const o of g.obligations) {
    if (ids.has(o.id)) refuse("DUPLICATE_GRANT_OBLIGATION");
    ids.add(o.id);
    if (!evidenceIds.has(o.evidenceId)) refuse("OBLIGATION_EVIDENCE_MISSING");
    if (BigInt(o.satisfiedMinor) > BigInt(o.allocatedMinor)) refuse("OBLIGATION_SATISFACTION_EXCEEDS_ALLOCATION");
  }
  if (hasObligation && (!g.obligations.length || sum(g.obligations.map(o => o.allocatedMinor)) !== BigInt(g.considerationMinor))) refuse("OBLIGATION_ALLOCATION_MISMATCH");
  if (!hasObligation && g.obligations.length) refuse("OBLIGATIONS_CONTRADICT_CLASSIFICATION");
  const cumulativeRevenue = hasObligation ? sum(g.obligations.map(o => o.satisfiedMinor)) : BigInt(g.recognisedResourcesMinor);
  const prior = BigInt(g.priorCumulativeRevenueMinor);
  if (prior > cumulativeRevenue) refuse("REVENUE_REVERSAL_WORKPAPER_REQUIRED");
  return frozen({ schema: "ipsas-fixed-grant-preparation/1", grantId: g.grantId, standard: uses47 ? "IPSAS47" : "IPSAS23",
    cumulativeRevenueMinor: String(cumulativeRevenue), periodRevenueMinor: String(cumulativeRevenue - prior),
    remainingObligationMinor: String(BigInt(g.recognisedResourcesMinor) - cumulativeRevenue),
    evidence: g.evidence, judgment: g.classification,
    limitation: "Fixed, fully funded monetary transfer; no receivable, variable consideration, financing, agency, modification or impairment calculation. Does not post or approve.",
    publicationAuthorized: false as const });
}

export const fxInput = scopeSchema.extend({
  itemId: identifier, evidence: z.array(evidenceSchema).min(1).max(100), foreignCurrency: currency,
  foreignScale: z.number().int().min(0).max(6), foreignMinor: nonNegativeMinor,
  carryingFunctionalMinor: nonNegativeMinor, nature: z.enum(["asset", "liability"]),
  measurement: z.enum(["monetary", "non-monetary-historical", "non-monetary-current-value"]),
  recognitionDate: date, rateDate: date,
  // Target MAJOR units per source MAJOR unit. Integer ratio and explicit scales prevent hidden unit conversion.
  rateNumerator: z.string().regex(/^[1-9][0-9]{0,24}$/), rateDenominator: z.string().regex(/^[1-9][0-9]{0,24}$/),
  rounding: z.literal("HALF_UP"),
}).strict();
export function prepareFx(raw: unknown) {
  const f = fxInput.parse(jsonSnapshot(raw)); scopedEvidence(f, f.evidence);
  if (f.foreignCurrency === f.currency) refuse("FOREIGN_CURRENCY_EQUALS_FUNCTIONAL");
  if (f.recognitionDate > f.period.end) refuse("ITEM_RECOGNISED_AFTER_PERIOD");
  if (f.measurement === "non-monetary-current-value") refuse("CURRENT_VALUE_FX_WORKPAPER_REQUIRED");
  const wanted = f.measurement === "monetary" ? f.period.end : f.recognitionDate;
  if (f.rateDate !== wanted) refuse(f.measurement === "monetary" ? "CLOSING_RATE_DATE_REQUIRED" : "HISTORICAL_RATE_DATE_REQUIRED");
  const translated = roundRatio(BigInt(f.foreignMinor) * BigInt(f.rateNumerator) * 10n ** BigInt(f.scale), BigInt(f.rateDenominator) * 10n ** BigInt(f.foreignScale));
  if (!minor.safeParse(String(translated)).success) refuse("TRANSLATED_AMOUNT_RANGE_EXCEEDED");
  const difference = translated - BigInt(f.carryingFunctionalMinor);
  if (f.measurement === "non-monetary-historical" && difference !== 0n) refuse("HISTORICAL_CARRYING_AMOUNT_MISMATCH");
  return frozen({ schema: "ipsas-fx-preparation/1", itemId: f.itemId, functionalMinor: String(translated),
    exchangeGainMinor: String(f.nature === "asset" ? difference : -difference), rateDate: f.rateDate,
    monetary: f.measurement === "monetary", evidence: f.evidence, rounding: f.rounding,
    publicationAuthorized: false as const });
}

const activity = z.enum(["operating", "investing", "financing"]);
const budgetRow = z.object({ id: identifier, label: z.string().min(1).max(250), activity, direction: z.enum(["receipt", "payment"]),
  performance: z.enum(["revenue", "expense", "neither"]), originalMinor: nonNegativeMinor, finalMinor: nonNegativeMinor,
  actualMinor: nonNegativeMinor, evidenceId: identifier,
  varianceAssessment: z.enum(["material", "not-material", "unresolved"]).nullable(),
  varianceExplanation: z.string().max(2000).nullable(), revisionExplanation: z.string().max(2000).nullable() }).strict();
const anchorName = z.enum(["operating", "investing", "financing", "revenue", "expense"]);
const bridgeItem = z.object({ id: identifier, amountMinor: minor, kind: z.enum(["basis", "timing", "entity", "other"]),
  reason: z.string().min(8).max(2000), evidenceId: identifier }).strict();
export const budgetInput = scopeSchema.extend({
  publiclyAvailable: z.enum(["yes", "no", "unresolved"]), applicabilityEvidence: evidenceSchema,
  budgetBasis: z.enum(["cash", "accrual", "other"]), budgetPeriod: z.object({ start: date, end: date }).strict(),
  evidence: z.array(evidenceSchema).min(1).max(100), rows: z.array(budgetRow).max(1000),
  anchors: z.array(z.object({ name: anchorName, financialStatementMinor: minor, evidenceId: identifier, bridge: z.array(bridgeItem).max(100) }).strict()).max(5),
  completenessEvidenceId: identifier,
}).strict();

/** Variance arithmetic and comparable-basis reconciliation. No favourable/adverse judgment inferred from signs. */
export function prepareBudget(raw: unknown) {
  const b = budgetInput.parse(jsonSnapshot(raw)); scopedEvidence(b, [b.applicabilityEvidence, ...b.evidence]);
  if (b.publiclyAvailable === "unresolved") refuse("BUDGET_APPLICABILITY_REQUIRED");
  if (b.budgetPeriod.start > b.budgetPeriod.end) refuse("REVERSED_BUDGET_PERIOD");
  const ids = new Set(b.evidence.map(e => e.id));
  if (!ids.has(b.completenessEvidenceId)) refuse("BUDGET_COMPLETENESS_EVIDENCE_REQUIRED");
  if (b.publiclyAvailable === "no") {
    if (b.rows.length || b.anchors.length) refuse("SUPPLEMENTARY_DONOR_BUDGET_IS_NOT_IPSAS24");
    return frozen({ state: "not-applicable" as const, basis: b.budgetBasis, rows: [], reconciliations: [], blockers: [], evidence: b.evidence, publicationAuthorized: false as const });
  }
  if (!b.rows.length) refuse("BUDGET_ROWS_REQUIRED");
  const rowIds = new Set<string>();
  for (const r of b.rows) {
    if (rowIds.has(r.id)) refuse("DUPLICATE_BUDGET_ROW");
    rowIds.add(r.id); if (!ids.has(r.evidenceId)) refuse("BUDGET_ROW_EVIDENCE_MISSING");
  }
  const wanted: string[] = b.budgetBasis === "accrual" ? ["operating", "investing", "financing", "revenue", "expense"] : ["operating", "investing", "financing"];
  if (new Set(b.anchors.map(a => a.name)).size !== b.anchors.length || b.anchors.length !== wanted.length || wanted.some(n => !b.anchors.some(a => a.name === n))) refuse("BUDGET_RECONCILIATION_ANCHORS_REQUIRED");
  const rows = b.rows.map(r => ({ ...r, varianceMinor: String(BigInt(r.actualMinor) - BigInt(r.finalMinor)),
    variancePercentHundredths: BigInt(r.finalMinor) === 0n ? null : String(roundRatio((BigInt(r.actualMinor) - BigInt(r.finalMinor)) * 10000n, BigInt(r.finalMinor))) }));
  const reconciliations = b.anchors.map(a => {
    if (!ids.has(a.evidenceId)) refuse("BUDGET_ANCHOR_EVIDENCE_MISSING");
    const actual = b.rows.filter(r => a.name === "revenue" || a.name === "expense" ? r.performance === a.name : r.activity === a.name)
      .reduce((n, r) => n + BigInt(r.actualMinor) * (a.name === "expense" ? (r.direction === "payment" ? 1n : -1n) : r.direction === "receipt" ? 1n : -1n), 0n);
    const bridgeIds = new Set<string>();
    for (const x of a.bridge) {
      if (bridgeIds.has(x.id)) refuse("DUPLICATE_BUDGET_BRIDGE"); bridgeIds.add(x.id);
      if (!ids.has(x.evidenceId)) refuse("BUDGET_BRIDGE_EVIDENCE_MISSING");
    }
    const difference = actual + sum(a.bridge.map(x => x.amountMinor)) - BigInt(a.financialStatementMinor);
    return { name: a.name, budgetActualMinor: String(actual), financialStatementMinor: a.financialStatementMinor, bridge: a.bridge, differenceMinor: String(difference) };
  });
  const blockers = reconciliations.filter(r => r.differenceMinor !== "0").map(r => `BUDGET_BASIS_BRIDGE_DIFFERENCE:${r.name}`);
  for (const r of rows) {
    if (r.varianceMinor !== "0" && (!r.varianceAssessment || r.varianceAssessment === "unresolved")) blockers.push(`BUDGET_VARIANCE_ASSESSMENT_REQUIRED:${r.id}`);
    if (r.varianceMinor !== "0" && r.varianceAssessment !== "unresolved" && (!r.varianceExplanation || r.varianceExplanation.trim().length < 8)) blockers.push(`BUDGET_VARIANCE_EXPLANATION_REQUIRED:${r.id}`);
    if (r.originalMinor !== r.finalMinor && (!r.revisionExplanation || r.revisionExplanation.trim().length < 8)) blockers.push(`BUDGET_REVISION_EXPLANATION_REQUIRED:${r.id}`);
  }
  // An equal net result does not prove that different budget coverage has been reconciled.
  if ((b.budgetPeriod.start !== b.period.start || b.budgetPeriod.end !== b.period.end) && !b.anchors.some(a => a.bridge.some(x => x.kind === "timing"))) blockers.push("BUDGET_PERIOD_BRIDGE_ASSESSMENT_REQUIRED");
  return frozen({ state: blockers.length ? "difference" as const : "reconciled" as const, basis: b.budgetBasis, rows, reconciliations, blockers, evidence: b.evidence, publicationAuthorized: false as const });
}
