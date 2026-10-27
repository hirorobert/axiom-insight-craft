import { expect, it } from "vitest";
import {
  EQUIPMENT_QUESTIONS,
  EQUIPMENT_SOURCE,
  grossReconciliation,
} from "./equipmentRequirements";
const balances = {
  openingGross: "2000000",
  openingDepreciation: "400000",
  openingImpairment: "0",
  closingGross: "2000000",
  closingDepreciation: "600000",
  closingImpairment: "0",
};
it("keeps the source edition and incomplete accounting review explicit", () => {
  expect(EQUIPMENT_SOURCE.framework).toBe("ifrs-for-smes/2015");
  expect(EQUIPMENT_SOURCE.status).toContain("review-pending");
  expect(new Set(EQUIPMENT_QUESTIONS.map((q) => q.id)).size).toBe(
    EQUIPMENT_QUESTIONS.length,
  );
  expect(
    EQUIPMENT_QUESTIONS.every((q) => q.refs.length && q.evidence.length),
  ).toBe(true);
});
it("independently checks opening and closing gross-to-net amounts for the controlled fixture", () => {
  expect(grossReconciliation(balances, "1600000", "1400000")).toEqual({
    state: "agrees",
    openingDifference: "0",
    closingDifference: "0",
  });
  expect(
    grossReconciliation(
      { ...balances, closingDepreciation: "500000" },
      "1600000",
      "1400000",
    ).closingDifference,
  ).toBe("100000");
});
it("requires known zero deductions rather than substituting zero for blank or net figures", () => {
  expect(
    grossReconciliation(
      { ...balances, openingImpairment: "" },
      "1600000",
      "1400000",
    ).state,
  ).toBe("incomplete");
  expect(
    grossReconciliation(
      { ...balances, closingDepreciation: "-600000" },
      "1600000",
      "1400000",
    ).state,
  ).toBe("incomplete");
  expect(grossReconciliation(balances, null, "1400000").state).toBe(
    "incomplete",
  );
});
it("collects existing policy answers once and asks only the remaining questions", async () => {
  const { preparationInputs } = await import("./equipmentRequirements");
  const rows = preparationInputs(
    {
      basis: "cost",
      method: "straight-line",
      usefulLife: "5 years",
      residualValue: "0",
      rationale: "Usage plan",
      evidence: "Approved register",
    },
    "agrees",
    "agrees",
    {
      recognition: "Owned by entity",
      components: "No material separate components",
      restrictions: "Reviewed contracts: none",
    },
  );
  expect(rows.every((q) => q.entered)).toBe(true);
  expect(rows.find((q) => q.id === "basis").usesExistingFields).toBe(true);
  expect(rows.some((q) => q.id === "revaluation")).toBe(false);
});
