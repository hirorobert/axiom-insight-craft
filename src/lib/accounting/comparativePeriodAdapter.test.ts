/**
 * comparativePeriodAdapter.test.ts — Ω∞ Phase 4 Slice 1.
 *
 * Proves the adapter never infers comparative source authority from period
 * existence alone, never fabricates the two structurally-excluded tiers,
 * fails closed on malformed/duplicate line data, and composes correctly
 * with the certified comparativeEvidence.ts functions (reused unmodified).
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  fromPeriodPairRow,
  buildComparativeEvidenceAvailability,
  lineLookupFromRows,
  type PeriodPairRow,
  type ComparativeSourceAuthorityFacts,
  type ComparativeLineRow,
} from "./comparativePeriodAdapter";
import {
  resolveComparativeSourceTier,
  resolveComparativeAmount,
  detectMappingDrift,
  detectPresenceChanges,
  type PeriodMappingSnapshot,
} from "./comparativeEvidence";

const NO_PRIOR_ROW: PeriodPairRow = {
  current_period_id: "period-2026",
  company_id: "company-1",
  prior_period_id: null,
  prior_label: null,
  prior_year_end: null,
};

const WITH_PRIOR_ROW: PeriodPairRow = {
  current_period_id: "period-2026",
  company_id: "company-1",
  prior_period_id: "period-2025",
  prior_label: "FY2025",
  prior_year_end: "2025-06-30",
};

// ── [1] priorPeriodId null creates only period facts, no authority ─────────

describe("[1] priorPeriodId null creates only period facts and no authority", () => {
  it("fromPeriodPairRow surfaces priorPeriodId: null", () => {
    const facts = fromPeriodPairRow(NO_PRIOR_ROW);
    expect(facts.priorPeriodId).toBeNull();
    expect(facts.priorPeriodLabel).toBeNull();
    expect(facts.priorYearEnd).toBeNull();
  });

  it("with no authority facts supplied, the source tier is UNAVAILABLE", () => {
    const availability = buildComparativeEvidenceAvailability({});
    expect(resolveComparativeSourceTier(availability)).toBe("UNAVAILABLE");
  });
});

// ── [2]/[3]/[4] period existence alone cannot establish any authority tier ─

describe("[2] priorPeriodId non-null alone cannot establish a source tier", () => {
  it("a real prior period relationship still resolves UNAVAILABLE without authority facts", () => {
    const facts = fromPeriodPairRow(WITH_PRIOR_ROW);
    expect(facts.priorPeriodId).toBe("period-2025");
    const availability = buildComparativeEvidenceAvailability({});
    expect(resolveComparativeSourceTier(availability)).toBe("UNAVAILABLE");
  });
});

describe("[3]/[4] PeriodPairRow carries no upload/certification data at all -- structurally cannot establish certified close or confirmed mapping", () => {
  it("PeriodPairFacts has no field derived from an upload or certification id", () => {
    const facts = fromPeriodPairRow(WITH_PRIOR_ROW);
    // @ts-expect-error -- priorUploadId does not exist on PeriodPairFacts; this adapter never reads it as authority
    const leak = facts.priorUploadId;
    expect(leak).toBeUndefined();
  });
});

// ── [5]/[6] structurally excluded tiers ─────────────────────────────────────

describe("[5] adapter structurally cannot set priorAuditedSignedStatements", () => {
  it("ComparativeSourceAuthorityFacts has no such field", () => {
    const bad: ComparativeSourceAuthorityFacts = {
      // @ts-expect-error -- priorAuditedSignedStatements does not exist on ComparativeSourceAuthorityFacts
      priorAuditedSignedStatements: { ref: "x", detail: "fabricated" },
    };
    expect(bad).toBeDefined();
  });

  it("the built availability object never carries the key, even when both real tiers are supplied", () => {
    const availability = buildComparativeEvidenceAvailability({
      priorStatementsLocked: { ref: "sso-1", detail: "locked" },
      priorCertificationNonBlocking: { ref: "cert-1", detail: "not blocking" },
    });
    expect("priorAuditedSignedStatements" in availability).toBe(false);
  });
});

describe("[6] adapter structurally cannot set manualComparativeWithProvenance", () => {
  it("ComparativeSourceAuthorityFacts has no such field", () => {
    const bad: ComparativeSourceAuthorityFacts = {
      // @ts-expect-error -- manualComparativeWithProvenance does not exist on ComparativeSourceAuthorityFacts
      manualComparativeWithProvenance: { ref: "x", detail: "fabricated" },
    };
    expect(bad).toBeDefined();
  });

  it("the built availability object never carries the key", () => {
    const availability = buildComparativeEvidenceAvailability({
      priorStatementsLocked: { ref: "sso-1", detail: "locked" },
      priorCertificationNonBlocking: { ref: "cert-1", detail: "not blocking" },
    });
    expect("manualComparativeWithProvenance" in availability).toBe(false);
  });
});

// ── [7]/[8]/[9] explicit authority facts resolve the correct tier ──────────

describe("[7] explicit priorCertificationNonBlocking resolves PRIOR_TB_WITH_CONFIRMED_MAPPING", () => {
  it("resolves the correct tier", () => {
    const availability = buildComparativeEvidenceAvailability({
      priorCertificationNonBlocking: { ref: "cert-1", detail: "not blocking" },
    });
    expect(resolveComparativeSourceTier(availability)).toBe("PRIOR_TB_WITH_CONFIRMED_MAPPING");
  });
});

describe("[8] explicit priorStatementsLocked resolves PRIOR_CERTIFIED_SAFF_CLOSE", () => {
  it("resolves the correct tier", () => {
    const availability = buildComparativeEvidenceAvailability({
      priorStatementsLocked: { ref: "sso-1", detail: "locked" },
    });
    expect(resolveComparativeSourceTier(availability)).toBe("PRIOR_CERTIFIED_SAFF_CLOSE");
  });
});

describe("[9] both supplied: the existing source hierarchy selects the higher-authority tier", () => {
  it("PRIOR_CERTIFIED_SAFF_CLOSE (Tier 2) wins over PRIOR_TB_WITH_CONFIRMED_MAPPING (Tier 3)", () => {
    const availability = buildComparativeEvidenceAvailability({
      priorStatementsLocked: { ref: "sso-1", detail: "locked" },
      priorCertificationNonBlocking: { ref: "cert-1", detail: "not blocking" },
    });
    expect(resolveComparativeSourceTier(availability)).toBe("PRIOR_CERTIFIED_SAFF_CLOSE");
  });
});

// ── [10]-[13] KNOWN / ZERO / MISSING / NOT_APPLICABLE via the certified resolver ─

describe("[10]-[13] zero/missing semantics compose correctly through the adapter's lookup", () => {
  const lookup = lineLookupFromRows([
    { naturalAccountCode: "21111101", amount: 100 },
    { naturalAccountCode: "33111113", amount: 0 },
  ]);

  it("[10] row amount 100 -> KNOWN 100", () => {
    const result = resolveComparativeAmount("21111101", "PRIOR_TB_WITH_CONFIRMED_MAPPING", lookup, "cert-1");
    expect(result.state).toBe("KNOWN");
    expect(result.state === "KNOWN" && result.value).toBe(100);
  });

  it("[11] row amount 0 -> ZERO", () => {
    const result = resolveComparativeAmount("33111113", "PRIOR_TB_WITH_CONFIRMED_MAPPING", lookup, "cert-1");
    expect(result.state).toBe("ZERO");
  });

  it("[12] absent line under a resolved source -> MISSING", () => {
    const result = resolveComparativeAmount("99999999", "PRIOR_TB_WITH_CONFIRMED_MAPPING", lookup, "cert-1");
    expect(result.state).toBe("MISSING");
  });

  it("[13] no comparative source at all -> NOT_APPLICABLE (existing behavior, unmodified)", () => {
    const result = resolveComparativeAmount("21111101", "UNAVAILABLE", lookup, "n/a");
    expect(result.state).toBe("NOT_APPLICABLE");
  });
});

// ── [14]-[17] malformed amounts fail closed ─────────────────────────────────

describe("[14]-[17] malformed amounts fail closed, deterministically, never coerced", () => {
  it("[14] NaN throws", () => {
    expect(() => lineLookupFromRows([{ naturalAccountCode: "X", amount: NaN }])).toThrow();
  });

  it("[15] Infinity throws", () => {
    expect(() => lineLookupFromRows([{ naturalAccountCode: "X", amount: Infinity }])).toThrow();
  });

  it("[16] -Infinity throws", () => {
    expect(() => lineLookupFromRows([{ naturalAccountCode: "X", amount: -Infinity }])).toThrow();
  });

  it("[17] a runtime string amount (bypassing TypeScript) throws, never coerces", () => {
    const rows = [{ naturalAccountCode: "X", amount: "100" as unknown as number }] as ComparativeLineRow[];
    expect(() => lineLookupFromRows(rows)).toThrow();
  });
});

// ── [18]/[19] duplicate codes fail closed, deterministically ───────────────

describe("[18]/[19] duplicate natural account codes fail closed, deterministically", () => {
  it("[18] a duplicate naturalAccountCode throws", () => {
    expect(() =>
      lineLookupFromRows([
        { naturalAccountCode: "21111101", amount: 100 },
        { naturalAccountCode: "21111101", amount: 200 },
      ]),
    ).toThrow();
  });

  it("[19] the duplicate error is deterministic across repeated calls with the same input", () => {
    const rows: ComparativeLineRow[] = [
      { naturalAccountCode: "21111101", amount: 100 },
      { naturalAccountCode: "21111101", amount: 200 },
    ];
    let firstMessage = "";
    let secondMessage = "";
    try {
      lineLookupFromRows(rows);
    } catch (e) {
      firstMessage = (e as Error).message;
    }
    try {
      lineLookupFromRows(rows);
    } catch (e) {
      secondMessage = (e as Error).message;
    }
    expect(firstMessage).not.toBe("");
    expect(firstMessage).toBe(secondMessage);
  });
});

// ── [20]-[22] mapping drift / presence change compatibility (unmodified) ───

describe("[20] mapping drift remains surfaced through the certified, unmodified detectMappingDrift", () => {
  it("same naturalAccountCode + changed presentation is flagged", () => {
    const prior: PeriodMappingSnapshot[] = [
      { periodLabel: "FY2025", naturalAccountCode: "63181188", presentationCode: "RESERVES" },
    ];
    const current: PeriodMappingSnapshot[] = [
      { periodLabel: "FY2026", naturalAccountCode: "63181188", presentationCode: "PAYABLES_AND_ACCRUALS" },
    ];
    const flags = detectMappingDrift(prior, current);
    expect(flags).toHaveLength(1);
    expect(flags[0].naturalAccountCode).toBe("63181188");
  });
});

describe("[21]/[22] presence changes remain surfaced through the certified, unmodified detectPresenceChanges", () => {
  it("[21] a current-only code is NEW_THIS_PERIOD", () => {
    const changes = detectPresenceChanges(["A"], ["A", "B"]);
    expect(changes).toContainEqual({ naturalAccountCode: "B", change: "NEW_THIS_PERIOD" });
  });

  it("[22] a prior-only code is ABSENT_THIS_PERIOD", () => {
    const changes = detectPresenceChanges(["A", "C"], ["A"]);
    expect(changes).toContainEqual({ naturalAccountCode: "C", change: "ABSENT_THIS_PERIOD" });
  });

  it("no cross-code continuity is fabricated for a code change (old code absent, new code new -- not merged)", () => {
    const changes = detectPresenceChanges(["OLD_CODE"], ["NEW_CODE"]);
    expect(changes).toContainEqual({ naturalAccountCode: "OLD_CODE", change: "ABSENT_THIS_PERIOD" });
    expect(changes).toContainEqual({ naturalAccountCode: "NEW_CODE", change: "NEW_THIS_PERIOD" });
    expect(changes).toHaveLength(2);
  });
});

// ── [23] determinism ─────────────────────────────────────────────────────────

describe("[23] same inputs twice produce deep-equal deterministic outputs", () => {
  it("buildComparativeEvidenceAvailability is deterministic", () => {
    const authority: ComparativeSourceAuthorityFacts = {
      priorStatementsLocked: { ref: "sso-1", detail: "locked" },
    };
    expect(buildComparativeEvidenceAvailability(authority)).toEqual(
      buildComparativeEvidenceAvailability(authority),
    );
  });

  it("fromPeriodPairRow is deterministic", () => {
    expect(fromPeriodPairRow(WITH_PRIOR_ROW)).toEqual(fromPeriodPairRow(WITH_PRIOR_ROW));
  });
});

// ── [24]/[25] no timestamps/random ids, no DB/network/write imports ────────

describe("[24]/[25] the module carries no timestamps, random ids, or DB/network/write dependencies", () => {
  it("[24] no Date.now()/new Date()/randomUUID in executable code", () => {
    const source: string = fs.readFileSync(
      path.join(__dirname, "comparativePeriodAdapter.ts"),
      "utf-8",
    );
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/Date\.now\(\)|new Date\(|randomUUID/);
  });

  it("[25] no supabase/DB/network import anywhere in the module", () => {
    const source: string = fs.readFileSync(
      path.join(__dirname, "comparativePeriodAdapter.ts"),
      "utf-8",
    );
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/supabase|fetch\(|XMLHttpRequest|process-trial-balance|account_review_decisions|account_mappings/i);
  });
});
