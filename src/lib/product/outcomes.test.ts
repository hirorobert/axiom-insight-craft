import { describe, expect, it } from "vitest";
import {
  OUTCOME_IDS,
  PRODUCT_OUTCOMES,
  getOutcome,
  isOutcomeId,
  outcomeAuthHref,
} from "./outcomes";

describe("customer outcome architecture", () => {
  it("defines five unique, stable outcome identifiers", () => {
    expect(PRODUCT_OUTCOMES).toHaveLength(5);
    expect(new Set(PRODUCT_OUTCOMES.map((outcome) => outcome.id)).size).toBe(5);
    expect(PRODUCT_OUTCOMES.map((outcome) => outcome.id)).toEqual(OUTCOME_IDS);
  });

  it("keeps internal engine identities outside customer-facing copy", () => {
    const copy = JSON.stringify(PRODUCT_OUTCOMES);
    expect(copy).not.toMatch(/SAFISHA|HESABU|KINGA|MAONO|MUSE/i);
  });

  it("gives every outcome an explicit input, deliverable, scope and availability", () => {
    for (const outcome of PRODUCT_OUTCOMES) {
      expect(outcome.input.length).toBeGreaterThan(8);
      expect(outcome.deliverable.length).toBeGreaterThan(8);
      expect(outcome.scope.length).toBeGreaterThan(2);
      expect(["Workflow available", "Tanzania workflow", "Data dependent"]).toContain(outcome.availability);
    }
  });

  it("fails closed for unknown outcome identifiers", () => {
    expect(isOutcomeId("not-a-real-outcome")).toBe(false);
    expect(getOutcome("not-a-real-outcome")).toBeNull();
    expect(getOutcome(null)).toBeNull();
  });

  it("routes selection through account creation without initiating checkout", () => {
    for (const id of OUTCOME_IDS) {
      const href = outcomeAuthHref(id);
      expect(href).toBe(`/auth?mode=signup&intent=${id}`);
      expect(href).not.toMatch(/checkout|payment|commercial-create-checkout/i);
    }
  });
});
