import { expect, it } from "vitest";
import { parseEquipmentEditorV2 } from "./editorSchema";
import { emptyAnswer, emptyBalances, emptyEstimate } from "./equipmentModel";

const editor = {
  sourceMode: "reference", priorReference: "Prior register", page: "1", priorAmount: "16000", priorGross: "", priorAccumulated: "", priorDate: "2025-12-31", priorCurrency: "TZS", priorUnits: "0",
  adjustments: [{ amount: "200", reason: "Approved correction", evidence: "Journal J1", category: "correction" }],
  classes: [{
    classId: "11111111-1111-4111-8111-111111111111", label: "Equipment", origin: "existing", accounts: "1500, 1510",
    opening: { ...emptyBalances(), carryingMinor: "1600000" }, closing: emptyBalances(),
    movements: [{ kind: "depreciation", grossMinor: "0", accumulatedDepreciationMinor: "200000", accumulatedImpairmentMinor: "0", source: { type: "register", reference: "Register" }, note: "" }],
    disposals: [], estimate: emptyEstimate(), answers: { recognition: { ...emptyAnswer(), status: "answered", text: "Owned", evidence: "Invoices" } },
  }],
  retiredClasses: [], destinations: [{ target: "sci.operating_expenses_by_function", amountMinor: "200000", evidence: "Ledger 6200", explanation: "" }],
  entityAnswers: { commitments: emptyAnswer() }, read: null,
};
const payload = { contract: "cfoclose-equipment-workpaper/2", companyId: "company-a", periodYear: 2026, editor };

it("restores a strictly bounded multi-class editor for the same company and period only", () => {
  expect(parseEquipmentEditorV2(payload, "company-a", 2026).classes[0].label).toBe("Equipment");
  expect(() => parseEquipmentEditorV2(payload, "company-b", 2026)).toThrow();
  expect(() => parseEquipmentEditorV2({ ...payload, periodYear: 2025 }, "company-a", 2026)).toThrow();
});
it("refuses the single-class contract, unknown keys, unknown movement kinds and oversized text as a whole", () => {
  expect(() => parseEquipmentEditorV2({ ...payload, contract: "cfoclose-equipment-workpaper/1" }, "company-a", 2026)).toThrow();
  expect(() => parseEquipmentEditorV2({ ...payload, editor: { ...editor, extra: 1 } }, "company-a", 2026)).toThrow();
  expect(() => parseEquipmentEditorV2({ ...payload, editor: { ...editor, classes: [{ ...editor.classes[0], movements: [{ ...editor.classes[0].movements[0], kind: "plug" }] }] } }, "company-a", 2026)).toThrow();
  expect(() => parseEquipmentEditorV2({ ...payload, editor: { ...editor, classes: [{ ...editor.classes[0], accounts: "x".repeat(2001) }] } }, "company-a", 2026)).toThrow();
  expect(() => parseEquipmentEditorV2({ ...payload, editor: { ...editor, classes: [{ ...editor.classes[0], classId: "not-a-uuid" }] } }, "company-a", 2026)).toThrow();
});
