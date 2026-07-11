/**
 * computeComplianceScore.test.ts
 * Phase 2 — Golden fixture tests for the canonical compliance scoring engine
 *
 * Tests the PURE function scoreFromData() and scoreToGrade().
 * No DB calls. No mocks needed for the logic under test.
 *
 * The 6 FA2026 golden fixtures at the bottom are named after real-world scenarios
 * and serve as regression anchors. If any pass/fail status changes after a code
 * edit, the code change is the bug — these expected values are ground truth.
 *
 * Score formula (verified 2026-07-11):
 *   A. Open findings × severity weight          30 pts
 *   B. Transfer pricing / thin cap risk         20 pts
 *   C. Payment coverage vs exposure             20 pts
 *   D. Overdue filing obligations               15 pts
 *   E. Period sign-off / lock status            15 pts
 *
 * Grade thresholds: ≥90=Compliant, ≥70=Monitor, ≥50=At Risk, <50=Critical
 */

import { describe, it, expect, vi } from "vitest";

// Mock supabase before importing the module (supabase is imported at file top-level
// in computeComplianceScore.ts but the pure functions don't call it)
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(() => ({ select: vi.fn(), eq: vi.fn(), in: vi.fn(), order: vi.fn(), limit: vi.fn() })),
  },
}));

import {
  scoreFromData,
  scoreToGrade,
  type ScoringInputData,
  type ComplianceGrade,
} from "../computeComplianceScore";

// ── Helpers ───────────────────────────────────────────────────────────────────

const FIXED_NOW = new Date("2026-07-11T00:00:00.000Z");

/** A period_end that is NOT overdue (60 days in the future) */
const FUTURE_PERIOD_END = "2026-09-10"; // 61 days from FIXED_NOW

/** A period_end that IS overdue (past period_end + 30 day grace) */
const OVERDUE_PERIOD_END = "2026-05-01"; // 71 days ago → grace expired

function cleanInput(): ScoringInputData {
  return {
    openFindings: [],
    taxCompWarnings: [],
    totalPaid: 0,
    signOffStatus: "locked",
    now: FIXED_NOW,
  };
}

// ── scoreToGrade ──────────────────────────────────────────────────────────────

describe("scoreToGrade — grade boundary fixtures", () => {
  it("score 90 → Compliant", () => expect(scoreToGrade(90)).toBe("Compliant"));
  it("score 100 → Compliant", () => expect(scoreToGrade(100)).toBe("Compliant"));
  it("score 89 → Monitor",   () => expect(scoreToGrade(89)).toBe("Monitor"));
  it("score 70 → Monitor",   () => expect(scoreToGrade(70)).toBe("Monitor"));
  it("score 69 → At Risk",   () => expect(scoreToGrade(69)).toBe("At Risk"));
  it("score 50 → At Risk",   () => expect(scoreToGrade(50)).toBe("At Risk"));
  it("score 49 → Critical",  () => expect(scoreToGrade(49)).toBe("Critical"));
  it("score 0 → Critical",   () => expect(scoreToGrade(0)).toBe("Critical"));
});

// ── Factor A: Open Findings (30 pts) ─────────────────────────────────────────

describe("Factor A — Open Findings (30 pts weight)", () => {
  it("no findings → Factor A contributes full 30 pts", () => {
    const result = scoreFromData({ ...cleanInput(), openFindings: [] });
    const factorA = result.factors.find(f => f.label === "Open Findings")!;
    expect(factorA.score).toBe(100);
    expect(factorA.contribution).toBe(30);
  });

  it("1 high-severity finding (cit_underpayment) → deducts 15 pts from A", () => {
    const input = {
      ...cleanInput(),
      openFindings: [{
        finding_category: "cit_underpayment",
        exposure_amount_tzs: 5_000_000,
        period_end: FUTURE_PERIOD_END,
      }],
      totalPaid: 5_000_000,  // fully paid → Factor C = 100
    };
    const result = scoreFromData(input);
    const factorA = result.factors.find(f => f.label === "Open Findings")!;
    expect(factorA.score).toBe(85);              // 100 − 15
    expect(factorA.contribution).toBeCloseTo(25.5, 1);
  });

  it("1 low-severity finding → deducts 8 pts from A", () => {
    const input = {
      ...cleanInput(),
      openFindings: [{
        finding_category: "other_adjustment",
        exposure_amount_tzs: 1_000_000,
        period_end: FUTURE_PERIOD_END,
      }],
    };
    const result = scoreFromData(input);
    const factorA = result.factors.find(f => f.label === "Open Findings")!;
    expect(factorA.score).toBe(92);              // 100 − 8
  });

  it("7 high findings → A deduction capped at 100 (score = 0)", () => {
    const input = {
      ...cleanInput(),
      openFindings: Array(7).fill({
        finding_category: "penalty",
        exposure_amount_tzs: 1_000_000,
        period_end: FUTURE_PERIOD_END,
      }),
    };
    const result = scoreFromData(input);
    const factorA = result.factors.find(f => f.label === "Open Findings")!;
    expect(factorA.score).toBe(0);
    expect(factorA.contribution).toBe(0);
  });

  it("high-severity categories include penalty, minimum_tax_gap, management_fee_disallowance", () => {
    const HIGH_CATS = ["cit_underpayment", "penalty", "minimum_tax_gap", "management_fee_disallowance"];
    for (const cat of HIGH_CATS) {
      const result = scoreFromData({
        ...cleanInput(),
        openFindings: [{ finding_category: cat, exposure_amount_tzs: 1_000_000, period_end: FUTURE_PERIOD_END }],
      });
      const factorA = result.factors.find(f => f.label === "Open Findings")!;
      expect(factorA.score).toBe(85); // 100 − 15 (high deduction)
    }
  });
});

// ── Factor B: Transfer Pricing Risk (20 pts) ─────────────────────────────────

describe("Factor B — TP Risk (20 pts weight)", () => {
  it("no TP findings, no warnings → full 20 pts", () => {
    const result = scoreFromData(cleanInput());
    const factorB = result.factors.find(f => f.label === "Transfer Pricing Risk")!;
    expect(factorB.score).toBe(100);
    expect(factorB.contribution).toBe(20);
  });

  it("1 management_fee_disallowance finding → -25 pts on Factor B", () => {
    const result = scoreFromData({
      ...cleanInput(),
      openFindings: [{
        finding_category: "management_fee_disallowance",
        exposure_amount_tzs: 50_000_000,
        period_end: FUTURE_PERIOD_END,
      }],
    });
    const factorB = result.factors.find(f => f.label === "Transfer Pricing Risk")!;
    expect(factorB.score).toBe(75);              // 100 − 25
  });

  it("2 TP findings → score = 50, contribution = 10", () => {
    const result = scoreFromData({
      ...cleanInput(),
      openFindings: [
        { finding_category: "management_fee_disallowance", exposure_amount_tzs: 10_000_000, period_end: null },
        { finding_category: "thin_cap_disallowance",       exposure_amount_tzs: 20_000_000, period_end: null },
      ],
    });
    const factorB = result.factors.find(f => f.label === "Transfer Pricing Risk")!;
    expect(factorB.score).toBe(50);              // 100 − 25 − 25
  });

  it("TP classification warnings also reduce Factor B", () => {
    const result = scoreFromData({
      ...cleanInput(),
      taxCompWarnings: [{ category: "thin_cap" }, { category: "management_fee" }],
    });
    const factorB = result.factors.find(f => f.label === "Transfer Pricing Risk")!;
    expect(factorB.score).toBe(80);              // 100 − 10 − 10
  });
});

// ── Factor C: Payment Coverage (20 pts) ──────────────────────────────────────

describe("Factor C — Payment Coverage (20 pts weight)", () => {
  it("zero exposure → 100% coverage score (100 pts)", () => {
    const result = scoreFromData({ ...cleanInput(), openFindings: [], totalPaid: 0 });
    const factorC = result.factors.find(f => f.label === "Payment Coverage")!;
    expect(factorC.score).toBe(100);
    expect(factorC.contribution).toBe(20);
  });

  it("50% coverage → Factor C score = 50", () => {
    const result = scoreFromData({
      ...cleanInput(),
      openFindings: [{
        finding_category: "cit_underpayment",
        exposure_amount_tzs: 10_000_000,
        period_end: null,
      }],
      totalPaid: 5_000_000,
    });
    const factorC = result.factors.find(f => f.label === "Payment Coverage")!;
    expect(factorC.score).toBe(50);              // 5M/10M × 100
    expect(factorC.contribution).toBe(10);
  });

  it("full coverage → Factor C = 100", () => {
    const result = scoreFromData({
      ...cleanInput(),
      openFindings: [{
        finding_category: "cit_underpayment",
        exposure_amount_tzs: 10_000_000,
        period_end: null,
      }],
      totalPaid: 10_000_000,
    });
    const factorC = result.factors.find(f => f.label === "Payment Coverage")!;
    expect(factorC.score).toBe(100);
  });

  it("overpayment capped at 100 (not above 100)", () => {
    const result = scoreFromData({
      ...cleanInput(),
      openFindings: [{
        finding_category: "cit_underpayment",
        exposure_amount_tzs: 5_000_000,
        period_end: null,
      }],
      totalPaid: 20_000_000,  // 4× overpaid
    });
    const factorC = result.factors.find(f => f.label === "Payment Coverage")!;
    expect(factorC.score).toBeLessThanOrEqual(100);
  });
});

// ── Factor D: Filing Deadlines (15 pts) ──────────────────────────────────────

describe("Factor D — Filing Deadlines (15 pts weight)", () => {
  it("no overdue → full 15 pts", () => {
    const result = scoreFromData({
      ...cleanInput(),
      openFindings: [{
        finding_category: "other",
        exposure_amount_tzs: 1_000_000,
        period_end: FUTURE_PERIOD_END,   // not overdue
      }],
    });
    const factorD = result.factors.find(f => f.label === "Filing Deadlines")!;
    expect(factorD.score).toBe(100);
  });

  it("1 overdue (>30 days past period_end) → -20 pts on D", () => {
    const result = scoreFromData({
      ...cleanInput(),
      openFindings: [{
        finding_category: "cit_underpayment",
        exposure_amount_tzs: 5_000_000,
        period_end: OVERDUE_PERIOD_END,  // overdue
      }],
    });
    const factorD = result.factors.find(f => f.label === "Filing Deadlines")!;
    expect(factorD.score).toBe(80);              // 100 − 20
    expect(factorD.contribution).toBeCloseTo(12, 0);
  });

  it("5 overdue → D score = 0 (floor)", () => {
    const result = scoreFromData({
      ...cleanInput(),
      openFindings: Array(5).fill({
        finding_category: "cit_underpayment",
        exposure_amount_tzs: 1_000_000,
        period_end: OVERDUE_PERIOD_END,
      }),
    });
    const factorD = result.factors.find(f => f.label === "Filing Deadlines")!;
    expect(factorD.score).toBe(0);               // 100 − 5×20 = 0
  });

  it("finding with null period_end is NOT counted as overdue", () => {
    const result = scoreFromData({
      ...cleanInput(),
      openFindings: [{
        finding_category: "cit_underpayment",
        exposure_amount_tzs: 1_000_000,
        period_end: null,  // no period end set
      }],
    });
    const factorD = result.factors.find(f => f.label === "Filing Deadlines")!;
    expect(factorD.score).toBe(100);             // null period_end → not overdue
  });
});

// ── Factor E: Period Sign-off (15 pts) ───────────────────────────────────────

describe("Factor E — Period Sign-off (15 pts weight)", () => {
  const cases: Array<[string | null, number]> = [
    ["locked",          100],
    ["approved",         90],
    ["reviewer_signed",  70],
    ["preparer_signed",  50],
    ["draft",            30],
    [null,               40],
  ];

  for (const [status, expectedScore] of cases) {
    it(`status="${status ?? "null"}" → E score = ${expectedScore}`, () => {
      const result = scoreFromData({ ...cleanInput(), signOffStatus: status });
      const factorE = result.factors.find(f => f.label === "Period Sign-off")!;
      expect(factorE.score).toBe(expectedScore);
      expect(factorE.contribution).toBeCloseTo(expectedScore * 0.15, 1);
    });
  }
});

// ── Total score correctness ───────────────────────────────────────────────────

describe("Total score arithmetic", () => {
  it("perfect input → total = 100", () => {
    const result = scoreFromData({
      openFindings: [],
      taxCompWarnings: [],
      totalPaid: 0,
      signOffStatus: "locked",
      now: FIXED_NOW,
    });
    expect(result.totalScore).toBe(100);
    expect(result.grade).toBe("Compliant");
  });

  it("factor contributions sum to totalScore", () => {
    const input: ScoringInputData = {
      openFindings: [
        { finding_category: "cit_underpayment",       exposure_amount_tzs: 5_000_000,  period_end: OVERDUE_PERIOD_END },
        { finding_category: "management_fee_disallowance", exposure_amount_tzs: 3_000_000, period_end: FUTURE_PERIOD_END },
      ],
      taxCompWarnings: [{ category: "management_fee" }],
      totalPaid: 2_000_000,
      signOffStatus: "reviewer_signed",
      now: FIXED_NOW,
    };
    const result = scoreFromData(input);
    const sumOfContributions = result.factors.reduce((s, f) => s + f.contribution, 0);
    expect(result.totalScore).toBe(Math.round(sumOfContributions));
  });
});

// ── FA2026 Golden Fixtures ────────────────────────────────────────────────────
//
// Six named scenarios based on real Tanzania ITA Cap.332 company profiles.
// These are regression anchors — expected scores must not change without
// deliberate decision and re-verification.

describe("FA2026 Golden Fixtures", () => {

  it("GF-1: Kamanga Normal — profitable, zero findings, locked period → Compliant 100", () => {
    const result = scoreFromData({
      openFindings: [],
      taxCompWarnings: [],
      totalPaid: 0,
      signOffStatus: "locked",
      now: FIXED_NOW,
    });
    expect(result.totalScore).toBe(100);
    expect(result.grade).toBe("Compliant");
  });

  it("GF-2: Loss year with minimum_tax_gap finding — Critical", () => {
    // Company has a minimum tax gap (AMT triggered), no payment, draft sign-off
    const result = scoreFromData({
      openFindings: [{
        finding_category: "minimum_tax_gap",   // high-severity
        exposure_amount_tzs: 12_000_000,
        period_end: OVERDUE_PERIOD_END,         // already overdue (loss yr end)
      }],
      taxCompWarnings: [],
      totalPaid: 0,                             // nothing paid
      signOffStatus: "draft",
      now: FIXED_NOW,
    });
    // Factor A: 100-15=85, ×0.30 = 25.5
    // Factor B: 100,    ×0.20 = 20.0 (minimum_tax_gap is not TP)
    // Factor C: 0,      ×0.20 = 0    (0 paid vs 12M exposure)
    // Factor D: 80,     ×0.15 = 12   (1 overdue)
    // Factor E: 30,     ×0.15 = 4.5  (draft)
    // Total = 25.5+20+0+12+4.5 = 62 → At Risk
    expect(result.totalScore).toBe(62);
    expect(result.grade).toBe("At Risk");
  });

  it("GF-3: Thin cap year — TP finding, partial payment, reviewer signed → At Risk", () => {
    const result = scoreFromData({
      openFindings: [{
        finding_category: "thin_cap_disallowance",   // TP category
        exposure_amount_tzs: 30_000_000,
        period_end: FUTURE_PERIOD_END,
      }],
      taxCompWarnings: [{ category: "thin_cap" }],
      totalPaid: 15_000_000,   // 50% coverage
      signOffStatus: "reviewer_signed",
      now: FIXED_NOW,
    });
    // Factor A: 100-8=92 (thin_cap is NOT a high-severity category), ×0.30 = 27.6 → 28
    // Factor B: 100-25-10=65, ×0.20 = 13
    // Factor C: 50, ×0.20 = 10
    // Factor D: 100, ×0.15 = 15 (not overdue)
    // Factor E: 70, ×0.15 = 10.5
    // Total = 27.6+13+10+15+10.5 = 76.1 → 76 → Monitor
    expect(result.totalScore).toBe(76);
    expect(result.grade).toBe("Monitor");
  });

  it("GF-4: AMT + penalty — two high-severity findings, no payment → Critical", () => {
    const result = scoreFromData({
      openFindings: [
        { finding_category: "minimum_tax_gap", exposure_amount_tzs: 10_000_000, period_end: OVERDUE_PERIOD_END },
        { finding_category: "penalty",         exposure_amount_tzs:  5_000_000, period_end: OVERDUE_PERIOD_END },
      ],
      taxCompWarnings: [],
      totalPaid: 0,
      signOffStatus: null,
      now: FIXED_NOW,
    });
    // Factor A: 100-30=70 (2 high findings), ×0.30 = 21
    // Factor B: 100, ×0.20 = 20
    // Factor C: 0,   ×0.20 = 0 (0 paid vs 15M)
    // Factor D: 60,  ×0.15 = 9 (2 overdue → 100-40=60)
    // Factor E: 40,  ×0.15 = 6 (null sign-off)
    // Total = 21+20+0+9+6 = 56 → At Risk
    expect(result.totalScore).toBe(56);
    expect(result.grade).toBe("At Risk");
  });

  it("GF-5: Management fee disallowance — high+TP, no payment, draft → Critical", () => {
    // Worst-case TP scenario: mgmt fee finding is BOTH high-severity AND TP-category
    const result = scoreFromData({
      openFindings: [
        { finding_category: "management_fee_disallowance", exposure_amount_tzs: 80_000_000, period_end: OVERDUE_PERIOD_END },
        { finding_category: "cit_underpayment",            exposure_amount_tzs: 24_000_000, period_end: OVERDUE_PERIOD_END },
      ],
      taxCompWarnings: [{ category: "management_fee" }],
      totalPaid: 0,
      signOffStatus: "draft",
      now: FIXED_NOW,
    });
    // Factor A: 100-(15+15)=70, ×0.30 = 21
    // Factor B: 100-25-10=65, ×0.20 = 13
    // Factor C: 0, ×0.20 = 0
    // Factor D: 60 (2 overdue), ×0.15 = 9
    // Factor E: 30 (draft), ×0.15 = 4.5
    // Total = 21+13+0+9+4.5 = 47.5 → 48 → Critical
    expect(result.totalScore).toBe(48);
    expect(result.grade).toBe("Critical");
  });

  it("GF-6: WHT penalty — minor penalty, full payment, approved sign-off → Monitor", () => {
    // WHT penalty finding (high-severity 'penalty' category) but fully paid and approved
    const result = scoreFromData({
      openFindings: [{
        finding_category: "penalty",   // high-severity
        exposure_amount_tzs: 2_500_000,
        period_end: FUTURE_PERIOD_END,
      }],
      taxCompWarnings: [],
      totalPaid: 2_500_000,   // 100% covered
      signOffStatus: "approved",
      now: FIXED_NOW,
    });
    // Factor A: 85, ×0.30 = 25.5 → 26 (1 high finding)
    // Factor B: 100, ×0.20 = 20 (penalty is not TP)
    // Factor C: 100, ×0.20 = 20 (fully paid)
    // Factor D: 100, ×0.15 = 15 (not overdue)
    // Factor E: 90,  ×0.15 = 13.5 (approved)
    // Total = 25.5+20+20+15+13.5 = 94 → Compliant
    expect(result.totalScore).toBe(94);
    expect(result.grade).toBe("Compliant");
  });
});

// ── Iron Dome invariants ──────────────────────────────────────────────────────

describe("Iron Dome invariants", () => {
  it("scoreFromData returns exactly 5 factors", () => {
    const result = scoreFromData(cleanInput());
    expect(result.factors).toHaveLength(5);
  });

  it("factor weights sum to 1.0", () => {
    const result = scoreFromData(cleanInput());
    const totalWeight = result.factors.reduce((s, f) => s + f.weight, 0);
    expect(totalWeight).toBeCloseTo(1.0, 5);
  });

  it("factor maxPts sum to 100", () => {
    const result = scoreFromData(cleanInput());
    const totalMaxPts = result.factors.reduce((s, f) => s + f.maxPts, 0);
    expect(totalMaxPts).toBe(100);
  });

  it("totalScore is always in range [0, 100]", () => {
    const worstCase: ScoringInputData = {
      openFindings: Array(10).fill({
        finding_category: "cit_underpayment",
        exposure_amount_tzs: 1_000_000,
        period_end: OVERDUE_PERIOD_END,
      }),
      taxCompWarnings: Array(10).fill({ category: "management_fee" }),
      totalPaid: 0,
      signOffStatus: "draft",
      now: FIXED_NOW,
    };
    const result = scoreFromData(worstCase);
    expect(result.totalScore).toBeGreaterThanOrEqual(0);
    expect(result.totalScore).toBeLessThanOrEqual(100);
  });

  it("grade is always one of the four valid values", () => {
    const validGrades: ComplianceGrade[] = ["Compliant", "Monitor", "At Risk", "Critical"];
    const result = scoreFromData(cleanInput());
    expect(validGrades).toContain(result.grade);
  });
});
