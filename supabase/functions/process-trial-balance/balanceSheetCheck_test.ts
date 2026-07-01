// Deno tests for the balance-sheet-equation check.
// Confirms net income is correctly included in closing equity across
// multiple realistic trial-balance scenarios.
//
// Run: deno test supabase/functions/process-trial-balance/balanceSheetCheck_test.ts

import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { checkBalanceSheetEquation, TOLERANCE } from "./balanceSheetCheck.ts";

Deno.test("profitable company: net income closes equity to balance", () => {
  // Assets 1,500; Liab 400; Opening Equity 900; Rev 1,000; Exp 800 → NI 200
  // Closing equity = 900 + 200 = 1,100 → 400 + 1,100 = 1,500 ✓
  const r = checkBalanceSheetEquation({
    assets: 1_500, liabilities: 400, equity: 900, revenue: 1_000, expenses: 800,
  });
  assertEquals(r.netIncome, 200);
  assertEquals(r.closingEquity, 1_100);
  assert(r.passed, `expected pass, got diff=${r.difference}`);
});

Deno.test("loss-making company: negative net income reduces equity", () => {
  // Assets 800; Liab 500; Opening Equity 500; Rev 300; Exp 500 → NI -200
  // Closing equity = 500 - 200 = 300 → 500 + 300 = 800 ✓
  const r = checkBalanceSheetEquation({
    assets: 800, liabilities: 500, equity: 500, revenue: 300, expenses: 500,
  });
  assertEquals(r.netIncome, -200);
  assertEquals(r.closingEquity, 300);
  assert(r.passed);
});

Deno.test("break-even: zero net income leaves equity unchanged", () => {
  const r = checkBalanceSheetEquation({
    assets: 1_000, liabilities: 300, equity: 700, revenue: 450, expenses: 450,
  });
  assertEquals(r.netIncome, 0);
  assertEquals(r.closingEquity, 700);
  assert(r.passed);
});

Deno.test("large TZS values: whole-shilling amounts still balance", () => {
  const r = checkBalanceSheetEquation({
    assets: 17_371_317_215,
    liabilities: 6_000_000_000,
    equity: 8_000_000_000,
    revenue: 12_000_000_000,
    expenses: 8_628_682_785,
  });
  assertEquals(r.netIncome, 3_371_317_215);
  assertEquals(r.closingEquity, 11_371_317_215);
  assert(r.passed, `diff=${r.difference}`);
});

Deno.test("rounding: sub-cent difference within tolerance passes", () => {
  const r = checkBalanceSheetEquation({
    assets: 1_000.005, liabilities: 400, equity: 400, revenue: 500, expenses: 300,
  });
  assert(r.difference <= TOLERANCE);
  assert(r.passed);
});

Deno.test("fails when net income is IGNORED from closing equity", () => {
  // Regression guard: the pre-v2.2 bug used Assets = Liab + Opening Equity
  // (ignoring NI). With NI ≠ 0 that formula fails; the correct formula passes.
  const totals = {
    assets: 2_000, liabilities: 500, equity: 1_000, revenue: 900, expenses: 400,
  };
  // Correct (includes NI = 500 → closing 1,500 → 500+1,500 = 2,000)
  const correct = checkBalanceSheetEquation(totals);
  assert(correct.passed, "correct formula must balance");

  // Buggy formula (ignores NI): |2000 - (500 + 1000)| = 500 → fails
  const buggyDiff = Math.abs(totals.assets - (totals.liabilities + totals.equity));
  assert(buggyDiff > TOLERANCE, "buggy formula should NOT balance");
  assertEquals(buggyDiff, 500);
});

Deno.test("materially unbalanced TB is flagged as failed", () => {
  const r = checkBalanceSheetEquation({
    assets: 1_000, liabilities: 200, equity: 500, revenue: 100, expenses: 50,
  });
  // NI 50 → closing 550 → 200+550 = 750, assets 1000 → diff 250
  assertEquals(r.difference, 250);
  assert(!r.passed);
});

Deno.test("negative opening equity (accumulated deficit) with recovery profit", () => {
  // Company recovering: opening equity -300, current-year NI 500 → closing 200
  const r = checkBalanceSheetEquation({
    assets: 900, liabilities: 700, equity: -300, revenue: 1_200, expenses: 700,
  });
  assertEquals(r.netIncome, 500);
  assertEquals(r.closingEquity, 200);
  assert(r.passed);
});