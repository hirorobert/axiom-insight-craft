import { describe, expect, it } from "vitest";
import { equipmentNoteProposalV2, estimatesProposalV2, policyProposalV2 } from "./equipmentProposals";
import { emptyEstimate, type Answer, type EquipmentClass } from "./equipmentModel";

const src = { type: "register" as const, reference: "Synthetic register 2026" };
const answered = (text: string, flags: Record<string, boolean> = {}): Answer => ({ status: "answered", text, evidence: "File", checkedBy: "", flags });
const none = (): Answer => ({ status: "none_with_basis", text: "", evidence: "Checked", checkedBy: "A. Preparer", flags: {} });
const equipment: EquipmentClass = {
  classId: "11111111-1111-4111-8111-111111111111", label: "Equipment", origin: "existing", accounts: "1500, 1510",
  opening: { grossMinor: "2000000", accumulatedDepreciationMinor: "600000", accumulatedImpairmentMinor: "0", carryingMinor: "1400000" },
  closing: { grossMinor: "2100000", accumulatedDepreciationMinor: "580000", accumulatedImpairmentMinor: "0", carryingMinor: "1520000" },
  movements: [
    { kind: "additions", grossMinor: "500000", accumulatedDepreciationMinor: "0", accumulatedImpairmentMinor: "0", source: src, note: "" },
    { kind: "disposals", grossMinor: "-400000", accumulatedDepreciationMinor: "-250000", accumulatedImpairmentMinor: "0", source: src, note: "" },
    { kind: "depreciation", grossMinor: "0", accumulatedDepreciationMinor: "230000", accumulatedImpairmentMinor: "0", source: src, note: "" },
  ],
  disposals: [{ reference: "Lathe L-2", date: "2026-03-31", costMinor: "400000", accumulatedDepreciationMinor: "250000", accumulatedImpairmentMinor: "0", proceedsMinor: "180000", source: src }],
  estimate: { ...emptyEstimate(), basis: "cost", method: "straight-line", lifeYears: "10", residualMinor: "0", convention: "daily", chargeSource: "register", registerChargeMinor: "230000", registerReference: "Register", changedSincePrior: "yes", changeDescription: "Remaining life of the press shortened to 2 years", changeEffectMinor: "200000", rationale: "ten years of two-shift use", evidence: "Capital budget" },
  answers: { recognition: answered("Owned"), components: answered("None"), lease: answered("Two generators under finance leases, net carrying amount TZS 7,600.00") },
};
const vehicles: EquipmentClass = { ...equipment, classId: "22222222-2222-4222-8222-222222222222", label: "Motor vehicles", origin: "new", movements: [{ kind: "depreciation", grossMinor: "0", accumulatedDepreciationMinor: "75000", accumulatedImpairmentMinor: "0", source: src, note: "" }], disposals: [], estimate: { ...equipment.estimate, method: "reducing-balance", ratePercent: "25", changedSincePrior: "no" }, answers: { recognition: answered("Owned"), components: answered("None") },
  opening: { grossMinor: "900000", accumulatedDepreciationMinor: "200000", accumulatedImpairmentMinor: "0", carryingMinor: "700000" }, closing: { grossMinor: "900000", accumulatedDepreciationMinor: "275000", accumulatedImpairmentMinor: "0", carryingMinor: "625000" } };

describe("proposals from confirmed answers (original wording, review required)", () => {
  it("writes one policy paragraph per class with its basis, method, life or rate, residual value and convention, and keeps every class", () => {
    const t = policyProposalV2([equipment, vehicles], "TZS", 2);
    expect(t).toContain("Equipment is measured at cost less accumulated depreciation");
    expect(t).toContain("straight-line basis over an estimated useful life of 10 years, pro rata by day");
    expect(t).toContain("Motor vehicles is measured at cost");
    expect(t).toContain("reducing-balance basis at 25% per year");
    expect(t).toContain("finance leases within Equipment");
    expect(t).toContain("not presented as revenue");
    expect(t).not.toMatch(/IFRS Foundation|©/);
  });
  it("writes the estimates note with each class's carrying amount and a change in estimate with its current-period effect", () => {
    const t = estimatesProposalV2([equipment, vehicles], "TZS", 2);
    expect(t).toContain("Equipment (carrying amount TZS 15200.00 at the end of the period)");
    expect(t).toContain("Change in estimate for Equipment: Remaining life of the press shortened to 2 years. The effect on the current period's depreciation is TZS 2000.00; the change is applied prospectively");
    expect(t).toContain("Motor vehicles (carrying amount TZS 6250.00");
    expect(t).not.toContain("Change in estimate for Motor vehicles");
  });
  it("writes the equipment note per class: gross and accumulated amounts at both dates, the reconciliation, the disposal gain, destinations and the 17.32 disclosures", () => {
    const entity = { restrictions_security: answered("Press P-1 (carrying amount TZS 5000.00) pledged to Synthetic Bank"), commitments: none(), impairment: answered("None", { indicator_present: false }), events_after: none(), framework_history: answered("Since 2020", {}) };
    const t = equipmentNoteProposalV2([equipment, vehicles], entity, [{ target: "sci.operating_expenses_by_function", amountMinor: "305000", evidence: "Ledger", explanation: "" }], "TZS", 2);
    expect(t).toContain("Equipment: gross carrying amount TZS 20000.00 at the start and TZS 21000.00 at the end");
    expect(t).toContain("accumulated depreciation and impairment 6000.00 at the start and 5800.00 at the end");
    expect(t).toContain("Disposals (carrying amount) TZS -1500.00 (cost -4000.00)");
    expect(t).toContain("The resulting gain of TZS 300.00 is recognised in profit or loss");
    expect(t).toContain("Motor vehicles: gross carrying amount TZS 9000.00");
    expect(t).toContain("included in: operating expenses by function TZS 3050.00");
    expect(t).toContain("Press P-1 (carrying amount TZS 5000.00) pledged");
    expect(t).toContain("There are no contractual commitments to acquire equipment");
    expect(t).toContain("no indication that any item of equipment was impaired");
  });
  it("states what it cannot state: unknown proceeds, an unsupported revaluation case, unrecorded answers", () => {
    const unknown = { ...equipment, disposals: [{ ...equipment.disposals[0], proceedsMinor: null }], estimate: { ...equipment.estimate, basis: "revaluation" as const } };
    const t = equipmentNoteProposalV2([unknown], {}, [], "TZS", 2);
    expect(t).toContain("cannot be stated until every proceeds figure is confirmed");
    expect(t).toContain("unsupported reporting case");
    expect(t).toContain("Restricted title and security: (not yet recorded)");
    expect(policyProposalV2([unknown], "TZS", 2)).toContain("recorded as an unsupported case for review");
  });
});
