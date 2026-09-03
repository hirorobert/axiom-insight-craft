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

  it("a code with no matching rule AND a zero balance resolves to bare Tier 8, never a guess (C4)", () => {
    // Zero balance carries no directional evidence at all (Design Gate
    // Step 6's conservative adjudication) -- this is the true Tier 8 case,
    // distinct from the Tier 7 cases below.
    const result = classifyMuseAccount({
      naturalAccountCode: "99999999",
      accountName: "Some Account Never Seen In Arusha Data",
      balance: 0,
    });
    expect(result.outcome).toBe("UNRESOLVED");
    expect(result.accountNature).toBeUndefined();
    expect(result.presentationCode).toBeUndefined();
    expect(result.confidence).toBe("NONE");
    expect(result.evidenceTier).toBeUndefined();
    expect(result.balanceSide).toBeUndefined();
    expect(result.requiresReview).toBeUndefined();
    expect(result.evidence).toHaveLength(0);
  });

  it("[A] unmatched exact code + positive balance -> UNRESOLVED, Tier 7, DEBIT, LOW, requiresReview true", () => {
    const result = classifyMuseAccount({
      naturalAccountCode: "99999999",
      accountName: "Some Account Never Seen In Arusha Data",
      balance: 12345.67,
    });
    expect(result.outcome).toBe("UNRESOLVED");
    expect(result.evidenceTier).toBe(7);
    expect(result.balanceSide).toBe("DEBIT");
    expect(result.confidence).toBe("LOW");
    expect(result.requiresReview).toBe(true);
  });

  it("[B] unmatched exact code + negative balance -> UNRESOLVED, Tier 7, CREDIT, LOW, requiresReview true", () => {
    const result = classifyMuseAccount({
      naturalAccountCode: "99999998",
      accountName: "Some Other Account Never Seen In Arusha Data",
      balance: -12345.67,
    });
    expect(result.outcome).toBe("UNRESOLVED");
    expect(result.evidenceTier).toBe(7);
    expect(result.balanceSide).toBe("CREDIT");
    expect(result.confidence).toBe("LOW");
    expect(result.requiresReview).toBe(true);
  });

  it("[C-F] Tier 7 results never fabricate accountNature, presentationCode, ruleId, or ruleVersion", () => {
    const result = classifyMuseAccount({
      naturalAccountCode: "99999997",
      accountName: "Yet Another Account Never Seen In Arusha Data",
      balance: 500,
    });
    expect(result.evidenceTier).toBe(7); // sanity: this is genuinely the Tier 7 path
    expect(result.accountNature).toBeUndefined(); // [C]
    expect(result.presentationCode).toBeUndefined(); // [D]
    expect(result.ruleId).toBeUndefined(); // [E]
    expect(result.ruleVersion).toBeUndefined(); // [F]
  });

  it("[G] Tier 7 never produces AUTO_MAPPED_RULE, regardless of balance sign", () => {
    const debitSide = classifyMuseAccount({
      naturalAccountCode: "99999996",
      accountName: "Unseen Debit-Side Account",
      balance: 999,
    });
    const creditSide = classifyMuseAccount({
      naturalAccountCode: "99999995",
      accountName: "Unseen Credit-Side Account",
      balance: -999,
    });
    expect(debitSide.outcome).not.toBe("AUTO_MAPPED_RULE");
    expect(creditSide.outcome).not.toBe("AUTO_MAPPED_RULE");
    expect(debitSide.outcome).toBe("UNRESOLVED");
    expect(creditSide.outcome).toBe("UNRESOLVED");
  });

  it("[H] existing Tier 2 exact-code matches remain unchanged: no Tier 7 fields leak onto them", () => {
    const highConfidence = classifyMuseAccount({
      naturalAccountCode: "21111101",
      accountName: "Civil Servants",
      balance: 58582200999.32,
    });
    expect(highConfidence.outcome).toBe("AUTO_MAPPED_RULE");
    expect(highConfidence.evidenceTier).toBeUndefined();
    expect(highConfidence.balanceSide).toBeUndefined();
    expect(highConfidence.requiresReview).toBeUndefined();

    const lowConfidence = classifyMuseAccount({
      naturalAccountCode: "14150101",
      accountName: "Revenue from Land",
      balance: 2612625,
    });
    expect(lowConfidence.outcome).toBe("REVIEW_SUGGESTED");
    expect(lowConfidence.evidenceTier).toBeUndefined();
    expect(lowConfidence.balanceSide).toBeUndefined();
    expect(lowConfidence.requiresReview).toBeUndefined();
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
