/**
 * primaryCashFlowEngine.test.ts — Ω∞ V5 Phase 5 final closure.
 *
 * Proves the Primary Cash-Flow Engine, the Dual-Engine Operating-CF Gate,
 * and the Sign-Off Gate result behaviorally -- structural independence from
 * the Reconciliation Engine, fail-closed numeric/discriminant handling, and
 * that CANNOT_ASSESS/FAIL can never become PASS.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  runPrimaryCashFlowEngine,
  evaluateDualEngineOperatingCashFlowGate,
  evaluateCashFlowSignOffGate,
  type PrimaryCashFlowFacts,
  type PrimaryCashFlowEngineResult,
  type ReconciliationOperatingCashFlowResult,
} from "./primaryCashFlowEngine";
import type { ComparativeAmount } from "./comparativeEvidence";
import type { MaterialityThreshold } from "./cashFlowEngines";

const KNOWN = (value: number): ComparativeAmount => ({
  state: "KNOWN",
  value,
  source: "PRIOR_TB_WITH_CONFIRMED_MAPPING",
  evidence: [],
});
const ZERO: ComparativeAmount = { state: "ZERO", value: 0, source: "PRIOR_TB_WITH_CONFIRMED_MAPPING", evidence: [] };
const MISSING: ComparativeAmount = { state: "MISSING", source: "PRIOR_TB_WITH_CONFIRMED_MAPPING", evidence: [] };
const NOT_APPLICABLE: ComparativeAmount = { state: "NOT_APPLICABLE", evidence: [] };

const BASE_FACTS: PrimaryCashFlowFacts = {
  currencyCode: "TZS",
  evidenceBasis: "OTHER_AUTHORITATIVE_BASIS",
  operatingCashInflows: KNOWN(9_000_000),
  operatingCashOutflows: KNOWN(6_000_000),
  investingCashInflows: KNOWN(200_000),
  investingCashOutflows: KNOWN(1_200_000),
  financingCashInflows: KNOWN(500_000),
  financingCashOutflows: KNOWN(100_000),
};

const TZS_MATERIALITY: MaterialityThreshold = { currencyCode: "TZS", percentageThreshold: 0.01, absoluteThreshold: 100_000 };

// ── PRIMARY ENGINE ────────────────────────────────────────────────────────

describe("runPrimaryCashFlowEngine — known facts produce correct O/I/F subtotals and net movement", () => {
  it("known operating receipts/outflows -> correct operating net", () => {
    const result = runPrimaryCashFlowEngine(BASE_FACTS);
    expect(result.operating.state).toBe("KNOWN");
    expect(result.operating.netAmount).toBe(3_000_000); // 9,000,000 - 6,000,000
  });

  it("known investing inflows/outflows -> correct investing net", () => {
    const result = runPrimaryCashFlowEngine(BASE_FACTS);
    expect(result.investing.netAmount).toBe(-1_000_000); // 200,000 - 1,200,000
  });

  it("known financing inflows/outflows -> correct financing net", () => {
    const result = runPrimaryCashFlowEngine(BASE_FACTS);
    expect(result.financing.netAmount).toBe(400_000); // 500,000 - 100,000
  });

  it("correct net movement in cash = sum of all three sections", () => {
    const result = runPrimaryCashFlowEngine(BASE_FACTS);
    expect(result.overallState).toBe("ASSESSABLE");
    expect(result.netMovementInCash).toBe(3_000_000 - 1_000_000 + 400_000);
  });

  it("genuine zeros are preserved, not treated as missing", () => {
    const facts: PrimaryCashFlowFacts = { ...BASE_FACTS, operatingCashInflows: ZERO, operatingCashOutflows: ZERO };
    const result = runPrimaryCashFlowEngine(facts);
    expect(result.operating.state).toBe("KNOWN");
    expect(result.operating.netAmount).toBe(0);
  });

  it("a negative legitimate KNOWN correction is accepted (finite, not rejected for being negative)", () => {
    const facts: PrimaryCashFlowFacts = { ...BASE_FACTS, financingCashInflows: KNOWN(-50_000) };
    const result = runPrimaryCashFlowEngine(facts);
    expect(result.financing.state).toBe("KNOWN");
    expect(result.financing.netAmount).toBe(-50_000 - 100_000);
  });

  it("a MISSING required fact makes its own section CANNOT_ASSESS, and the overall result CANNOT_ASSESS", () => {
    const facts: PrimaryCashFlowFacts = { ...BASE_FACTS, investingCashInflows: MISSING };
    const result = runPrimaryCashFlowEngine(facts);
    expect(result.investing.state).toBe("CANNOT_ASSESS");
    expect(result.investing.netAmount).toBeNull();
    expect(result.overallState).toBe("CANNOT_ASSESS");
    expect(result.netMovementInCash).toBeNull();
  });

  it("NOT_APPLICABLE behaves the same as MISSING for section assessability", () => {
    const facts: PrimaryCashFlowFacts = { ...BASE_FACTS, financingCashOutflows: NOT_APPLICABLE };
    const result = runPrimaryCashFlowEngine(facts);
    expect(result.financing.state).toBe("CANNOT_ASSESS");
    expect(result.overallState).toBe("CANNOT_ASSESS");
  });

  it("no missing->zero: a CANNOT_ASSESS section never reports netAmount 0", () => {
    const facts: PrimaryCashFlowFacts = { ...BASE_FACTS, operatingCashInflows: MISSING };
    const result = runPrimaryCashFlowEngine(facts);
    expect(result.operating.netAmount).toBeNull();
    expect(result.operating.netAmount).not.toBe(0);
  });

  it("a malformed runtime discriminant (bogus state) fails closed", () => {
    const bogus = { state: "BOGUS", value: 1 } as unknown as ComparativeAmount;
    const facts: PrimaryCashFlowFacts = { ...BASE_FACTS, operatingCashInflows: bogus };
    expect(() => runPrimaryCashFlowEngine(facts)).toThrow();
  });

  it("a NaN KNOWN value fails closed", () => {
    const facts: PrimaryCashFlowFacts = { ...BASE_FACTS, investingCashOutflows: KNOWN(NaN) };
    expect(() => runPrimaryCashFlowEngine(facts)).toThrow();
  });

  it("an Infinity KNOWN value fails closed", () => {
    const facts: PrimaryCashFlowFacts = { ...BASE_FACTS, financingCashInflows: KNOWN(Infinity) };
    expect(() => runPrimaryCashFlowEngine(facts)).toThrow();
  });

  it("the caller's evidenceBasis designation is echoed back unchanged, never inferred", () => {
    const facts: PrimaryCashFlowFacts = { ...BASE_FACTS, evidenceBasis: "GROSS_RECEIPTS_AND_PAYMENTS" };
    const result = runPrimaryCashFlowEngine(facts);
    expect(result.evidenceBasis).toBe("GROSS_RECEIPTS_AND_PAYMENTS");
  });

  it("empty currencyCode fails closed", () => {
    const facts: PrimaryCashFlowFacts = { ...BASE_FACTS, currencyCode: "" };
    expect(() => runPrimaryCashFlowEngine(facts)).toThrow();
  });
});

// ── STRUCTURAL INDEPENDENCE ──────────────────────────────────────────────────

describe("structural independence: neither engine can accept the other's result", () => {
  it("PrimaryCashFlowFacts has no field for a reconciliation-engine result", () => {
    const facts = BASE_FACTS as unknown as Record<string, unknown>;
    expect("reconciledOperatingCashFlow" in facts).toBe(false);
    expect("primaryOperatingCashFlow" in facts).toBe(false);
  });

  it("constructing PrimaryCashFlowFacts with a reconciliation-shaped field fails to compile", () => {
    const bad: PrimaryCashFlowFacts = {
      ...BASE_FACTS,
      // @ts-expect-error -- reconciledOperatingCashFlow does not exist on PrimaryCashFlowFacts
      reconciledOperatingCashFlow: 12345,
    };
    expect(bad.currencyCode).toBe("TZS");
  });

  it("this module never imports cashFlowEngines.ts's Engine-B-specific exports (source-scan)", () => {
    const source: string = fs.readFileSync(path.join(__dirname, "primaryCashFlowEngine.ts"), "utf-8");
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/buildOperatingCashFlowReconciliation|OperatingCashFlowReconciliation|buildPrimaryCashFlowStatement|crossCheckOperatingCashFlow/);
  });

  it("cashFlowEngines.ts has no import statement referencing primaryCashFlowEngine.ts (one-directional dependency)", () => {
    const source: string = fs.readFileSync(path.join(__dirname, "cashFlowEngines.ts"), "utf-8");
    const importLines = source
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line))
      .join("\n");
    expect(importLines).not.toMatch(/primaryCashFlowEngine/);
  });

  it("changing primary facts without changing reconciliation facts changes only the primary result", () => {
    const reconciliation: ReconciliationOperatingCashFlowResult = { state: "ASSESSABLE", operatingCashFlow: 3_000_000 };
    const gateBefore = evaluateDualEngineOperatingCashFlowGate(runPrimaryCashFlowEngine(BASE_FACTS), reconciliation, TZS_MATERIALITY);

    const changedFacts: PrimaryCashFlowFacts = { ...BASE_FACTS, operatingCashInflows: KNOWN(99_000_000) };
    const gateAfter = evaluateDualEngineOperatingCashFlowGate(runPrimaryCashFlowEngine(changedFacts), reconciliation, TZS_MATERIALITY);

    expect(gateAfter.primaryOperatingCashFlow).not.toBe(gateBefore.primaryOperatingCashFlow);
    expect(gateAfter.reconciliationOperatingCashFlow).toBe(gateBefore.reconciliationOperatingCashFlow);
  });

  it("changing reconciliation facts without changing primary facts changes only the reconciliation result", () => {
    const primary = runPrimaryCashFlowEngine(BASE_FACTS);
    const reconciliationBefore: ReconciliationOperatingCashFlowResult = { state: "ASSESSABLE", operatingCashFlow: 3_000_000 };
    const reconciliationAfter: ReconciliationOperatingCashFlowResult = { state: "ASSESSABLE", operatingCashFlow: 5_000_000 };

    const gateBefore = evaluateDualEngineOperatingCashFlowGate(primary, reconciliationBefore, TZS_MATERIALITY);
    const gateAfter = evaluateDualEngineOperatingCashFlowGate(primary, reconciliationAfter, TZS_MATERIALITY);

    expect(gateAfter.reconciliationOperatingCashFlow).not.toBe(gateBefore.reconciliationOperatingCashFlow);
    expect(gateAfter.primaryOperatingCashFlow).toBe(gateBefore.primaryOperatingCashFlow);
  });
});

// ── DUAL-ENGINE GATE ──────────────────────────────────────────────────────

describe("evaluateDualEngineOperatingCashFlowGate", () => {
  const assessablePrimary: PrimaryCashFlowEngineResult = runPrimaryCashFlowEngine(BASE_FACTS); // operating net = 3,000,000

  it("exact equality -> PASS", () => {
    const reconciliation: ReconciliationOperatingCashFlowResult = { state: "ASSESSABLE", operatingCashFlow: 3_000_000 };
    const result = evaluateDualEngineOperatingCashFlowGate(assessablePrimary, reconciliation, TZS_MATERIALITY);
    expect(result.status).toBe("PASS");
    expect(result.difference).toBe(0);
  });

  it("difference inside materiality -> PASS", () => {
    const reconciliation: ReconciliationOperatingCashFlowResult = { state: "ASSESSABLE", operatingCashFlow: 3_000_000 - 50_000 };
    const result = evaluateDualEngineOperatingCashFlowGate(assessablePrimary, reconciliation, TZS_MATERIALITY);
    expect(result.status).toBe("PASS");
  });

  it("difference EXACTLY at materiality -> PASS (inclusive <=)", () => {
    const materiality: MaterialityThreshold = { currencyCode: "TZS", percentageThreshold: 0, absoluteThreshold: 100_000 };
    const reconciliation: ReconciliationOperatingCashFlowResult = { state: "ASSESSABLE", operatingCashFlow: 3_000_000 - 100_000 };
    const result = evaluateDualEngineOperatingCashFlowGate(assessablePrimary, reconciliation, materiality);
    expect(result.difference).toBe(100_000);
    expect(result.thresholdApplied).toBe(100_000);
    expect(result.status).toBe("PASS");
  });

  it("difference just above materiality -> FAIL", () => {
    const materiality: MaterialityThreshold = { currencyCode: "TZS", percentageThreshold: 0, absoluteThreshold: 100_000 };
    const reconciliation: ReconciliationOperatingCashFlowResult = { state: "ASSESSABLE", operatingCashFlow: 3_000_000 - 100_001 };
    const result = evaluateDualEngineOperatingCashFlowGate(assessablePrimary, reconciliation, materiality);
    expect(result.difference).toBe(100_001);
    expect(result.status).toBe("FAIL");
  });

  it("currency mismatch fails closed", () => {
    const usdMateriality: MaterialityThreshold = { currencyCode: "USD", percentageThreshold: 0.01, absoluteThreshold: 100 };
    const reconciliation: ReconciliationOperatingCashFlowResult = { state: "ASSESSABLE", operatingCashFlow: 3_000_000 };
    expect(() => evaluateDualEngineOperatingCashFlowGate(assessablePrimary, reconciliation, usdMateriality)).toThrow(/currency/i);
  });

  it("primary CANNOT_ASSESS -> gate CANNOT_ASSESS, never PASS", () => {
    const unassessablePrimary = runPrimaryCashFlowEngine({ ...BASE_FACTS, operatingCashInflows: MISSING });
    const reconciliation: ReconciliationOperatingCashFlowResult = { state: "ASSESSABLE", operatingCashFlow: 3_000_000 };
    const result = evaluateDualEngineOperatingCashFlowGate(unassessablePrimary, reconciliation, TZS_MATERIALITY);
    expect(result.status).toBe("CANNOT_ASSESS");
    expect(result.difference).toBeNull();
  });

  it("reconciliation CANNOT_ASSESS -> gate CANNOT_ASSESS, never PASS", () => {
    const reconciliation: ReconciliationOperatingCashFlowResult = { state: "CANNOT_ASSESS", reason: "surplus not yet certified" };
    const result = evaluateDualEngineOperatingCashFlowGate(assessablePrimary, reconciliation, TZS_MATERIALITY);
    expect(result.status).toBe("CANNOT_ASSESS");
  });

  it("both CANNOT_ASSESS -> gate CANNOT_ASSESS, never PASS", () => {
    const unassessablePrimary = runPrimaryCashFlowEngine({ ...BASE_FACTS, investingCashOutflows: NOT_APPLICABLE });
    const reconciliation: ReconciliationOperatingCashFlowResult = { state: "CANNOT_ASSESS", reason: "no evidence" };
    const result = evaluateDualEngineOperatingCashFlowGate(unassessablePrimary, reconciliation, TZS_MATERIALITY);
    expect(result.status).toBe("CANNOT_ASSESS");
  });

  it("NaN materiality threshold fails closed", () => {
    const bad: MaterialityThreshold = { currencyCode: "TZS", percentageThreshold: NaN, absoluteThreshold: 100_000 };
    const reconciliation: ReconciliationOperatingCashFlowResult = { state: "ASSESSABLE", operatingCashFlow: 3_000_000 };
    expect(() => evaluateDualEngineOperatingCashFlowGate(assessablePrimary, reconciliation, bad)).toThrow();
  });

  it("Infinity reconciliation operating cash flow fails closed", () => {
    const reconciliation: ReconciliationOperatingCashFlowResult = { state: "ASSESSABLE", operatingCashFlow: Infinity };
    expect(() => evaluateDualEngineOperatingCashFlowGate(assessablePrimary, reconciliation, TZS_MATERIALITY)).toThrow();
  });

  it("deterministic: same inputs twice produce a deep-equal result", () => {
    const reconciliation: ReconciliationOperatingCashFlowResult = { state: "ASSESSABLE", operatingCashFlow: 3_000_000 };
    const first = evaluateDualEngineOperatingCashFlowGate(assessablePrimary, reconciliation, TZS_MATERIALITY);
    const second = evaluateDualEngineOperatingCashFlowGate(assessablePrimary, reconciliation, TZS_MATERIALITY);
    expect(first).toEqual(second);
  });
});

// ── SIGN-OFF GATE ─────────────────────────────────────────────────────────

describe("evaluateCashFlowSignOffGate", () => {
  it("PASS -> SIGNOFF_ALLOWED, and its reason text does not claim total approval", () => {
    const gate = evaluateDualEngineOperatingCashFlowGate(
      runPrimaryCashFlowEngine(BASE_FACTS),
      { state: "ASSESSABLE", operatingCashFlow: 3_000_000 },
      TZS_MATERIALITY,
    );
    const signOff = evaluateCashFlowSignOffGate(gate);
    expect(signOff.status).toBe("SIGNOFF_ALLOWED");
    expect(signOff.reasons.join(" ").toLowerCase()).toMatch(/does not certify/);
  });

  it("FAIL -> SIGNOFF_BLOCKED", () => {
    const materiality: MaterialityThreshold = { currencyCode: "TZS", percentageThreshold: 0, absoluteThreshold: 1 };
    const gate = evaluateDualEngineOperatingCashFlowGate(
      runPrimaryCashFlowEngine(BASE_FACTS),
      { state: "ASSESSABLE", operatingCashFlow: 3_000_000 - 999_999 },
      materiality,
    );
    expect(gate.status).toBe("FAIL");
    const signOff = evaluateCashFlowSignOffGate(gate);
    expect(signOff.status).toBe("SIGNOFF_BLOCKED");
  });

  it("CANNOT_ASSESS -> CANNOT_ASSESS, reported distinctly (never silently collapsed into SIGNOFF_BLOCKED's literal status)", () => {
    const gate = evaluateDualEngineOperatingCashFlowGate(
      runPrimaryCashFlowEngine(BASE_FACTS),
      { state: "CANNOT_ASSESS", reason: "no evidence" },
      TZS_MATERIALITY,
    );
    const signOff = evaluateCashFlowSignOffGate(gate);
    expect(signOff.status).toBe("CANNOT_ASSESS");
    expect(signOff.status).not.toBe("SIGNOFF_ALLOWED");
  });
});

// ── PURITY / GLOBALITY ────────────────────────────────────────────────────

describe("purity and globality", () => {
  it("no DB/network/storage/time/random dependency anywhere in the module", () => {
    const source: string = fs.readFileSync(path.join(__dirname, "primaryCashFlowEngine.ts"), "utf-8");
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/supabase|fetch\(|localStorage|sessionStorage|Date\.now\(\)|new Date\(|Math\.random|randomUUID|\.insert\(|\.update\(|\.delete\(|\.upsert\(/i);
  });

  it("no Tanzania/KINGA/TRA/ITA/EFDMS runtime coupling anywhere in executable code", () => {
    const source: string = fs.readFileSync(path.join(__dirname, "primaryCashFlowEngine.ts"), "utf-8");
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/Tanzania|\bTRA\b|\bITA\b|EFDMS|kinga|VAT|WHT/i);
  });
});
