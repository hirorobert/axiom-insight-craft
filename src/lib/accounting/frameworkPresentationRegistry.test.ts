/**
 * frameworkPresentationRegistry.test.ts
 *
 * Slice 3 — proves the registry preserves the exact presentation content
 * that used to be hardcoded inline in ExportStatements.tsx's getFrameworkConfig
 * (regression proof for the refactor), and that unsupported frameworks
 * return null rather than throwing or guessing (C4).
 */

import { describe, it, expect } from "vitest";
import {
  getFrameworkPresentation,
  supportedPresentationFrameworks,
} from "./frameworkPresentationRegistry";

describe("getFrameworkPresentation", () => {
  it("IFRS_FOR_SMES matches the original hardcoded ExportStatements.tsx content verbatim", () => {
    const p = getFrameworkPresentation("IFRS_FOR_SMES");
    expect(p).toEqual({
      displayLabel: "IFRS for SMEs",
      statementNames: {
        balanceSheet: "Statement of Financial Position",
        incomeStatement: "Statement of Comprehensive Income",
        equity: "Statement of Changes in Equity",
        cashFlow: "Statement of Cash Flows",
      },
      equitySectionLabel: "Equity",
      footer:
        "Prepared in accordance with the International Financial Reporting " +
        "Standard for Small and Medium-sized Entities (IFRS for SMEs) as issued by the IASB.",
    });
  });

  it("IPSAS_ACCRUAL matches the original hardcoded ExportStatements.tsx content verbatim, plus Phase 2's Net Assets section label", () => {
    const p = getFrameworkPresentation("IPSAS_ACCRUAL");
    expect(p).toEqual({
      displayLabel: "IPSAS Accrual",
      statementNames: {
        balanceSheet: "Statement of Financial Position",
        incomeStatement: "Statement of Financial Performance",
        equity: "Statement of Changes in Net Assets/Equity",
        cashFlow: "Statement of Cash Flows",
      },
      equitySectionLabel: "Net Assets",
      footer:
        "Prepared in accordance with International Public Sector Accounting " +
        "Standards (IPSAS) as issued by the IPSASB. Accrual basis.",
    });
  });

  it("IPSAS_ACCRUAL's balance-sheet section label is 'Net Assets', never the IFRS term 'Equity' (Phase 2)", () => {
    const p = getFrameworkPresentation("IPSAS_ACCRUAL");
    expect(p!.equitySectionLabel).toBe("Net Assets");
    expect(p!.equitySectionLabel).not.toBe("Equity");
  });

  it("returns null (never throws, never guesses) for frameworks with no registered presentation yet", () => {
    expect(getFrameworkPresentation("IFRS")).toBeNull();
    expect(getFrameworkPresentation("OTHER_CONFIRMED")).toBeNull();
    expect(getFrameworkPresentation("UNKNOWN")).toBeNull();
  });
});

describe("supportedPresentationFrameworks", () => {
  it("lists exactly the two frameworks CompanyManager.tsx allows a preparer to select today", () => {
    expect(supportedPresentationFrameworks().sort()).toEqual(
      ["IFRS_FOR_SMES", "IPSAS_ACCRUAL"].sort(),
    );
  });
});
