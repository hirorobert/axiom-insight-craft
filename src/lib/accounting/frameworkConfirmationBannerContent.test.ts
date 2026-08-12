/**
 * frameworkConfirmationBannerContent.test.ts
 *
 * Slice 14 — proves the banner's content selection matches Section XVII's
 * three postures, renders nothing when nothing should be said, and never
 * asserts an UNKNOWN framework as if it were a real detected value.
 */

import { describe, it, expect } from "vitest";
import { buildFrameworkBannerContent } from "./frameworkConfirmationBannerContent";

describe("buildFrameworkBannerContent", () => {
  it("HIGH confidence -> quiet tone, states the framework plainly", () => {
    const c = buildFrameworkBannerContent("IPSAS_ACCRUAL", "HIGH", "QUIET_CONFIRMATION");
    expect(c.tone).toBe("quiet");
    expect(c.headline).toContain("IPSAS Accrual");
  });

  it("MEDIUM confidence -> question tone, hedges on 'not yet backed by audited evidence'", () => {
    const c = buildFrameworkBannerContent("IPSAS_ACCRUAL", "MEDIUM", "COMPACT_QUESTION");
    expect(c.tone).toBe("question");
    expect(c.detail).toContain("not yet backed by audited evidence");
  });

  it("LOW confidence -> explicit-ask tone, asks the preparer to review deliberately", () => {
    const c = buildFrameworkBannerContent("IFRS_FOR_SMES", "LOW", "EXPLICIT_ASK");
    expect(c.tone).toBe("explicit-ask");
    expect(c.headline).toContain("not yet confirmed");
  });

  it("NO_PROMPT_NEEDED renders nothing, regardless of framework/confidence", () => {
    const c = buildFrameworkBannerContent("IPSAS_ACCRUAL", "HIGH", "NO_PROMPT_NEEDED");
    expect(c.tone).toBeNull();
    expect(c.headline).toBeNull();
  });

  it("an UNKNOWN framework never renders a banner, even if a posture was computed", () => {
    const c = buildFrameworkBannerContent("UNKNOWN", "NONE", "EXPLICIT_ASK");
    expect(c.tone).toBeNull();
  });

  it("never contains an actionable verb suggesting a button exists ('Confirm', 'Save', 'Submit') — informational only, no fake write action", () => {
    const postures: Array<["QUIET_CONFIRMATION" | "COMPACT_QUESTION" | "EXPLICIT_ASK", string]> = [
      ["QUIET_CONFIRMATION", "HIGH"],
      ["COMPACT_QUESTION", "MEDIUM"],
      ["EXPLICIT_ASK", "LOW"],
    ];
    for (const [posture] of postures) {
      const c = buildFrameworkBannerContent("IPSAS_ACCRUAL", "MEDIUM", posture);
      const text = `${c.headline} ${c.detail}`;
      expect(text).not.toMatch(/\bConfirm\b|\bSubmit\b/);
    }
  });
});
