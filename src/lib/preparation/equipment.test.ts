import { describe, it, expect } from "vitest";
import {
  openingBridge,
  openingAnchorDate,
  reconcileEquipment,
  policyDraft,
  formatMinor,
  parseSourceAmount,
  type SourceFact,
} from "./equipment";
const context = {
  entity: "Synthetic SME",
  priorPeriodEnd: "2024-12-31",
  currency: "TZS",
  exponent: 2,
};
const fact: SourceFact = {
  documentSha256: "a".repeat(64),
  page: 7,
  entity: context.entity,
  periodEnd: context.priorPeriodEnd,
  currency: "TZS",
  scale: 2,
  label: "Equipment carrying amount",
  amountMinor: "1600000",
  confirmed: true,
};
describe("equipment preparation, not accounting authority", () => {
  it("reconciles the controlled SME equipment fixture without guessing useful life", () => {
    expect(openingBridge(fact, [], "1600000", context).state).toBe("agrees");
    expect(
      reconcileEquipment(
        "1600000",
        [
          {
            kind: "depreciation",
            amountMinor: "-200000",
            evidence: "Synthetic register",
          },
        ],
        "1400000",
        "1400000",
      ).state,
    ).toBe("agrees");
    expect(
      policyDraft({
        assetClass: "Equipment",
        basis: "cost",
        method: "straight-line",
        usefulLife: "",
        residualValue: "",
        rationale: "",
        evidence: "",
      }).text,
    ).toBeNull();
  });
  it("accepts explained opening adjustments without rewriting the prior reported figure", () => {
    const result = openingBridge(
      fact,
      [
        {
          amountMinor: "20000",
          reason: "Approved correction",
          evidence: "Journal and approval J1",
        },
      ],
      "1620000",
      context,
    );
    expect(result.state).toBe("agrees");
    expect(fact.amountMinor).toBe("1600000");
  });
  it("keeps an Enduimet-shaped missing-PPE case incomplete rather than inventing an asset", () => {
    expect(openingBridge(null, [], "0", context).state).toBe("incomplete");
    expect(openingBridge(fact, [], "0", context).state).toBe("difference");
    expect(reconcileEquipment("1600000", [], "0", null).state).toBe(
      "incomplete",
    );
  });
  it.each(["entity", "periodEnd", "currency", "scale"] as const)(
    "refuses mismatched %s",
    (key) => {
      expect(
        openingBridge(
          { ...fact, [key]: key === "scale" ? 0 : "different" },
          [],
          "1600000",
          context,
        ).state,
      ).toBe("incomplete");
    },
  );
  it("requires confirmation, original provenance and adjustment support", () => {
    expect(
      openingBridge({ ...fact, confirmed: false }, [], "1600000", context)
        .state,
    ).toBe("incomplete");
    expect(
      openingBridge(
        { ...fact, documentSha256: "", page: 0 },
        [],
        "1600000",
        context,
      ).state,
    ).toBe("incomplete");
    expect(
      openingBridge(
        fact,
        [{ amountMinor: "20000", reason: "", evidence: "" }],
        "1620000",
        context,
      ).state,
    ).toBe("incomplete");
  });
  it("does not equate two-TB net change with gross movements or cash flow", () => {
    expect(reconcileEquipment("1600000", [], "1400000", "1400000").state).toBe(
      "difference",
    );
    expect(
      reconcileEquipment(
        "1600000",
        [{ kind: "other", amountMinor: "-200000", evidence: "" }],
        "1400000",
        "1400000",
      ).state,
    ).toBe("incomplete");
  });
  it("checks both internal arithmetic and the server statement independently", () => {
    const r = reconcileEquipment(
      "1600000",
      [{ kind: "depreciation", amountMinor: "-100000", evidence: "Register" }],
      "1400000",
      "1300000",
    );
    expect(r.movementDifferenceMinor).toBe("-100000");
    expect(r.statementDifferenceMinor).toBe("100000");
  });
  it("distinguishes unavailable from a verified zero and rejects nonexact amounts", () => {
    expect(reconcileEquipment("0", [], "0", "0").state).toBe("agrees");
    expect(reconcileEquipment("0", [], "0", null).state).toBe("incomplete");
    expect(reconcileEquipment("1.2", [], "0", "0").state).toBe("incomplete");
  });
  it("formats large exact signed figures without floating point", () => {
    expect(formatMinor("900719925474099312", 2)).toBe("9007199254740993.12");
    expect(formatMinor("-1", 2)).toBe("-0.01");
    expect(formatMinor("0", 0)).toBe("0");
    expect(() => formatMinor("1e3", 2)).toThrow();
  });
});

it("keeps manually confirmed figures distinct from document-backed figures", () => {
  const manual = {
    ...fact,
    origin: "manual" as const,
    documentSha256: null,
    page: null,
    sourceRef: "Reviewed register A1",
  };
  expect(openingBridge(manual, [], "1600000", context).state).toBe("agrees");
  expect(
    openingBridge({ ...manual, sourceRef: "" }, [], "1600000", context).state,
  ).toBe("incomplete");
});

it("normalizes thousands and millions without rounding or accepting malformed grouping", () => {
  expect(parseSourceAmount("16.1234", 2, 3)).toBe("1612340");
  expect(parseSourceAmount("(1,234.50)", 2, 0)).toBe("-123450");
  expect(parseSourceAmount("2", 0, 6)).toBe("2000000");
  for (const bad of ["1,2", "1,000,00", "1e3", "−20", "", "-", "1.001"])
    expect(parseSourceAmount(bad, 2, 0)).toBeNull();
});

it("uses saved current dates when no prior TB exists, without guessing a calendar year", () => {
  expect(openingAnchorDate(null, "2026-07-01")).toBe("2026-06-30");
  expect(openingAnchorDate(null, "2024-03-01")).toBe("2024-02-29");
  expect(openingAnchorDate("2025-06-30", "2026-07-01")).toBe("2025-06-30");
  expect(openingAnchorDate(null, null)).toBeNull();
});
