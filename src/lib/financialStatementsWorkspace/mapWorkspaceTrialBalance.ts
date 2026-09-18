// financialStatementsWorkspace/mapWorkspaceTrialBalance.ts — workspace-side
// glue between the existing HESABU-era data (trial_balance_uploads
// .processing_result JSONB + the account_mappings reviewed-mapping
// authority) and trialBalanceAdapter.ts's expected
// ReviewedTrialBalanceAccountLine[] input.
//
// Deliberately upstream of the canonical adapter, not a canonical adapter
// itself: it performs no accounting computation and applies no rule — it
// only joins two existing workspace tables' already-reviewed data into the
// adapter's input shape, and reports which trial-balance accounts have no
// account_mappings row at all (never silently drops them).
//
// The account's PLACEMENT (statement + classification) is always taken
// from account_mappings — the reviewed authority — never from whichever
// processing_result section happened to list it, so a professional's
// review decision is what reaches the canonical model, not a machine
// pre-classification that may since have been overridden.

import { sha256Hex, canonicalStringify } from "@/lib/canonicalStatement/serialization";
import type { AccountClassification, ReviewedTrialBalanceAccountLine } from "./trialBalanceAdapter";

export interface AccountMappingRow {
  readonly account_key: string;
  readonly account_code: string | null;
  readonly account_name: string;
  readonly normalized_account_name: string | null;
  readonly statement: "balance_sheet" | "income_statement" | "cash_flow";
  readonly classification: string;
  readonly normal_balance: "debit" | "credit";
  readonly is_cash_account: boolean | null;
  readonly is_retained_earnings: boolean | null;
  readonly is_payroll_account: boolean | null;
}

interface RawAccountEntryLike {
  readonly account_code: string;
  readonly account_name: string;
  readonly debit: number;
  readonly credit: number;
  readonly balance: number;
}

interface StatementSectionLike {
  readonly accounts?: readonly RawAccountEntryLike[];
}

export interface CanonicalStatementsLike {
  readonly balance_sheet?: Record<string, StatementSectionLike> | null;
  readonly income_statement?: Record<string, StatementSectionLike> | null;
  readonly cash_flow?: Record<string, StatementSectionLike> | null;
}

export interface UnmappedAccount {
  readonly accountCode: string;
  readonly accountName: string;
}

export interface AmbiguousAccount {
  readonly accountCode: string;
  readonly accountName: string;
  /** Distinct placements found for this account code — never resolved by picking one. */
  readonly placements: readonly string[];
}

export interface MapReviewedTrialBalanceResult {
  readonly lines: readonly ReviewedTrialBalanceAccountLine[];
  readonly unmappedAccounts: readonly UnmappedAccount[];
  /** Accounts with conflicting mapping rows: excluded, and reported for review. */
  readonly ambiguousAccounts: readonly AmbiguousAccount[];
  /** Number of distinct accounts present in the trial balance. */
  readonly totalAccounts: number;
}

const KNOWN_CLASSIFICATIONS = new Set<string>([
  "current_assets",
  "non_current_assets",
  "current_liabilities",
  "non_current_liabilities",
  "equity",
  "revenue",
  "cost_of_goods_sold",
  "operating_expenses",
  "other_income",
  "taxes",
  "operating_activities",
  "investing_activities",
  "financing_activities",
]);

function collectAccountEntries(statements: CanonicalStatementsLike | null | undefined): RawAccountEntryLike[] {
  const groups = [statements?.balance_sheet, statements?.income_statement, statements?.cash_flow];
  const byCode = new Map<string, RawAccountEntryLike>();
  for (const group of groups) {
    if (!group) continue;
    for (const section of Object.values(group)) {
      for (const account of section.accounts ?? []) {
        if (!byCode.has(account.account_code)) byCode.set(account.account_code, account);
      }
    }
  }
  return [...byCode.values()].sort((a, b) => a.account_code.localeCompare(b.account_code));
}

export function mapWorkspaceTrialBalanceToReviewedLines(params: {
  readonly statements: CanonicalStatementsLike | null | undefined;
  readonly accountMappings: readonly AccountMappingRow[];
  readonly currency: string;
  readonly scale?: number;
  readonly sourceUploadId: string;
  /** "CURRENT" (default) or the declared comparative periodId, e.g. "COMPARATIVE_1". */
  readonly periodId?: string;
}): MapReviewedTrialBalanceResult {
  const periodId = params.periodId ?? "CURRENT";
  const scale = params.scale ?? 2;
  const rowsByCode = new Map<string, AccountMappingRow[]>();
  for (const m of params.accountMappings) {
    if (!m.account_code) continue;
    const bucket = rowsByCode.get(m.account_code) ?? [];
    bucket.push(m);
    rowsByCode.set(m.account_code, bucket);
  }

  const entries = collectAccountEntries(params.statements);
  const unmappedAccounts: UnmappedAccount[] = [];
  const ambiguousAccounts: AmbiguousAccount[] = [];
  const lines: ReviewedTrialBalanceAccountLine[] = [];

  for (const entry of entries) {
    const candidates = rowsByCode.get(entry.account_code) ?? [];
    const placements = [...new Set(candidates.map((c) => `${c.statement}/${c.classification}/${c.normal_balance}`))].sort();
    if (placements.length > 1) {
      ambiguousAccounts.push({ accountCode: entry.account_code, accountName: entry.account_name, placements });
      continue;
    }
    const mapping = candidates[0];
    if (!mapping || !KNOWN_CLASSIFICATIONS.has(mapping.classification)) {
      unmappedAccounts.push({ accountCode: entry.account_code, accountName: entry.account_name });
      continue;
    }
    // account_mappings' own "cash_flow" statement bucket has no direct
    // counterpart in the adapter's `statement` enum (`balance_sheet` |
    // `income_statement` only — see trialBalanceAdapter.ts's module
    // comment on the SAFISHA ledger gap). Its classification is always one
    // of the three SCF-only values, which the adapter explicitly accepts
    // under `statement: "balance_sheet"` and turns into a WARNING + skip
    // (never a rejection) — so route it through that way rather than
    // reporting a genuinely-reviewed account as "unmapped."
    const adapterStatement = mapping.statement === "cash_flow" ? "balance_sheet" : mapping.statement;

    lines.push({
      accountKey: mapping.account_key,
      accountCode: mapping.account_code ?? undefined,
      accountName: mapping.account_name,
      statement: adapterStatement,
      classification: mapping.classification as AccountClassification,
      normalBalance: mapping.normal_balance,
      balance: entry.balance,
      currency: params.currency,
      scale,
      periodId,
      isComparative: periodId !== "CURRENT",
      isCashAccount: mapping.is_cash_account,
      isRetainedEarnings: mapping.is_retained_earnings,
      isPayrollAccount: mapping.is_payroll_account,
      sourceUploadId: params.sourceUploadId,
      // Content hash of THIS reviewed dataset (not the original file's own
      // bytes, which this layer never has direct access to) — stable and
      // reproducible for the same set of reviewed lines, satisfying the
      // adapter's provenance identity requirement honestly.
      sourceHash: sha256Hex(canonicalStringify({ sourceUploadId: params.sourceUploadId, entries: entries.map((e) => [e.account_code, e.balance]) })),
    });
  }

  return { lines, unmappedAccounts, ambiguousAccounts, totalAccounts: entries.length };
}
