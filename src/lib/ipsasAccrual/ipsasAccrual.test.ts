import { describe, expect, it } from "vitest";
import { computeOpeningBridge, type BridgeItem, type OpeningFact, type PublishedClosing } from "./openingBridge";
import { computePpeWorkpaper } from "./ppeWorkpaper";
import { generatePpePolicyNote, GENERATED_LABEL } from "./policyNote";
import { buildIncompletePreview, OFFICIAL_ISSUANCE_BLOCKERS, tasksFromPreparation } from "./preview";
import { allAnswers, baseInput, DISPLAY, EXPECTED, office, vehicles } from "./ipsasAccrual.fixture";
import { emptyAnswer } from "../preparation/equipmentModel";

const codes = (r: ReturnType<typeof computePpeWorkpaper>) => r.issues.map((i) => i.code);

describe("PPE cost-model workpaper — independently derived expectations", () => {
  const r = computePpeWorkpaper(baseInput());
  it("is ready for review with no open issue, and every identity agrees", () => {
    expect(r.issues).toEqual([]);
    expect(r.state).toBe("ready-for-review");
    for (const c of r.classes) expect(c.rollForward.state).toBe("agrees");
  });
  it("calculates the charge per class from the entity's estimates (365-day year, part-year addition, mid-year disposal)", () => {
    expect(r.classes[0].chargeCalculatedMinor).toBe(EXPECTED.vehiclesCharge);
    expect(r.classes[1].chargeCalculatedMinor).toBe(EXPECTED.officeCharge);
    expect(r.totals.depreciationMinor).toBe(EXPECTED.depreciation);
  });
  it("totals the carrying amounts and the loss on disposal", () => {
    expect(r.totals.openingCarryingMinor).toBe(EXPECTED.openingCarrying);
    expect(r.totals.closingCarryingMinor).toBe(EXPECTED.closingCarrying);
    expect(r.classes[0].disposalGainMinor).toBe(EXPECTED.v2Loss);
  });
  it("is unchanged by the order of classes and of items", () => {
    const v = vehicles();
    v.estimate.items.reverse();
    const shuffled = computePpeWorkpaper(baseInput({ classes: [office(), v] }));
    expect(shuffled.issues).toEqual([]);
    expect(shuffled.totals).toEqual(r.totals);
  });
  it("uses 366 days in a leap-spanning year (hand: 7,320,000 ÷ 366 = 20,000 a day × 182 days = 3,640,000)", () => {
    const leap = office({
      opening: { grossMinor: "7320000", accumulatedDepreciationMinor: "0", accumulatedImpairmentMinor: "0", carryingMinor: "7320000" },
      closing: { grossMinor: "7320000", accumulatedDepreciationMinor: "3640000", accumulatedImpairmentMinor: "0", carryingMinor: "3680000" },
      movements: [{ kind: "depreciation", grossMinor: "0", accumulatedDepreciationMinor: "3640000", accumulatedImpairmentMinor: "0", source: { type: "register", reference: "Register" }, note: "" }],
    });
    leap.estimate.items = [{ ...leap.estimate.items[0], costMinor: "7320000", residualMinor: "0", lifeYears: "1", openingAccumulatedMinor: "0", availableFrom: "2024-01-01" }];
    const out = computePpeWorkpaper(baseInput({ period: { start: "2023-07-01", end: "2024-06-30" }, classes: [leap], tb: { ppeCarryingOpeningMinor: "7320000", ppeCarryingClosingMinor: "3680000", depreciationExpenseMinor: "3640000" } }));
    expect(out.classes[0].chargeCalculatedMinor).toBe("3640000");
    expect(out.issues).toEqual([]);
  });
});

describe("PPE workpaper — what it refuses to do", () => {
  it("never supplies an estimate: a missing life is a blocker, not a default", () => {
    const v = vehicles();
    v.estimate.items[0] = { ...v.estimate.items[0], lifeYears: "" };
    const r = computePpeWorkpaper(baseInput({ classes: [v, office()] }));
    expect(codes(r)).toContain("ESTIMATE_MISSING");
    expect(r.classes[0].chargeCalculatedMinor).toBeNull();
    expect(r.state).toBe("incomplete");
  });
  it("requires a recorded convention rather than assuming one", () => {
    expect(codes(computePpeWorkpaper(baseInput({ convention: "" })))).toContain("CONVENTION_REQUIRED");
  });
  it("blocks a revaluation model instead of treating it as cost or as not applicable", () => {
    const r = computePpeWorkpaper(baseInput({ classes: [vehicles({ measurementModel: "revaluation" }), office()] }));
    expect(codes(r)).toContain("REVALUATION_MODEL_NOT_SUPPORTED");
    expect(r.state).toBe("incomplete");
  });
  it("blocks movement kinds that exist only in other frameworks", () => {
    const v = vehicles();
    v.movements.push({ kind: "revaluations_and_oci_impairment", grossMinor: "0", accumulatedDepreciationMinor: "0", accumulatedImpairmentMinor: "0", source: { type: "register", reference: "Register" }, note: "" });
    expect(codes(computePpeWorkpaper(baseInput({ classes: [v, office()] })))).toContain("UNSUPPORTED_MOVEMENT_KIND");
  });
  it("treats unconfirmed estimates as proposals", () => {
    const r = computePpeWorkpaper(baseInput({ classes: [vehicles({ estimateConfirmed: false }), office()] }));
    expect(codes(r)).toContain("ESTIMATE_UNCONFIRMED");
    expect(r.classes[0].estimateReady).toBe(false);
  });
  it("leaves a roll-forward difference visible and never balances it", () => {
    const v = vehicles();
    v.closing = { ...v.closing, grossMinor: "7000000001", carryingMinor: "4851232878" };
    const r = computePpeWorkpaper(baseInput({ classes: [v, office()] }));
    expect(codes(r)).toContain("ROLL_FORWARD_DIFFERENCE");
    expect(r.classes[0].rollForward.differences?.grossMinor).toBe("1");
  });
  it("requires the register item list to be the class: a dropped item is caught", () => {
    const v = vehicles();
    v.estimate.items.pop();
    expect(codes(computePpeWorkpaper(baseInput({ classes: [v, office()] })))).toContain("ITEMS_COST_NOT_CLASS_GROSS");
  });
  it("catches a schedule charge that differs from the calculation unless exactly that difference is explained", () => {
    const bump = (v: ReturnType<typeof vehicles>) => { v.movements[2] = { ...v.movements[2], accumulatedDepreciationMinor: "873972603" }; v.closing = { ...v.closing, accumulatedDepreciationMinor: "2148767124", carryingMinor: "4851232876" }; return v; };
    expect(codes(computePpeWorkpaper(baseInput({ classes: [bump(vehicles()), office()] })))).toContain("CHARGE_DIFFERENCE_UNEXPLAINED");
    const wrong = bump(vehicles()); wrong.estimate.chargeDifference = { amountMinor: "2", explanation: "rounding of the register", evidence: "Register export" };
    expect(codes(computePpeWorkpaper(baseInput({ classes: [wrong, office()] })))).toContain("CHARGE_DIFFERENCE_UNEXPLAINED");
    const right = bump(vehicles()); right.estimate.chargeDifference = { amountMinor: "1", explanation: "register rounds the V2 day count", evidence: "Register export" };
    const ok = computePpeWorkpaper(baseInput({ classes: [right, office()], tb: { ppeCarryingOpeningMinor: EXPECTED.openingCarrying, ppeCarryingClosingMinor: "5331232876", depreciationExpenseMinor: "1113972603" } }));
    expect(codes(ok)).not.toContain("CHARGE_DIFFERENCE_UNEXPLAINED");
  });
  it("keeps unknown disposal proceeds unknown", () => {
    const v = vehicles(); v.disposals[0] = { ...v.disposals[0], proceedsMinor: null };
    const r = computePpeWorkpaper(baseInput({ classes: [v, office()] }));
    expect(codes(r)).toContain("DISPOSAL_PROCEEDS_UNKNOWN");
    expect(r.classes[0].disposalGainMinor).toBeNull();
  });
  it("ties to the reviewed trial balance, and an absent trial-balance figure is unknown rather than zero", () => {
    expect(codes(computePpeWorkpaper(baseInput({ tb: { ppeCarryingOpeningMinor: EXPECTED.openingCarrying, ppeCarryingClosingMinor: "5331232000", depreciationExpenseMinor: EXPECTED.depreciation } })))).toContain("TB_CARRYING_CLOSING_DIFFERENCE");
    const unknown = computePpeWorkpaper(baseInput({ tb: { ppeCarryingOpeningMinor: null, ppeCarryingClosingMinor: null, depreciationExpenseMinor: null } }));
    expect(codes(unknown)).toEqual(expect.arrayContaining(["TB_CARRYING_OPENING_UNKNOWN", "TB_CARRYING_CLOSING_UNKNOWN", "TB_DEPRECIATION_UNKNOWN"]));
  });
  it("requires an exact, evidenced explanation of a depreciation expense difference", () => {
    const tb = { ppeCarryingOpeningMinor: EXPECTED.openingCarrying, ppeCarryingClosingMinor: EXPECTED.closingCarrying, depreciationExpenseMinor: "1100000000" };
    expect(codes(computePpeWorkpaper(baseInput({ tb })))).toContain("TB_DEPRECIATION_DIFFERENCE");
    const diff = String(1113972602 - 1100000000);
    expect(codes(computePpeWorkpaper(baseInput({ tb, depreciationDifference: { amountMinor: diff, explanation: "Depreciation capitalised into a project asset", evidence: "Project cost ledger" } })))).not.toContain("TB_DEPRECIATION_DIFFERENCE");
  });
  it("makes every entity question an explicit answer, and routes 'applies' to a governed workpaper rather than excluding it", () => {
    const empty = computePpeWorkpaper(baseInput({ entityAnswers: {} }));
    expect(empty.issues.filter((i) => i.code.startsWith("ENTITY_QUESTION_UNRESOLVED")).length).toBe(5);
    const a = allAnswers(); a.heritage_assets = { ...emptyAnswer(), status: "answered", text: "The trust holds a museum collection", evidence: "Collection register", flags: { applies: true } };
    const r = computePpeWorkpaper(baseInput({ entityAnswers: a }));
    expect(codes(r)).toContain("SPECIALISED_ROUTE_REQUIRED:heritage_assets");
    const vague = allAnswers(); vague.impairment_indicators = { ...vague.impairment_indicators, flags: {} };
    expect(codes(computePpeWorkpaper(baseInput({ entityAnswers: vague })))).toContain("ENTITY_QUESTION_UNRESOLVED:impairment_indicators");
    const thin = allAnswers(); thin.held_for_sale = { ...thin.held_for_sale, text: "no", evidence: "" };
    expect(codes(computePpeWorkpaper(baseInput({ entityAnswers: thin })))).toContain("ENTITY_QUESTION_UNRESOLVED:held_for_sale");
  });
});

describe("generated policy and note", () => {
  const input = baseInput();
  const result = computePpeWorkpaper(input);
  const gen = generatePpePolicyNote(input, result, DISPLAY, "Mwamba Community Trust");
  it("is labelled as output for review", () => { expect(gen.label).toBe(GENERATED_LABEL); });
  it("states each confirmed estimate from the facts, with typed bindings for amounts", () => {
    const flat = gen.policy.map((p) => p.segments.map((s) => (s.t === "text" ? s.text : s.display)).join("")).join("\n");
    expect(flat).toContain("cost less accumulated depreciation and accumulated impairment losses");
    expect(flat).toContain("straight-line over 9 years");
    expect(flat).toContain("straight-line over 5 years");
    expect(gen.bindings[`fact.ppe.${vehicles().classId}.residual`]).toEqual({ kind: "amount", value: "700000000" });
    expect(gen.policy.every((p) => !p.unresolved)).toBe(true);
  });
  it("builds note tables whose totals equal the workpaper totals", () => {
    const carrying = gen.tables.find((t) => t.id === "table.ppe.carrying")!;
    const total = carrying.rows[carrying.rows.length - 1];
    expect(total.cells.map((c) => c?.minor)).toEqual([EXPECTED.openingCarrying, EXPECTED.closingCarrying]);
    const gross = gen.tables.find((t) => t.id === "table.ppe.gross")!.rows.at(-1)!;
    expect(gross.cells.map((c) => c?.minor)).toEqual(["9200000000", "2000000000", "-3000000000", "8200000000"]);
    expect(total.cells[1]?.display).toBe("TZS 53,312,328.77");
  });
  it("generates no wording for a class whose estimates are unconfirmed", () => {
    const i = baseInput({ classes: [vehicles({ estimateConfirmed: false }), office()] });
    const g = generatePpePolicyNote(i, computePpeWorkpaper(i), DISPLAY, "Mwamba Community Trust");
    const block = g.policy.find((p) => p.classId === vehicles().classId)!;
    expect(block.unresolved).toBe(true);
    expect(block.segments.map((s) => (s.t === "text" ? s.text : s.display)).join("")).not.toMatch(/straight-line|years/);
    expect(g.unresolved.join(" ")).toContain("Motor vehicles");
  });
});

describe("opening bridge", () => {
  const pub = (lineId: string, amountMinor: string | null, confirmed = true): PublishedClosing => ({ lineId, label: lineId, amountMinor, locator: "p. 12", confirmed });
  const open = (lineId: string, amountMinor: string | null): OpeningFact => ({ lineId, label: lineId, amountMinor, source: "prior-tb-closing", reference: "TB FY2025" });
  const item = (over: Partial<BridgeItem> = {}): BridgeItem => ({ id: "BRIDGE-1", groupId: "", lineId: "ppe", kind: "posted-journal", amountMinor: "200000", evidenceRef: "Journal J-114", authorityReference: "Approved by finance committee 2026-01-12", ...over });

  it("agrees when the opening equals the printed prior figure", () => {
    const r = computeOpeningBridge([pub("ppe", "5600000000")], [open("ppe", "5600000000")], []);
    expect(r.state).toBe("agrees");
  });
  it("never plugs: an unexplained difference is a blocker carrying the exact residual", () => {
    const r = computeOpeningBridge([pub("ppe", "5600000000")], [open("ppe", "5600200000")], []);
    expect(r.state).toBe("blocked");
    expect(r.lines[0].residualMinor).toBe("200000");
    expect(r.blockers[0].code).toBe("OPENING_RESIDUAL_UNEXPLAINED");
  });
  it("bridges only with an evidenced, authorised item for exactly the difference", () => {
    expect(computeOpeningBridge([pub("ppe", "5600000000")], [open("ppe", "5600200000")], [item()]).state).toBe("bridged");
    expect(computeOpeningBridge([pub("ppe", "5600000000")], [open("ppe", "5600200000")], [item({ amountMinor: "199999" })]).state).toBe("blocked");
    expect(computeOpeningBridge([pub("ppe", "5600000000")], [open("ppe", "5600200000")], [item({ evidenceRef: "" })]).itemProblems.join()).toContain("evidence");
    expect(computeOpeningBridge([pub("ppe", "5600000000")], [open("ppe", "5600200000")], [item({ authorityReference: "x" })]).itemProblems.join()).toContain("authority");
  });
  it("requires a reclassification to net to zero across lines", () => {
    const base = [pub("ppe", "100"), pub("inv", "50")];
    const ok = computeOpeningBridge(base, [open("ppe", "70"), open("inv", "80")], [item({ id: "RECLASS-1", groupId: "GROUP-1", lineId: "ppe", kind: "reclassification", amountMinor: "-30" }), item({ id: "RECLASS-2", groupId: "GROUP-1", lineId: "inv", kind: "reclassification", amountMinor: "30" })]);
    expect(ok.state).toBe("bridged");
    const lopsided = computeOpeningBridge(base, [open("ppe", "70"), open("inv", "50")], [item({ id: "RECLASS-1", groupId: "GROUP-1", lineId: "ppe", kind: "reclassification", amountMinor: "-30" })]);
    expect(lopsided.itemProblems.join()).toMatch(/net to zero|only one line/);
    expect(lopsided.state).toBe("blocked");
  });
  it("treats a missing or unconfirmed figure as unknown, never zero", () => {
    expect(computeOpeningBridge([pub("ppe", null)], [open("ppe", "0")], []).lines[0].status).toBe("published-missing");
    expect(computeOpeningBridge([pub("ppe", "0", false)], [open("ppe", "0")], []).lines[0].status).toBe("published-unconfirmed");
    expect(computeOpeningBridge([pub("ppe", "0")], [open("ppe", null)], []).lines[0].status).toBe("opening-missing");
    expect(computeOpeningBridge([pub("ppe", "0")], [], []).state).toBe("blocked");
  });
  it("rejects duplicate lines, duplicate items and items on unknown lines", () => {
    expect(computeOpeningBridge([pub("ppe", "1"), pub("ppe", "1")], [open("ppe", "1")], []).itemProblems.join()).toContain("twice");
    expect(computeOpeningBridge([pub("ppe", "1")], [open("ppe", "1")], [item({ id: "ITEM-X", lineId: "nope" })]).itemProblems.join()).toContain("neither");
    expect(computeOpeningBridge([pub("ppe", "1")], [open("ppe", "2")], [item({ id: "ITEM-X", amountMinor: "1" }), item({ id: "ITEM-X", amountMinor: "1" })]).itemProblems.join()).toContain("unique");
  });
  it("flags an over-explained line (bridge without a difference)", () => {
    const r = computeOpeningBridge([pub("ppe", "5")], [open("ppe", "5")], [item({ amountMinor: "1" })]);
    expect(r.state).toBe("blocked");
    expect(r.lines[0].residualMinor).toBe("-1");
  });
});

describe("tasks and the incomplete preview", () => {
  const bridge = computeOpeningBridge([{ lineId: "ppe", label: "PPE", amountMinor: "6320000000", locator: "p. 12", confirmed: true }], [{ lineId: "ppe", label: "PPE", amountMinor: "6320000000", source: "prior-tb-closing", reference: "TB" }], []);
  it("turns every blocker into a task that says what, why, which evidence, who, where and what it affects", () => {
    const input = baseInput({ classes: [vehicles({ estimateConfirmed: false }), office()], entityAnswers: {} });
    const ppe = computePpeWorkpaper(input);
    const tasks = tasksFromPreparation(ppe, bridge);
    expect(tasks.length).toBe(ppe.issues.length);
    for (const t of tasks) {
      expect(t.missing.length).toBeGreaterThan(10);
      expect(t.why.length).toBeGreaterThan(10);
      expect(t.acceptedEvidence.length).toBeGreaterThan(3);
      expect(t.target.length).toBeGreaterThan(2);
      expect(t.affects.length).toBeGreaterThan(0);
    }
    expect(tasks.find((t) => t.id.includes("ESTIMATE_UNCONFIRMED"))?.responsible).toBe("management");
  });
  it("always states why official issuance is unavailable, even when the PPE slice is complete", () => {
    const input = baseInput();
    const result = computePpeWorkpaper(input);
    const p = buildIncompletePreview(result, bridge, generatePpePolicyNote(input, result, DISPLAY, "Mwamba Community Trust"));
    expect(result.state).toBe("ready-for-review");
    expect(p.label).toMatch(/INCOMPLETE DRAFT/);
    expect(p.officialIssuance.available).toBe(false);
    expect(p.officialIssuance.reasons).toEqual(OFFICIAL_ISSUANCE_BLOCKERS);
    expect(p.nextAction).toBeNull();
  });
  it("puts bring-information tasks before preparation tasks", () => {
    const badBridge = computeOpeningBridge([{ lineId: "ppe", label: "PPE", amountMinor: "1", locator: "p. 1", confirmed: true }], [{ lineId: "ppe", label: "PPE", amountMinor: "5", source: "prior-tb-closing", reference: "TB" }], []);
    const input = baseInput({ entityAnswers: {} });
    const t = tasksFromPreparation(computePpeWorkpaper(input), badBridge);
    expect(t[0].area).toBe("bring");
  });
});

describe("generated PPE note: every displayed amount uses the server-confirmed denomination (independent review of #229, finding 4)", () => {
  const input = baseInput();
  const result = computePpeWorkpaper(input);
  const decimalsOf = (s: string) => { const m = /\.(\d+)$/.exec(s.trim()); return m ? m[1].length : 0; };
  it.each([["TZS", 2], ["USD", 2], ["JPY", 0], ["KWD", 3]])("%s: each amount carries the code and exactly %i decimals", (currency, exponent) => {
    const shown = [...JSON.stringify(generatePpePolicyNote(input, result, { currency, exponent }, "Mwamba Community Trust")).matchAll(/"display":"([^"]+)"/g)].map((x) => x[1]);
    expect(shown.length).toBeGreaterThan(0);
    const amounts = shown.filter((d) => /\d/.test(d));
    expect(amounts.length).toBeGreaterThan(0);
    for (const d of amounts) { expect(d).toContain(currency); expect(decimalsOf(d), d).toBe(exponent); }
  });
  it("the same figures read differently under different units, so a note is only right in the server's own", () => {
    const flat = (display: { currency: string; exponent: number }) => JSON.stringify(generatePpePolicyNote(input, result, display, "Mwamba Community Trust"));
    expect(flat({ currency: "JPY", exponent: 0 })).not.toBe(flat({ currency: "TZS", exponent: 2 }));
  });
});
