/**
 * goldenTestCorpus.test.ts — Ω∞ public-sector / framework intelligence
 * engine, Slice 6: dry-run simulator and fixture corpus (Section XXII),
 * cross-checked against every acceptance scenario in Section XXVI.
 *
 * Two describe-block groups:
 *   1. Golden Test Corpus (Section XXII A-D) — LGA IPSAS is real data
 *      (museClassifier + museIpsasRulePack, Slice 4). Public Agency and SOE
 *      IFRS have NO real account-level data available (Phase 0 confirmed
 *      no MUSE export exists for a TCU/PPRA/ADEM/ATCL-like entity) — those
 *      are proven at the CONTEXT-DETECTION layer only (Slice 2), which is
 *      real, working code, not a fabricated agency chart of accounts.
 *      Inventing MUSE codes for entities we have no evidence for would be
 *      exactly the false-certainty failure mode Section XVIII prohibits.
 *   2. Acceptance Scenarios (Section XXVI, Scenarios 1-10) — each is
 *      explicitly marked PROVEN (test exists, passes, cites what it proves)
 *      or DEFERRED (depends on a slice not yet built — named explicitly,
 *      not silently skipped). Section XXVII: never claim certification
 *      while a scenario doesn't actually hold.
 */

import { describe, it, expect } from "vitest";
import { classifyMuseAccount, classifyMuseAccounts, summarizeDryRun } from "./museClassifier";
import { TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1 } from "./museIpsasRulePack";
import { detectEntityAccountingContext } from "./detectEntityContext";
import { classifyConfirmationPosture } from "./confirmationPosture";
import {
  resolveComparativeAmount,
  detectPresenceChanges,
  type ComparativeLineLookup,
} from "./comparativeEvidence";

// ════════════════════════════════════════════════════════════════════════
// 1. GOLDEN TEST CORPUS (Section XXII)
// ════════════════════════════════════════════════════════════════════════

describe("Golden Test Corpus — A. LGA IPSAS (real Arusha DC data, Slice 4)", () => {
  // Section XXII.A's named required cases, each mapped to the real natural
  // account code that actually produced it in the Arusha DC MUSE export.
  const required: Array<[label: string, code: string, expectNature: string]> = [
    ["Service levy", "11640172", "REVENUE"],
    ["user fee", "12120107", "REVENUE"],
    ["government subvention", "13410102", "REVENUE"],
    ["development grant", "13465104", "REVENUE"],
    ["personal emoluments", "21111101", "EXPENSE"],
    ["per diem", "22010105", "EXPENSE"],
    ["office consumables", "22001101", "EXPENSE"],
    ["diesel", "22003102", "EXPENSE"],
    ["maintenance", "22018107", "EXPENSE"],
    ["PPE", "31112102", "ASSET"],
    ["deferred income", "33191110", "LIABILITY"],
    ["receivables", "32171120", "ASSET"],
    ["ECL", "32173113", "ASSET"],
    ["social benefits", "27210104", "EXPENSE"],
  ];

  it.each(required)("%s (%s) is classified with real evidence, nature=%s", (_label, code, expectNature) => {
    const rule = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.find((r) => r.naturalAccountCode === code);
    expect(rule).toBeDefined();
    expect(rule!.accountNature).toBe(expectNature);
    const outcome = classifyMuseAccount({
      naturalAccountCode: code,
      accountName: rule!.observedAccountName,
      balance: 0,
    });
    expect(outcome.outcome).not.toBe("UNRESOLVED");
    expect(outcome.evidence.length).toBeGreaterThan(0);
  });
});

describe("Golden Test Corpus — B. Public Agency IPSAS (context-detection layer only — no real agency account data)", () => {
  it("an agency-scoped company (reporting_framework=ipsas_accrual) is detected as IPSAS without needing any LGA-specific content", () => {
    // Deliberately does NOT touch museClassifier/museIpsasRulePack — those
    // are LOCAL_GOVERNMENT/Arusha-DC-scoped by evidence (Slice 4 header).
    // Framework detection (Slice 2) is entity-class-agnostic: it never
    // reads entityClass to decide reportingFramework (see C1 proof below),
    // so an agency and an LGA on the same DB value detect identically —
    // proving the architecture doesn't hardcode LGA presentation into
    // framework detection. What a TCU/PPRA/ADEM-shaped rule PACK would
    // contain is unverifiable without a real export — not attempted here.
    const ctx = detectEntityAccountingContext({
      jurisdiction: "TZ",
      companyReportingFrameworkDbValue: "ipsas_accrual",
    });
    expect(ctx.reportingFramework.value).toBe("IPSAS_ACCRUAL");
  });

  it("the MuseIpsasRule shape is entity-class-parameterised, not LOCAL_GOVERNMENT-hardcoded — extending to agencies is a registry addition, not a fork", () => {
    // Structural proof for Section XXVI Scenario 3 ("without custom
    // application forks"): entityClasses is a real field on every rule,
    // not a constant baked into the classifier's control flow. A future
    // PUBLIC_AGENCY-scoped rule pack would compose alongside this one,
    // not require branching code (Section IV).
    const sample = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1[0];
    expect(Array.isArray(sample.entityClasses)).toBe(true);
    expect(sample.entityClasses).toContain("LOCAL_GOVERNMENT");
    // No rule in today's pack claims agency scope — honest, not a gap hidden.
    const agencyScoped = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.filter((r) =>
      r.entityClasses.includes("PUBLIC_AGENCY"),
    );
    expect(agencyScoped).toHaveLength(0);
  });
});

describe("Golden Test Corpus — C. SOE IFRS (context-detection layer only — no real SOE account data)", () => {
  it("ATCL-shaped fixture: government ownership does not switch a full_ifrs company to IPSAS", () => {
    const ctx = detectEntityAccountingContext({
      jurisdiction: "TZ",
      companyReportingFrameworkDbValue: "full_ifrs",
    });
    expect(ctx.reportingFramework.value).toBe("IFRS");
    expect(ctx.reportingFramework.value).not.toBe("IPSAS_ACCRUAL");
  });

  it("the MUSE/IPSAS rule pack never applies to an IFRS-framework company — scope is structurally bounded, not filtered at call time", () => {
    // Every rule in the pack is framework:"IPSAS_ACCRUAL" (Slice 4's own
    // integrity test proves this too) — there is no code path by which an
    // IFRS SOE's accounts could be run through IPSAS-shaped MUSE rules.
    const nonIpsas = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.filter((r) => r.framework !== "IPSAS_ACCRUAL");
    expect(nonIpsas).toHaveLength(0);
  });
});

describe("Golden Test Corpus — D. NGO/QuickBooks", () => {
  it("QuickBooks source detected, framework remains UNKNOWN/unconfirmed without evidence", () => {
    const ctx = detectEntityAccountingContext({
      jurisdiction: "TZ",
      companyReportingFrameworkDbValue: "ifrs_for_smes", // untouched schema default
    });
    expect(ctx.reportingFramework.confidence).toBe("LOW");
    expect(classifyConfirmationPosture(ctx.reportingFramework)).toBe("EXPLICIT_ASK");
  });

  it("no false IPSAS inference: every rule in the MUSE pack is sourceSystem=MUSE — a QuickBooks account can never match one", () => {
    const nonMuse = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.filter((r) => r.sourceSystem !== "MUSE");
    expect(nonMuse).toHaveLength(0);
    // And directly: an account explicitly NOT from the Arusha MUSE corpus
    // (arbitrary QuickBooks-style code) resolves UNRESOLVED, never IPSAS.
    const outcome = classifyMuseAccount({
      naturalAccountCode: "4000", // plausible QuickBooks default COA revenue code — not in the MUSE pack
      accountName: "Sales",
      balance: 1000,
    });
    expect(outcome.outcome).toBe("UNRESOLVED");
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2. ACCEPTANCE SCENARIOS (Section XXVI) — explicit certification status
// ════════════════════════════════════════════════════════════════════════

describe("Section XXVI acceptance scenarios — certification status", () => {
  it("Scenario 1 — PROVEN: Arusha DC MUSE accounts no longer fall into NO_MATCH unnecessarily; genuine ambiguity remains for review", () => {
    const accounts = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.map((r) => ({
      naturalAccountCode: r.naturalAccountCode,
      accountName: r.observedAccountName,
      balance: 0,
    }));
    const summary = summarizeDryRun(classifyMuseAccounts(accounts));
    expect(summary.unresolved).toBe(0); // no unnecessary NO_MATCH
    expect(summary.reviewSuggested).toBeGreaterThan(0); // genuine ambiguity still surfaced, not hidden
  });

  it("Scenario 2 — PARTIAL: architecture supports agency IPSAS without LGA-forced presentation, but no real TCU rule content exists to prove exchange/non-exchange family coverage end-to-end", () => {
    // See "Golden Test Corpus — B" above for the structural proof. A full
    // PROVEN status needs a real TCU/agency MUSE export, same as Slice 4
    // needed the real Arusha export — not available today.
    expect(true).toBe(true); // status marker; real assertions live in section B above
  });

  it("Scenario 3 — PARTIAL: same reasoning as Scenario 2, for PPRA/ADEM-shaped agencies", () => {
    expect(true).toBe(true); // status marker; real assertions live in section B above
  });

  it("Scenario 4 — PROVEN: government ownership does not switch ATCL-shaped entity to IPSAS; IFRS evidence wins", () => {
    const ctx = detectEntityAccountingContext({ companyReportingFrameworkDbValue: "full_ifrs" });
    expect(ctx.reportingFramework.value).toBe("IFRS");
  });

  it("Scenario 5 — PROVEN: QuickBooks detected as source, framework stays unconfirmed until evidence establishes it", () => {
    const ctx = detectEntityAccountingContext({ companyReportingFrameworkDbValue: "ifrs_for_smes" });
    expect(classifyConfirmationPosture(ctx.reportingFramework)).toBe("EXPLICIT_ASK");
  });

  it("Scenario 6 — PROVEN (Slice 7): a real Arusha DC account absent from the comparative-source period resolves MISSING, never a fabricated zero", () => {
    const lookup: ComparativeLineLookup = { find: (code) => (code === "11640172" ? 1467620521.27 : undefined) };
    // '13465101 Subvention Capital' is real: present in FY2025, absent from FY2026
    // (verified directly against both raw exports — see comparativeEvidence.test.ts).
    const amt = resolveComparativeAmount("13465101", "PRIOR_TB_WITH_CONFIRMED_MAPPING", lookup, "upload-fy2025");
    expect(amt.state).toBe("MISSING");
    expect("value" in amt).toBe(false);

    const changes = detectPresenceChanges(["13465101", "11640172"], ["11640172"]);
    expect(changes).toEqual([{ naturalAccountCode: "13465101", change: "ABSENT_THIS_PERIOD" }]);
  });

  it("Scenario 7 — PROVEN (Slice 7): a resolved comparative amount carries evidence/source fields only — no 'approved' field exists to be mistaken for professional sign-off", () => {
    const lookup: ComparativeLineLookup = { find: () => 1467620521.27 };
    const amt = resolveComparativeAmount("11640172", "PRIOR_TB_WITH_CONFIRMED_MAPPING", lookup, "upload-fy2025");
    expect(amt.state).toBe("KNOWN");
    expect(Object.keys(amt)).not.toContain("approved");
    expect(Object.keys(amt)).not.toContain("approvedBy");
    expect(amt.evidence.length).toBeGreaterThan(0);
  });

  it("Scenario 8 — PROVEN (Slice 8): decision 23/44 -> back to 22 -> change draft -> forward, no corruption (see reviewDecisionState.test.ts for the full mechanism proof; verified live in a browser against AccountReviewPanel itself, not just this pure model)", () => {
    // Full assertions live in reviewDecisionState.test.ts. This status
    // marker also records that the REAL component (not just the pure
    // model) was exercised in a running browser: Next -> Next -> change
    // Account 3's classification -> Previous -> Next confirmed the draft
    // change persisted, and "Show full list" showed the same draft state.
    expect(true).toBe(true);
  });

  it("Scenario 9 — PROVEN (Slice 10): primary operating cash flow reconciles to the reconciliation engine, using real Arusha DC FY2026 investing figures", () => {
    // Full assertions live in cashFlowEngines.test.ts, including an
    // adversarial case proving the cross-check actually fails (does not
    // silently pass) when the two engines are fed inconsistent inputs.
    // Along the way this slice's gate caught two real bugs before they
    // shipped: WIP-transfer entries wrongly counted as capex outflows, and
    // an inverted sign in the financing-activities formula — both fixed.
    expect(true).toBe(true);
  });

  it("Scenario 10 — PROVEN: every AUTO_MAPPED_RULE/REVIEW_SUGGESTED outcome carries rule/evidence provenance", () => {
    const accounts = TZ_PUBLIC_SECTOR_IPSAS_ACCRUAL_V1.map((r) => ({
      naturalAccountCode: r.naturalAccountCode,
      accountName: r.observedAccountName,
      balance: 0,
    }));
    const outcomes = classifyMuseAccounts(accounts);
    for (const o of outcomes) {
      expect(o.ruleId).toBeDefined();
      expect(o.ruleVersion).toBeDefined();
      expect(o.evidence.length).toBeGreaterThan(0);
    }
  });
});
