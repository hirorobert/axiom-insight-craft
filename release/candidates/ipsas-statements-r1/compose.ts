/** Pure composition; no DB, network, entitlement, approval, storage or issuance side effects. */
import { canonicalStringify, sha256Hex } from "@/lib/canonicalStatement/serialization";
import { frozen, jsonSnapshot, refuse, scopedEvidence, sum } from "../ipsas-accrual-r1/contracts";
import { prepareNgo, type NgoPreparationInput } from "../ipsas-accrual-r1/preparation";
import { statementSetInput, type Figure, type Row, type Statement, type Task, type StatementSetInput } from "./contracts";

type Prepared = ReturnType<typeof prepareNgo>;
type Period = Prepared["current"];
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const digest = (v: unknown) => sha256Hex(canonicalStringify(v));
const distinct = (ids: string[], code: string) => { if (new Set(ids).size !== ids.length) refuse(code); };

function restate(source: NgoPreparationInput, journals: StatementSetInput["comparativeRestatements"]) {
  distinct(journals.map(j => j.id), "DUPLICATE_COMPARATIVE_JOURNAL");
  const original = prepareNgo(source);
  if (!journals.length) return { original, restated: original.comparative, journals: [], consumedBridges: new Set<string>() };
  if (!source.comparative) refuse("COMPARATIVE_REQUIRED_FOR_RESTATEMENT");
  const revised = structuredClone(source), prior = revised.comparative!;
  const consumedBridges = new Set<string>();
  const audit = [];
  let before = original.comparative!;
  // IDs define application order; row input ordering never determines the accounting result.
  for (const j of [...journals].sort((a, b) => order(a.id, b.id))) {
    scopedEvidence(source.scope, [j.evidence]);
    distinct(j.entries.map(e => e.accountId), "DUPLICATE_COMPARATIVE_JOURNAL_ACCOUNT");
    if (sum(j.entries.map(e => e.debitDeltaMinor)) !== sum(j.entries.map(e => e.creditDeltaMinor))) refuse("COMPARATIVE_JOURNAL_UNBALANCED");
    if (j.entries.every(e => e.debitDeltaMinor === "0" && e.creditDeltaMinor === "0")) refuse("COMPARATIVE_JOURNAL_EMPTY");
    for (const e of j.entries) {
      const account = prior.accounts.find(a => a.id === e.accountId);
      if (!account) refuse("COMPARATIVE_JOURNAL_ACCOUNT_UNKNOWN");
      if (account.lineId === "cash") refuse("COMPARATIVE_CASH_RESTATEMENT_WORKPAPER_REQUIRED");
      const debit = BigInt(account.debitMinor) + BigInt(e.debitDeltaMinor);
      const credit = BigInt(account.creditMinor) + BigInt(e.creditDeltaMinor);
      if (debit < 0n || credit < 0n) refuse("COMPARATIVE_JOURNAL_NEGATIVE_MAGNITUDE");
      account.debitMinor = String(debit); account.creditMinor = String(credit);
    }
    const after = prepareNgo(revised).comparative!;
    const delta = BigInt(after.totals.netAssetsMinor) - BigInt(before.totals.netAssetsMinor);
    if (j.kind === "presentation-reclassification" && delta !== 0n) refuse("PRESENTATION_RECLASSIFICATION_CHANGES_NET_ASSETS");
    if (delta !== 0n) {
      const bridge = source.openingAdjustments.find(b => b.id === j.openingBridgeId);
      if (!bridge || consumedBridges.has(bridge.id) || BigInt(bridge.amountMinor) !== delta) refuse("COMPARATIVE_OPENING_BRIDGE_REQUIRED");
      if (!(["restatement", "correction", "policy-transition"] as string[]).includes(bridge.kind)) refuse("COMPARATIVE_OPENING_BRIDGE_KIND_MISMATCH");
      consumedBridges.add(bridge.id);
    } else if (j.openingBridgeId !== null) refuse("ZERO_NET_RECLASSIFICATION_HAS_OPENING_BRIDGE");
    audit.push({ ...j, netAssetsDeltaMinor: String(delta) });
    before = after;
  }
  return { original, restated: before, journals: audit, consumedBridges };
}

/** All-zero absent captions derive from the existing candidate's asserted complete, validated TB. */
function statements(current: Period, reported: Period | null, comparative: Period | null, source: NgoPreparationInput): Statement[] {
  const periods = [current, ...(reported ? [reported] : []), ...(comparative ? [comparative] : [])];
  const keys = [...new Set(periods.flatMap(p => p.rows.map(r => r.id)))].sort(order);
  const metadata = (key: string) => periods.flatMap(p => p.rows).find(r => r.id === key)!;
  const value = (p: Period, key: string) => p.rows.find(r => r.id === key)?.amountMinor ?? "0";
  const periodSource = (p: Period) => p.period.start === source.current.period.start ? source.current : source.comparative!;
  const fig = (p: Period, amount: string | null, refs: string[]): Figure => ({ amountMinor: amount, sourceRefs: refs.length ? refs : [`evidence:${periodSource(p).completenessEvidence.id}`] });
  const row = (id: string, label: string, section: string, amount: (p: Period) => string | null,
    refs: (p: Period) => string[], role: Row["role"] = "detail"): Row => ({ id, label, section, role,
      current: fig(current, amount(current), refs(current)), asReported: reported ? fig(reported, amount(reported), refs(reported)) : null,
      comparative: comparative ? fig(comparative, amount(comparative), refs(comparative)) : null, noteIds: [] });
  const accountRefs = (p: Period, key: string) => (p.rows.find(r => r.id === key)?.sources ?? []).flatMap(s => [`account:${s.accountId}`, `evidence:${s.evidenceId}`]);
  const refsFor = (natures: string[]) => (p: Period) => p.rows.filter(r => natures.includes(r.nature)).map(r => `${["asset", "liability", "net-assets"].includes(r.nature) ? "sfp" : "sfperf"}:${r.id}`);
  const position = keys.filter(k => ["asset", "liability", "net-assets"].includes(metadata(k).nature)).map(k =>
    row(`sfp:${k}`, metadata(k).label, `${metadata(k).nature}:${metadata(k).section}`, p => value(p, k), p => accountRefs(p, k)));
  position.push(row("sfp:result", "Surplus / (deficit) for the period", "net-assets:result", p => p.totals.surplusMinor, () => ["sfperf:surplus"]));
  position.push(row("sfp:assets", "Total assets", "total", p => p.totals.assetsMinor, refsFor(["asset"]), "total"));
  position.push(row("sfp:liabilities", "Total liabilities", "total", p => p.totals.liabilitiesMinor, refsFor(["liability"]), "total"));
  position.push(row("sfp:net-assets", "Total net assets/equity", "total", p => p.totals.netAssetsMinor, p => [...refsFor(["net-assets"])(p), "sfperf:surplus"], "total"));
  const performance = keys.filter(k => ["revenue", "expense"].includes(metadata(k).nature)).map(k => row(`sfperf:${k}`, metadata(k).label, metadata(k).nature,
    p => String(BigInt(value(p, k)) * (metadata(k).nature === "expense" ? -1n : 1n)), p => accountRefs(p, k)));
  performance.push(row("sfperf:revenue", "Total revenue", "total", p => p.totals.revenueMinor, refsFor(["revenue"]), "total"));
  performance.push(row("sfperf:expense", "Total expenses", "total", p => p.totals.expenseMinor, refsFor(["expense"]), "total"));
  performance.push(row("sfperf:surplus", "Surplus / (deficit)", "total", p => p.totals.surplusMinor, () => ["sfperf:revenue", "sfperf:expense"], "total"));
  const movementKeys = [...new Set(periods.flatMap(p => p.netAssets.otherMovements.map(m => m.id)))].sort(order);
  const netAssets = [row("scna:opening", "Opening net assets/equity", "opening", p => p.netAssets.openingMinor, p => [`evidence:${periodSource(p).netAssets.evidenceId}`]),
    row("scna:surplus", "Surplus / (deficit)", "movement", p => p.totals.surplusMinor, () => ["sfperf:surplus"]),
    ...movementKeys.map(k => row(`scna:movement:${k}`, periods.flatMap(p => p.netAssets.otherMovements).find(m => m.id === k)!.label, "movement",
      p => p.netAssets.otherMovements.find(m => m.id === k)?.amountMinor ?? "0", p => p.netAssets.otherMovements.filter(m => m.id === k).map(m => `evidence:${m.evidenceId}`))),
    row("scna:closing", "Closing net assets/equity", "total", p => p.totals.netAssetsMinor, () => ["sfp:net-assets"], "total")];
  const cashKeys = [...new Set(periods.flatMap(p => p.cashFlow.lines.map(r => r.id)))].sort(order);
  const cash = cashKeys.map(k => row(`scf:${k}`, periods.flatMap(p => p.cashFlow.lines).find(r => r.id === k)!.label,
    periods.flatMap(p => p.cashFlow.lines).find(r => r.id === k)!.activity, p => p.cashFlow.lines.find(r => r.id === k)?.amountMinor ?? "0",
    p => (p.cashFlow.lines.find(r => r.id === k)?.evidence ?? []).flatMap(e => [`movement:${e.movementId}`, `evidence:${e.evidenceId}`])));
  for (const activity of ["operating", "investing", "financing"]) cash.push(row(`scf:${activity}`, `Net cash from ${activity} activities`, activity,
    p => p.cashFlow.activities.find(a => a.id === activity)!.amountMinor, p => p.cashFlow.lines.filter(l => l.activity === activity).map(l => `row:scf:${l.id}`), "total"));
  cash.push(row("scf:opening", "Opening cash and cash equivalents", "reconciliation", p => p.cashFlow.openingMinor, p => p.cashFlow.openings.map(o => `evidence:${o.evidenceId}`)),
    row("scf:exchange", "Effect of exchange-rate changes", "reconciliation", p => p.cashFlow.exchangeEffectMinor, p => p.cashFlow.openings.map(o => `evidence:${o.evidenceId}`)),
    row("scf:closing", "Closing cash and cash equivalents", "total", p => p.cashFlow.closingMinor, () => ["sfp:cash:current"], "total"));
  return [{ id: "SFP", title: "Statement of financial position", rows: position }, { id: "SFPERF", title: "Statement of financial performance", rows: performance },
    { id: "SCNA", title: "Statement of changes in net assets/equity — aggregate workpaper", rows: netAssets }, { id: "SCF", title: "Statement of cash flows — direct method", rows: cash }];
}

export function composeIpsasStatements(raw: unknown) {
  const input = statementSetInput.parse(jsonSnapshot(raw));
  const source = prepareNgo(input.preparation).sourceSnapshot;
  const addedEvidence = [...input.comparativeRestatements.map(j => j.evidence), ...input.notes.flatMap(n => n.evidence), ...input.requirements.flatMap(r => r.evidence ? [r.evidence] : [])];
  if (addedEvidence.length) scopedEvidence(source.scope, addedEvidence);
  const evidenceVersions = new Map<string, string>();
  for (const e of [...source.evidence, ...addedEvidence]) {
    const fingerprint = digest(e);
    if (evidenceVersions.has(e.id) && evidenceVersions.get(e.id) !== fingerprint) refuse("EVIDENCE_ID_REUSED");
    evidenceVersions.set(e.id, fingerprint);
  }
  const { original, restated, journals, consumedBridges } = restate(source, input.comparativeRestatements);
  const report = statements(original.current, original.comparative, restated, source);
  for (const row of report.flatMap(s => s.rows)) {
    if (!row.comparative) continue;
    for (const j of journals) if (j.entries.some(e => row.comparative!.sourceRefs.includes(`account:${e.accountId}`))) row.comparative.sourceRefs.push(`comparative-journal:${j.id}`);
  }
  const blockers = new Set(original.blockers);
  const checks: { id: string; differenceMinor: string | null; state: "agrees" | "difference" | "missing" }[] = [];
  const check = (id: string, difference: bigint | null) => {
    const state = difference === null ? "missing" : difference === 0n ? "agrees" : "difference";
    checks.push({ id, differenceMinor: difference === null ? null : String(difference), state });
    if (state !== "agrees") blockers.add(`RECONCILIATION:${id}`);
  };
  for (const [name, p] of [["current", original.current], ["comparative", restated]] as const) {
    if (!p) continue;
    check(`${name}:position`, BigInt(p.totals.positionDifferenceMinor));
    check(`${name}:net-assets`, p.netAssets.openingMinor === null ? null : BigInt(p.netAssets.openingMinor) + BigInt(p.totals.surplusMinor) + sum(p.netAssets.otherMovements.map(m => m.amountMinor)) - BigInt(p.totals.netAssetsMinor));
    check(`${name}:cash`, BigInt(p.cashFlow.openingMinor) + sum(p.cashFlow.activities.map(a => a.amountMinor)) + BigInt(p.cashFlow.exchangeEffectMinor) - BigInt(p.cashFlow.closingMinor));
    blockers.add(`NET_ASSET_COMPONENT_WORKPAPER_REQUIRED:${name}`);
  }
  if (restated) {
    const remaining = source.openingAdjustments.filter(b => !consumedBridges.has(b.id));
    check("opening-net-assets", original.current.netAssets.openingMinor === null ? null : BigInt(original.current.netAssets.openingMinor) - BigInt(restated.totals.netAssetsMinor) - sum(remaining.map(b => b.amountMinor)));
    check("opening-cash", BigInt(original.current.cashFlow.openingMinor) - BigInt(restated.cashFlow.closingMinor));
    // The original as-reported bridge is separately retained; the effective bridge above uses each adjustment once.
    if (checks.find(c => c.id === "opening-net-assets")!.state === "agrees") blockers.delete("OPENING_NET_ASSETS_BRIDGE_DIFFERENCE");
  }
  const budget = original.budget ? { ...original.budget, rows: [...original.budget.rows].sort((a, b) => order(a.id, b.id)), reconciliations: [...original.budget.reconciliations].sort((a, b) => order(a.name, b.name)) } : null;
  if (original.profile.budgetComparison !== "not-applicable-by-recorded-assessment") {
    report.push({ id: "SCBA", title: "Statement of comparison of budget and actual amounts", rows: (budget?.rows ?? []).map(r => ({
      id: `budget:${r.id}`, label: r.label, section: r.activity, role: "detail", current: { amountMinor: r.actualMinor, sourceRefs: [`evidence:${r.evidenceId}`] },
      asReported: null, comparative: null, noteIds: [],
    })) });
    if (!budget) blockers.add("BUDGET_PREPARATION_REQUIRED");
  }
  distinct(input.notes.map(n => n.id), "DUPLICATE_NOTE_ID");
  distinct(input.requirements.map(r => r.id), "DUPLICATE_REQUIREMENT_ID");
  const targetRows = new Map(report.flatMap(s => s.rows).map(r => [r.id, r]));
  const notes = [...input.notes].sort((a, b) => order(a.id, b.id)).map((n, index) => {
    scopedEvidence(source.scope, n.evidence);
    distinct(n.rows.map(r => r.id), "DUPLICATE_NOTE_ROW");
    const ids = new Set(n.evidence.map(e => e.id));
    for (const r of n.rows) if (!ids.has(r.evidenceId)) refuse("NOTE_FIGURE_EVIDENCE_MISSING");
    distinct(n.ties.map(t => t.target), "DUPLICATE_NOTE_TIE");
    for (const tie of n.ties) {
      const target = targetRows.get(tie.target);
      if (!target || tie.target.startsWith("budget:")) refuse("NOTE_TIE_TARGET_UNKNOWN");
      distinct(tie.rowIds, "DUPLICATE_NOTE_TIE_ROW");
      const rows = tie.rowIds.map(id => { const r = n.rows.find(r => r.id === id); if (!r) refuse("NOTE_TIE_ROW_UNKNOWN"); return r; });
      for (const column of ["current", "comparative"] as const) {
        const cell = target[column]; if (column === "comparative" && !restated) continue;
        const values = rows.map(r => column === "current" ? r.currentMinor : r.comparativeMinor);
        const unknown = !cell || cell.amountMinor === null || values.some(v => v === null);
        check(`note:${n.id}:${tie.target}:${column}`, unknown ? null : sum(values as string[]) - BigInt(cell!.amountMinor!));
      }
      target.noteIds.push(n.id);
    }
    return { ...n, number: index + 1 };
  });
  for (const r of input.requirements) {
    if (r.evidence) scopedEvidence(source.scope, [r.evidence]);
    if (r.applicability === "unresolved" || !r.evidence) blockers.add(`REQUIREMENT_ASSESSMENT_REQUIRED:${r.id}`);
    if (r.applicability === "applicable") {
      if (!["supported", "external-workpaper"].includes(r.support)) blockers.add(`REQUIREMENT_UNSUPPORTED:${r.id}`);
      if (r.support === "external-workpaper") blockers.add(`GOVERNED_WORKPAPER_SERVER_VERIFICATION_REQUIRED:${r.id}`);
      for (const id of r.noteIds) if (!notes.some(n => n.id === id && n.requirementId === r.id)) blockers.add(`REQUIRED_NOTE_MISSING:${r.id}:${id}`);
    }
  }
  if (!input.requirements.length) blockers.add("REQUIREMENT_CHECKLIST_MISSING");
  blockers.add("AUTHENTICATED_SOURCE_BINDING_NOT_IMPLEMENTED");
  blockers.add("ACCOUNTANT_ACCEPTANCE_OUTSTANDING");
  const tasks: Task[] = [...blockers].sort(order).map(code => ({ code, target: code.startsWith("RECONCILIATION:note:") ? "notes" : code.includes("BUDGET") ? "budget" : code.includes("COMPARATIVE") || code.includes("TRANSITION") || code.includes("opening") ? "comparatives" : "review",
    action: code.startsWith("RECONCILIATION:") ? "Open the named reconciliation and correct its source figures or record the required evidenced bridge; do not insert a balancing amount."
      : code.includes("REQUIRED_NOTE") ? "Complete the named disclosure from confirmed facts and reconcile its figures to the statement."
      : code.includes("BUDGET") ? "Confirm budget applicability, import the approved original and final budget, and complete the comparable-basis reconciliation."
      : code.includes("TRANSITION") || code.includes("COMPARATIVE") ? "Have the accounting reviewer resolve the reporting-period standard and comparative treatment using the cited transition workpaper."
      : "Resolve this named requirement with its responsible reviewer; this draft cannot be approved or issued.",
    acceptedEvidence: code.includes("RECONCILIATION") ? "Confirmed source rows, referenced journals or a reviewed reconciliation workpaper." : "Entity- and period-specific source evidence and the relevant reviewed requirement.",
    owner: code.includes("HOSTED") || code.includes("AUTHENTICATED") ? "technical-owner" : code.includes("ACCOUNT") || code.includes("FRAMEWORK") || code.includes("TRANSITION") || code.includes("REQUIREMENT") ? "accounting-reviewer" : "preparer" }));
  const normal = report.map(s => ({ id: s.id, rows: s.rows.map(r => ({ id: r.id, current: r.current.amountMinor, comparative: r.comparative?.amountMinor ?? null, asReported: r.asReported?.amountMinor ?? null })) }));
  const result = { schema: "ipsas-statement-set/1", label: "INCOMPLETE DRAFT — NOT APPROVED OR ISSUED", scope: source.scope, legalName: source.legalName,
    statements: report, budget, notes, checks, tasks, comparativeJournalAudit: journals,
    originalComparative: original.comparative, effectiveComparative: restated,
    inputSha256: digest(input), accountingResultSha256: digest({ scope: source.scope, comparativePeriod: source.comparative?.period ?? null, standards: original.profile.selected, statements: normal,
      notes: notes.map(n => ({ id: n.id, rows: [...n.rows].sort((a, b) => order(a.id, b.id)).map(r => ({ id: r.id, current: r.currentMinor, comparative: r.comparativeMinor })) })),
      budget: budget ? { basis: budget.basis, period: source.budget?.budgetPeriod, rows: budget.rows.map(r => ({ id: r.id, original: r.originalMinor, final: r.finalMinor, actual: r.actualMinor })),
        reconciliations: budget.reconciliations.map(r => ({ name: r.name, actual: r.budgetActualMinor, financialStatement: r.financialStatementMinor,
          bridge: r.bridge.map(b => ({ kind: b.kind, amount: b.amountMinor })).sort((a, b) => order(canonicalStringify(a), canonicalStringify(b))), difference: r.differenceMinor })) } : null }),
    provenanceSha256: digest({ source: original.provenanceSha256, journals, notes, requirements: input.requirements }),
    officialIssuance: { available: false as const, reasons: [...blockers].sort(order) }, publicationAuthorized: false as const };
  return frozen(result);
}
export type IpsasStatementSet = ReturnType<typeof composeIpsasStatements>;
