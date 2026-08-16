/**
 * detectEntityContext.test.ts
 *
 * Slice 2 — proves the read-only detector's evidence ladder and, critically,
 * the false-automation prohibitions from directive Section XVIII using the
 * adversarial fixture shapes from Section XXII (ATCL-style SOE, LGA-style
 * agency, NGO/QuickBooks). No DB/network access — all inputs are plain data.
 */

import { describe, it, expect } from "vitest";
import { detectEntityAccountingContext } from "./detectEntityContext";

describe("detectEntityAccountingContext — reportingFramework tiers", () => {
  it("LGA-style fixture: non-default ipsas_accrual resolves at MEDIUM confidence, not HIGH", () => {
    const ctx = detectEntityAccountingContext({
      jurisdiction: "TZ",
      companyReportingFrameworkDbValue: "ipsas_accrual",
    });
    expect(ctx.reportingFramework.value).toBe("IPSAS_ACCRUAL");
    expect(ctx.reportingFramework.confidence).toBe("MEDIUM");
    expect(ctx.reportingFramework.source).toBe("USER_MANUAL_ENTRY");
    expect(ctx.accountingBasis.value).toBe("ACCRUAL");
  });

  it("ATCL-style fixture: government ownership must NOT switch a full_ifrs company to IPSAS", () => {
    // This detector doesn't even accept an ownership input — it can only
    // ever read companies.reporting_framework. That is the structural proof:
    // there is no code path by which ownership could reach this decision.
    const ctx = detectEntityAccountingContext({
      jurisdiction: "TZ",
      companyReportingFrameworkDbValue: "full_ifrs",
    });
    expect(ctx.reportingFramework.value).toBe("IFRS");
    expect(ctx.reportingFramework.value).not.toBe("IPSAS_ACCRUAL");
  });

  it("NGO/QuickBooks-style fixture: untouched default framework resolves at LOW confidence, never HIGH", () => {
    const ctx = detectEntityAccountingContext({
      jurisdiction: "TZ",
      companyReportingFrameworkDbValue: "ifrs_for_smes",
    });
    expect(ctx.reportingFramework.value).toBe("IFRS_FOR_SMES");
    expect(ctx.reportingFramework.confidence).toBe("LOW");
    expect(ctx.reportingFramework.source).toBe("CONFIGURED_ENGAGEMENT_CONTEXT");
    // LOW confidence is the honest signal that this must not be presented
    // as confirmed — see confirmationPosture.test.ts for the UX consequence.
  });

  it("a prior professional confirmation wins over the raw DB value and reaches HIGH confidence", () => {
    const ctx = detectEntityAccountingContext({
      jurisdiction: "TZ",
      // DB still says the default — but a professional already confirmed IPSAS.
      companyReportingFrameworkDbValue: "ifrs_for_smes",
      priorConfirmedFramework: {
        framework: "IPSAS_ACCRUAL",
        accountingBasis: "ACCRUAL",
        confirmedBy: "firm-member-42",
        confirmedAt: "2026-01-15T00:00:00Z",
        evidenceDetail: "Confirmed against FY2025 audited financial statements citing IPSAS compliance.",
      },
    });
    expect(ctx.reportingFramework.value).toBe("IPSAS_ACCRUAL");
    expect(ctx.reportingFramework.confidence).toBe("HIGH");
    expect(ctx.reportingFramework.source).toBe("PRIOR_PROFESSIONAL_CONFIRMATION");
    expect(ctx.reportingFramework.confirmedBy).toBe("firm-member-42");
    expect(ctx.accountingBasis.confidence).toBe("HIGH");
  });

  it("an unrecognised DB value is UNKNOWN/NONE, never a guess", () => {
    const ctx = detectEntityAccountingContext({
      companyReportingFrameworkDbValue: "some_future_framework_value",
    });
    expect(ctx.reportingFramework.value).toBe("UNKNOWN");
    expect(ctx.reportingFramework.confidence).toBe("NONE");
  });

  it("null/undefined DB value is UNKNOWN/NONE, never defaults to a guess", () => {
    expect(
      detectEntityAccountingContext({ companyReportingFrameworkDbValue: null }).reportingFramework
        .value,
    ).toBe("UNKNOWN");
    expect(
      detectEntityAccountingContext({ companyReportingFrameworkDbValue: undefined })
        .reportingFramework.value,
    ).toBe("UNKNOWN");
  });
});

describe("detectEntityAccountingContext — undetected dimensions stay honest", () => {
  it("entityClass, ownershipClass, and sourceSystem are always UNKNOWN/NONE today — no fabricated certainty", () => {
    // Covers every fixture family from Section XXII in one assertion: no
    // matter what framework evidence exists, the dimensions this slice has
    // no real evidence source for must never silently resolve to anything.
    const fixtures = ["ipsas_accrual", "full_ifrs", "ifrs_for_smes", "ipsas_cash", null, "garbage"];
    for (const dbValue of fixtures) {
      const ctx = detectEntityAccountingContext({ companyReportingFrameworkDbValue: dbValue });
      expect(ctx.entityClass.value).toBe("UNKNOWN");
      expect(ctx.entityClass.confidence).toBe("NONE");
      expect(ctx.ownershipClass.value).toBe("UNKNOWN");
      expect(ctx.ownershipClass.confidence).toBe("NONE");
      expect(ctx.sourceSystem.value).toBe("UNKNOWN");
      expect(ctx.sourceSystem.confidence).toBe("NONE");
    }
  });
});
