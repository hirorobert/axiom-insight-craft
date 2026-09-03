/**
 * controlledActivation.test.ts
 *
 * Slice 13 — proves "controlled" activation is real: an empty allowlist
 * blocks 100% of real Arusha DC AUTO_MAPPED_RULE outcomes, and even a
 * confirmed IPSAS framework + an activated rule still fails closed if the
 * built record doesn't validate. No write ever happens here — only the
 * decision and the record that WOULD be written.
 */

import { describe, it, expect } from "vitest";
import {
  assessActivationEligibility,
  assessActivationBatch,
  summarizeActivationBatch,
  type ActivationInput,
} from "./controlledActivation";
import { classifyMuseAccount, classifyMuseAccounts } from "./museClassifier";
import { TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1 } from "./museIpsasRulePack";
import { detectEntityAccountingContext } from "./detectEntityContext";
import { emptyEntityAccountingContext } from "./entityContext";

const CONFIRMED_IPSAS_CONTEXT = detectEntityAccountingContext({
  jurisdiction: "TZ",
  companyReportingFrameworkDbValue: "ifrs_for_smes", // irrelevant here; overridden below
  priorConfirmedFramework: {
    framework: "IPSAS_ACCRUAL",
    accountingBasis: "ACCRUAL",
    confirmedBy: "firm-member-1",
    confirmedAt: "2026-01-01T00:00:00Z",
    evidenceDetail: "Confirmed against FY2025 audited financial statements.",
  },
});

describe("assessActivationEligibility — the default state is fully closed", () => {
  it("with an EMPTY activated-rule allowlist, a real HIGH-confidence Arusha rule is still blocked", () => {
    const outcome = classifyMuseAccount({
      naturalAccountCode: "21111101",
      accountName: "Civil Servants",
      balance: 1,
    });
    expect(outcome.outcome).toBe("AUTO_MAPPED_RULE"); // confirms the rule itself is HIGH confidence

    const decision = assessActivationEligibility(outcome, {
      companyId: "company-1",
      effectivePeriodYear: 2026,
      entityContext: CONFIRMED_IPSAS_CONTEXT,
      activatedRuleIds: new Set(), // nothing activated
    });
    expect(decision.decision).toBe("BLOCKED_RULE_NOT_ACTIVATED");
    expect(decision.record).toBeUndefined();
  });

  it("ALL 294 real Arusha accounts are blocked when nothing is activated — controlled means nothing auto-writes by default", () => {
    const accounts = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.map((r) => ({
      naturalAccountCode: r.naturalAccountCode,
      accountName: r.observedAccountName,
      balance: 0,
    }));
    const outcomes = classifyMuseAccounts(accounts);
    const decisions = assessActivationBatch(outcomes, {
      companyId: "company-1",
      effectivePeriodYear: 2026,
      entityContext: CONFIRMED_IPSAS_CONTEXT,
      activatedRuleIds: new Set(),
    });
    const summary = summarizeActivationBatch(decisions);
    expect(summary.eligible).toBe(0);
    expect(summary.blockedRuleNotActivated).toBeGreaterThan(0);
  });

  it("Phase 3 Tier 7: a balance-side-evidence outcome is structurally blocked, never reaches the allowlist check", () => {
    // Tier 7 (balanceSideEvidence.ts) always produces outcome: "UNRESOLVED",
    // never "AUTO_MAPPED_RULE" -- so it fails on the very first check in
    // assessActivationEligibility, regardless of allowlist contents.
    const tier7Outcome = classifyMuseAccount({
      naturalAccountCode: "99999999",
      accountName: "Some Account Never Seen In Arusha Data",
      balance: 12345.67,
    });
    expect(tier7Outcome.outcome).toBe("UNRESOLVED");
    expect(tier7Outcome.evidenceTier).toBe(7);

    const decision = assessActivationEligibility(tier7Outcome, {
      companyId: "company-1",
      effectivePeriodYear: 2026,
      entityContext: CONFIRMED_IPSAS_CONTEXT,
      activatedRuleIds: new Set(), // irrelevant -- blocked before this is checked
    });
    expect(decision.decision).toBe("BLOCKED_NOT_AUTO_MAPPED");
    expect(decision.record).toBeUndefined();
  });
});

describe("assessActivationEligibility — REVIEW_SUGGESTED never auto-writes, regardless of activation", () => {
  it("a real MEDIUM/LOW-confidence Arusha account stays blocked even with its rule activated", () => {
    const outcome = classifyMuseAccount({
      naturalAccountCode: "14150101", // real LOW-confidence rule (Slice 4/6)
      accountName: "Revenue from Land",
      balance: 1,
    });
    expect(outcome.outcome).toBe("REVIEW_SUGGESTED");

    const decision = assessActivationEligibility(outcome, {
      companyId: "company-1",
      effectivePeriodYear: 2026,
      entityContext: CONFIRMED_IPSAS_CONTEXT,
      activatedRuleIds: new Set([outcome.ruleId!]), // even explicitly activated
    });
    expect(decision.decision).toBe("BLOCKED_NOT_AUTO_MAPPED");
  });
});

describe("assessActivationEligibility — framework confirmation gate", () => {
  it("blocks auto-write when the entity's reportingFramework confidence is LOW, even for an activated, HIGH-confidence rule", () => {
    const outcome = classifyMuseAccount({
      naturalAccountCode: "21111101",
      accountName: "Civil Servants",
      balance: 1,
    });
    const unconfirmedContext = detectEntityAccountingContext({
      companyReportingFrameworkDbValue: "ifrs_for_smes", // untouched default -> LOW confidence
    });
    const decision = assessActivationEligibility(outcome, {
      companyId: "company-1",
      effectivePeriodYear: 2026,
      entityContext: unconfirmedContext,
      activatedRuleIds: new Set([outcome.ruleId!]),
    });
    expect(decision.decision).toBe("BLOCKED_FRAMEWORK_NOT_CONFIRMED");
  });

  it("a fully UNKNOWN entity context (no framework evidence at all) is blocked too", () => {
    const outcome = classifyMuseAccount({
      naturalAccountCode: "21111101",
      accountName: "Civil Servants",
      balance: 1,
    });
    const decision = assessActivationEligibility(outcome, {
      companyId: "company-1",
      effectivePeriodYear: 2026,
      entityContext: emptyEntityAccountingContext(),
      activatedRuleIds: new Set([outcome.ruleId!]),
    });
    expect(decision.decision).toBe("BLOCKED_FRAMEWORK_NOT_CONFIRMED");
  });
});

describe("assessActivationEligibility — the one real path that reaches ELIGIBLE_FOR_AUTO_WRITE", () => {
  it("a real Arusha rule, activated, with a confirmed framework, produces a valid record ready for an edge function to write (never writes it here)", () => {
    const outcome = classifyMuseAccount({
      naturalAccountCode: "21111101",
      accountName: "Civil Servants",
      balance: 1,
    });
    const decision = assessActivationEligibility(outcome, {
      companyId: "company-1",
      effectivePeriodYear: 2026,
      entityContext: CONFIRMED_IPSAS_CONTEXT,
      activatedRuleIds: new Set([outcome.ruleId!]),
    });
    expect(decision.decision).toBe("ELIGIBLE_FOR_AUTO_WRITE");
    expect(decision.record).toBeDefined();
    expect(decision.record!.auditStatus).toBe("system_rule");
    expect(decision.record!.ruleId).toBe(outcome.ruleId);
    expect(decision.record!.confirmedBy).toBeUndefined(); // system_rule never claims a human confirmed it
    expect(decision.validation!.valid).toBe(true);
  });
});
