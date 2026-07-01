// Pure helper mirroring the STEP 9 accounting-equation check in index.ts.
// Extracted so it can be unit-tested in isolation.
//
// In an unadjusted trial balance, P&L accounts are not yet closed to
// retained earnings, so:
//     Closing Equity = Opening Equity + (Revenue - Expenses)
//     Assets        = Liabilities + Closing Equity   (± TOLERANCE)

export const TOLERANCE = 0.01;

export interface TbTotals {
  assets: number;
  liabilities: number;
  equity: number;   // opening equity (pre-close)
  revenue: number;
  expenses: number;
}

export interface BalanceSheetCheckResult {
  passed: boolean;
  netIncome: number;
  closingEquity: number;
  difference: number;
}

export function checkBalanceSheetEquation(
  totals: TbTotals,
  tolerance: number = TOLERANCE,
): BalanceSheetCheckResult {
  const netIncome     = totals.revenue - totals.expenses;
  const closingEquity = totals.equity + netIncome;
  const difference    = Math.abs(totals.assets - (totals.liabilities + closingEquity));
  return {
    passed: difference <= tolerance,
    netIncome,
    closingEquity,
    difference,
  };
}