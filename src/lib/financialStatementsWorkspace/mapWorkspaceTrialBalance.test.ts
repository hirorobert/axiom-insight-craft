import { describe, expect, it } from "vitest";
import { mapWorkspaceTrialBalanceToReviewedLines, type AccountMappingRow } from "./mapWorkspaceTrialBalance";
import { createTrialBalanceAdapter } from "./trialBalanceAdapter";

function mapping(overrides: Partial<AccountMappingRow> & Pick<AccountMappingRow, "account_key" | "account_code" | "account_name" | "statement" | "classification" | "normal_balance">): AccountMappingRow {
  return {
    normalized_account_name: null,
    is_cash_account: null,
    is_retained_earnings: null,
    is_payroll_account: null,
    ...overrides,
  };
}

const statements = {
  balance_sheet: {
    current_assets: { accounts: [{ account_code: "1000", account_name: "Cash at Bank", debit: 5_000_000, credit: 0, balance: 5_000_000 }] },
    equity: { accounts: [{ account_code: "3000", account_name: "Share Capital", debit: 0, credit: 5_000_000, balance: 5_000_000 }] },
  },
  income_statement: {
    revenue: { accounts: [{ account_code: "4000", account_name: "Sales", debit: 0, credit: 1_000_000, balance: 1_000_000 }] },
  },
  cash_flow: null,
};

describe("mapWorkspaceTrialBalanceToReviewedLines", () => {
  it("maps a fully-reviewed trial balance to lines the adapter accepts", async () => {
    const mappings: AccountMappingRow[] = [
      mapping({ account_key: "1000", account_code: "1000", account_name: "Cash at Bank", statement: "balance_sheet", classification: "current_assets", normal_balance: "debit", is_cash_account: true }),
      mapping({ account_key: "3000", account_code: "3000", account_name: "Share Capital", statement: "balance_sheet", classification: "equity", normal_balance: "credit" }),
      mapping({ account_key: "4000", account_code: "4000", account_name: "Sales", statement: "income_statement", classification: "revenue", normal_balance: "credit" }),
    ];

    const result = mapWorkspaceTrialBalanceToReviewedLines({ statements, accountMappings: mappings, currency: "TZS", sourceUploadId: "upload-1" });
    expect(result.unmappedAccounts).toHaveLength(0);
    expect(result.lines).toHaveLength(3);

    const adapter = createTrialBalanceAdapter();
    const extraction = await adapter.normalize({ companyId: "company-1", periodYear: 2025, reviewedAccountLines: result.lines });
    expect(extraction.statements.map((s) => s.type)).toEqual(["STATEMENT_OF_FINANCIAL_POSITION", "STATEMENT_OF_PROFIT_OR_LOSS"]);
  });

  it("reports an account with no account_mappings row as unmapped, never silently drops or guesses its classification", () => {
    const result = mapWorkspaceTrialBalanceToReviewedLines({ statements, accountMappings: [], currency: "TZS", sourceUploadId: "upload-1" });
    expect(result.lines).toHaveLength(0);
    expect(result.unmappedAccounts.map((a) => a.accountCode).sort()).toEqual(["1000", "3000", "4000"]);
  });

  it("prefers the account_mappings reviewed placement over whichever processing_result section the account appeared under", () => {
    // Account 1000 appears under current_assets in processing_result, but the reviewer has since remapped it as non_current_assets.
    const mappings: AccountMappingRow[] = [mapping({ account_key: "1000", account_code: "1000", account_name: "Cash at Bank", statement: "balance_sheet", classification: "non_current_assets", normal_balance: "debit" })];
    const result = mapWorkspaceTrialBalanceToReviewedLines({ statements: { balance_sheet: statements.balance_sheet }, accountMappings: mappings, currency: "TZS", sourceUploadId: "upload-1" });
    expect(result.lines[0].classification).toBe("non_current_assets");
  });

  it("routes an account_mappings 'cash_flow' statement bucket through as an SCF-classified balance_sheet line, not as unmapped", () => {
    const mappings: AccountMappingRow[] = [mapping({ account_key: "9000", account_code: "9000", account_name: "Loan Proceeds", statement: "cash_flow", classification: "financing_activities", normal_balance: "credit" })];
    const withCf = { balance_sheet: {}, income_statement: {}, cash_flow: { financing_activities: { accounts: [{ account_code: "9000", account_name: "Loan Proceeds", debit: 0, credit: 1000, balance: 1000 }] } } };
    const result = mapWorkspaceTrialBalanceToReviewedLines({ statements: withCf, accountMappings: mappings, currency: "TZS", sourceUploadId: "upload-1" });
    expect(result.unmappedAccounts).toHaveLength(0);
    expect(result.lines[0]).toMatchObject({ statement: "balance_sheet", classification: "financing_activities" });
  });

  it("is deterministic — same input always produces the same sourceHash", () => {
    const mappings: AccountMappingRow[] = [mapping({ account_key: "1000", account_code: "1000", account_name: "Cash at Bank", statement: "balance_sheet", classification: "current_assets", normal_balance: "debit" })];
    const a = mapWorkspaceTrialBalanceToReviewedLines({ statements: { balance_sheet: statements.balance_sheet }, accountMappings: mappings, currency: "TZS", sourceUploadId: "upload-1" });
    const b = mapWorkspaceTrialBalanceToReviewedLines({ statements: { balance_sheet: statements.balance_sheet }, accountMappings: mappings, currency: "TZS", sourceUploadId: "upload-1" });
    expect(a.lines[0].sourceHash).toBe(b.lines[0].sourceHash);
    expect(a.lines[0].sourceHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports conflicting mapping rows for one account as ambiguous instead of picking one", () => {
    const mappings: AccountMappingRow[] = [
      mapping({ account_key: "1000", account_code: "1000", account_name: "Cash", statement: "balance_sheet", classification: "current_assets", normal_balance: "debit" }),
      mapping({ account_key: "1000-b", account_code: "1000", account_name: "Cash", statement: "balance_sheet", classification: "non_current_assets", normal_balance: "debit" }),
    ];
    const result = mapWorkspaceTrialBalanceToReviewedLines({ statements: { balance_sheet: statements.balance_sheet }, accountMappings: mappings, currency: "TZS", sourceUploadId: "u" });
    expect(result.lines.map((l) => l.accountCode)).not.toContain("1000");
    expect(result.ambiguousAccounts).toEqual([{ accountCode: "1000", accountName: "Cash at Bank", placements: ["balance_sheet/current_assets/debit", "balance_sheet/non_current_assets/debit"] }]);
  });

  it("tags comparative lines with the declared comparative period", () => {
    const mappings: AccountMappingRow[] = [mapping({ account_key: "1000", account_code: "1000", account_name: "Cash", statement: "balance_sheet", classification: "current_assets", normal_balance: "debit" })];
    const result = mapWorkspaceTrialBalanceToReviewedLines({ statements: { balance_sheet: statements.balance_sheet }, accountMappings: mappings, currency: "TZS", sourceUploadId: "prior", periodId: "COMPARATIVE_1" });
    expect(result.lines[0]).toMatchObject({ periodId: "COMPARATIVE_1", isComparative: true });
    expect(result.totalAccounts).toBe(2);
  });
});
