import { describe, expect, it } from "vitest";
import {
  OUTCOME_IDS,
  PRODUCT_OUTCOMES,
  getOutcome,
  isOutcomeId,
  outcomeAuthHref,
} from "./outcomes";

describe("customer outcome architecture", () => {
  it("defines six unique, stable outcome identifiers", () => {
    expect(PRODUCT_OUTCOMES).toHaveLength(6);
    expect(new Set(PRODUCT_OUTCOMES.map((outcome) => outcome.id)).size).toBe(6);
    expect(PRODUCT_OUTCOMES.map((outcome) => outcome.id)).toEqual(OUTCOME_IDS);
  });

  it("separates document-driven statement review from data-driven statement preparation", () => {
    const prepare = PRODUCT_OUTCOMES.find((o) => o.id === "prepare-statements");
    const review = PRODUCT_OUTCOMES.find((o) => o.id === "review-statements");
    expect(prepare?.inputKind).toBe("trial_balance");
    expect(review?.inputKind).toBe("financial_statements");
    expect(review?.routeIntent).toBe("review-existing-statements");
    // Ordering: review-statements immediately follows prepare-statements.
    const ids = PRODUCT_OUTCOMES.map((o) => o.id);
    expect(ids.indexOf("review-statements")).toBe(ids.indexOf("prepare-statements") + 1);
  });

  it("gives every outcome an explicit, non-generic CTA label — never the word 'Assess this'", () => {
    for (const outcome of PRODUCT_OUTCOMES) {
      expect(outcome.ctaLabel.length).toBeGreaterThan(3);
      expect(outcome.ctaLabel.toLowerCase()).not.toBe("select");
      expect(outcome.ctaLabel.toLowerCase()).not.toContain("assess this");
    }
    expect(new Set(PRODUCT_OUTCOMES.map((o) => o.ctaLabel)).size).toBe(PRODUCT_OUTCOMES.length);
  });

  it("review-statements states only the formats actually accepted and persisted — no false claim of a supporting-trial-balance capability that does not exist", () => {
    const review = PRODUCT_OUTCOMES.find((o) => o.id === "review-statements")!;
    expect(review.input).toBe("PDF, DOCX, XLSX or iXBRL financial statements");
    expect(review.input).not.toMatch(/supporting/i);
    expect(review.input).not.toMatch(/optional/i);
    expect(review.input).not.toMatch(/trial balance/i);
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
