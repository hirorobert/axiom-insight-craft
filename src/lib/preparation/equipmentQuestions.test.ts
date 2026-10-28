import { describe, expect, it } from "vitest";
import { EQUIPMENT_QUESTIONS_V2, EQUIPMENT_SOURCE_V2, answerProblems, entityEstimateTextProblem, estimateProblems, evaluateQuestions, unresolvedQuestions } from "./equipmentQuestions";
import { emptyAnswer, emptyBalances, emptyEstimate, type Answer, type EquipmentClass, type EquipmentPreparationV2 } from "./equipmentModel";

const period = { start: "2026-01-01", end: "2026-12-31" };
const src = { type: "register" as const, reference: "Synthetic register 2026" };
const answered = (text: string, flags: Record<string, boolean> = {}): Answer => ({ status: "answered", text, evidence: "Engagement file E-1", checkedBy: "", flags });
const none = (): Answer => ({ status: "none_with_basis", text: "", evidence: "Loan register and board minutes checked", checkedBy: "A. Preparer, 2027-01-15", flags: {} });
function cls(over: Partial<EquipmentClass> = {}): EquipmentClass {
  return {
    classId: "11111111-1111-4111-8111-111111111111", label: "Equipment", origin: "new", accounts: "1500, 1510",
    opening: { grossMinor: "2000000", accumulatedDepreciationMinor: "400000", accumulatedImpairmentMinor: "0", carryingMinor: "1600000" },
    closing: { grossMinor: "2000000", accumulatedDepreciationMinor: "600000", accumulatedImpairmentMinor: "0", carryingMinor: "1400000" },
    movements: [{ kind: "depreciation", grossMinor: "0", accumulatedDepreciationMinor: "200000", accumulatedImpairmentMinor: "0", source: src, note: "" }],
    disposals: [],
    estimate: { ...emptyEstimate(), basis: "cost", method: "straight-line", lifeYears: "10", residualMinor: "0", convention: "full-period", chargeSource: "register", registerChargeMinor: "200000", registerReference: "Register depreciation report 2026", changedSincePrior: "no", rationale: "Expected ten years of use on two shifts", evidence: "Capital budget and maintenance plan" },
    answers: { recognition: answered("All items owned; invoices on file"), components: answered("No major parts; uniform low-value items") },
    ...over,
  };
}
const entity = (): Record<string, Answer> => ({
  restrictions_security: none(), commitments: none(), impairment: answered("No damage, obsolescence or idle items; checklist signed", { indicator_present: false }),
  events_after: none(), framework_history: answered("Prepared under the IFRS for SMEs since 2020", { first_smes_statements: false }),
});
const prep = (over: Partial<EquipmentPreparationV2> = {}): EquipmentPreparationV2 => ({ classes: [cls()], retiredClasses: [], destinations: [], entityAnswers: entity(), ...over });

describe("the question catalogue", () => {
  it("names its source edition, keeps review pending, and has unique ids with paragraph references", () => {
    expect(EQUIPMENT_SOURCE_V2.framework).toBe("ifrs-for-smes/2015");
    expect(EQUIPMENT_SOURCE_V2.status).toContain("review-pending");
    expect(new Set(EQUIPMENT_QUESTIONS_V2.map((q) => q.id)).size).toBe(EQUIPMENT_QUESTIONS_V2.length);
    expect(EQUIPMENT_QUESTIONS_V2.every((q) => q.refs.length > 0 && q.evidence.length > 10 && q.purpose.length > 10)).toBe(true);
  });
  it("asks the mandatory questions every period and resolves the complete synthetic case with nothing unresolved", () => {
    const qs = evaluateQuestions(prep(), period);
    const ids = qs.map((q) => q.def.id);
    for (const id of ["classes", "restrictions_security", "commitments", "impairment", "events_after", "framework_history", "recognition", "components", "basis", "estimates", "method", "gross", "movements"]) expect(ids).toContain(id);
    for (const id of ["impairment_measurement", "transition", "addition_cost", "replacement", "deferred_payment", "dismantling", "spares", "lease", "grant", "disposals", "estimate_change", "revaluation"]) expect(ids).not.toContain(id);
    expect(unresolvedQuestions(qs)).toEqual([]);
  });
  it("AC-16(b): 'none' needs who checked and what was checked; a blank is not none", () => {
    const def = EQUIPMENT_QUESTIONS_V2.find((q) => q.id === "restrictions_security")!;
    expect(answerProblems({ ...emptyAnswer(), status: "none_with_basis" }, def)).toEqual(["'None' needs who checked and what was checked."]);
    expect(answerProblems(undefined, def)).toEqual(["Not yet answered."]);
    expect(answerProblems(none(), def)).toEqual([]);
  });
  it("AC-28 / AC-14: the impairment assessment is always asked; an indicator makes the measurement question applicable", () => {
    const e = entity(); e.impairment = answered("Machine M-3 damaged in a flood", { indicator_present: true });
    const qs = evaluateQuestions(prep({ entityAnswers: e }), period);
    const m = qs.find((q) => q.def.id === "impairment_measurement")!;
    expect(m.resolved).toBe(false);
    expect(m.def.refs).toContain("27.30");
  });
  it("AC-30: first IFRS for SMEs statements make the transition question applicable", () => {
    const e = entity(); e.framework_history = answered("First statements under the Standard", { first_smes_statements: true });
    expect(evaluateQuestions(prep({ entityAnswers: e }), period).some((q) => q.def.id === "transition")).toBe(true);
  });
  it("AC-17 / AC-18 / AC-19: spares, leased items and grants follow from the recognition answer's flags, per class", () => {
    const c = cls({ answers: { recognition: answered("Two leased generators; spare rotors held", { spares_held: true, items_not_owned: true, grant_or_donation: true }), components: answered("None") } });
    const ids = evaluateQuestions(prep({ classes: [c] }), period).map((q) => q.def.id);
    expect(ids).toEqual(expect.arrayContaining(["spares", "lease", "grant"]));
  });
  it("AC-17 / AC-20 / AC-21 / AC-22: additions make the cost question applicable; its flags open replacement, deferred payment and dismantling; expensed items block it", () => {
    const c = cls({
      closing: { grossMinor: "2500000", accumulatedDepreciationMinor: "600000", accumulatedImpairmentMinor: "0", carryingMinor: "1900000" },
      movements: [{ kind: "additions", grossMinor: "500000", accumulatedDepreciationMinor: "0", accumulatedImpairmentMinor: "0", source: src, note: "" }, { kind: "depreciation", grossMinor: "0", accumulatedDepreciationMinor: "200000", accumulatedImpairmentMinor: "0", source: src, note: "" }],
    });
    let ids = evaluateQuestions(prep({ classes: [c] }), period).map((q) => q.def.id);
    expect(ids).toContain("addition_cost");
    expect(ids).not.toContain("replacement");
    c.answers.addition_cost = answered("Price, delivery and installation; ready for use 1 March", { replacement_or_inspection: true, deferred_or_exchange: true, dismantling_obligation: true });
    const qs = evaluateQuestions(prep({ classes: [c] }), period);
    ids = qs.map((q) => q.def.id);
    expect(ids).toEqual(expect.arrayContaining(["replacement", "deferred_payment", "dismantling"]));
    c.answers.addition_cost = answered("Includes staff training 250 and construction interest 400", { expensed_items_included: true });
    const blocked = evaluateQuestions(prep({ classes: [c] }), period).find((q) => q.def.id === "addition_cost")!;
    expect(blocked.resolved).toBe(false);
    expect(blocked.problems.join(" ")).toContain("expensed under the 2015 edition");
  });
  it("AC-06: a disposal with unknown proceeds keeps the disposal question unresolved; a confirmed figure resolves it", () => {
    const c = cls({
      closing: { grossMinor: "1600000", accumulatedDepreciationMinor: "350000", accumulatedImpairmentMinor: "0", carryingMinor: "1250000" },
      movements: [{ kind: "disposals", grossMinor: "-400000", accumulatedDepreciationMinor: "-250000", accumulatedImpairmentMinor: "0", source: src, note: "" }, { kind: "depreciation", grossMinor: "0", accumulatedDepreciationMinor: "200000", accumulatedImpairmentMinor: "0", source: src, note: "" }],
      disposals: [{ reference: "Lathe L-2", date: "2026-03-31", costMinor: "400000", accumulatedDepreciationMinor: "250000", accumulatedImpairmentMinor: "0", proceedsMinor: null, source: src }],
    });
    const q = evaluateQuestions(prep({ classes: [c] }), period).find((x) => x.def.id === "disposals")!;
    expect(q.resolved).toBe(false);
    expect(q.problems.join(" ")).toContain("no confirmed proceeds");
    c.disposals[0].proceedsMinor = "180000";
    expect(evaluateQuestions(prep({ classes: [c] }), period).find((x) => x.def.id === "disposals")!.resolved).toBe(true);
  });
  it("AC-15: the revaluation basis opens the 17.33 question and names the unsupported other-comprehensive-income stop", () => {
    const c = cls({ estimate: { ...cls().estimate, basis: "revaluation" } });
    const q = evaluateQuestions(prep({ classes: [c] }), period).find((x) => x.def.id === "revaluation")!;
    expect(q.resolved).toBe(false);
    expect(q.def.question).toContain("cannot yet finalise");
  });
  it("AC-12: a changed estimate opens the change-in-estimate question until its effect is recorded", () => {
    const c = cls({ estimate: { ...cls().estimate, changedSincePrior: "yes" } });
    const q = evaluateQuestions(prep({ classes: [c] }), period).find((x) => x.def.id === "estimate_change")!;
    expect(q.resolved).toBe(false);
    c.estimate.changeDescription = "Remaining life shortened to 2 years after heavier use"; c.estimate.changeEffectMinor = "200000";
    expect(evaluateQuestions(prep({ classes: [c] }), period).find((x) => x.def.id === "estimate_change")!.resolved).toBe(true);
  });
  it("AC-35: a useful life stated as a tax class or a template is refused as an estimate", () => {
    expect(entityEstimateTextProblem("as per TRA class 2 (25%)")).toContain("tax class");
    expect(entityEstimateTextProblem("per KPMG template")).toContain("template");
    expect(entityEstimateTextProblem("wear and tear allowance rates")).toContain("wear-and-tear");
    expect(entityEstimateTextProblem("Expected ten years of use on two shifts")).toBeNull();
    const e = { ...cls().estimate, rationale: "Per TRA class 2 (25%)" };
    expect(estimateProblems(e, false).join(" ")).toContain("entity's own estimate");
  });
  it("component identification requires component-level items when the charge is calculated", () => {
    const e = { ...cls().estimate, chargeSource: "calculated" as const, items: [] };
    expect(estimateProblems(e, true)).toEqual(expect.arrayContaining(["Add the assets or components the charge is calculated from."]));
    const one = { ...e, items: [{ label: "Machine", costMinor: "1000000", residualMinor: "0", openingAccumulatedMinor: "0", method: "straight-line" as const, lifeYears: "10", ratePercent: "", totalUnits: "", unitsThisPeriod: "", availableFrom: "", derecognisedOn: "" }] };
    expect(estimateProblems(one, true)).toEqual(expect.arrayContaining(["Components were identified: list each component with its own cost and life."]));
    expect(estimateProblems(one, false)).toEqual([]);
  });
  it("the classes question needs named classes with their accounts and unique labels", () => {
    const q = evaluateQuestions(prep({ classes: [cls({ accounts: "" }), cls({ classId: "22222222-2222-4222-8222-222222222222" })] }), period).find((x) => x.def.id === "classes")!;
    expect(q.resolved).toBe(false);
    expect(q.problems).toEqual(expect.arrayContaining(["Name the accounts that make up Equipment.", "Class names must be unique."]));
    expect(evaluateQuestions(prep({ classes: [] }), period).find((x) => x.def.id === "classes")!.problems).toEqual(["Add at least one class."]);
    expect(emptyBalances().grossMinor).toBe("");
  });
});
