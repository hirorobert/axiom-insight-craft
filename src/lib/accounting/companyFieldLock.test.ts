import { describe, expect, it } from "vitest";
import { deriveCompanyFieldLock, guardCompanyFieldChange } from "./companyFieldLock";

describe("deriveCompanyFieldLock — the period/framework contract", () => {
  it("is editable before anything has been processed", () => {
    expect(deriveCompanyFieldLock({ hasProcessedUpload: false })).toEqual({ locked: false, reason: null });
  });

  it("locks once anything has been processed, with a non-empty explanatory reason", () => {
    const result = deriveCompanyFieldLock({ hasProcessedUpload: true });
    expect(result.locked).toBe(true);
    expect(result.reason).toBeTruthy();
    expect(result.reason).toMatch(/already been processed/i);
  });
});

describe("guardCompanyFieldChange — the enforcement behind 'Correct instead' (fails closed even if the UI's disabled control were bypassed)", () => {
  const base = {
    locked: true,
    frameworkChanged: false,
    frameworkCorrectionReason: null,
    fiscalYearEndChanged: false,
    fiscalYearEndCorrectionReason: null,
  };

  it("unlocked (nothing processed yet): any change is allowed, no reason required", () => {
    expect(guardCompanyFieldChange({ ...base, locked: false, frameworkChanged: true })).toEqual({
      allowed: true,
      blockedField: null,
    });
  });

  it("locked and unchanged: allowed — saving unrelated fields never trips the guard", () => {
    expect(guardCompanyFieldChange(base)).toEqual({ allowed: true, blockedField: null });
  });

  it("locked and framework changed WITHOUT a correction reason: blocked", () => {
    expect(guardCompanyFieldChange({ ...base, frameworkChanged: true })).toEqual({
      allowed: false,
      blockedField: "reporting_framework",
    });
  });

  it("locked and framework changed WITH a correction reason: allowed", () => {
    expect(guardCompanyFieldChange({ ...base, frameworkChanged: true, frameworkCorrectionReason: "Client confirmed the original selection was wrong." })).toEqual({
      allowed: true,
      blockedField: null,
    });
  });

  it("locked and fiscal year end changed WITHOUT a correction reason: blocked", () => {
    expect(guardCompanyFieldChange({ ...base, fiscalYearEndChanged: true })).toEqual({
      allowed: false,
      blockedField: "fiscal_year_end",
    });
  });

  it("locked and fiscal year end changed WITH a correction reason: allowed", () => {
    expect(
      guardCompanyFieldChange({ ...base, fiscalYearEndChanged: true, fiscalYearEndCorrectionReason: "Statutory year-end changed by board resolution." }),
    ).toEqual({ allowed: true, blockedField: null });
  });

  it("a blank/whitespace-only reason is the caller's responsibility to reject before it ever reaches here — this guard only checks presence", () => {
    // confirmCorrection() in CompanyManager.tsx already trims and requires non-empty before setting
    // the reason state, so an empty string never legitimately reaches this guard as "provided".
    expect(guardCompanyFieldChange({ ...base, frameworkChanged: true, frameworkCorrectionReason: "" })).toEqual({
      allowed: false,
      blockedField: "reporting_framework",
    });
  });
});
