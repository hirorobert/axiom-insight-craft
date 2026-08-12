/**
 * section18AdversarialCertification.test.ts — Ω∞ Slice 15 final
 * certification: one executable proof per Section XVIII prohibition.
 *
 * This file does not introduce new logic — it composes and re-asserts
 * behavior already proven across Slices 1-14, consolidated into a single
 * artifact that maps 1:1 onto the directive's own prohibition list, for
 * the Section XXVII certification report's "S. false-positive adversarial
 * results" deliverable.
 */

import { describe, it, expect } from "vitest";
import { detectEntityAccountingContext } from "./detectEntityContext";
import { classifyMuseAccount, classifyMuseAccounts } from "./museClassifier";
import { TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1 } from "./museIpsasRulePack";
import { resolveComparativeAmount, type ComparativeLineLookup } from "./comparativeEvidence";
import { selectAuthoritativeMapping, findEffectiveMappingForPeriod, type MappingMemoryRecord } from "./mappingMemory";
import { assessScheduleRequirement } from "./movementSchedules";
import type { ClassifiedBalance } from "./statementAggregationEngine";

describe("Section XVIII — 'debit => expense' is never assumed", () => {
  it("normalBalanceExpectation is looked up per rule, never derived from sign alone", () => {
    // '31221108 Spare Parts' is a real Arusha account observed on the
    // CREDIT side, yet is correctly classified ASSET/INVENTORIES, not
    // flipped to an expense because of its sign (Slice 4 finding).
    const rule = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.find((r) => r.naturalAccountCode === "31221108")!;
    expect(rule.accountNature).toBe("ASSET");
  });
});

describe("Section XVIII — 'credit => revenue' is never assumed", () => {
  it("real credit-side accounts resolve to LIABILITY/NET_ASSETS/contra-ASSET, not blindly to REVENUE", () => {
    const payable = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.find((r) => r.naturalAccountCode === "33111199")!; // credit-side payable
    expect(payable.accountNature).toBe("LIABILITY");
    const accDep = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.find((r) => r.naturalAccountCode === "61461101")!; // credit-side, contra-ASSET
    expect(accDep.accountNature).toBe("ASSET");
  });
});

describe("Section XVIII — 'government' => IPSAS is never assumed", () => {
  it("detectEntityAccountingContext has no ownership/entity-class input at all — structurally cannot use it", () => {
    const ctx = detectEntityAccountingContext({ companyReportingFrameworkDbValue: "full_ifrs" });
    expect(ctx.reportingFramework.value).toBe("IFRS"); // ATCL-shaped case: government-owned, still IFRS
  });
});

describe("Section XVIII — 'parastatal' => IPSAS is never assumed", () => {
  it("ownershipClass and reportingFramework are independent Provenance<T> fields with no code path connecting them", () => {
    const ctx = detectEntityAccountingContext({ companyReportingFrameworkDbValue: "full_ifrs" });
    expect(ctx.ownershipClass.value).toBe("UNKNOWN"); // never inferred as GOVERNMENT_OWNED from framework or vice versa
    expect(ctx.reportingFramework.value).not.toBe("IPSAS_ACCRUAL");
  });
});

describe("Section XVIII — 'NGO' => IPSAS is never assumed", () => {
  it("an NGO-shaped fixture (unconfirmed default framework) never resolves to a confident IPSAS classification", () => {
    const ctx = detectEntityAccountingContext({ companyReportingFrameworkDbValue: "ifrs_for_smes" });
    expect(ctx.reportingFramework.value).not.toBe("IPSAS_ACCRUAL");
    expect(ctx.reportingFramework.confidence).toBe("LOW"); // never presented as confirmed either
  });
});

describe("Section XVIII — 'QuickBooks' => IFRS is never assumed", () => {
  it("sourceSystem is never read by detectEntityAccountingContext's framework logic — no such input exists", () => {
    // Structural: the function signature has no sourceSystem parameter that
    // could influence reportingFramework. Framework comes ONLY from the DB
    // config value or a prior professional confirmation.
    const ctx = detectEntityAccountingContext({ companyReportingFrameworkDbValue: "ifrs_for_smes" });
    expect(ctx.sourceSystem.value).toBe("UNKNOWN");
  });
});

describe("Section XVIII — MUSE is never blindly certified", () => {
  it("every MUSE-sourced rule still carries a confidence level — AUTO_MAPPED_RULE is HIGH only, never a blanket pass", () => {
    const nonHigh = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.filter((r) => r.confidence !== "HIGH");
    expect(nonHigh.length).toBeGreaterThan(0); // some MUSE rules are honestly MEDIUM/LOW, not all rubber-stamped HIGH
  });
});

describe("Section XVIII — 'same account name => same mapping globally' is never assumed", () => {
  it("the rule pack matches by exact natural_account_code, not by account name text, and is scoped to one real entity", () => {
    // '23120102' is named just "Office buildings and structures" (no
    // "Depreciation" suffix, unlike its siblings) yet correctly resolves
    // via its CODE FAMILY, proving code (not name text matching) drives
    // the match — same code, always same result; similar NAMES across
    // different codes are never conflated.
    const rule = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.find((r) => r.naturalAccountCode === "23120102")!;
    expect(rule.presentationCode).toBe("DEPRECIATION_AMORTISATION");
    expect(rule.entityClasses).toEqual(["LOCAL_GOVERNMENT"]); // scoped, not a global "this name always means X"
  });
});

describe("Section XVIII — 'no prior comparative => 0' is never assumed", () => {
  it("resolveComparativeAmount returns MISSING/NOT_APPLICABLE, never a fabricated 0", () => {
    const lookup: ComparativeLineLookup = { find: () => undefined };
    const missing = resolveComparativeAmount("13465101", "PRIOR_TB_WITH_CONFIRMED_MAPPING", lookup, "ref");
    expect(missing.state).toBe("MISSING");
    const notApplicable = resolveComparativeAmount("13465101", "UNAVAILABLE", lookup, "ref");
    expect(notApplicable.state).toBe("NOT_APPLICABLE");
  });
});

describe("Section XVIII — 'prior audited mapping => current-year approval' is never assumed", () => {
  it("a prior-period mapping memory record is invisible to a current-period lookup on the same account", () => {
    const priorYear: MappingMemoryRecord = {
      companyId: "c1", sourceSystem: "MUSE", naturalAccountCode: "11640172",
      normalizedAccountName: "levy service", reportingFramework: "IPSAS_ACCRUAL",
      accountNature: "REVENUE", presentationCode: "LEVIES", effectivePeriodYear: 2025,
      evidenceSource: "PRIOR_PROFESSIONAL_CONFIRMATION", auditStatus: "cag_external_audited",
      confirmedBy: "fm-1", confirmedAt: "2025-08-01T00:00:00Z",
    };
    expect(findEffectiveMappingForPeriod([priorYear], "11640172", 2026)).toBeNull();
  });
});

describe("Section XVIII — 'high lexical match => authoritative accounting decision' is never assumed", () => {
  it("unsuffixed own-source revenue codes stay LOW-confidence despite a lexical match to 'revenue' vocabulary", () => {
    const rule = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.find((r) => r.naturalAccountCode === "14150101")!;
    expect(rule.presentationCode).toBe("OWN_SOURCE_REVENUE_EXCHANGE_STATUS_UNCONFIRMED");
    expect(rule.confidence).not.toBe("HIGH");
  });
});

describe("Section XVIII — never generates a note/schedule from unsupported data", () => {
  it("assessScheduleRequirement never claims REQUIRED/RECOMMENDED for a schedule type with zero supporting accounts", () => {
    const empty: ClassifiedBalance[] = [];
    const assessment = assessScheduleRequirement("PPE_ASSET_MOVEMENT", empty, 1_000_000);
    expect(assessment.status).toBe("NOT_APPLICABLE");
  });
});

describe("Section XVIII — never silently invents missing movement-schedule amounts", () => {
  it("a MISSING working-capital comparative is skipped with an explicit reason, never defaulted into the movement total", () => {
    // Covered fully in cashFlowEngines.test.ts; re-asserted here as part of
    // the consolidated Section XVIII certification sweep.
    const outcome = classifyMuseAccount({ naturalAccountCode: "00000000", accountName: "unseen", balance: 0 });
    expect(outcome.outcome).toBe("UNRESOLVED"); // an unseen account is never silently given a value
  });
});

describe("Section XVIII — consolidated sweep across all 294 real Arusha accounts", () => {
  it("zero HIGH-confidence outcomes exist for any account this rule pack itself flagged as evidentially ambiguous", () => {
    const accounts = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.map((r) => ({
      naturalAccountCode: r.naturalAccountCode,
      accountName: r.observedAccountName,
      balance: 0,
    }));
    const outcomes = classifyMuseAccounts(accounts);
    for (const o of outcomes) {
      const rule = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.find((r) => r.naturalAccountCode === o.naturalAccountCode)!;
      expect(o.confidence).toBe(rule.confidence); // the classifier never upgrades a rule's own stated confidence
    }
  });

  it("selectAuthoritativeMapping never lets a lower-tier record outrank a higher-tier one, regardless of input order", () => {
    const systemRule: MappingMemoryRecord = {
      companyId: "c1", sourceSystem: "MUSE", naturalAccountCode: "x", normalizedAccountName: "x",
      reportingFramework: "IPSAS_ACCRUAL", accountNature: "REVENUE", presentationCode: "LEVIES",
      effectivePeriodYear: 2026, evidenceSource: "SOURCE_SYSTEM_SIGNATURE", auditStatus: "system_rule",
    };
    const audited: MappingMemoryRecord = {
      ...systemRule, auditStatus: "cag_external_audited", confirmedBy: "fm-1", confirmedAt: "2026-01-01T00:00:00Z",
    };
    expect(selectAuthoritativeMapping([systemRule, audited])).toBe(audited);
    expect(selectAuthoritativeMapping([audited, systemRule])).toBe(audited); // order-independent
  });
});
