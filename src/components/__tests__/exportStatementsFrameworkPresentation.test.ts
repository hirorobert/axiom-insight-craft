/**
 * exportStatementsFrameworkPresentation.test.ts — Phase 2 regression guard.
 *
 * V5 Phase 2 Done When: "No scattered if (framework === 'ipsas_accrual')
 * branching in engine code" and framework-specific behaviour driven through
 * the registry. Gate 0 discovery found a real, live inconsistency: the
 * registry already carries the correct per-framework statement titles
 * (proven by frameworkPresentationRegistry.test.ts -- IPSAS's own
 * "Statement of Financial Performance" / "Statement of Changes in Net
 * Assets/Equity"), but ExportStatements.tsx's PDF page titles were hardcoded
 * literal strings that never read from it, so an IPSAS entity's exported PDF
 * carried IFRS-specific page titles.
 *
 * No component-rendering harness exists in this project, so this is proven
 * at the source-text boundary, matching the precedent established across
 * Phase 1 (reportingFrameworkNoDefault.test.ts, tinGateRemoved.test.ts).
 *
 * Extended after an independent audit (Codex) of the first Phase 2 commit
 * found the identical anti-pattern missed in two more spots in the same
 * file: the Appendix A / Excel "Equity" subcategory label used for every
 * net-asset account row, and the Statement of Cash Flows not-yet-available
 * placeholder. Both are now covered here so this exact class of gap cannot
 * silently reappear.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const EXPORT_STATEMENTS = readFileSync(
  join(__dirname, "../ExportStatements.tsx"),
  "utf-8",
);

describe("ExportStatements.tsx — statement page titles read from the registry, not literals", () => {
  it("does not hardcode the four statement titles as literal strings", () => {
    expect(EXPORT_STATEMENTS).not.toMatch(/doc\.text\(\s*"STATEMENT OF FINANCIAL POSITION"/);
    expect(EXPORT_STATEMENTS).not.toMatch(/doc\.text\(\s*"STATEMENT OF COMPREHENSIVE INCOME"/);
    expect(EXPORT_STATEMENTS).not.toMatch(/doc\.text\(\s*"STATEMENT OF CHANGES IN EQUITY"/);
    expect(EXPORT_STATEMENTS).not.toMatch(/doc\.text\(\s*"STATEMENT OF CASH FLOWS"/);
  });

  it("draws all four page titles from cfg.statementNames", () => {
    expect(EXPORT_STATEMENTS).toMatch(/cfg\.statementNames\.balanceSheet\.toUpperCase\(\)/);
    expect(EXPORT_STATEMENTS).toMatch(/cfg\.statementNames\.incomeStatement\.toUpperCase\(\)/);
    expect(EXPORT_STATEMENTS).toMatch(/cfg\.statementNames\.equity\.toUpperCase\(\)/);
    expect(EXPORT_STATEMENTS).toMatch(/cfg\.statementNames\.cashFlow\.toUpperCase\(\)/);
  });

  it("the SOCIE not-yet-available placeholder also uses the registry's statement name, not a hardcoded IFRS term", () => {
    expect(EXPORT_STATEMENTS).not.toMatch(
      /"Statement of Changes in Equity will appear here/,
    );
    expect(EXPORT_STATEMENTS).toMatch(
      /\$\{cfg\.statementNames\.equity\} will appear here/,
    );
  });

  it("the balance-sheet equity/net-assets section label is not hardcoded to the IFRS term", () => {
    expect(EXPORT_STATEMENTS).not.toMatch(/label:\s*"EQUITY"/);
    expect(EXPORT_STATEMENTS).not.toMatch(/"TOTAL LIABILITIES & EQUITY"/);
    expect(EXPORT_STATEMENTS).toMatch(/cfg\.equitySectionLabel/);
  });

  it("the Appendix A / Excel equity subcategory label is not hardcoded to the IFRS term", () => {
    expect(EXPORT_STATEMENTS).not.toMatch(
      /getAllAccounts\(sn\.balanceSheet,\s*"Equity"/,
    );
    expect(EXPORT_STATEMENTS).toMatch(
      /getAllAccounts\(sn\.balanceSheet,\s*cfg\.equitySectionLabel/,
    );
  });

  it("the Statement of Cash Flows not-yet-available placeholder uses the registry's statement name", () => {
    expect(EXPORT_STATEMENTS).not.toMatch(
      /"Statement of Cash Flows will appear here/,
    );
    expect(EXPORT_STATEMENTS).toMatch(
      /\$\{cfg\.statementNames\.cashFlow\} will appear here/,
    );
  });
});
