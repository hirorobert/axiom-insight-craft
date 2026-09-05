import { describe, it, expect } from "vitest";
import {
  classifyEntitlement,
  isEntitledForPrivilegedUse,
  periodsOverlap,
  wouldViolateLicenceAuthorityInvariant,
  selectCurrentAuthoritativeLicence,
  type CurrentLicenceSnapshot,
  type LicencePeriod,
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

// ─────────────────────────────────────────────────────────────────────────
// Licence-authority invariant — mirrors excl_cl_no_overlapping_authoritative
// _periods (a PostgreSQL EXCLUDE USING gist constraint) and the resolver's
// current-period selection query. The DB constraint itself cannot be
// exercised here (no live Postgres in this environment) — these tests prove
// the SELECTION and OVERLAP-DETECTION logic that mirrors it.
// ─────────────────────────────────────────────────────────────────────────

const day = (n: number) => new Date(Date.UTC(2026, 0, n));

function period(overrides: Partial<LicencePeriod> & { id: string }): LicencePeriod {
  return {
    status: "ACTIVE",
    planCode: "PAID",
    featureCodes: ["HESABU_REPORTING"],
    effectiveStart: day(1),
    effectiveEnd: null,
    ...overrides,
  };
}

describe("periodsOverlap / wouldViolateLicenceAuthorityInvariant", () => {
  it("two conflicting effective ACTIVE licences cannot become authority: detected as an invariant violation", () => {
    const existing = [period({ id: "A", status: "ACTIVE", effectiveStart: day(1), effectiveEnd: null })];
    const candidate = period({ id: "B", status: "ACTIVE", effectiveStart: day(5), effectiveEnd: null });
    expect(periodsOverlap(existing[0], candidate)).toBe(true);
    expect(wouldViolateLicenceAuthorityInvariant(candidate, existing)).toBe(true);
  });

  it("same effective_start cannot create ambiguous authority: identical starts always overlap", () => {
    const existing = [period({ id: "A", status: "ACTIVE", effectiveStart: day(10), effectiveEnd: null })];
    const candidate = period({ id: "B", status: "ACTIVE", effectiveStart: day(10), effectiveEnd: day(20) });
    expect(wouldViolateLicenceAuthorityInvariant(candidate, existing)).toBe(true);
  });

  it("ACTIVE + future renewal behaves deterministically: abutting periods (old closed exactly where new begins) do NOT overlap", () => {
    const existing = [period({ id: "A", status: "ACTIVE", effectiveStart: day(1), effectiveEnd: day(10) })];
    const renewal = period({ id: "B", status: "ACTIVE", effectiveStart: day(10), effectiveEnd: null });
    expect(periodsOverlap(existing[0], renewal)).toBe(false);
    expect(wouldViolateLicenceAuthorityInvariant(renewal, existing)).toBe(false);
  });

  it("boundary timestamps behave deterministically: one instant of gap is enough to avoid overlap", () => {
    const existing = [period({ id: "A", effectiveStart: day(1), effectiveEnd: new Date(day(10).getTime()) })];
    const adjacent = period({ id: "B", effectiveStart: new Date(day(10).getTime()), effectiveEnd: day(20) });
    expect(periodsOverlap(existing[0], adjacent)).toBe(false);
    const overlapping = period({ id: "C", effectiveStart: new Date(day(10).getTime() - 1), effectiveEnd: day(20) });
    expect(periodsOverlap(existing[0], overlapping)).toBe(true);
  });

  it("suspended/cancelled/pending never participate in the invariant, regardless of overlap", () => {
    const existing = [period({ id: "A", status: "ACTIVE", effectiveStart: day(1), effectiveEnd: null })];
    for (const status of ["SUSPENDED", "CANCELLED", "PENDING", "EXPIRED"] as const) {
      const candidate = period({ id: "B", status, effectiveStart: day(1), effectiveEnd: null });
      expect(wouldViolateLicenceAuthorityInvariant(candidate, existing)).toBe(false);
    }
  });

  it("a SUSPENDED row can coexist with an overlapping ACTIVE row without violating the invariant (suspend-then-replace pattern)", () => {
    const existing = [period({ id: "A", status: "SUSPENDED", effectiveStart: day(1), effectiveEnd: null })];
    const replacement = period({ id: "B", status: "ACTIVE", effectiveStart: day(1), effectiveEnd: null });
    expect(wouldViolateLicenceAuthorityInvariant(replacement, existing)).toBe(false);
  });
});

describe("selectCurrentAuthoritativeLicence — mirrors the resolver's current-period query", () => {
  it("suspended/cancelled cannot accidentally win even when their dates cover now()", () => {
    const periods = [
      period({ id: "A", status: "SUSPENDED", effectiveStart: day(1), effectiveEnd: null }),
      period({ id: "B", status: "CANCELLED", effectiveStart: day(1), effectiveEnd: null }),
      period({ id: "C", status: "PENDING", effectiveStart: day(1), effectiveEnd: null }),
    ];
    expect(selectCurrentAuthoritativeLicence(periods, day(15))).toBeNull();
  });

  it("expired (date-window elapsed) + active: the active one wins deterministically", () => {
    const periods = [
      period({ id: "old", status: "ACTIVE", effectiveStart: day(1), effectiveEnd: day(10) }),
      period({ id: "new", status: "ACTIVE", effectiveStart: day(10), effectiveEnd: null }),
    ];
    expect(selectCurrentAuthoritativeLicence(periods, day(15))?.id).toBe("new");
    expect(selectCurrentAuthoritativeLicence(periods, day(5))?.id).toBe("old");
  });

  it("ACTIVE + future renewal: current selection depends only on now(), not on which row was inserted more recently", () => {
    const periods = [
      period({ id: "current", status: "ACTIVE", effectiveStart: day(1), effectiveEnd: day(10) }),
      period({ id: "future", status: "ACTIVE", effectiveStart: day(10), effectiveEnd: null }),
    ];
    expect(selectCurrentAuthoritativeLicence(periods, day(5))?.id).toBe("current");
    expect(selectCurrentAuthoritativeLicence(periods, day(10))?.id).toBe("future");
    expect(selectCurrentAuthoritativeLicence(periods, day(9.999))?.id).toBe("current");
  });

  it("boundary timestamps: effective_start is inclusive, effective_end is exclusive", () => {
    const p = period({ id: "A", effectiveStart: day(1), effectiveEnd: day(10) });
    expect(selectCurrentAuthoritativeLicence([p], day(1))?.id).toBe("A");
    expect(selectCurrentAuthoritativeLicence([p], new Date(day(10).getTime() - 1))?.id).toBe("A");
    expect(selectCurrentAuthoritativeLicence([p], day(10))).toBeNull();
  });

  it("GRACE participates in selection exactly like ACTIVE", () => {
    const p = period({ id: "A", status: "GRACE", effectiveStart: day(1), effectiveEnd: null });
    expect(selectCurrentAuthoritativeLicence([p], day(15))?.id).toBe("A");
  });

  it("empty period list -> null, never a fabricated default", () => {
    expect(selectCurrentAuthoritativeLicence([], day(1))).toBeNull();
  });

  it("UNKNOWN remains fail-closed end-to-end: no selectable period feeds classifyEntitlement to NOT_ENTITLED, never a guess", () => {
    const periods = [period({ id: "A", status: "CANCELLED", effectiveStart: day(1), effectiveEnd: null })];
    const current = selectCurrentAuthoritativeLicence(periods, day(15));
    const result = classifyEntitlement(
      "HESABU_REPORTING",
      true,
      current
        ? { status: current.status, planCode: current.planCode, featureCodes: current.featureCodes }
        : null,
      false,
    );
    expect(result.status).toBe("NOT_ENTITLED");
    expect(isEntitledForPrivilegedUse(result)).toBe(false);
  });
});
