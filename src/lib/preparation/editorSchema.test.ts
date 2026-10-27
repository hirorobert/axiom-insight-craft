import { expect, it } from "vitest";
import { parseEquipmentEditor } from "./editorSchema";
const editor = {
  sourceMode: "reference",
  priorReference: "Prior register",
  page: "1",
  priorAmount: "16000",
  priorDate: "2024-12-31",
  priorCurrency: "TZS",
  priorUnits: "0",
  opening: "16000",
  closing: "14000",
  adjustments: [],
  movementValues: { depreciation: "2000" },
  source: "Current register",
  policy: {
    assetClass: "Equipment",
    basis: "cost",
    method: "straight-line",
    usefulLife: "Decided by entity",
    residualValue: "0",
    rationale: "Expected use",
    evidence: "Register",
  },
  gross: {
    openingGross: "20000",
    openingDepreciation: "4000",
    openingImpairment: "0",
    closingGross: "20000",
    closingDepreciation: "6000",
    closingImpairment: "0",
  },
  judgements: { components: "No separately significant parts" },
  read: null,
};
const data = {
  contract: "cfoclose-equipment-workpaper/1",
  companyId: "A",
  periodYear: 2025,
  editor,
};
it("restores only a bounded, correctly scoped editor snapshot", () => {
  expect(parseEquipmentEditor(data, "A", 2025).opening).toBe("16000");
  expect(() => parseEquipmentEditor(data, "B", 2025)).toThrow();
  expect(() => parseEquipmentEditor(data, "A", 2024)).toThrow();
  expect(() =>
    parseEquipmentEditor(
      { ...data, editor: { ...editor, unexpected: "injected" } },
      "A",
      2025,
    ),
  ).toThrow();
  expect(() =>
    parseEquipmentEditor(
      { ...data, editor: { ...editor, movementValues: { invented: "2000" } } },
      "A",
      2025,
    ),
  ).toThrow();
  expect(() =>
    parseEquipmentEditor(
      {
        ...data,
        editor: {
          ...editor,
          read: {
            sha256: "a".repeat(64),
            page: 201,
            pages: 201,
            text: "",
            method: "ocr",
          },
        },
      },
      "A",
      2025,
    ),
  ).toThrow();
});
