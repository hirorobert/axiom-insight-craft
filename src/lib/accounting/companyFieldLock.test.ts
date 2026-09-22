import { describe, expect, it } from "vitest";
import { deriveCompanyFieldLock, guardCompanyFieldChange } from "./companyFieldLock";

describe("deriveCompanyFieldLock — absolute immutability once anything has processed, fails closed on uncertainty", () => {
  it("unprocessed setup remains editable — the ONLY unlocked state is a positive confirmation of no processing", () => {
    expect(deriveCompanyFieldLock({ processingCertainty: "not_processed" })).toEqual({ locked: false, reason: null });
  });

  it("processed: locked, with a non-empty reason", () => {
    const result = deriveCompanyFieldLock({ processingCertainty: "processed" });
    expect(result.locked).toBe(true);
    expect(result.reason).toBeTruthy();
  });

  it("malformed/uncertain processing state fails closed: 'checking' (read in flight) is LOCKED, never optimistically unlocked", () => {
    expect(deriveCompanyFieldLock({ processingCertainty: "checking" }).locked).toBe(true);
  });

  it("malformed/uncertain processing state fails closed: 'check_failed' (the read itself errored) is LOCKED, never mistaken for 'nothing processed'", () => {
    const result = deriveCompanyFieldLock({ processingCertainty: "check_failed" });
    expect(result.locked).toBe(true);
    expect(result.reason).toMatch(/could not confirm/i);
  });
});

describe("guardCompanyFieldChange — processed engagement metadata cannot be mutated through UI bypass or direct handler invocation", () => {
  it("has no reason parameter at all — there is no input through which a reason could override immutability (structural, not policy)", () => {
    // TypeScript itself enforces this at the call site; this test documents the guarantee runtime-side:
    // calling with a locked+changed input never returns allowed, regardless of any extra property forced in.
    const bypassAttempt = { locked: true, frameworkChanged: true, fiscalYearEndChanged: false, reason: "trust me" } as never;
    expect(guardCompanyFieldChange(bypassAttempt)).toEqual({ allowed: false, blockedField: "reporting_framework" });
  });

  it("unlocked: any change is allowed", () => {
    expect(guardCompanyFieldChange({ locked: false, frameworkChanged: true, fiscalYearEndChanged: true })).toEqual({
      allowed: true,
      blockedField: null,
    });
  });

  it("locked and unchanged: allowed — saving unrelated fields never trips the guard", () => {
    expect(guardCompanyFieldChange({ locked: true, frameworkChanged: false, fiscalYearEndChanged: false })).toEqual({
      allowed: true,
      blockedField: null,
    });
  });

  it("locked and framework changed: ALWAYS blocked, unconditionally", () => {
    expect(guardCompanyFieldChange({ locked: true, frameworkChanged: true, fiscalYearEndChanged: false })).toEqual({
      allowed: false,
      blockedField: "reporting_framework",
    });
  });

  it("locked and fiscal year end changed: ALWAYS blocked, unconditionally", () => {
    expect(guardCompanyFieldChange({ locked: true, frameworkChanged: false, fiscalYearEndChanged: true })).toEqual({
      allowed: false,
      blockedField: "fiscal_year_end",
    });
  });

  it("locked and BOTH changed: blocked on framework first (deterministic precedence), never silently allows the other through", () => {
    expect(guardCompanyFieldChange({ locked: true, frameworkChanged: true, fiscalYearEndChanged: true })).toEqual({
      allowed: false,
      blockedField: "reporting_framework",
    });
  });
});
