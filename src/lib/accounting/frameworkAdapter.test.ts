/**
 * frameworkAdapter.test.ts
 *
 * Slice 1 — proves the DB-string <-> typed conversion is lossless for all
 * currently-live values, and explicitly documents the ipsas_cash decision
 * (see the comment in frameworkAdapter.ts) rather than leaving it implicit.
 */

import { describe, it, expect } from "vitest";
import {
  fromCompanyReportingFrameworkDbValue,
  toCompanyReportingFrameworkDbValue,
  type CompanyReportingFrameworkDbValue,
} from "./frameworkAdapter";

describe("fromCompanyReportingFrameworkDbValue", () => {
  it("maps ifrs_for_smes to IFRS_FOR_SMES + ACCRUAL", () => {
    expect(fromCompanyReportingFrameworkDbValue("ifrs_for_smes")).toEqual({
      framework: "IFRS_FOR_SMES",
      accountingBasis: "ACCRUAL",
    });
  });

  it("maps full_ifrs to IFRS + ACCRUAL", () => {
    expect(fromCompanyReportingFrameworkDbValue("full_ifrs")).toEqual({
      framework: "IFRS",
      accountingBasis: "ACCRUAL",
    });
  });

  it("maps ipsas_accrual to IPSAS_ACCRUAL + ACCRUAL", () => {
    expect(fromCompanyReportingFrameworkDbValue("ipsas_accrual")).toEqual({
      framework: "IPSAS_ACCRUAL",
      accountingBasis: "ACCRUAL",
    });
  });

  it("maps the disabled ipsas_cash value to OTHER_CONFIRMED + CASH (documented decision, not a silent drop)", () => {
    expect(fromCompanyReportingFrameworkDbValue("ipsas_cash")).toEqual({
      framework: "OTHER_CONFIRMED",
      accountingBasis: "CASH",
    });
  });

  it("returns null for null/undefined/empty — never guesses a framework (C4)", () => {
    expect(fromCompanyReportingFrameworkDbValue(null)).toBeNull();
    expect(fromCompanyReportingFrameworkDbValue(undefined)).toBeNull();
    expect(fromCompanyReportingFrameworkDbValue("")).toBeNull();
  });

  it("returns null for a value outside the known CHECK constraint, rather than guessing", () => {
    expect(fromCompanyReportingFrameworkDbValue("some_future_value")).toBeNull();
  });
});

describe("toCompanyReportingFrameworkDbValue", () => {
  const knownValues: CompanyReportingFrameworkDbValue[] = [
    "ifrs_for_smes",
    "full_ifrs",
    "ipsas_accrual",
    "ipsas_cash",
  ];

  it("round-trips every known DB value through from -> to", () => {
    for (const dbValue of knownValues) {
      const pair = fromCompanyReportingFrameworkDbValue(dbValue);
      expect(pair).not.toBeNull();
      const roundTripped = toCompanyReportingFrameworkDbValue(
        pair!.framework,
        pair!.accountingBasis,
      );
      expect(roundTripped).toBe(dbValue);
    }
  });

  it("returns null for a (framework, basis) pair with no DB representation, rather than guessing (C4)", () => {
    // IFRS with CASH basis has no lossless DB column value.
    expect(toCompanyReportingFrameworkDbValue("IFRS", "CASH")).toBeNull();
    expect(toCompanyReportingFrameworkDbValue("UNKNOWN", "UNKNOWN")).toBeNull();
  });
});
