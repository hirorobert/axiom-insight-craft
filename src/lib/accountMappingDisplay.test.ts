import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { computedConfidence, confidenceLabel, formatBalance, needsReview } from "./accountMappingDisplay";

describe("account mapping display (NULL means NOT COMPUTED)", () => {
  it("an unscored account has no confidence: never a default figure", () => {
    expect(computedConfidence({})).toBeNull();
    expect(computedConfidence({ confidence: null })).toBeNull();
    expect(computedConfidence({ confidence: Number.NaN })).toBeNull();
    expect(confidenceLabel(computedConfidence({}))).toBe("Not scored");
  });

  it("a computed confidence is shown as computed, including zero", () => {
    expect(computedConfidence({ confidence: 0 })).toBe(0);
    expect(confidenceLabel(0)).toBe("0%");
    expect(confidenceLabel(72)).toBe("72%");
  });

  it("an unscored or low-scored account is routed to review; a scored one at 70 or above is not", () => {
    expect(needsReview({})).toBe(true);
    expect(needsReview({ confidence: 69 })).toBe(true);
    expect(needsReview({ confidence: 70 })).toBe(false);
  });

  it("a balance carries no currency symbol and keeps two decimals", () => {
    expect(formatBalance(1234.5)).toBe("1,234.50");
    expect(formatBalance(-41421.6)).toBe("-41,421.60");
    expect(formatBalance(0)).toBe("0.00");
  });

  it("the modal no longer invents a confidence, a coloured score or a dollar sign", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../components/AccountMappingModal.tsx"), "utf8");
    expect(src).not.toMatch(/confidence\s*\|\|\s*\d/);
    expect(src).not.toMatch(/getConfidenceBadge|getConfidenceColor|<Progress/);
    expect(src).not.toMatch(/Balance:\s*\$\{/);
    expect(src).toContain("computedConfidence(account)");
  });
});
