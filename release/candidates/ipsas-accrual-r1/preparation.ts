/** Candidate NGO preparation engine. A source snapshot is NOT an authenticated hosted read or accounting sign-off. */
import { z } from "zod";
import { canonicalStringify, sha256Hex } from "@/lib/canonicalStatement/serialization";
import { evidenceSchema, frozen, identifier, minor, nonNegativeMinor, periodSchema, scopeSchema, scopedEvidence, sum, refuse, jsonSnapshot } from "./contracts";
import { assessmentSchema, preparationTasks } from "./inventory";
import { profileInput, resolveIpsasProfile } from "./profile";
import { budgetInput, grantInput, fxInput, prepareBudget, prepareFixedGrant, prepareFx } from "./ngoCalculations";

/** Reviewed presentation vocabulary for this candidate, not a prescribed chart of accounts or an exhaustive taxonomy. */
export const LINES = [
  ["cash", "Cash and cash equivalents", "asset"], ["receivables", "Receivables", "asset"],
  ["inventories", "Inventories", "asset"], ["prepayments", "Prepayments", "asset"],
  ["other_financial_assets", "Other financial assets", "asset"], ["ppe", "Property, plant and equipment", "asset"],
  ["right_of_use", "Right-of-use assets", "asset"], ["investment_property", "Investment property", "asset"],
  ["intangibles", "Intangible assets", "asset"], ["other_assets", "Other assets", "asset"],
  ["payables", "Payables and accruals", "liability"], ["grant_obligations", "Unfulfilled grant obligations", "liability"],
  ["transfer_obligations", "Transfer obligations", "liability"], ["borrowings", "Borrowings", "liability"],
  ["lease_liabilities", "Lease liabilities", "liability"], ["employee_benefits", "Employee benefits", "liability"],
  ["provisions", "Provisions", "liability"], ["other_liabilities", "Other liabilities", "liability"],
  ["capital", "Contributions from owners", "net-assets"], ["reserves", "Reserves", "net-assets"],
  ["funds", "Fund balances", "net-assets"], ["accumulated", "Accumulated surplus or deficit", "net-assets"],
  ["grants", "Grant revenue", "revenue"], ["donations", "Donations", "revenue"], ["fees", "Fees and services", "revenue"],
  ["investment_income", "Investment income", "revenue"], ["other_revenue", "Other revenue", "revenue"],
  ["employees", "Employee expenses", "expense"], ["supplies", "Supplies and services", "expense"],
  ["depreciation", "Depreciation and amortisation", "expense"], ["impairment", "Impairment", "expense"],
  ["transfers", "Transfer expenses", "expense"], ["finance", "Finance expenses", "expense"], ["other_expenses", "Other expenses", "expense"],
] as const;
const account = z.object({ id: identifier, code: z.string().max(100), label: z.string().min(1).max(250), debitMinor: nonNegativeMinor, creditMinor: nonNegativeMinor,
  lineId: z.string().nullable(), section: z.enum(["current", "non-current", "net-assets", "performance"]).nullable(),
  zeroDisposition: z.enum(["movement-source-reviewed", "non-reporting-reviewed"]).nullable(), evidenceId: identifier }).strict();
const cashMovement = z.object({ id: identifier, accountId: identifier, activity: z.enum(["operating", "investing", "financing", "internal"]),
  label: z.string().min(1).max(250), amountMinor: minor, transferId: identifier.nullable(), evidenceId: identifier }).strict();
const cashOpening = z.object({ accountId: identifier, openingMinor: minor, exchangeEffectMinor: minor, evidenceId: identifier }).strict();
const periodInput = z.object({ period: periodSchema, currency: z.string().regex(/^[A-Z]{3}$/), scale: z.number().int().min(0).max(6), basis: z.enum(["accrual", "cash"]), mode: z.enum(["pre-close", "post-close"]),
  completenessEvidence: evidenceSchema, accounts: z.array(account).min(1).max(2000),
  cash: z.object({ completenessEvidence: evidenceSchema, openings: z.array(cashOpening).max(2000), movements: z.array(cashMovement).max(20000) }).strict(),
  netAssets: z.object({ openingMinor: minor.nullable(), evidenceId: identifier,
    otherMovements: z.array(z.object({ id: identifier, label: z.string().min(1).max(250), amountMinor: minor, evidenceId: identifier }).strict()).max(1000),
    completenessEvidence: evidenceSchema }).strict(),
}).strict();
const openingAdjustment = z.object({ id: identifier, kind: z.enum(["policy-transition", "restatement", "scope-change", "correction"]),
  amountMinor: minor, reason: z.string().min(8).max(2000), authorityReference: z.string().min(3).max(1000), evidenceId: identifier }).strict();
export const preparationInput = z.object({ schema: z.literal("ipsas-ngo-source/1"), scope: scopeSchema,
  legalName: z.string().min(1).max(250), profile: profileInput, evidence: z.array(evidenceSchema).min(1).max(2000),
  current: periodInput, comparative: periodInput.nullable(), openingAdjustments: z.array(openingAdjustment).max(100),
  grants: z.array(grantInput).max(100), fx: z.array(fxInput).max(100), budget: budgetInput.nullable(),
  assessments: z.array(assessmentSchema).max(100),
}).strict();
export type NgoPreparationInput = z.infer<typeof preparationInput>;
const same = (a: unknown, b: unknown) => canonicalStringify(a) === canonicalStringify(b);

function compilePeriod(input: z.infer<typeof periodInput>, source: NgoPreparationInput) {
  const scope = { ...source.scope, period: input.period }, evidence = source.evidence.filter(e => same(e.period, input.period));
  if (input.currency !== source.scope.currency || input.scale !== source.scope.scale) refuse("SOURCE_DENOMINATION_MISMATCH");
  if (input.basis !== "accrual") refuse("SOURCE_ACCRUAL_BASIS_REQUIRED");
  scopedEvidence(scope, [input.completenessEvidence, input.cash.completenessEvidence, input.netAssets.completenessEvidence, ...evidence]);
  const evidenceIds = new Set(evidence.map(e => e.id));
  const requireEvidence = (id: string) => { if (!evidenceIds.has(id)) refuse("FACT_EVIDENCE_MISSING"); };
  if (input.mode !== "pre-close") refuse("POST_CLOSE_PERFORMANCE_LEDGER_REQUIRED");
  const ids = new Set<string>();
  const lines = new Map<string, { id: string; label: string; nature: string; section: string; amountMinor: string; sources: { accountId: string; evidenceId: string; amountMinor: string }[] }>();
  for (const a of input.accounts) {
    if (ids.has(a.id)) refuse("DUPLICATE_SOURCE_ACCOUNT_ID"); ids.add(a.id); requireEvidence(a.evidenceId);
    const net = BigInt(a.debitMinor) - BigInt(a.creditMinor);
    if (!a.lineId) {
      if (net !== 0n || !a.zeroDisposition) refuse("ACCOUNT_PRESENTATION_REQUIRED");
      continue;
    }
    const line = LINES.find(l => l[0] === a.lineId);
    if (!line) refuse("UNKNOWN_PRESENTATION_LINE");
    const nature = line[2], wanted = nature === "net-assets" ? ["net-assets"] : ["revenue", "expense"].includes(nature) ? ["performance"] : ["current", "non-current"];
    if (!a.section || !wanted.includes(a.section)) refuse("PRESENTATION_SECTION_REQUIRED");
    const value = ["asset", "expense"].includes(nature) ? net : -net, key = `${line[0]}:${a.section}`;
    const previous = lines.get(key);
    lines.set(key, { id: key, label: line[1], nature, section: a.section, amountMinor: String(BigInt(previous?.amountMinor ?? "0") + value),
      sources: [...(previous?.sources ?? []), { accountId: a.id, evidenceId: a.evidenceId, amountMinor: String(value) }] });
  }
  const tbDifference = sum(input.accounts.map(a => a.debitMinor)) - sum(input.accounts.map(a => a.creditMinor));
  if (tbDifference !== 0n) refuse("TRIAL_BALANCE_NOT_BALANCED");
  const rows = [...lines.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), total = (nature: string) => sum(rows.filter(l => l.nature === nature).map(l => l.amountMinor));
  const result = total("revenue") - total("expense"), closingNetAssets = total("net-assets") + result;
  const cashAccounts = input.accounts.filter(a => a.lineId === "cash");
  if (cashAccounts.some(a => a.section !== "current")) refuse("CASH_PERIMETER_WORKPAPER_REQUIRED");
  const cashIds = new Set(cashAccounts.map(a => a.id)), openingIds = new Set(input.cash.openings.map(a => a.accountId));
  if (openingIds.size !== input.cash.openings.length || cashIds.size !== openingIds.size || [...cashIds].some(id => !openingIds.has(id))) refuse("CASH_OPENING_PERIMETER_MISMATCH");
  const movementIds = new Set<string>(), transfers = new Map<string, typeof input.cash.movements>();
  for (const m of input.cash.movements) {
    if (movementIds.has(m.id)) refuse("DUPLICATE_CASH_MOVEMENT"); movementIds.add(m.id); requireEvidence(m.evidenceId);
    if (!cashIds.has(m.accountId)) refuse("CASH_MOVEMENT_OUTSIDE_PERIMETER");
    if (m.activity === "internal") {
      if (!m.transferId) refuse("INTERNAL_TRANSFER_ID_REQUIRED");
      transfers.set(m.transferId, [...(transfers.get(m.transferId) ?? []), m]);
    } else if (m.transferId) refuse("EXTERNAL_CASH_FLOW_HAS_TRANSFER_ID");
  }
  for (const t of transfers.values()) if (t.length !== 2 || t[0].accountId === t[1].accountId || sum(t.map(m => m.amountMinor)) !== 0n) refuse("INTERNAL_CASH_TRANSFER_NOT_RECONCILED");
  const blockers: string[] = [];
  for (const o of input.cash.openings) {
    requireEvidence(o.evidenceId);
    const a = cashAccounts.find(a => a.id === o.accountId)!;
    const expected = BigInt(o.openingMinor) + sum(input.cash.movements.filter(m => m.accountId === a.id).map(m => m.amountMinor)) + BigInt(o.exchangeEffectMinor);
    if (expected !== BigInt(a.debitMinor) - BigInt(a.creditMinor)) blockers.push(`CASH_ACCOUNT_DIFFERENCE:${a.id}`);
  }
  const activities = ["operating", "investing", "financing"].map(id => ({ id, amountMinor: String(sum(input.cash.movements.filter(m => m.activity === id).map(m => m.amountMinor))),
    sources: input.cash.movements.filter(m => m.activity === id).map(m => ({ movementId: m.id, evidenceId: m.evidenceId })) }));
  const cashLines = new Map<string, { id: string; activity: string; label: string; amountMinor: string; evidence: { movementId: string; evidenceId: string }[] }>();
  for (const m of input.cash.movements.filter(m => m.activity !== "internal")) {
    const key = `${m.activity}:${BigInt(m.amountMinor) < 0n ? "payment" : "receipt"}:${m.label}`;
    const prev = cashLines.get(key);
    cashLines.set(key, { id: key, activity: m.activity, label: m.label, amountMinor: String(BigInt(prev?.amountMinor ?? "0") + BigInt(m.amountMinor)), evidence: [...(prev?.evidence ?? []), { movementId: m.id, evidenceId: m.evidenceId }] });
  }
  const cashOpeningMinor = String(sum(input.cash.openings.map(o => o.openingMinor))), cashClosingMinor = String(sum(cashAccounts.map(a => String(BigInt(a.debitMinor) - BigInt(a.creditMinor)))));
  requireEvidence(input.netAssets.evidenceId);
  const netMovementIds = new Set<string>();
  for (const m of input.netAssets.otherMovements) { requireEvidence(m.evidenceId); if (netMovementIds.has(m.id)) refuse("DUPLICATE_NET_ASSET_MOVEMENT"); netMovementIds.add(m.id); }
  const expectedNetAssets = input.netAssets.openingMinor === null ? null : BigInt(input.netAssets.openingMinor) + result + sum(input.netAssets.otherMovements.map(m => m.amountMinor));
  if (expectedNetAssets === null) blockers.push("OPENING_NET_ASSETS_MISSING");
  else if (expectedNetAssets !== closingNetAssets) blockers.push("NET_ASSET_ROLL_FORWARD_DIFFERENCE");
  return { period: input.period, rows, totals: { assetsMinor: String(total("asset")), liabilitiesMinor: String(total("liability")), netAssetsMinor: String(closingNetAssets),
    revenueMinor: String(total("revenue")), expenseMinor: String(total("expense")), surplusMinor: String(result),
    positionDifferenceMinor: String(total("asset") - total("liability") - closingNetAssets) },
    cashFlow: { openingMinor: cashOpeningMinor, lines: [...cashLines.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), activities, exchangeEffectMinor: String(sum(input.cash.openings.map(o => o.exchangeEffectMinor))), closingMinor: cashClosingMinor, openings: input.cash.openings },
    netAssets: { openingMinor: input.netAssets.openingMinor, surplusMinor: String(result), otherMovements: input.netAssets.otherMovements, closingMinor: String(closingNetAssets) }, blockers };
}

/** Own the validated snapshot, bind it to its exact profile and evidence, and return no publication authority. */
export function prepareNgo(raw: unknown) {
  const s = preparationInput.parse(jsonSnapshot(raw)), profile = resolveIpsasProfile(s.profile);
  if (!same(s.scope, { companyId: s.profile.companyId, period: s.profile.period, currency: s.profile.currency, scale: s.profile.scale }) || !same(s.current.period, s.scope.period)) refuse("PROFILE_SOURCE_SCOPE_MISMATCH");
  if (!same(s.comparative?.period ?? null, s.profile.comparative)) refuse("COMPARATIVE_PROFILE_MISMATCH");
  if (s.assessments.length) scopedEvidence(s.scope, s.assessments.map(a => a.evidence));
  const allIds = new Map<string, string>();
  for (const e of s.evidence) {
    const encoded = canonicalStringify(e); if (allIds.has(e.id) && allIds.get(e.id) !== encoded) refuse("EVIDENCE_ID_REUSED"); allIds.set(e.id, encoded);
    if (e.companyId !== s.scope.companyId || (!same(e.period, s.current.period) && !same(e.period, s.comparative?.period))) refuse("EVIDENCE_SCOPE_MISMATCH");
  }
  const current = compilePeriod(s.current, s), comparative = s.comparative ? compilePeriod(s.comparative, s) : null;
  const blockers = [...profile.blockers, ...current.blockers.map(b => `CURRENT:${b}`), ...(comparative?.blockers ?? []).map(b => `COMPARATIVE:${b}`)];
  const adjustmentIds = new Set<string>();
  for (const a of s.openingAdjustments) {
    if (adjustmentIds.has(a.id)) refuse("DUPLICATE_OPENING_ADJUSTMENT"); adjustmentIds.add(a.id);
    if (!s.evidence.some(e => e.id === a.evidenceId && same(e.period, s.current.period))) refuse("OPENING_ADJUSTMENT_EVIDENCE_MISSING");
  }
  if (comparative && current.netAssets.openingMinor !== null && BigInt(current.netAssets.openingMinor) !== BigInt(comparative.totals.netAssetsMinor) + sum(s.openingAdjustments.map(a => a.amountMinor))) blockers.push("OPENING_NET_ASSETS_BRIDGE_DIFFERENCE");
  if (comparative && current.cashFlow.openingMinor !== comparative.cashFlow.closingMinor) blockers.push("OPENING_CASH_BRIDGE_WORKPAPER_REQUIRED");
  const grants = s.grants.map(g => { if (!same(g.profile, s.profile)) refuse("GRANT_PROFILE_SCOPE_MISMATCH"); return prepareFixedGrant(g); });
  const fx = s.fx.map(f => { if (!same({ companyId: f.companyId, period: f.period, currency: f.currency, scale: f.scale }, s.scope)) refuse("FX_PROFILE_SCOPE_MISMATCH"); return prepareFx(f); });
  const grantIds = new Set(grants.map(g => g.grantId)), fxIds = new Set(fx.map(f => f.itemId));
  if (grantIds.size !== grants.length || fxIds.size !== fx.length) refuse("DUPLICATE_PREPARATION_SCHEDULE");
  const grantRevenue = sum(current.rows.filter(r => r.id.startsWith("grants:")).map(r => r.amountMinor));
  const grantLiability = sum(current.rows.filter(r => r.id.startsWith("grant_obligations:")).map(r => r.amountMinor));
  if (grants.length && (sum(grants.map(g => g.periodRevenueMinor)) !== grantRevenue || sum(grants.map(g => g.remainingObligationMinor)) !== grantLiability)) blockers.push("GRANT_SCHEDULE_STATEMENT_DIFFERENCE");
  let budget: ReturnType<typeof prepareBudget> | null = null;
  if (s.budget) {
    if (!same({ companyId: s.budget.companyId, period: s.budget.period, currency: s.budget.currency, scale: s.budget.scale }, s.scope) || (s.profile.publicBudget !== "unresolved" && s.budget.publiclyAvailable !== s.profile.publicBudget)) refuse("BUDGET_PROFILE_SCOPE_MISMATCH");
    budget = prepareBudget(s.budget); blockers.push(...budget.blockers);
    for (const a of s.budget.anchors) {
      const actual = a.name === "revenue" ? current.totals.revenueMinor : a.name === "expense" ? current.totals.expenseMinor : current.cashFlow.activities.find(x => x.id === a.name)!.amountMinor;
      if (a.financialStatementMinor !== actual) blockers.push(`BUDGET_ANCHOR_STATEMENT_MISMATCH:${a.name}`);
    }
  } else if (profile.budgetComparison !== "not-applicable-by-recorded-assessment") blockers.push("BUDGET_PREPARATION_REQUIRED");
  if (comparative) blockers.push("COMPARATIVE_FRAMEWORK_AND_TRANSITION_REVIEW_REQUIRED");
  const tasks = preparationTasks(s.assessments);
  for (const t of tasks) if (t.applicability === "unresolved") blockers.push(`APPLICABILITY_REQUIRED:${t.id}`);
  if ((grantRevenue !== 0n || grantLiability !== 0n) && !grants.length) blockers.push("GRANT_PREPARATION_OR_GOVERNED_WORKPAPER_REQUIRED");
  // Do not mistake arithmetic over an asserted FX item for a reconciled link to its statement account.
  if (fx.length) blockers.push("FX_TO_ACCOUNT_BINDING_REQUIRES_SERVER_INTEGRATION");
  blockers.push("REQUIREMENT_UNIVERSE_NOT_ACCOUNTING_REVIEWED", "FRAMEWORK_CONTENT_NOT_ACCOUNTING_VALIDATED", "HOSTED_COMPILATION_AND_ISSUANCE_NOT_INTEGRATED");
  const sourceSha256 = sha256Hex(canonicalStringify(s));
  const accounting = { current, comparative, grants: grants.map(g => ({ grantId: g.grantId, standard: g.standard, periodRevenueMinor: g.periodRevenueMinor, cumulativeRevenueMinor: g.cumulativeRevenueMinor, remainingObligationMinor: g.remainingObligationMinor })),
    fx: fx.map(f => ({ itemId: f.itemId, functionalMinor: f.functionalMinor, exchangeGainMinor: f.exchangeGainMinor })), budget };
  const normalPeriod = (p: typeof current | null) => p === null ? null : ({ period: p.period, rows: p.rows.map(r => ({ id: r.id, nature: r.nature, section: r.section, amountMinor: r.amountMinor })), totals: p.totals,
    cashFlow: { openingMinor: p.cashFlow.openingMinor, closingMinor: p.cashFlow.closingMinor, lines: p.cashFlow.lines.map(l => ({ id: l.id, activity: l.activity, amountMinor: l.amountMinor })), activities: p.cashFlow.activities.map(a => ({ id: a.id, amountMinor: a.amountMinor })), exchangeEffectMinor: p.cashFlow.exchangeEffectMinor },
    netAssets: { openingMinor: p.netAssets.openingMinor, surplusMinor: p.netAssets.surplusMinor, otherMovements: p.netAssets.otherMovements.map(m => ({ id: m.id, amountMinor: m.amountMinor })).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), closingMinor: p.netAssets.closingMinor } });
  const normalBudget = budget === null ? null : { state: budget.state, basis: budget.basis, rows: budget.rows.map(r => ({ id: r.id, originalMinor: r.originalMinor, finalMinor: r.finalMinor, actualMinor: r.actualMinor, varianceMinor: r.varianceMinor })).sort((a,b)=>a.id.localeCompare(b.id)),
    reconciliations: budget.reconciliations.map(r => ({ name: r.name, budgetActualMinor: r.budgetActualMinor, financialStatementMinor: r.financialStatementMinor, bridgeMinor: String(sum(r.bridge.map(x => x.amountMinor))), differenceMinor: r.differenceMinor })).sort((a,b)=>a.name.localeCompare(b.name)) };
  const normalAccounting = { scope: s.scope, standards: profile.selected, current: normalPeriod(current), comparative: normalPeriod(comparative), grants: [...accounting.grants].sort((a,b) => a.grantId < b.grantId ? -1 : a.grantId > b.grantId ? 1 : 0), fx: [...accounting.fx].sort((a,b) => a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0), budget: normalBudget };
  return frozen({ schema: "ipsas-ngo-preparation/1", label: "INCOMPLETE — PREPARATION ONLY", scope: s.scope, legalName: s.legalName,
    profile, ...accounting, tasks, blockers, sourceSnapshot: s, sourceSha256, accountingResultSha256: sha256Hex(canonicalStringify(normalAccounting)),
    provenanceSha256: sha256Hex(canonicalStringify({ schema: "ipsas-ngo-provenance/1", source: s })), publicationAuthorized: false as const });
}
