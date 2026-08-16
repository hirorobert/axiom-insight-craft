/**
 * museClassifier.test.ts
 *
 * Slice 4/5 — proves the evidence-ladder classifier's outcome model, and
 * runs the Section XXI dry-run requirement: classify every real account this
 * rule pack was built from and report AUTO_MAPPED_RULE / REVIEW_SUGGESTED /
 * UNRESOLVED counts. NO WRITES anywhere in this file or the code it tests.
 */

import { describe, it, expect } from "vitest";
import { classifyMuseAccount, classifyMuseAccounts, summarizeDryRun } from "./museClassifier";
import { TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1 } from "./museIpsasRulePack";

describe("classifyMuseAccount", () => {
  it("a HIGH-confidence rule match resolves to AUTO_MAPPED_RULE", () => {
    const result = classifyMuseAccount({
      naturalAccountCode: "21111101",
      accountName: "Civil Servants",
      balance: 58582200999.32,
    });
    expect(result.outcome).toBe("AUTO_MAPPED_RULE");
    expect(result.accountNature).toBe("EXPENSE");
    expect(result.presentationCode).toBe("EMPLOYEE_COSTS");
    expect(result.ruleId).toBe("TZ-IPSAS-MUSE-21111101");
    expect(result.evidence).toHaveLength(1);
  });

  it("a LOW/MEDIUM-confidence rule match resolves to REVIEW_SUGGESTED, not AUTO_MAPPED_RULE", () => {
    // 14150101 is deliberately LOW confidence — see museIpsasRulePack.test.ts.
    const result = classifyMuseAccount({
      naturalAccountCode: "14150101",
      accountName: "Revenue from Land",
      balance: 2612625,
    });
    expect(result.outcome).toBe("REVIEW_SUGGESTED");
    expect(result.accountNature).toBe("REVENUE");
    expect(result.confidence).toBe("LOW");
  });

  it("a code with no matching rule resolves to UNRESOLVED, never a guess (C4)", () => {
    const result = classifyMuseAccount({
      naturalAccountCode: "99999999",
      accountName: "Some Account Never Seen In Arusha Data",
      balance: 100,
    });
    expect(result.outcome).toBe("UNRESOLVED");
    expect(result.accountNature).toBeUndefined();
    expect(result.presentationCode).toBeUndefined();
    expect(result.confidence).toBe("NONE");
  });

  it("outcome=AUTO_MAPPED_RULE is not the same thing as professionally approved (Section VII)", () => {
    // Structural proof: the outcome type has no field claiming professional
    // sign-off, and the reason text never uses approval language.
    const result = classifyMuseAccount({
      naturalAccountCode: "21111101",
      accountName: "Civil Servants",
      balance: 1,
    });
    expect(result.reason.toLowerCase()).not.toContain("approved");
    expect(result.reason.toLowerCase()).not.toContain("certified");
  });
});

describe("Section XXI dry-run — real Arusha DC unresolved accounts, NO WRITES", () => {
  // The dry-run corpus IS the rule pack's own source accounts: every code
  // TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1 was built from, run back through the
  // classifier that consumes it. This is not circular — it proves the
  // classifier actually resolves every account the rule pack claims to
  // cover, with the exact confidence tier each one was assigned, rather
  // than asserting rule-pack correctness without ever executing the lookup.
  const accounts = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.map((rule) => ({
    naturalAccountCode: rule.naturalAccountCode,
    accountName: rule.observedAccountName,
    balance: 0, // dry-run classification does not depend on balance magnitude
  }));

  const outcomes = classifyMuseAccounts(accounts);
  const summary = summarizeDryRun(outcomes);

  it("classifies all 294 real Arusha DC accounts with zero UNRESOLVED (every one has a grounded rule)", () => {
    expect(summary.total).toBe(294);
    expect(summary.unresolved).toBe(0);
    expect(summary.autoMappedRule + summary.reviewSuggested).toBe(294);
  });

  it("REVIEW_SUGGESTED is reserved for the genuinely ambiguous cases, not the majority", () => {
    // Matches the rule pack's own MEDIUM/LOW-confidence count exactly.
    const nonHighInPack = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.filter(
      (r) => r.confidence !== "HIGH",
    ).length;
    expect(summary.reviewSuggested).toBe(nonHighInPack);
    expect(summary.autoMappedRule).toBeGreaterThan(summary.reviewSuggested);
  });

  it("adding one genuinely unseen account to the batch yields exactly one UNRESOLVED, without disturbing the other 294", () => {
    const withUnknown = classifyMuseAccounts([
      ...accounts,
      { naturalAccountCode: "00000000", accountName: "Never seen", balance: 0 },
    ]);
    const s = summarizeDryRun(withUnknown);
    expect(s.total).toBe(295);
    expect(s.unresolved).toBe(1);
    expect(s.autoMappedRule + s.reviewSuggested).toBe(294);
  });
});
