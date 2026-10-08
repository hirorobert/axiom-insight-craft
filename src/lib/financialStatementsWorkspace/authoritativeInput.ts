// financialStatementsWorkspace/authoritativeInput.ts — the financial-statements workspace's figures from the ONE
// authoritative read, fs_reporting_input (20261016100000): the authoritative certification of the year with the approved
// Close Review adjustments applied as a layer, the prior year AS REPORTED (or the exact reason it is missing — never a
// substitute), the applied adjustments (self-approvals disclosed), the Close Review findings summary, and an input
// identity (inputSha256) that a saved report records and that changes whenever any of it changes.
//
// Replaces, when supplied, the legacy route that read an upload's processing result (a float payload of an
// upload that was merely "complete and valid"). Amounts arrive as exact minor-unit strings; they are handed to the
// canonical adapter as the decimal value whose exact recovery numberToMoneyExact guarantees (or refuses).

import { z } from "zod";
import type { AccountClassification, ReviewedTrialBalanceAccountLine } from "./trialBalanceAdapter";
import type { MapReviewedTrialBalanceResult } from "./mapWorkspaceTrialBalance";
import { COMPARATIVE_PERIOD_ID, type ComparativeCandidateUpload, type ComparativeSourceState } from "./comparativeSource";

const MINOR = z.string().regex(/^(0|-?[1-9][0-9]*)$/);
const accountSchema = z.object({
  accountKey: z.string().min(1),
  accountCode: z.string().nullable(),
  accountName: z.string().min(1),
  statement: z.enum(["balance_sheet", "income_statement", "cash_flow"]).nullable(),
  classification: z.string().min(1),
  normalBalance: z.enum(["debit", "credit"]).nullable(),
  isCashAccount: z.boolean().nullable(),
  isRetainedEarnings: z.boolean().nullable(),
  isPayrollAccount: z.boolean().nullable(),
  certifiedDebitMinor: MINOR, certifiedCreditMinor: MINOR,
  adjustmentDebitMinor: MINOR, adjustmentCreditMinor: MINOR,
  debitMinor: MINOR, creditMinor: MINOR,
  adjustmentIds: z.array(z.string()),
});
const adjustmentSchema = z.object({ id: z.string(), number: z.number().int(), kind: z.enum(["adjustment", "reversal"]), reverses: z.string().nullable(),
  totalMinor: MINOR, reason: z.string(), selfApproved: z.boolean(), selfRevalidated: z.boolean() });
const periodSchema = z.object({
  certificationId: z.string(), uploadId: z.string(), periodYear: z.number().int().nullable(), certifiedAt: z.string(),
  periodId: z.string().nullable(), currency: z.string().regex(/^[A-Z]{3}$/).nullable(), exponent: z.number().int().min(0).max(4).nullable(),
  reportingStart: z.string().nullable(), reportingEnd: z.string().nullable(),
  accounts: z.array(accountSchema),
});
const inputSchema = z.union([
  z.object({ state: z.enum(["unavailable", "invalid_request"]) }),
  z.object({ state: z.enum(["no_authority", "legacy_certification", "currency_unknown"]), periodYear: z.number().int() }),
  z.object({
    state: z.literal("current"),
    contract: z.literal("fs-reporting-input/1"),
    current: periodSchema,
    comparative: z.union([
      z.object({ state: z.enum(["missing", "not_authoritative"]), periodYear: z.number().int() }),
      periodSchema.extend({ state: z.enum(["available", "legacy_certification"]), adjustments: z.array(adjustmentSchema) }),
    ]),
    adjustments: z.array(adjustmentSchema),
    findings: z.record(z.unknown()),
    adjustmentsRequiringRevalidation: z.number().int().min(0),
    inputSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
]);

export interface AuthoritativeAccount {
  accountKey: string; accountCode: string | null; accountName: string;
  statement: "balance_sheet" | "income_statement" | "cash_flow" | null; classification: string; normalBalance: "debit" | "credit" | null;
  isCashAccount: boolean | null; isRetainedEarnings: boolean | null; isPayrollAccount: boolean | null;
  certifiedDebitMinor: string; certifiedCreditMinor: string; adjustmentDebitMinor: string; adjustmentCreditMinor: string;
  debitMinor: string; creditMinor: string; adjustmentIds: string[];
}
export interface AppliedAdjustment { id: string; number: number; kind: "adjustment" | "reversal"; reverses: string | null; totalMinor: string; reason: string; selfApproved: boolean;
  /** Carried to the current certification by its own proposer under the self-approval policy (disclosed). */
  selfRevalidated: boolean }
export interface ReportingPeriodInput {
  certificationId: string; uploadId: string; periodYear: number | null; certifiedAt: string; periodId: string | null;
  currency: string | null; exponent: number | null; reportingStart: string | null; reportingEnd: string | null; accounts: AuthoritativeAccount[];
}
export type ComparativeInput =
  | { state: "missing" | "not_authoritative"; periodYear: number }
  | (ReportingPeriodInput & { state: "available" | "legacy_certification"; adjustments: AppliedAdjustment[] });
export interface CurrentReportingInput {
  state: "current"; contract: "fs-reporting-input/1"; current: ReportingPeriodInput; comparative: ComparativeInput;
  adjustments: AppliedAdjustment[]; findings: Record<string, unknown>;
  /** Approved adjustments of this period that apply to an earlier certification and await a revalidation decision. */
  adjustmentsRequiringRevalidation: number;
  inputSha256: string;
}
export type AuthoritativeReportingInput =
  | { state: "unavailable" | "invalid_request" }
  | { state: "no_authority" | "legacy_certification" | "currency_unknown"; periodYear: number }
  | CurrentReportingInput;
type Period = ReportingPeriodInput;

/** Strict: anything not exactly fs-reporting-input/1 is refused (null), never partially used. */
export function parseReportingInput(raw: unknown): AuthoritativeReportingInput | null {
  const r = inputSchema.safeParse(raw);
  return r.success ? (r.data as unknown as AuthoritativeReportingInput) : null;
}

export const INPUT_STATE_WORDS: Record<string, string> = {
  unavailable: "Financial statements are not enabled for this workspace.",
  invalid_request: "The request was not valid.",
  no_authority: "There is no reviewed trial balance for this period yet. Finish the trial balance review first.",
  legacy_certification: "This trial balance was checked before exact amounts were recorded. Run its check again first.",
  currency_unknown: "This period has no reporting currency. Set it in Trial Balance › Intake first.",
};

/** Exact decimal text of a minor-unit amount at `exponent` (e.g. -12345 at 2 → "-123.45"). */
export function minorToDecimalText(minor: bigint, exponent: number): string {
  const neg = minor < 0n;
  const s = (neg ? -minor : minor).toString().padStart(exponent + 1, "0");
  const body = exponent === 0 ? s : `${s.slice(0, s.length - exponent)}.${s.slice(s.length - exponent)}`;
  return neg ? `-${body}` : body;
}

const KNOWN = new Set(["current_assets", "non_current_assets", "current_liabilities", "non_current_liabilities", "equity", "revenue",
  "cost_of_goods_sold", "operating_expenses", "other_income", "taxes", "operating_activities", "investing_activities", "financing_activities"]);

/**
 * One period's accounts → the canonical adapter's reviewed lines. The balance is the natural-direction amount (debit
 * normal: debit − credit; credit normal: credit − debit) of the ADJUSTED figures. An account without a reviewed placement
 * is reported unmapped, never guessed.
 */
export function periodToReviewedLines(p: Period, inputSha256: string, periodId: string): MapReviewedTrialBalanceResult {
  const lines: ReviewedTrialBalanceAccountLine[] = [];
  const unmapped: { accountCode: string; accountName: string }[] = [];
  const exponent = p.exponent ?? 0;
  for (const a of p.accounts) {
    if (!a.statement || !a.normalBalance || !KNOWN.has(a.classification) || !p.currency || p.exponent === null) {
      unmapped.push({ accountCode: a.accountCode ?? a.accountKey, accountName: a.accountName });
      continue;
    }
    const d = BigInt(a.debitMinor), c = BigInt(a.creditMinor);
    const natural = a.normalBalance === "debit" ? d - c : c - d;
    lines.push({
      accountKey: a.accountKey,
      accountCode: a.accountCode ?? undefined,
      accountName: a.accountName,
      statement: a.statement === "cash_flow" ? "balance_sheet" : a.statement,
      classification: a.classification as AccountClassification,
      normalBalance: a.normalBalance,
      balance: Number(minorToDecimalText(natural, exponent)),
      currency: p.currency,
      scale: exponent,
      periodId,
      isComparative: periodId !== "CURRENT",
      isCashAccount: a.isCashAccount,
      isRetainedEarnings: a.isRetainedEarnings,
      isPayrollAccount: a.isPayrollAccount,
      sourceUploadId: p.uploadId,
      sourceHash: inputSha256,
    });
  }
  return { lines, unmappedAccounts: unmapped, ambiguousAccounts: [], totalAccounts: p.accounts.length };
}

/** Where every figure of an account comes from: the certification, its upload and each approved adjustment applied. */
export interface AccountLineage { readonly certificationId: string; readonly uploadId: string; readonly adjustmentIds: readonly string[] }
export function lineageByAccount(p: Period): ReadonlyMap<string, AccountLineage> {
  return new Map(p.accounts.map((a) => [a.accountKey, { certificationId: p.certificationId, uploadId: p.uploadId, adjustmentIds: a.adjustmentIds }]));
}

/** The workspace's comparative state from the authoritative input (the certified upload is the provenance, never a substitute). */
export function comparativeFromInput(input: CurrentReportingInput, companyId: string):
  ComparativeSourceState<ComparativeCandidateUpload & { file_name: string }> {
  const c = input.comparative;
  if (c.state === "missing") return { state: "MISSING", periodYear: c.periodYear, reason: `No trial balance has been imported for ${c.periodYear}.` };
  if (c.state === "not_authoritative") {
    return { state: "MISSING", periodYear: c.periodYear, reason: `The ${c.periodYear} trial balance is not reviewed (no authoritative check), so it cannot be a comparative.` };
  }
  const certified = c as ReportingPeriodInput & { state: "available" | "legacy_certification" };
  const upload = { id: certified.uploadId, company_id: companyId, period_year: certified.periodYear, status: "certified", is_valid: true, processing_result: null,
    uploaded_at: certified.certifiedAt, file_name: "" };
  if (c.state === "legacy_certification") {
    return { state: "INELIGIBLE", periodYear: c.periodYear ?? 0, upload, reason: `The ${c.periodYear} trial balance was checked before exact amounts were recorded. Run its check again.` };
  }
  return { state: "AVAILABLE", periodYear: c.periodYear ?? 0, upload };
}

export const AUTHORITATIVE_COMPARATIVE_PERIOD_ID = COMPARATIVE_PERIOD_ID;
