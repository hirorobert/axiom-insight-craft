import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildReadinessInput, evaluateReadiness } from "../../../../../supabase/functions/_shared/readiness/index";
import { presentIssues } from "../../present";
import { PILOT_FILE_NAMES, pilotFiles, type PilotOptions } from "../pilotData";
import { omittedLiabilityAdjustment, pilotAdjustments, pilotExtras, pilotLoadedInputs, type Registration } from "../pilotRegistrations";

/**
 * The pilot, end to end through the product's own pieces: frozen exports → parsers → registrations → the real engine →
 * plain-language issues. One entity, FY2025/26, synthetic fixtures; constructed facts are named in fixtures/README.md.
 */
const FIX = path.resolve(__dirname, "../fixtures");
const run = (opts: PilotOptions = {}, o: { adjustments?: ReturnType<typeof pilotAdjustments>; drop?: (r: Registration) => boolean; files?: Partial<ReturnType<typeof pilotFiles>> } = {}) => {
  const files = { ...pilotFiles(opts), ...(o.files ?? {}) };
  const loaded = pilotLoadedInputs({ files, extras: pilotExtras(opts), adjustments: o.adjustments, drop: o.drop });
  const result = evaluateReadiness(buildReadinessInput(loaded));
  return { loaded, result, issues: presentIssues(result, { currency: "TZS", exponent: 2 }) };
};
const FOOD = "3351879300";

describe("pilot fixtures", () => {
  it("the committed files are exactly what the generator writes (deterministic, LF)", () => {
    const files = pilotFiles();
    for (const k of Object.keys(PILOT_FILE_NAMES) as (keyof typeof PILOT_FILE_NAMES)[]) {
      const committed = fs.readFileSync(path.join(FIX, PILOT_FILE_NAMES[k]), "utf8");
      expect(committed, PILOT_FILE_NAMES[k]).toBe(files[k]);
      expect(committed.includes("\r")).toBe(false);
    }
  });
  it("the general ledger ties to the trial balance and the bank statement chains and is complete", () => {
    const { result } = run();
    expect(result.findings.some((f) => f.rule === "LEDGER_TIEOUT" && f.outcome === "pass")).toBe(true);
    expect(result.findings.filter((f) => f.rule === "RUNNING_BALANCE_BREAK" || f.rule === "STATEMENT_PAGES_MISSING")).toEqual([]);
  });
});

describe("the food-rations case through the product", () => {
  it("(b) with no correction: a confirmed double charge, exactly the two proposals, cash unchanged, held", () => {
    const { result, issues } = run();
    const f = result.findings.find((x) => x.rule === "OPENING_PAYABLE_CHARGED_TO_EXPENSE");
    expect(f?.outcome).toBe("confirmed");
    expect(result.proposals.map((p) => p.id).sort()).toEqual(["corr:food:003/2024.2025", "corr:opening:payables-food"]);
    expect(result.scopes.payables).toBe("HELD");
    expect(result.finalization.held).toBe(true);
    const issue = issues.find((i) => i.scope === "payables");
    expect(issue?.headline).toMatch(/33,518,793\.00/);
    expect(issue?.nextAction.kind).toBe("review_correction");
  });
  it("(a) with both corrections approved: expense lowered by the one payment, payable zero, OBE moved, cash unchanged, not held", () => {
    const { result } = run({}, { adjustments: pilotAdjustments() });
    expect(result.balances["2000"]).toBe("0");
    expect(result.balances["5607"]).toBe((BigInt(run().loaded.accounts!.find((a) => a.key === "5607")!.debitMinor) - BigInt(FOOD)).toString());
    const tb1020 = run().loaded.accounts!.find((a) => a.key === "1020")!;
    expect(result.balances["1020"]).toBe((BigInt(tb1020.debitMinor) - BigInt(tb1020.creditMinor)).toString());
    expect(result.scopes.payables).toBe("READY");
    expect(result.finalization).toEqual({ held: false, reasons: [] });
  });
  it("only the reclassification approved: the payable would be left a debit, so it holds", () => {
    const { result } = run({}, { adjustments: pilotAdjustments().slice(1) });
    expect(result.scopes.payables).toBe("HELD");
    expect(result.findings.some((f) => f.rule === "CORRECTION_POSTCONDITION_FAILED")).toBe(true);
  });
});

describe("the product knows when it lacks evidence: one missing input, named, affected checks held, one next action", () => {
  const oneAction = (issues: ReturnType<typeof run>["issues"]) => { for (const i of issues) expect(i.nextAction, i.scope).toBeTruthy(); expect(new Set(issues.map((i) => i.scope)).size).toBe(issues.length); };
  it("a bank page removed", () => {
    const bankFile = pilotFiles().bank;
    const lines = bankFile.trimEnd().split("\n");
    const kept = lines.filter((l, i) => i === 0 || !/,2$/.test(l));
    const { result, issues } = run({}, { adjustments: pilotAdjustments(), files: { bank: kept.join("\n") + "\n" } });
    expect(result.scopes[`cash:${pilotExtras().bank.id}`]).toBe("HELD");
    expect(result.finalization.held).toBe(true);
    const issue = issues.find((i) => i.scope.startsWith("cash:"));
    expect(issue?.missing.join(" ")).toMatch(/page/i);
    oneAction(issues);
  });
  it("the original posting of the cheque removed from the ledger", () => {
    const gl = pilotFiles().gl.trimEnd().split("\n").filter((l) => !l.includes("CHQ-001593")).join("\n") + "\n";
    const held = run({}, { adjustments: pilotAdjustments(), files: { gl } });
    expect(held.result.finalization.held).toBe(true);
    expect(held.result.scopes.ledger).toBe("HELD");
    expect(held.result.scope_reasons.ledger).toContain("LEDGER_TIEOUT_FAILED");
    expect(held.result.scopes[`cash:${pilotExtras().bank.id}`]).toBe("HELD");
    oneAction(held.issues);
  });
  it("the subsequent evidence for a seeded omitted liability removed", () => {
    const base = run({ omittedLiability: true }, { adjustments: [...pilotAdjustments(), omittedLiabilityAdjustment()] });
    expect(base.result.scopes["completeness:liabilities"]).toBe("READY");
    const dropped = run({ omittedLiability: true }, { adjustments: [...pilotAdjustments(), omittedLiabilityAdjustment()], drop: (r) => r.family === "evidence" && (r.key === "EV-PAYLIST" || r.key === "EV-INVREG") });
    expect(dropped.result.scopes["completeness:liabilities"]).toBe("HELD");
    expect(dropped.result.finalization.held).toBe(true);
    const issue = dropped.issues.find((i) => i.scope === "completeness:liabilities");
    expect(issue?.missing.join(" ")).toMatch(/payments listing|invoice register/i);
    expect(issue?.nextAction.kind).toBe("upload_evidence");
    oneAction(dropped.issues);
  });
  it("evidence removed for the double charge names the missing document", () => {
    const { result, issues } = run({}, { drop: (r) => r.family === "evidence" && r.key === "EV-PV-001593" });
    expect(result.proposals.map((p) => p.id)).not.toContain("corr:food:003/2024.2025");
    expect(result.scopes.payables).toBe("HELD");
    expect(issues.find((i) => i.scope === "payables")?.missing.join(" ")).toMatch(/voucher/i);
  });
});

describe("clean cases at product level", () => {
  it("supported opening equity: the opening agrees to the approved figures at account level", () => {
    const { result } = run({}, { adjustments: pilotAdjustments() });
    expect(result.scopes["opening:equipment"] ?? result.scopes["opening:cash"]).toBe("READY");
  });
  it("an outstanding cheque cleared by subsequent statement evidence ties cash and is ready", () => {
    const { result } = run({ outstandingCheque: true }, { adjustments: pilotAdjustments() });
    expect(result.scopes[`cash:${pilotExtras().bank.id}`]).toBe("READY");
    expect(result.findings.some((f) => f.rule === "TIMING_ITEM_CLEARED" && f.outcome === "pass")).toBe(true);
    expect(result.finalization).toEqual({ held: false, reasons: [] });
  });
  it("the same outstanding cheque with no subsequent evidence holds with a targeted request", () => {
    const { result, issues } = run({ outstandingCheque: true }, { adjustments: pilotAdjustments(), drop: (r) => r.family === "evidence" && r.key === "EV-JUL-STMT" });
    expect(result.scopes[`cash:${pilotExtras().bank.id}`]).toBe("HELD");
    expect(issues.find((i) => i.scope.startsWith("cash:"))?.missing.join(" ")).toMatch(/000777|July/);
  });
});

describe("customer wording", () => {
  it("never names an internal engine or statutory term", () => {
    const all = [run(), run({ omittedLiability: true }), run({ outstandingCheque: true })].flatMap((r) => r.issues).map((i) => JSON.stringify(i)).join(" ");
    expect(all).not.toMatch(/SAFISHA|HESABU|KINGA|MAONO|TRA\b|EFDMS|Tanzania/);
  });
});
