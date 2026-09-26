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

const ALL_PAID = ["CLOSE_ASSURANCE", "COMPARATIVE_REPORTING", "ENTITY_CAPACITY", "NAMED_USER_SEATS", "STATEMENT_CERTIFICATION", "REPORTING_PACK_EXPORT", "CLOSE_INSIGHTS"];
const practiceLicence: CurrentLicenceSnapshot = { status: "ACTIVE", planCode: "PRACTICE", featureCodes: ALL_PAID };
const freeLicence: CurrentLicenceSnapshot = { status: "ACTIVE", planCode: "FREE", featureCodes: ["CLOSE_ASSURANCE", "COMPARATIVE_REPORTING", "ENTITY_CAPACITY", "NAMED_USER_SEATS"] };

describe("classifyEntitlement — mirrors _resolve_entitlement_for_owner() (20260925130000: no free plan, one matrix)", () => {
  it("unknown feature code -> UNKNOWN, fails closed", () => {
    const result = classifyEntitlement("NOT_A_REAL_FEATURE", true, practiceLicence, false);
    expect(result.status).toBe("UNKNOWN");
    expect(isEntitledForPrivilegedUse(result)).toBe(false);
  });

  it("no permanent free entitlement: capabilities included in every plan still need a plan", () => {
    for (const code of ["CLOSE_ASSURANCE", "COMPARATIVE_REPORTING", "MULTI_PERIOD", "SAFISHA_PREVIEW"]) {
      expect(classifyEntitlement(code, false, null, false)).toEqual({ status: "NOT_ENTITLED", reason: "NO_CURRENT_PLAN", licenceStatus: null, planCode: null, source: null });
      expect(classifyEntitlement(code, true, null, false).reason).toBe("NO_CURRENT_PLAN");
      expect(classifyEntitlement(code, true, practiceLicence, false).status).toBe("ENTITLED");
    }
  });

  it("capacity is never a yes/no flag in the mirror (the server resolves the number)", () => {
    expect(classifyEntitlement("ENTITY_CAPACITY", true, practiceLicence, false).status).toBe("UNKNOWN");
    expect(classifyEntitlement("MULTI_COMPANY", true, practiceLicence, false).status).toBe("UNKNOWN");
    expect(classifyEntitlement("NAMED_USER_SEATS", true, practiceLicence, false).status).toBe("UNKNOWN");
  });

  it("no billing customer -> NOT_ENTITLED with no plan (a known fact, never UNKNOWN)", () => {
    expect(classifyEntitlement("STATEMENT_CERTIFICATION", false, null, false)).toEqual({
      status: "NOT_ENTITLED", reason: "NO_CURRENT_PLAN", licenceStatus: null, planCode: null, source: null,
    });
  });

  it("active admin override wins even with no current licence", () => {
    const result = classifyEntitlement("CLOSE_INSIGHTS", true, null, true);
    expect(result.status).toBe("ENTITLED");
    expect(result.source).toBe("ADMIN_OVERRIDE");
  });

  it("no current licence period, no override -> NOT_ENTITLED with no plan (read-only after expiry)", () => {
    const result = classifyEntitlement("REPORTING_PACK_EXPORT", true, null, false);
    expect([result.status, result.reason, result.planCode]).toEqual(["NOT_ENTITLED", "NO_CURRENT_PLAN", null]);
  });

  it.each<[LicenceStatusLike]>([["SUSPENDED"], ["CANCELLED"], ["EXPIRED"], ["PENDING"]])(
    "licence status %s -> NOT_ENTITLED, never silently entitled",
    (status) => {
      const result = classifyEntitlement("STATEMENT_CERTIFICATION", true, { ...practiceLicence, status }, false);
      expect(result.status).toBe("NOT_ENTITLED");
      expect(result.reason).toBe("LICENCE_NOT_ACTIVE");
      expect(result.licenceStatus).toBe(status);
    },
  );

  it("GRACE status counts as entitled, same as ACTIVE", () => {
    const result = classifyEntitlement("STATEMENT_CERTIFICATION", true, { ...practiceLicence, status: "GRACE" }, false);
    expect(result.status).toBe("ENTITLED");
    expect(result.source).toBe("ACTIVE_LICENCE");
  });

  it("Practice includes every paid capability; legacy input codes resolve the same way", () => {
    for (const code of ["STATEMENT_CERTIFICATION", "REPORTING_PACK_EXPORT", "CLOSE_INSIGHTS", "SAFISHA_CERTIFY", "HESABU_EXPORT", "MAONO_INTELLIGENCE"]) {
      const result = classifyEntitlement(code, true, practiceLicence, false);
      expect([result.status, result.reason, result.planCode]).toEqual(["ENTITLED", "ACTIVE_LICENCE_INCLUDES_FEATURE", "PRACTICE"]);
    }
  });

  it("a licence on the retired Free plan entitles nothing, whatever features it claims", () => {
    for (const code of ["CLOSE_ASSURANCE", "COMPARATIVE_REPORTING", "STATEMENT_CERTIFICATION", "REPORTING_PACK_EXPORT", "CLOSE_INSIGHTS", "CLEAN_PDF"]) {
      const result = classifyEntitlement(code, true, freeLicence, false);
      expect([result.status, result.reason, result.planCode]).toEqual(["NOT_ENTITLED", "RETIRED_PLAN", null]);
    }
  });

  it("Solo includes every capability except multi-entity reporting; consolidation is on no plan", () => {
    const solo: CurrentLicenceSnapshot = { status: "ACTIVE", planCode: "SOLO", featureCodes: ALL_PAID };
    for (const code of ["CLOSE_ASSURANCE", "COMPARATIVE_REPORTING", "STATEMENT_CERTIFICATION", "REPORTING_PACK_EXPORT", "CLOSE_INSIGHTS", "CLEAN_PDF", "EXCEL_EXPORT", "FILING_PACKS", "MANAGEMENT_LETTERS", "REGIONAL_PACKS"]) {
      expect(classifyEntitlement(code, true, solo, false).status).toBe("ENTITLED");
    }
    expect(classifyEntitlement("MULTI_ENTITY_REPORTING", true, solo, false).reason).toBe("PLAN_DOES_NOT_INCLUDE_FEATURE");
    expect(classifyEntitlement("MULTI_ENTITY_REPORTING", true, practiceLicence, false).status).toBe("ENTITLED");
    for (const l of [solo, practiceLicence]) expect(classifyEntitlement("CONSOLIDATION", true, l, false).status).toBe("NOT_ENTITLED");
  });

  it("an unknown plan code is refused, whatever features it claims", () => {
    const result = classifyEntitlement("CLOSE_INSIGHTS", true, { status: "ACTIVE", planCode: "GOLD", featureCodes: ALL_PAID }, false);
    expect([result.status, result.reason]).toEqual(["NOT_ENTITLED", "UNKNOWN_PLAN"]);
  });

  it("the grandfathered legacy PAID plan still entitles its paid capabilities", () => {
    expect(classifyEntitlement("CLOSE_INSIGHTS", true, { status: "ACTIVE", planCode: "PAID", featureCodes: ALL_PAID }, false).status).toBe("ENTITLED");
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
    planCode: "PRACTICE",
    featureCodes: ["CLOSE_ASSURANCE"],
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
      "STATEMENT_CERTIFICATION",
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
