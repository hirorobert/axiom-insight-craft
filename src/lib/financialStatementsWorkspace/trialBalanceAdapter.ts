// financialStatementsWorkspace/trialBalanceAdapter.ts — Phase 2: the first
// operational canonicalStatement adapter. Implements
// canonicalStatement/adapters.ts's `TrialBalanceAdapter`, converting an
// already-reviewed set of trial-balance account lines (the output of the
// existing account_mappings/account-review authority — never raw,
// unreviewed trial-balance rows) into a canonical `AdapterExtractionResult`.
//
// What this version deliberately does NOT attempt, and why:
//
//   - Statement of Cash Flows: DEFECT-SAFISHA-TRANSACTION-LEDGER-GAP-001
//     (CLAUDE.md §9.1) registers that this repository has no
//     period-complete, classified cash-movement ledger. A trial balance's
//     operating/investing/financing_activities classifications are
//     structurally insufficient to build an honest cash flow statement.
//     Lines classified into those three SCF buckets are accepted as valid
//     input (never rejected) but are excluded from the extraction, each
//     producing a WARNING diagnostic — never silently dropped.
//   - Statement of Changes in Equity: a genuine SOCIE roll-forward needs
//     opening equity + dividends/transfers, which a single period's
//     reviewed trial balance does not carry. Not fabricated.
//   - Net profit / total comprehensive income on the P&L: the canonical
//     rule pack's subtotal-casting rule (Rule 2) sums a total's declared
//     children with plain, unsigned addition. A trial balance's natural-
//     balance-direction figures cannot be summed that way into a
//     mathematically correct net result without a distinct signed
//     contribution-to-profit representation this adapter version does not
//     yet implement — inventing one here risked a subtly wrong number
//     reaching a reviewer's screen, which is worse than an honest
//     omission. The P&L statement is emitted as section subtotals only
//     (Revenue, Cost of Sales, Operating Expenses, Other Income,
//     Taxation), with a WARNING diagnostic noting the omission.
//   - IPSAS_CASH: this adapter builds STATEMENT_OF_FINANCIAL_POSITION /
//     STATEMENT_OF_PROFIT_OR_LOSS only — it never produces a
//     STATEMENT_OF_CASH_RECEIPTS_AND_PAYMENTS. `TrialBalanceNormalizationInput`
//     carries no framework (that is orchestrator-level knowledge — see
//     evaluationOrchestrator.ts), so an IPSAS_CASH company must be rejected
//     by the ORCHESTRATOR before it ever calls this adapter, not here;
//     `validateCanonicalReport` would in any case reject the resulting
//     aggregate (an IPSAS_CASH report may not contain an SFP — see
//     validation.ts's framework-specific structural checks).

import { z } from "zod";
import { sumMoney, type CurrencyCode, type Money } from "@/lib/canonicalStatement/money";
import type {
  AccountingPolicy,
  MonetaryFact,
  Note,
  ReportingPeriodRef,
  Statement,
  StatementLine,
  StatementSection,
  TextualDisclosure,
} from "@/lib/canonicalStatement/types";
import { CANONICAL_CONCEPTS } from "@/lib/canonicalStatement/concepts";
import type { AdapterExtractionResult, TrialBalanceAdapter, TrialBalanceNormalizationInput } from "@/lib/canonicalStatement/adapters";
import { AdapterRejectedError, type AdapterDiagnostic, type AdapterIdentity } from "./adapterContract";
import { numberToMoneyExact, UnsafeMagnitudeError, UnsupportedPrecisionError } from "./moneyConversion";

export const TRIAL_BALANCE_ADAPTER_VERSION = "1.0.0";

export const TRIAL_BALANCE_ADAPTER_IDENTITY: AdapterIdentity = {
  adapterKind: "TRIAL_BALANCE",
  adapterVersion: TRIAL_BALANCE_ADAPTER_VERSION,
};

// ─── Input contract ────────────────────────────────────────────────────────

const SFP_CLASSIFICATIONS = ["current_assets", "non_current_assets", "current_liabilities", "non_current_liabilities", "equity"] as const;
const PL_CLASSIFICATIONS = ["revenue", "cost_of_goods_sold", "operating_expenses", "other_income", "taxes"] as const;
const SCF_CLASSIFICATIONS = ["operating_activities", "investing_activities", "financing_activities"] as const;

export type AccountClassification =
  | (typeof SFP_CLASSIFICATIONS)[number]
  | (typeof PL_CLASSIFICATIONS)[number]
  | (typeof SCF_CLASSIFICATIONS)[number];

/** One reviewed trial-balance account line, for one period, already resolved by the existing account_mappings/account-review authority — never a raw, unreviewed row. */
export interface ReviewedTrialBalanceAccountLine {
  readonly accountKey: string;
  readonly accountCode?: string;
  readonly accountName: string;
  readonly statement: "balance_sheet" | "income_statement";
  readonly classification: AccountClassification;
  readonly normalBalance: "debit" | "credit";
  /** The reported natural-balance-direction magnitude, exactly as account_mappings/process-trial-balance presents it (never pre-signed). */
  readonly balance: number;
  readonly currency: CurrencyCode;
  readonly scale: number;
  readonly periodId: string;
  readonly isComparative: boolean;
  readonly isCashAccount: boolean;
  readonly isRetainedEarnings: boolean;
  readonly isPayrollAccount: boolean;
  readonly sourceUploadId: string;
  /** sha256 of the reviewed dataset this line was drawn from — content identity, mirroring the intake function's own discipline. */
  readonly sourceHash: string;
}

const reviewedLineSchema = z.object({
  accountKey: z.string().min(1),
  accountCode: z.string().optional(),
  accountName: z.string().min(1),
  statement: z.enum(["balance_sheet", "income_statement"]),
  classification: z.enum([...SFP_CLASSIFICATIONS, ...PL_CLASSIFICATIONS, ...SCF_CLASSIFICATIONS]),
  normalBalance: z.enum(["debit", "credit"]),
  balance: z.number(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  scale: z.number().int().nonnegative(),
  periodId: z.string().min(1),
  isComparative: z.boolean(),
  isCashAccount: z.boolean(),
  isRetainedEarnings: z.boolean(),
  isPayrollAccount: z.boolean(),
  sourceUploadId: z.string().min(1),
  sourceHash: z.string().regex(/^[0-9a-fA-F]{64}$/),
});

// ─── Section metadata ──────────────────────────────────────────────────────

interface SectionMeta {
  readonly classification: AccountClassification;
  readonly label: string;
  readonly normalBalance: "DEBIT_NORMAL" | "CREDIT_NORMAL";
}

const SFP_SECTIONS: readonly SectionMeta[] = [
  { classification: "current_assets", label: "Current Assets", normalBalance: "DEBIT_NORMAL" },
  { classification: "non_current_assets", label: "Non-current Assets", normalBalance: "DEBIT_NORMAL" },
  { classification: "current_liabilities", label: "Current Liabilities", normalBalance: "CREDIT_NORMAL" },
  { classification: "non_current_liabilities", label: "Non-current Liabilities", normalBalance: "CREDIT_NORMAL" },
  { classification: "equity", label: "Equity", normalBalance: "CREDIT_NORMAL" },
];

const PL_SECTIONS: readonly SectionMeta[] = [
  { classification: "revenue", label: "Revenue", normalBalance: "CREDIT_NORMAL" },
  { classification: "cost_of_goods_sold", label: "Cost of Sales", normalBalance: "DEBIT_NORMAL" },
  { classification: "operating_expenses", label: "Operating Expenses", normalBalance: "DEBIT_NORMAL" },
  { classification: "other_income", label: "Other Income", normalBalance: "CREDIT_NORMAL" },
  { classification: "taxes", label: "Taxation", normalBalance: "DEBIT_NORMAL" },
];

const ASSET_CLASSIFICATIONS = ["current_assets", "non_current_assets"] as const;
const LIABILITY_CLASSIFICATIONS = ["current_liabilities", "non_current_liabilities"] as const;

// ─── Diagnostic codes ──────────────────────────────────────────────────────

const CODE = {
  SCHEMA_INVALID: "TB_SCHEMA_INVALID",
  NO_LINES: "TB_NO_REVIEWED_LINES",
  INCONSISTENT_SOURCE: "TB_INCONSISTENT_SOURCE",
  NO_CURRENT_PERIOD: "TB_NO_CURRENT_PERIOD_DATA",
  STATEMENT_CLASSIFICATION_MISMATCH: "TB_STATEMENT_CLASSIFICATION_MISMATCH",
  DUPLICATE_ACCOUNT_IN_PERIOD: "TB_DUPLICATE_ACCOUNT_IN_PERIOD",
  UNCONVERTIBLE_AMOUNT: "TB_UNCONVERTIBLE_AMOUNT",
  CASH_FLOW_CLASSIFICATION_SKIPPED: "TB_CASH_FLOW_CLASSIFICATION_SKIPPED",
  NET_RESULT_NOT_COMPUTED: "TB_NET_RESULT_NOT_COMPUTED",
} as const;

function blocking(code: string, message: string, extra: Partial<AdapterDiagnostic> = {}): AdapterDiagnostic {
  return { code, severity: "BLOCKING", message, ...extra };
}

function warning(code: string, message: string, extra: Partial<AdapterDiagnostic> = {}): AdapterDiagnostic {
  return { code, severity: "WARNING", message, ...extra };
}

// ─── Normalization ─────────────────────────────────────────────────────────

interface ConvertedLine extends ReviewedTrialBalanceAccountLine {
  readonly convertedValue: Money;
}

function sumIfAllPresent(values: readonly (Money | undefined)[]): Money | null {
  if (values.length === 0 || values.some((v) => v === undefined)) return null;
  return sumMoney(values as Money[]);
}

function reportingPeriodRef(periodId: string, isComparative: boolean): ReportingPeriodRef {
  return { periodId, isComparative };
}

function buildFact(
  factId: string,
  value: Money,
  period: ReportingPeriodRef,
  accountCode: string,
  uploadId: string,
  sourceHash: string,
  originalText: string,
): MonetaryFact {
  return {
    factId,
    version: 1,
    value,
    reportingPeriod: period,
    signConvention: "NATURAL",
    provenance: {
      source: { sourceDocumentId: uploadId, sourceHash, artifactKind: "TRIAL_BALANCE" },
      locator: { kind: "TRIAL_BALANCE_ROW", accountCode, uploadId },
      extractionMethod: "TRIAL_BALANCE_DERIVED",
      extractionConfidence: { kind: "CERTAIN" },
      originalText,
    },
    supersedesVersion: null,
  };
}

/**
 * Builds one statement (SFP or P&L) from its converted lines. `statementKind`
 * namespaces every generated id so the two statements' ids never collide.
 * `sections` is the fixed, ordered section metadata for this statement type.
 * `anchorTotals`, when provided, additionally builds the four SFP anchor
 * TOTAL lines (total_assets / total_liabilities / total_equity /
 * total_liabilities_and_equity) from the section subtotals just built.
 */
function buildStatement(
  statementKind: "sfp" | "pl",
  statementId: string,
  statementType: Statement["type"],
  title: string,
  sections: readonly SectionMeta[],
  lines: readonly ConvertedLine[],
  periodIds: readonly string[],
  periodIsComparative: ReadonlyMap<string, boolean>,
  buildAnchors: boolean,
): { statement: Statement; facts: MonetaryFact[] } {
  const facts: MonetaryFact[] = [];
  const outputSections: StatementSection[] = [];
  const sectionSubtotalLineIdByClassification = new Map<string, string>();
  /** lineId -> periodId -> its own resolved Money value, populated as each line is built so later TOTAL lines can sum by lineId without ever reconstructing a factId. */
  const valueByLineAndPeriod = new Map<string, Map<string, Money>>();

  function recordValue(lineId: string, periodId: string, value: Money): void {
    const byPeriod = valueByLineAndPeriod.get(lineId) ?? new Map<string, Money>();
    byPeriod.set(periodId, value);
    valueByLineAndPeriod.set(lineId, byPeriod);
  }

  function valueOfLineForPeriod(lineId: string | undefined, periodId: string): Money | undefined {
    if (!lineId) return undefined;
    return valueByLineAndPeriod.get(lineId)?.get(periodId);
  }

  for (const section of sections) {
    const sectionLines = lines.filter((l) => l.classification === section.classification);
    if (sectionLines.length === 0) continue;

    const byAccountKey = new Map<string, ConvertedLine[]>();
    for (const l of sectionLines) {
      const bucket = byAccountKey.get(l.accountKey) ?? [];
      bucket.push(l);
      byAccountKey.set(l.accountKey, bucket);
    }
    const accountKeys = [...byAccountKey.keys()].sort();

    const detailLines: StatementLine[] = [];
    for (const accountKey of accountKeys) {
      const perAccount = byAccountKey.get(accountKey)!;
      const lineId = `line:detail:${statementKind}:${accountKey}`;
      const bindings = perAccount
        .slice()
        .sort((a, b) => a.periodId.localeCompare(b.periodId))
        .map((l) => {
          const factId = `fact:detail:${statementKind}:${accountKey}:${l.periodId}`;
          facts.push(
            buildFact(
              factId,
              l.convertedValue,
              reportingPeriodRef(l.periodId, l.isComparative),
              l.accountCode ?? l.accountKey,
              l.sourceUploadId,
              l.sourceHash,
              `${l.accountName}: ${l.balance}`,
            ),
          );
          recordValue(lineId, l.periodId, l.convertedValue);
          return { periodId: l.periodId, factId };
        });
      const representative = perAccount[0];
      detailLines.push({
        lineId,
        label: representative.accountName,
        concept: `detail:${statementKind}:${accountKey}`,
        role: "DETAIL",
        normalBalance: representative.normalBalance === "debit" ? "DEBIT_NORMAL" : "CREDIT_NORMAL",
        isContra: false,
        factBindings: bindings,
        castingChildLineIds: [],
      });
    }

    const subtotalLineId = `line:subtotal:${statementKind}:${section.classification}`;
    const subtotalBindings = periodIds.flatMap((periodId) => {
      const valuesForPeriod = detailLines.map((dl) => valueOfLineForPeriod(dl.lineId, periodId));
      const sum = sumIfAllPresent(valuesForPeriod);
      if (sum === null) return [];
      const factId = `fact:subtotal:${statementKind}:${section.classification}:${periodId}`;
      facts.push(
        buildFact(
          factId,
          sum,
          reportingPeriodRef(periodId, periodIsComparative.get(periodId) ?? false),
          section.classification,
          sectionLines[0].sourceUploadId,
          sectionLines[0].sourceHash,
          `${section.label} subtotal`,
        ),
      );
      recordValue(subtotalLineId, periodId, sum);
      return [{ periodId, factId }];
    });

    const subtotalLine: StatementLine = {
      lineId: subtotalLineId,
      label: `Total ${section.label}`,
      concept: `subtotal:${statementKind}:${section.classification}`,
      role: "SUBTOTAL",
      normalBalance: section.normalBalance,
      isContra: false,
      factBindings: subtotalBindings,
      castingChildLineIds: detailLines.map((l) => l.lineId),
    };
    sectionSubtotalLineIdByClassification.set(section.classification, subtotalLineId);

    outputSections.push({ sectionId: `section:${statementKind}:${section.classification}`, label: section.label, lines: [...detailLines, subtotalLine] });
  }

  if (buildAnchors && outputSections.length > 0) {
    const assetChildIds = ASSET_CLASSIFICATIONS.map((c) => sectionSubtotalLineIdByClassification.get(c)).filter((v): v is string => !!v);
    const liabilityChildIds = LIABILITY_CLASSIFICATIONS.map((c) => sectionSubtotalLineIdByClassification.get(c)).filter((v): v is string => !!v);
    const equityChildId = sectionSubtotalLineIdByClassification.get("equity");

    const anchorLines: StatementLine[] = [];

    function buildAnchorLine(lineId: string, label: string, concept: string, normalBalance: "DEBIT_NORMAL" | "CREDIT_NORMAL", childLineIds: readonly string[]): StatementLine {
      const bindings = periodIds.flatMap((periodId) => {
        const childValues = childLineIds.map((id) => valueOfLineForPeriod(id, periodId));
        const sum = sumIfAllPresent(childValues);
        if (sum === null) return [];
        const factId = `fact:total:${statementKind}:${concept}:${periodId}`;
        facts.push(buildFact(factId, sum, reportingPeriodRef(periodId, periodIsComparative.get(periodId) ?? false), concept, lines[0].sourceUploadId, lines[0].sourceHash, label));
        recordValue(lineId, periodId, sum);
        return [{ periodId, factId }];
      });
      return { lineId, label, concept, role: "TOTAL", normalBalance, isContra: false, factBindings: bindings, castingChildLineIds: [...childLineIds] };
    }

    const totalAssetsLine = buildAnchorLine("line:total:sfp:total_assets", "Total Assets", CANONICAL_CONCEPTS.TOTAL_ASSETS, "DEBIT_NORMAL", assetChildIds);
    const totalLiabilitiesLine = buildAnchorLine("line:total:sfp:total_liabilities", "Total Liabilities", CANONICAL_CONCEPTS.TOTAL_LIABILITIES, "CREDIT_NORMAL", liabilityChildIds);
    const totalEquityLine = buildAnchorLine("line:total:sfp:total_equity", "Total Equity", CANONICAL_CONCEPTS.TOTAL_EQUITY, "CREDIT_NORMAL", equityChildId ? [equityChildId] : []);
    const totalLiabilitiesAndEquityLine = buildAnchorLine(
      "line:total:sfp:total_liabilities_and_equity",
      "Total Liabilities and Equity",
      CANONICAL_CONCEPTS.TOTAL_LIABILITIES_AND_EQUITY,
      "CREDIT_NORMAL",
      [totalLiabilitiesLine.lineId, totalEquityLine.lineId],
    );
    anchorLines.push(totalAssetsLine, totalLiabilitiesLine, totalEquityLine, totalLiabilitiesAndEquityLine);

    outputSections.push({ sectionId: `section:${statementKind}:totals`, label: "Totals", lines: anchorLines });
  }

  return {
    statement: { statementId, type: statementType, title, sections: outputSections },
    facts,
  };
}

async function normalizeTrialBalance(input: TrialBalanceNormalizationInput): Promise<AdapterExtractionResult> {
  const parsed = z.array(reviewedLineSchema).safeParse(input.reviewedAccountLines);
  if (!parsed.success) {
    const diagnostics = parsed.error.issues.map((issue) => blocking(CODE.SCHEMA_INVALID, `[${issue.path.join(".")}] ${issue.message}`));
    throw new AdapterRejectedError(TRIAL_BALANCE_ADAPTER_IDENTITY, diagnostics);
  }
  const rows = parsed.data as readonly ReviewedTrialBalanceAccountLine[];

  if (rows.length === 0) {
    throw new AdapterRejectedError(TRIAL_BALANCE_ADAPTER_IDENTITY, [blocking(CODE.NO_LINES, "No reviewed trial-balance account lines were supplied")]);
  }

  const blockingDiagnostics: AdapterDiagnostic[] = [];
  const warnings: AdapterDiagnostic[] = [];

  const currency = rows[0].currency;
  const scale = rows[0].scale;
  for (const row of rows) {
    if (row.currency !== currency || row.scale !== scale) {
      blockingDiagnostics.push(
        blocking(CODE.INCONSISTENT_SOURCE, `Row for account "${row.accountKey}" uses ${row.currency}@scale${row.scale}, expected ${currency}@scale${scale} (must be a single denomination per normalization call)`, {
          accountKey: row.accountKey,
          accountName: row.accountName,
        }),
      );
    }
    const isSfpClassification = (SFP_CLASSIFICATIONS as readonly string[]).includes(row.classification);
    const isPlClassification = (PL_CLASSIFICATIONS as readonly string[]).includes(row.classification);
    if (row.statement === "balance_sheet" && !isSfpClassification && !(SCF_CLASSIFICATIONS as readonly string[]).includes(row.classification)) {
      blockingDiagnostics.push(blocking(CODE.STATEMENT_CLASSIFICATION_MISMATCH, `Account "${row.accountKey}" is mapped to statement="balance_sheet" with classification="${row.classification}", which does not belong on the statement of financial position`, { accountKey: row.accountKey, accountName: row.accountName }));
    }
    if (row.statement === "income_statement" && !isPlClassification) {
      blockingDiagnostics.push(blocking(CODE.STATEMENT_CLASSIFICATION_MISMATCH, `Account "${row.accountKey}" is mapped to statement="income_statement" with classification="${row.classification}", which does not belong on the statement of profit or loss`, { accountKey: row.accountKey, accountName: row.accountName }));
    }
  }

  if (!rows.some((r) => r.periodId === "CURRENT")) {
    blockingDiagnostics.push(blocking(CODE.NO_CURRENT_PERIOD, 'No reviewed lines were supplied for periodId "CURRENT" — the report\'s own period must have data'));
  }

  const seenPerPeriod = new Map<string, Set<string>>();
  for (const row of rows) {
    const seen = seenPerPeriod.get(row.periodId) ?? new Set<string>();
    if (seen.has(row.accountKey)) {
      blockingDiagnostics.push(blocking(CODE.DUPLICATE_ACCOUNT_IN_PERIOD, `Account "${row.accountKey}" appears more than once for periodId "${row.periodId}"`, { accountKey: row.accountKey, accountName: row.accountName }));
    }
    seen.add(row.accountKey);
    seenPerPeriod.set(row.periodId, seen);
  }

  const converted: ConvertedLine[] = [];
  for (const row of rows) {
    if ((SCF_CLASSIFICATIONS as readonly string[]).includes(row.classification)) {
      warnings.push(
        warning(CODE.CASH_FLOW_CLASSIFICATION_SKIPPED, `Account "${row.accountKey}" is classified "${row.classification}" (cash flow) — this adapter version does not construct a Statement of Cash Flows from a trial balance (see DEFECT-SAFISHA-TRANSACTION-LEDGER-GAP-001); it is excluded from the extraction`, {
          accountKey: row.accountKey,
          accountName: row.accountName,
        }),
      );
      continue;
    }
    try {
      const value = numberToMoneyExact(row.balance, row.currency, row.scale);
      converted.push({ ...row, convertedValue: value });
    } catch (err) {
      if (err instanceof UnsupportedPrecisionError || err instanceof UnsafeMagnitudeError || err instanceof RangeError) {
        blockingDiagnostics.push(blocking(CODE.UNCONVERTIBLE_AMOUNT, `Account "${row.accountKey}" balance ${row.balance} could not be converted exactly: ${err.message}`, { accountKey: row.accountKey, accountName: row.accountName }));
      } else {
        throw err;
      }
    }
  }

  if (blockingDiagnostics.length > 0) {
    throw new AdapterRejectedError(TRIAL_BALANCE_ADAPTER_IDENTITY, blockingDiagnostics);
  }

  const periodIsComparative = new Map<string, boolean>();
  for (const row of converted) periodIsComparative.set(row.periodId, row.isComparative);
  const periodIds = [...periodIsComparative.keys()].sort((a, b) => (a === "CURRENT" ? -1 : b === "CURRENT" ? 1 : a.localeCompare(b)));

  const sfpRows = converted.filter((r) => r.statement === "balance_sheet");
  const plRows = converted.filter((r) => r.statement === "income_statement");

  const statements: Statement[] = [];
  const allFacts: MonetaryFact[] = [];

  if (sfpRows.length > 0) {
    const built = buildStatement("sfp", "statement:sfp", "STATEMENT_OF_FINANCIAL_POSITION", "Statement of Financial Position", SFP_SECTIONS, sfpRows, periodIds, periodIsComparative, true);
    statements.push(built.statement);
    allFacts.push(...built.facts);
  }

  if (plRows.length > 0) {
    const built = buildStatement("pl", "statement:pl", "STATEMENT_OF_PROFIT_OR_LOSS", "Statement of Profit or Loss", PL_SECTIONS, plRows, periodIds, periodIsComparative, false);
    statements.push(built.statement);
    allFacts.push(...built.facts);
    warnings.push(warning(CODE.NET_RESULT_NOT_COMPUTED, "Net profit/(loss) for the period is not computed by this adapter version — section subtotals only (Revenue, Cost of Sales, Operating Expenses, Other Income, Taxation)"));
  }

  const accountingPolicies: AccountingPolicy[] = [];
  const textualDisclosures: TextualDisclosure[] = [];
  const notes: Note[] = [];

  return {
    facts: allFacts,
    statements,
    notes,
    accountingPolicies,
    textualDisclosures,
    warnings: warnings.map((w) => `[${w.code}] ${w.message}`),
  };
}

export function createTrialBalanceAdapter(): TrialBalanceAdapter {
  return {
    adapterKind: "TRIAL_BALANCE",
    normalize: normalizeTrialBalance,
  };
}
