import { describe, expect, it } from "vitest";
import {
  classPreservation,
  classRollForward,
  depreciationTieOut,
  disposalResults,
  movementCarryingMinor,
  openingGrossBridge,
  totalCarrying,
  type ClassMovement,
  type DisposalItem,
} from "./equipmentSchedule";

// Synthetic figures, independently calculated by hand (TZS, exponent 2). None describes a real entity.
const src = { type: "register" as const, reference: "Synthetic fixed asset register 2026" };
const mv = (kind: ClassMovement["kind"], g: string, d: string, i: string, source = src): ClassMovement => ({ kind, grossMinor: g, accumulatedDepreciationMinor: d, accumulatedImpairmentMinor: i, source, note: "" });
const bal = (g: string, d: string, i: string, c: string) => ({ grossMinor: g, accumulatedDepreciationMinor: d, accumulatedImpairmentMinor: i, carryingMinor: c });

describe("class roll-forward (17.31(d)-(e)): gross, accumulated and carrying identities", () => {
  it("AC-01: the controlled fixture agrees in every column and yields the schedule row the server expects", () => {
    const r = classRollForward("Equipment", { opening: bal("2000000", "400000", "0", "1600000"), closing: bal("2000000", "600000", "0", "1400000") }, [mv("depreciation", "0", "200000", "0")], []);
    expect(r.state).toBe("agrees");
    expect(r.scheduleRow).toEqual({ classLabel: "Equipment", openingMinor: "1600000", closingMinor: "1400000", movements: [{ kind: "depreciation", amountMinor: "-200000" }] });
    expect(r.differences).toEqual({ grossMinor: "0", accumulatedDepreciationMinor: "0", accumulatedImpairmentMinor: "0", carryingMinor: "0" });
  });
  it("AC-06: additions, a disposal (cost 4,000 / acc dep 2,500) and depreciation 2,300 roll forward through cost and accumulated depreciation", () => {
    // 14,000 + 5,000 - 1,500 - 2,300 = 15,200; gross 20,000 + 5,000 - 4,000 = 21,000; acc dep 6,000 + 2,300 - 2,500 = 5,800.
    const disposal: DisposalItem = { reference: "Lathe L-2", date: "2026-03-31", costMinor: "400000", accumulatedDepreciationMinor: "250000", accumulatedImpairmentMinor: "0", proceedsMinor: "180000", source: src };
    const r = classRollForward("Equipment", { opening: bal("2000000", "600000", "0", "1400000"), closing: bal("2100000", "580000", "0", "1520000") },
      [mv("additions", "500000", "0", "0"), mv("disposals", "-400000", "-250000", "0"), mv("depreciation", "0", "230000", "0")], [disposal]);
    expect(r.state).toBe("agrees");
    expect(r.scheduleRow!.movements).toEqual([{ kind: "additions", amountMinor: "500000" }, { kind: "disposals", amountMinor: "-150000" }, { kind: "depreciation", amountMinor: "-230000" }]);
    const g = disposalResults([disposal]);
    expect(g.items[0]).toEqual({ reference: "Lathe L-2", carryingMinor: "150000", proceedsMinor: "180000", gainMinor: "30000" });
    expect(g.totalGainMinor).toBe("30000");
  });
  it("AC-06 negative: the disposed items must equal the cost removed and the accumulated depreciation eliminated", () => {
    const r = classRollForward("Equipment", { opening: bal("2000000", "600000", "0", "1400000"), closing: bal("2100000", "580000", "0", "1520000") },
      [mv("additions", "500000", "0", "0"), mv("disposals", "-400000", "-250000", "0"), mv("depreciation", "0", "230000", "0")],
      [{ reference: "Lathe L-2", date: "2026-03-31", costMinor: "300000", accumulatedDepreciationMinor: "250000", accumulatedImpairmentMinor: "0", proceedsMinor: null, source: src }]);
    expect(r.state).toBe("incomplete");
    expect(r.problems.join(" ")).toContain("Disposed cost 300000 does not equal the cost removed in the disposals movement 400000");
  });
  it("AC-05: missing movements leave a difference in the carrying amount and in accumulated depreciation; nothing is inferred", () => {
    const r = classRollForward("Equipment", { opening: bal("2000000", "400000", "0", "1600000"), closing: bal("2000000", "600000", "0", "1400000") }, [], []);
    expect(r.state).toBe("difference");
    expect(r.differences!.accumulatedDepreciationMinor).toBe("200000");
    expect(r.differences!.carryingMinor).toBe("-200000");
    expect(r.scheduleRow).toBeNull();
  });
  it("AC-09 / AC-10: a blank amount is unknown (incomplete), and the net identity is checked at both dates", () => {
    expect(classRollForward("Equipment", { opening: bal("2000000", "400000", "", "1600000"), closing: bal("2000000", "600000", "0", "1400000") }, [mv("depreciation", "0", "200000", "0")], []).state).toBe("incomplete");
    const r = classRollForward("Equipment", { opening: bal("2000000", "400000", "0", "1600000"), closing: bal("2000000", "500000", "0", "1400000") }, [mv("depreciation", "0", "100000", "0")], []);
    expect(r.state).toBe("difference");
    expect(r.netIdentity!.closingMinor).toBe("100000");
  });
  it("AC-34: accumulated impairment is a separate column that still nets to the carrying amount", () => {
    const r = classRollForward("Equipment", { opening: bal("2000000", "400000", "0", "1600000"), closing: bal("2000000", "500000", "100000", "1400000") }, [mv("depreciation", "0", "100000", "0"), mv("impairment_profit_or_loss", "0", "0", "100000")], []);
    expect(r.state).toBe("agrees");
    expect(r.scheduleRow!.movements.find((m) => m.kind === "impairment_profit_or_loss")!.amountMinor).toBe("-100000");
  });
  it("AC-07: the carrying effect of a movement follows its columns, and the pack's direction rule is checked", () => {
    expect(movementCarryingMinor({ grossMinor: "-400000", accumulatedDepreciationMinor: "-250000", accumulatedImpairmentMinor: "0" })).toBe("-150000");
    expect(movementCarryingMinor({ grossMinor: "", accumulatedDepreciationMinor: "0", accumulatedImpairmentMinor: "0" })).toBeNull();
    const r = classRollForward("Equipment", { opening: bal("2000000", "400000", "0", "1600000"), closing: bal("1500000", "400000", "0", "1100000") }, [mv("additions", "-500000", "0", "0")], []);
    expect(r.problems.join(" ")).toContain("additions cannot reduce the carrying amount");
  });
  it("AC-33: every movement needs a register, ledger account, journal or reviewed workpaper", () => {
    const r = classRollForward("Equipment", { opening: bal("2000000", "400000", "0", "1600000"), closing: bal("2000000", "600000", "0", "1400000") }, [mv("depreciation", "0", "200000", "0", { type: "", reference: "" })], []);
    expect(r.state).toBe("incomplete");
    expect(r.problems.join(" ")).toContain("Name the register, ledger account, journal or reviewed workpaper that supports depreciation");
  });
});

describe("depreciation tie-out (17.17; charter G5)", () => {
  const classes = [{ movements: [mv("depreciation", "0", "125000", "0")] }, { movements: [mv("depreciation", "0", "75000", "0")] }];
  const composed = [{ lineId: "sci.operating_expenses_by_function", amountMinor: "990000" }, { lineId: "sci.cost_of_sales", amountMinor: "1400000" }];
  it("agrees when the destinations account for the whole charge, including an amount capitalised into inventories", () => {
    const r = depreciationTieOut(classes, [
      { target: "sci.operating_expenses_by_function", amountMinor: "150000", evidence: "Expense ledger 6200", explanation: "" },
      { target: "capitalised_inventories", amountMinor: "50000", evidence: "Production overhead absorption working", explanation: "" },
    ], composed);
    expect(r.state).toBe("agrees");
    expect(r).toMatchObject({ scheduleDepreciationMinor: "200000", destinationsMinor: "200000", differenceMinor: "0" });
  });
  it("reports a difference the preparer must explain and never posts a journal; an amount above its composed line is refused", () => {
    const r = depreciationTieOut(classes, [{ target: "sci.operating_expenses_by_function", amountMinor: "150000", evidence: "Expense ledger 6200", explanation: "" }], composed);
    expect(r.state).toBe("difference");
    expect(r.differenceMinor).toBe("50000");
    expect(r.problems.join(" ")).toContain("differ by 50000");
    const over = depreciationTieOut(classes, [{ target: "sci.cost_of_sales", amountMinor: "2000000", evidence: "x", explanation: "" }], composed);
    expect(over.lines[0].exceeds).toBe(true);
  });
  it("is incomplete while a class's depreciation is not exact or a destination is unnamed", () => {
    expect(depreciationTieOut([{ movements: [mv("depreciation", "0", "", "0")] }], [], composed).state).toBe("incomplete");
    expect(depreciationTieOut(classes, [{ target: "", amountMinor: "200000", evidence: "x", explanation: "" }], composed).state).toBe("incomplete");
  });
});

describe("class preservation (AC-27) and the gross bridge (AC-23)", () => {
  it("refuses to drop a recorded class unless it is retired with a reason and evidence", () => {
    const existing = [{ classLabel: "Equipment" }, { classLabel: "Motor vehicles" }];
    expect(classPreservation(existing, [{ label: "Equipment and vehicles" }], []).missing).toEqual(["Equipment", "Motor vehicles"]);
    expect(classPreservation(existing, [{ label: "Equipment" }], [{ label: "Motor vehicles", reason: "", evidence: "" }]).problems.join(" ")).toContain("needs a reason and supporting evidence");
    expect(classPreservation(existing, [{ label: "Equipment" }], [{ label: "Motor vehicles", reason: "All vehicles sold in March", evidence: "Sale agreement V-1" }])).toEqual({ missing: [], problems: [] });
  });
  it("AC-23: a net bridge that agrees can hide a gross difference; the gross opening is bridged separately", () => {
    const classes = [{ opening: bal("2100000", "500000", "0", "1600000") }];
    const r = openingGrossBridge({ grossMinor: "2000000", accumulatedMinor: "400000" }, classes);
    expect(r.state).toBe("difference");
    expect(r.grossDifferenceMinor).toBe("100000");
    expect(r.accumulatedDifferenceMinor).toBe("100000");
    expect(openingGrossBridge({ grossMinor: null, accumulatedMinor: null }, classes).state).toBe("not_provided");
    expect(openingGrossBridge({ grossMinor: "2100000", accumulatedMinor: "500000" }, classes).state).toBe("agrees");
  });
  it("sums carrying amounts exactly across classes, or not at all", () => {
    expect(totalCarrying([{ opening: bal("1", "0", "0", "900000"), closing: bal("1", "0", "0", "875000") }, { opening: bal("1", "0", "0", "700000"), closing: bal("1", "0", "0", "525000") }], "closing")).toBe("1400000");
    expect(totalCarrying([{ opening: bal("1", "0", "0", ""), closing: bal("1", "0", "0", "1") }], "opening")).toBeNull();
  });
});
