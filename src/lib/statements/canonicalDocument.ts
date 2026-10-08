// statements/canonicalDocument.ts — the statements of financial position and comprehensive income as CANONICAL statements
// and facts, built deterministically from the database's composition (fs_statement_composition) under the fixed fact
// identities the sign-off checks (20261021100000):
//
//   fact:<current|comparative>:<section>:<lineId>     each composed line
//   fact:<current|comparative>:total:<key>             each total of a complete period (e.g. totalAssetsMinor)
//
//   fact:<current|comparative>:account:<accountKey>    each presented account of a line (from the composition lineage)
//   fact:comparative:restatement:<id>:<section>:<lineId>  each approved restatement delta of the comparative
//
// The database refuses REVIEWED/FINAL unless the report carries exactly these figures and nothing else on these two
// statements (STATEMENT_FIGURE_MISMATCH / STATEMENT_FIGURE_NOT_COMPOSED). Nothing is added up here: every amount is a
// server figure. Statements built from evidence (cash flows, changes in equity) come from the existing generators.

import { CANONICAL_SCHEMA_VERSION } from "@/lib/canonicalStatement/types";
import type { CanonicalFinancialStatementReport, MonetaryFact, Statement, StatementLine, StatementSection } from "@/lib/canonicalStatement/types";
import type { Composition, CompositionLine } from "./composition";

export const COMPOSED_CURRENT_PERIOD_ID = "CURRENT";
export const COMPOSED_COMPARATIVE_PERIOD_ID = "COMPARATIVE_1";

export interface ReportingDependenciesRef {
  readonly dependenciesSha256: string;
  readonly compositionSha256: string;
  readonly notesStatusSha256: string | null;
  readonly comparativeStatusSha256: string | null;
}

type Period = "current" | "comparative";
const periodId = (p: Period) => (p === "current" ? COMPOSED_CURRENT_PERIOD_ID : COMPOSED_COMPARATIVE_PERIOD_ID);
export const lineFactId = (p: Period, section: string, lineId: string) => `fact:${p}:${section}:${lineId}`;
export const totalFactId = (p: Period, key: string) => `fact:${p}:total:${key}`;

const SECTION_LABELS: Record<string, string> = {
  non_current_assets: "Non-current assets", current_assets: "Current assets", equity: "Equity",
  non_current_liabilities: "Non-current liabilities", current_liabilities: "Current liabilities",
};
const ASSET_SECTIONS = new Set(["non_current_assets", "current_assets"]);
const INCOME_LINES = new Set(["sci.revenue", "sci.other_income", "sci.share_of_associates"]);

export interface ComposedStatements {
  readonly comparativePeriods: CanonicalFinancialStatementReport["comparativePeriods"];
  readonly statements: readonly Statement[];
  readonly facts: readonly MonetaryFact[];
}

/**
 * SFP and SCI canonical statements + facts from the composition. The comparative period's dates are the authoritative
 * reporting input's (fs_reporting_input comparative.reportingStart / reportingEnd) — never assumed; without them, when a
 * comparative is composed, this refuses.
 */
export function composedStatements(c: Composition, comparativeDates: { readonly start: string; readonly end: string } | null): ComposedStatements {
  const periods: Period[] = c.comparative.state === "available" ? ["current", "comparative"] : ["current"];
  const facts: MonetaryFact[] = [];
  const money = (minor: string) => ({ currency: c.current.currency, scale: c.current.exponent, minorUnits: BigInt(minor) });
  const fact = (id: string, p: Period, minor: string, sign: MonetaryFact["signConvention"], originalText: string, locatorNote: string): void => {
    facts.push({
      factId: id, version: 1, value: money(minor),
      reportingPeriod: { periodId: periodId(p), isComparative: p === "comparative" },
      signConvention: sign,
      provenance: {
        source: { sourceDocumentId: p === "current" ? c.current.certificationId : c.comparative.certificationId ?? c.current.certificationId, sourceHash: c.inputSha256, artifactKind: "TRIAL_BALANCE" },
        locator: { kind: "MANUAL", note: locatorNote },
        extractionMethod: "TRIAL_BALANCE_DERIVED",
        extractionConfidence: { kind: "CERTAIN" },
        originalText,
      },
      supersedesVersion: null,
    });
  };
  const bindings = (idFor: (p: Period) => string) => periods.map((p) => ({ periodId: periodId(p), factId: idFor(p) }));

  // Each composed line is a SUBTOTAL casting its presented accounts (DETAIL lines line:detail:<sfp|sci>:<accountKey> —
  // the identity the cash-ledger authority reads per account) and, on the comparative, any approved restatement delta.
  // Every amount is the server's (the line from the composition; each account and delta from its lineage).
  const composedLine = (l: CompositionLine): StatementLine[] => {
    const sign: MonetaryFact["signConvention"] = l.statement === "SFP" ? (ASSET_SECTIONS.has(l.section) ? "DEBIT_POSITIVE" : "CREDIT_POSITIVE") : (INCOME_LINES.has(l.lineId) ? "CREDIT_POSITIVE" : "DEBIT_POSITIVE");
    const normal: StatementLine["normalBalance"] = sign === "DEBIT_POSITIVE" ? "DEBIT_NORMAL" : "CREDIT_NORMAL";
    const stmt = l.statement === "SFP" ? "sfp" : "sci";
    const children = new Map<string, { label: string; byPeriod: Map<Period, string> }>();
    for (const x of l.lineage) {
      const p = x.period as Period;
      if (!periods.includes(p)) continue;
      const childId = x.kind === "restatement" ? `line:restatement:${x.restatementId}:${l.section}:${l.lineId}` : `line:detail:${stmt}:${x.accountKey}`;
      const factId = x.kind === "restatement" ? `fact:comparative:restatement:${x.restatementId}:${l.section}:${l.lineId}` : `fact:${p}:account:${x.accountKey}`;
      const label = x.kind === "restatement" ? `Restatement of ${l.label}` : `${x.accountCode ?? x.accountKey} ${x.accountName}`;
      fact(factId, p, x.amountMinor, sign, `${label}: ${x.amountMinor}`, `fs_statement_composition lineage ${l.lineId} ${x.kind}`);
      const ch = children.get(childId) ?? { label, byPeriod: new Map<Period, string>() };
      ch.byPeriod.set(p, factId);
      children.set(childId, ch);
    }
    for (const p of periods) {
      const a = p === "current" ? l.current : l.comparative;
      if (!a) continue;
      fact(lineFactId(p, l.section, l.lineId), p, a.amountMinor, sign, `${l.label}: ${a.amountMinor} (composed by the database from ${a.accounts} account(s))`, `fs_statement_composition ${l.statement} ${l.section} ${l.lineId}`);
    }
    const detailLines: StatementLine[] = [...children.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, ch]) => ({
      lineId: id, label: ch.label, concept: `${l.lineId}#component`, role: "DETAIL", normalBalance: normal, isContra: false,
      factBindings: periods.filter((p) => ch.byPeriod.has(p)).map((p) => ({ periodId: periodId(p), factId: ch.byPeriod.get(p)! })), castingChildLineIds: [],
    }));
    return [...detailLines, {
      lineId: `line:${l.section}:${l.lineId}`, label: l.label, concept: l.lineId, role: "SUBTOTAL", normalBalance: normal, isContra: false,
      factBindings: bindings((p) => lineFactId(p, l.section, l.lineId)).filter((b) => facts.some((f) => f.factId === b.factId)), castingChildLineIds: detailLines.map((d) => d.lineId),
    }];
  };
  const totalsComplete = (p: Period) => c.totals[p]?.state === "complete";
  const total = (stmt: "sfp" | "sci", key: string, label: string, concept: string, role: "SUBTOTAL" | "TOTAL", normal: StatementLine["normalBalance"], children: string[]): StatementLine | null => {
    const ps = periods.filter(totalsComplete);
    if (ps.length === 0) return null;
    for (const p of ps) {
      const t = c.totals[p] as Record<string, string>;
      fact(totalFactId(p, key), p, t[key], normal === "DEBIT_NORMAL" ? "DEBIT_POSITIVE" : "CREDIT_POSITIVE", `${label}: ${t[key]} (database total)`, `fs_statement_composition total ${key}`);
    }
    // Line ids are unique report-wide (a figure shown on both statements is one fact on two lines).
    return { lineId: `line:${stmt}:total:${key}`, label, concept, role, normalBalance: normal, isContra: false,
      factBindings: ps.map((p) => ({ periodId: periodId(p), factId: totalFactId(p, key) })), castingChildLineIds: children };
  };
  const section = (id: string, keys: [string, string, string] | null): StatementSection => {
    const lines = c.lines.filter((l) => l.statement === "SFP" && l.section === id).flatMap(composedLine);
    const sub = keys ? total("sfp", keys[0], keys[1], keys[2], "SUBTOTAL", ASSET_SECTIONS.has(id) ? "DEBIT_NORMAL" : "CREDIT_NORMAL", lines.filter((x) => x.role === "SUBTOTAL").map((x) => x.lineId)) : null;
    return { sectionId: `section:${id}`, label: SECTION_LABELS[id], lines: sub ? [...lines, sub] : lines };
  };
  const sfpTotals = (): StatementSection => {
    const lines = [
      total("sfp", "totalAssetsMinor", "Total assets", "total_assets", "TOTAL", "DEBIT_NORMAL", []),
      total("sfp", "profitOrLossMinor", "Profit or loss for the period (not yet transferred to equity accounts)", "profit_or_loss_for_period_in_equity", "SUBTOTAL", "CREDIT_NORMAL", []),
      total("sfp", "totalEquityMinor", "Total equity", "total_equity", "TOTAL", "CREDIT_NORMAL", []),
      total("sfp", "totalLiabilitiesMinor", "Total liabilities", "total_liabilities", "TOTAL", "CREDIT_NORMAL", []),
      total("sfp", "totalEquityAndLiabilitiesMinor", "Total equity and liabilities", "total_equity_and_liabilities", "TOTAL", "CREDIT_NORMAL", []),
    ].filter((x): x is StatementLine => x !== null);
    return { sectionId: "section:sfp-totals", label: "Totals", lines };
  };
  const sfp: Statement = {
    statementId: "stmt:sfp", type: "STATEMENT_OF_FINANCIAL_POSITION", title: "Statement of Financial Position",
    sections: [
      section("non_current_assets", ["nonCurrentAssetsMinor", "Total non-current assets", "total_non_current_assets"]),
      section("current_assets", ["currentAssetsMinor", "Total current assets", "total_current_assets"]),
      section("equity", ["equityAccountsMinor", "Equity accounts", "equity_accounts"]),
      section("non_current_liabilities", ["nonCurrentLiabilitiesMinor", "Total non-current liabilities", "total_non_current_liabilities"]),
      section("current_liabilities", ["currentLiabilitiesMinor", "Total current liabilities", "total_current_liabilities"]),
      sfpTotals(),
    ],
  };
  const sciLines = c.lines.filter((l) => l.statement === "SCI").flatMap(composedLine);
  const sciTotals = [
    total("sci", "incomeMinor", "Total income", "total_income", "SUBTOTAL", "CREDIT_NORMAL", []),
    total("sci", "expensesExcludingTaxMinor", "Total expenses (excluding tax)", "total_expenses_excluding_tax", "SUBTOTAL", "DEBIT_NORMAL", []),
    total("sci", "profitBeforeTaxMinor", "Profit before tax", "profit_before_tax", "SUBTOTAL", "CREDIT_NORMAL", []),
    total("sci", "taxExpenseMinor", "Tax expense (total)", "total_tax_expense", "SUBTOTAL", "DEBIT_NORMAL", []),
    total("sci", "profitOrLossMinor", "Profit or loss for the period", "profit_or_loss", "TOTAL", "CREDIT_NORMAL", []),
  ].filter((x): x is StatementLine => x !== null);
  const sci: Statement = {
    statementId: "stmt:sci", type: "STATEMENT_OF_PROFIT_OR_LOSS", title: "Statement of Comprehensive Income",
    sections: [{ sectionId: "section:sci", label: "Profit or loss", lines: [...sciLines, ...sciTotals] }],
  };
  // The balance check is a total of its own (always zero when the database reports no BALANCE_DIFFERENCE blocker).
  const diff = total("sfp", "balanceDifferenceMinor", "Balance check (assets less equity and liabilities)", "balance_difference", "SUBTOTAL", "DEBIT_NORMAL", []);
  if (diff) (sfp.sections[sfp.sections.length - 1].lines as StatementLine[]).push(diff);

  // Facts must be unique by id (the totals helper is called once per key); sort for a deterministic document.
  const unique = [...new Map(facts.map((f) => [f.factId, f])).values()].sort((a, b) => (a.factId < b.factId ? -1 : 1));
  if (periods.includes("comparative") && (!comparativeDates || c.comparative.periodYear === null)) {
    throw new Error("composedStatements: the comparative is composed but its period dates were not supplied from the reporting input");
  }
  const comparativePeriods = periods.includes("comparative") && comparativeDates && c.comparative.periodYear !== null
    ? [{ periodId: COMPOSED_COMPARATIVE_PERIOD_ID, startDate: comparativeDates.start, endDate: comparativeDates.end, periodYear: c.comparative.periodYear,
         isRestated: c.comparative.restatementIds.length > 0, ...(c.comparative.restatementIds.length > 0 ? { restatementReason: "Restated: approved restatements of the comparative (see the comparatives note)" } : {}) }]
    : [];
  return { comparativePeriods, statements: [sfp, sci], facts: unique };
}

export { CANONICAL_SCHEMA_VERSION };
