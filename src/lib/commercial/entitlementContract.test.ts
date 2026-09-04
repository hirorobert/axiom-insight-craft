import { describe, it, expect } from "vitest";
import {
  classifyEntitlement,
  isEntitledForPrivilegedUse,
  type CurrentLicenceSnapshot,
} from "./entitlementContract";

const paidLicence: CurrentLicenceSnapshot = {
  status: "ACTIVE",
  planCode: "PAID",
  featureCodes: [
    "SAFISHA_PREVIEW",
    "SAFISHA_CERTIFY",
    "HESABU_REPORTING",
    "HESABU_EXPORT",
    "MAONO_INTELLIGENCE",
    "MULTI_COMPANY",
    "MULTI_PERIOD",
  ],
};

const freeLicence: CurrentLicenceSnapshot = {
  status: "ACTIVE",
  planCode: "FREE",
  featureCodes: ["SAFISHA_PREVIEW", "HESABU_REPORTING"],
};

describe("classifyEntitlement — mirrors _resolve_entitlement_for_owner()", () => {
  it("unknown feature code -> UNKNOWN, fails closed", () => {
    const result = classifyEntitlement("NOT_A_REAL_FEATURE", true, paidLicence, false);
    expect(result.status).toBe("UNKNOWN");
    expect(isEntitledForPrivilegedUse(result)).toBe(false);
  });

  it("no billing customer -> NOT_ENTITLED (a known fact, never UNKNOWN)", () => {
    const result = classifyEntitlement("HESABU_REPORTING", false, null, false);
    expect(result).toEqual({
      status: "NOT_ENTITLED",
      reason: "NO_BILLING_CUSTOMER",
      licenceStatus: null,
      planCode: null,
      source: null,
    });
  });

  it("active admin override wins even with no current licence", () => {
    const result = classifyEntitlement("MAONO_INTELLIGENCE", true, null, true);
    expect(result.status).toBe("ENTITLED");
    expect(result.source).toBe("ADMIN_OVERRIDE");
    expect(isEntitledForPrivilegedUse(result)).toBe(true);
  });

  it("no current licence period, no override -> NOT_ENTITLED", () => {
    const result = classifyEntitlement("HESABU_REPORTING", true, null, false);
    expect(result.status).toBe("NOT_ENTITLED");
    expect(result.reason).toBe("NO_CURRENT_LICENCE_PERIOD");
  });

  it.each<[LicenceStatusLike]>([["SUSPENDED"], ["CANCELLED"], ["EXPIRED"], ["PENDING"]])(
    "licence status %s -> NOT_ENTITLED, never silently entitled",
    (status) => {
      const result = classifyEntitlement("HESABU_REPORTING", true, { ...paidLicence, status }, false);
      expect(result.status).toBe("NOT_ENTITLED");
      expect(result.reason).toBe("LICENCE_NOT_ACTIVE");
      expect(result.licenceStatus).toBe(status);
    },
  );

  it("GRACE status counts as entitled, same as ACTIVE (flagged design decision)", () => {
    const result = classifyEntitlement("HESABU_REPORTING", true, { ...paidLicence, status: "GRACE" }, false);
    expect(result.status).toBe("ENTITLED");
    expect(result.source).toBe("ACTIVE_LICENCE");
  });

  it("ACTIVE licence whose plan includes the feature -> ENTITLED", () => {
    const result = classifyEntitlement("MULTI_COMPANY", true, paidLicence, false);
    expect(result.status).toBe("ENTITLED");
    expect(result.reason).toBe("ACTIVE_LICENCE_INCLUDES_FEATURE");
    expect(result.planCode).toBe("PAID");
  });

  it("ACTIVE licence whose plan excludes the feature -> NOT_ENTITLED (FREE plan lacks MAONO)", () => {
    const result = classifyEntitlement("MAONO_INTELLIGENCE", true, freeLicence, false);
    expect(result.status).toBe("NOT_ENTITLED");
    expect(result.reason).toBe("PLAN_DOES_NOT_INCLUDE_FEATURE");
    expect(result.planCode).toBe("FREE");
  });

  it("FREE plan IS entitled to its own included features", () => {
    const result = classifyEntitlement("HESABU_REPORTING", true, freeLicence, false);
    expect(result.status).toBe("ENTITLED");
  });
});

describe("isEntitledForPrivilegedUse — fail-closed contract", () => {
  it("only ENTITLED passes; NOT_ENTITLED and UNKNOWN both fail closed", () => {
    expect(isEntitledForPrivilegedUse({ status: "ENTITLED", reason: "x", licenceStatus: null, planCode: null, source: null })).toBe(true);
    expect(isEntitledForPrivilegedUse({ status: "NOT_ENTITLED", reason: "x", licenceStatus: null, planCode: null, source: null })).toBe(false);
    expect(isEntitledForPrivilegedUse({ status: "UNKNOWN", reason: "x", licenceStatus: null, planCode: null, source: null })).toBe(false);
  });
});

type LicenceStatusLike = "PENDING" | "ACTIVE" | "GRACE" | "SUSPENDED" | "CANCELLED" | "EXPIRED";
