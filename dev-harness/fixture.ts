// NON-PRODUCTION FIXTURE — used only by dev-harness/main.tsx under the Vite dev
// server for browser acceptance. Nothing under src/ may import this file
// (asserted by src/lib/financialStatementsWorkspace/harnessIsolation.test.ts),
// and it is never part of the production bundle.
import type { AccountMappingRow } from "../src/lib/financialStatementsWorkspace/mapWorkspaceTrialBalance";
import type { WorkspaceUploadInput } from "../src/hooks/useFinancialStatementsWorkspace";

export type ScenarioId = "defect" | "clean" | "no-comparative" | "unmapped" | "ambiguous" | "no-fye";

interface Account {
  code: string;
  name: string;
  statement: "balance_sheet" | "income_statement";
  classification: string;
  normal: "debit" | "credit";
  balance: number;
  cash?: boolean;
}

function accounts(year: "current" | "prior", scenario: ScenarioId): Account[] {
  const retained = scenario === "defect" && year === "current" ? 400_000 : 500_000; // 100,000 out of balance in the defect scenario
  const list: Account[] = [
    { code: "1000", name: "Cash at Bank", statement: "balance_sheet", classification: "current_assets", normal: "debit", balance: 5_000_000, cash: true },
    { code: "1100", name: "Trade Receivables", statement: "balance_sheet", classification: "current_assets", normal: "debit", balance: 2_000_000 },
    { code: "1500", name: "Property, Plant and Equipment", statement: "balance_sheet", classification: "non_current_assets", normal: "debit", balance: 8_000_000 },
    { code: "1590", name: "Accumulated Depreciation", statement: "balance_sheet", classification: "non_current_assets", normal: "debit", balance: -1_500_000 },
    { code: "2000", name: "Trade Payables", statement: "balance_sheet", classification: "current_liabilities", normal: "credit", balance: 3_000_000 },
    { code: "2500", name: "Long-term Loan", statement: "balance_sheet", classification: "non_current_liabilities", normal: "credit", balance: 4_000_000 },
    { code: "3000", name: "Share Capital", statement: "balance_sheet", classification: "equity", normal: "credit", balance: 6_000_000 },
    { code: "3100", name: "Retained Earnings", statement: "balance_sheet", classification: "equity", normal: "credit", balance: retained },
    { code: "4000", name: "Sales Revenue", statement: "income_statement", classification: "revenue", normal: "credit", balance: year === "current" ? 12_000_000 : 10_500_000 },
    { code: "5000", name: "Cost of Sales", statement: "income_statement", classification: "cost_of_goods_sold", normal: "debit", balance: year === "current" ? 6_000_000 : 5_250_000 },
    { code: "6000", name: "Operating Expenses", statement: "income_statement", classification: "operating_expenses", normal: "debit", balance: year === "current" ? 3_000_000 : 2_800_000 },
  ];
  // The defect scenario's prior year lacks the depreciation account, so comparative subtotals/totals show the dash policy.
  return scenario === "defect" && year === "prior" ? list.filter((a) => a.code !== "1590") : list;
}

function processingResult(list: Account[]) {
  const group = (statement: Account["statement"]) => {
    const out: Record<string, { accounts: { account_code: string; account_name: string; debit: number; credit: number; balance: number }[]; total: number }> = {};
    for (const a of list.filter((x) => x.statement === statement)) {
      const s = (out[a.classification] ??= { accounts: [], total: 0 });
      s.accounts.push({ account_code: a.code, account_name: a.name, debit: a.normal === "debit" ? a.balance : 0, credit: a.normal === "credit" ? a.balance : 0, balance: a.balance });
      s.total += a.balance;
    }
    return out;
  };
  return { statements: { balance_sheet: group("balance_sheet"), income_statement: group("income_statement"), cash_flow: null } };
}

function upload(id: string, year: number, list: Account[]): WorkspaceUploadInput {
  return { id, file_name: `trial-balance-${year}.xlsx`, company_id: "harness-company", period_year: year, status: "complete", is_valid: true, processing_result: processingResult(list), uploaded_at: `${year + 1}-02-01T00:00:00Z` };
}

export function buildFixture(scenario: ScenarioId) {
  const currentList = accounts("current", scenario);
  const uploads: WorkspaceUploadInput[] = [upload("upload-2025", 2025, currentList)];
  if (scenario !== "no-comparative") uploads.push(upload("upload-2024", 2024, accounts("prior", scenario)));

  let mappings: AccountMappingRow[] = currentList.map((a) => ({
    account_key: a.code,
    account_code: a.code,
    account_name: a.name,
    normalized_account_name: null,
    statement: a.statement,
    classification: a.classification,
    normal_balance: a.normal,
    is_cash_account: a.cash ? true : null,
    is_retained_earnings: a.code === "3100" ? true : null,
    is_payroll_account: null,
  }));
  if (scenario === "unmapped") mappings = mappings.filter((m) => m.account_code !== "1100");
  if (scenario === "ambiguous") mappings.push({ ...mappings.find((m) => m.account_code === "1100")!, account_key: "1100-dup", classification: "non_current_assets" });

  return {
    uploads,
    currentUpload: uploads[0],
    loadAccountMappings: async () => ({ rows: mappings, error: null }),
    fiscalYearEnd: scenario === "no-fye" ? null : "2020-12-31",
  };
}
