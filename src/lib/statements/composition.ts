// statements/composition.ts — the browser's view of the database-composed statements (fs_statement_composition,
// 20261018100000). The database composes; this module only validates the payload (refusing anything malformed) and lays
// the server's figures out as rows. It adds nothing up: every amount shown is a server figure, and a figure the server
// did not compute is shown as missing with its reason — never as zero.
//
// Writes go through the server RPCs only (fs_assign_presentation, fs_elect_early_application); no table is written here.

import { z } from "zod";
import { presentAmount, type AmountCell, type AmountText } from "@/lib/presentation/amounts";

const MINOR = z.string().regex(/^(0|-?[1-9][0-9]*)$/);
const UUID = z.string().regex(/^[0-9a-f-]{36}$/);
const lineageSchema = z.object({
  period: z.enum(["current", "comparative"]), accountKey: z.string(), accountCode: z.string().nullable(), accountName: z.string(),
  certificationId: UUID.nullable(), classification: z.string().nullable(), amountMinor: MINOR, certifiedAmountMinor: MINOR,
  adjustmentIds: z.array(z.string()), assignmentId: UUID.nullable(), assignmentSeq: z.number().int().nullable(),
  // Version 2: an account row (bridged when bridgeId is set) or an approved restatement delta of the comparative.
  kind: z.enum(["account", "restatement"]), bridgeId: UUID.nullable(), restatementId: UUID.nullable(),
});
const amountSchema = z.object({ amountMinor: MINOR, accounts: z.number().int().min(0) });
const comparativeAmountSchema = amountSchema.extend({ asReportedMinor: MINOR, restated: z.boolean() });
const lineSchema = z.object({
  statement: z.enum(["SFP", "SCI"]),
  section: z.enum(["non_current_assets", "current_assets", "equity", "non_current_liabilities", "current_liabilities", "sci"]),
  lineId: z.string(), label: z.string(), requirementId: z.string(),
  current: amountSchema, comparative: comparativeAmountSchema.nullable(), lineage: z.array(lineageSchema),
});
const completeTotals = z.object({
  state: z.literal("complete"),
  nonCurrentAssetsMinor: MINOR, currentAssetsMinor: MINOR, totalAssetsMinor: MINOR,
  currentLiabilitiesMinor: MINOR, nonCurrentLiabilitiesMinor: MINOR, totalLiabilitiesMinor: MINOR,
  equityAccountsMinor: MINOR, incomeMinor: MINOR, expensesExcludingTaxMinor: MINOR, profitBeforeTaxMinor: MINOR,
  taxExpenseMinor: MINOR, profitOrLossMinor: MINOR, totalEquityMinor: MINOR, totalEquityAndLiabilitiesMinor: MINOR, balanceDifferenceMinor: MINOR,
});
const totalsSchema = z.union([completeTotals, z.object({ state: z.literal("incomplete"), notPresented: z.number().int().min(1) })]);
const composedSchema = z.object({
  state: z.literal("composed"),
  contract: z.literal("fs-statement-composition/2"),
  pack: z.object({ family: z.literal("ifrs-for-smes"), linesVersion: z.string(), packId: z.enum(["ifrs-for-smes/2015", "ifrs-for-smes/2025"]), earlyApplication: z.boolean() }),
  inputSha256: z.string().regex(/^[0-9a-f]{64}$/),
  current: z.object({ periodYear: z.number().int(), certificationId: UUID, currency: z.string().regex(/^[A-Z]{3}$/), exponent: z.number().int().min(0).max(4),
    reportingStart: z.string().nullable(), reportingEnd: z.string().nullable() }),
  comparative: z.object({ state: z.string(), periodYear: z.number().int().nullable(), certificationId: UUID.nullable(), currency: z.string().nullable(),
    bridgeIds: z.array(UUID), restatementIds: z.array(UUID) }),
  lines: z.array(lineSchema),
  totals: z.object({ current: totalsSchema.optional(), comparative: totalsSchema.optional() }),
  accountsNotPresented: z.array(z.object({ period: z.enum(["current", "comparative"]), accountKey: z.string(), accountCode: z.string().nullable(),
    accountName: z.string(), classification: z.string(), status: z.enum(["unassigned", "incompatible", "excluded"]), lineId: z.string().nullable() })),
  blockers: z.array(z.string()),
  compositionSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const notComposedSchema = z.object({
  state: z.enum(["unavailable", "invalid_request", "no_authority", "legacy_certification", "currency_unknown", "edition_unresolved"]),
  periodYear: z.number().int().optional(), reason: z.string().optional(),
});

export type Composition = z.infer<typeof composedSchema>;
export type CompositionLine = z.infer<typeof lineSchema>;
export type CompositionResult = Composition | z.infer<typeof notComposedSchema>;

/** Validates a server payload. Anything else is an error, never a partial view. */
export function parseComposition(payload: unknown): CompositionResult {
  const composed = composedSchema.safeParse(payload);
  if (composed.success) return composed.data;
  const other = notComposedSchema.safeParse(payload);
  if (other.success) return other.data;
  throw new Error(`fs_statement_composition returned an unrecognised payload: ${composed.error.issues[0]?.message ?? "invalid"}`);
}

// ── Server calls ─────────────────────────────────────────────────────────────────────────────────────────────────────
export interface CompositionDb {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}
export type AssignOutcome = { outcome: "recorded"; count: number; replay?: boolean } | { outcome: "unchanged" | "forbidden" | "feature_disabled" | "invalid_request" | "framework_not_ifrs_for_smes" | "request_reused" } | { outcome: "unknown_line"; lineId: string };

export function compositionClient(db: CompositionDb) {
  const call = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await db.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  return {
    compose: async (companyId: string, periodYear: number) => parseComposition(await call("fs_statement_composition", { p_company_id: companyId, p_period_year: periodYear })),
    assign: async (companyId: string, assignments: readonly { accountKey: string; lineId: string | null }[], reason: string, requestId: string) =>
      (await call("fs_assign_presentation", { p_company_id: companyId, p_assignments: assignments, p_reason: reason, p_request_id: requestId })) as AssignOutcome,
    electEarlyApplication: async (companyId: string, periodYear: number, elect: boolean, jurisdictionConfirmation: string | null, reason: string) =>
      (await call("fs_elect_early_application", { p_company_id: companyId, p_period_year: periodYear, p_elect: elect, p_jurisdiction_confirmation: jurisdictionConfirmation, p_reason: reason })) as { outcome: string },
  };
}

// ── The statement view ───────────────────────────────────────────────────────────────────────────────────────────────
export interface StatementRow {
  readonly kind: "heading" | "line" | "subtotal" | "total";
  readonly label: string;
  readonly lineId?: string;
  readonly requirementId?: string;
  readonly current?: AmountText;
  readonly comparative?: AmountText;
  /** Set when the comparative is restated: the as-reported figure, shown beside the presented one. */
  readonly comparativeAsReported?: AmountText;
  readonly lineage?: CompositionLine["lineage"];
}
export interface StatementView {
  readonly id: "SFP" | "SCI";
  readonly title: string;
  readonly rows: readonly StatementRow[];
}

const SECTION_TITLES: Record<string, string> = {
  non_current_assets: "Non-current assets", current_assets: "Current assets", equity: "Equity",
  non_current_liabilities: "Non-current liabilities", current_liabilities: "Current liabilities",
};
const TITLES = { SFP: "Statement of Financial Position", SCI: "Statement of Comprehensive Income" } as const;
/** Lines of the statement of comprehensive income presented credit-positive (income); every other line is an expense. */
const INCOME_LINES = new Set(["sci.revenue", "sci.other_income", "sci.share_of_associates"]);

/** The two statements as rows, in presentation order. Totals come only from the server's totals of a complete period. */
export function statementViews(c: Composition): StatementView[] {
  const exp = c.current.exponent;
  const amount = (minor: string): AmountCell => ({ kind: "amount", minor: BigInt(minor), exponent: exp });
  const comparativeOn = c.comparative.state === "available";
  const cmpMissingReason = (): string => (c.comparative.state === "different_currency" ? "the prior year is in another currency (translation is deferred)"
    : c.comparative.state === "missing" ? "no prior-year trial balance" : c.comparative.state === "not_authoritative" ? "the prior year has no authoritative certification"
    : c.comparative.state === "legacy_certification" ? "the prior year's certification predates exact amounts" : `comparative ${c.comparative.state}`);
  const total = (period: "current" | "comparative", key: keyof z.infer<typeof completeTotals>): AmountText => {
    if (period === "comparative" && !comparativeOn) return presentAmount({ kind: "missing", reason: cmpMissingReason() });
    const t = c.totals[period];
    if (!t || t.state !== "complete") return presentAmount({ kind: "missing", reason: t?.state === "incomplete" ? `${t.notPresented} account(s) not presented` : "not composed" });
    return presentAmount(amount(t[key] as string));
  };
  // Display sign only: expense lines of the statement of comprehensive income are shown in parentheses so the column reads
  // as a sum to profit before tax (the server returns them as positive expense amounts).
  const shown = (l: CompositionLine, minor: string) => (l.statement === "SCI" && !INCOME_LINES.has(l.lineId) ? (-BigInt(minor)).toString() : minor);
  const lineRow = (l: CompositionLine): StatementRow => ({
    kind: "line", label: l.label, lineId: l.lineId, requirementId: l.requirementId, lineage: l.lineage,
    current: presentAmount(amount(shown(l, l.current.amountMinor))),
    comparative: l.comparative ? presentAmount(amount(shown(l, l.comparative.amountMinor))) : presentAmount({ kind: "missing", reason: cmpMissingReason() }),
    ...(l.comparative?.restated ? { comparativeAsReported: presentAmount(amount(shown(l, l.comparative.asReportedMinor))) } : {}),
  });
  const both = (label: string, key: keyof z.infer<typeof completeTotals>, kind: StatementRow["kind"] = "subtotal"): StatementRow =>
    ({ kind, label, current: total("current", key), comparative: total("comparative", key) });
  const section = (s: CompositionLine["section"]) => c.lines.filter((l) => l.section === s).map(lineRow);

  const sfp: StatementRow[] = [
    { kind: "heading", label: SECTION_TITLES.non_current_assets }, ...section("non_current_assets"), both("Total non-current assets", "nonCurrentAssetsMinor"),
    { kind: "heading", label: SECTION_TITLES.current_assets }, ...section("current_assets"), both("Total current assets", "currentAssetsMinor"),
    both("Total assets", "totalAssetsMinor", "total"),
    { kind: "heading", label: SECTION_TITLES.equity }, ...section("equity"),
    both("Profit or loss for the period (not yet transferred to equity accounts)", "profitOrLossMinor", "line"),
    both("Total equity", "totalEquityMinor"),
    { kind: "heading", label: SECTION_TITLES.non_current_liabilities }, ...section("non_current_liabilities"), both("Total non-current liabilities", "nonCurrentLiabilitiesMinor"),
    { kind: "heading", label: SECTION_TITLES.current_liabilities }, ...section("current_liabilities"), both("Total current liabilities", "currentLiabilitiesMinor"),
    both("Total liabilities", "totalLiabilitiesMinor"),
    both("Total equity and liabilities", "totalEquityAndLiabilitiesMinor", "total"),
  ];
  const sciLines = section("sci");
  const isTax = (r: StatementRow) => r.lineId === "sci.tax_expense";
  const sci: StatementRow[] = [
    ...sciLines.filter((r) => !isTax(r)),
    both("Profit before tax", "profitBeforeTaxMinor"),
    ...sciLines.filter(isTax),
    both("Profit or loss for the period", "profitOrLossMinor", "total"),
  ];
  return [{ id: "SFP", title: TITLES.SFP, rows: sfp }, { id: "SCI", title: TITLES.SCI, rows: sci }];
}
