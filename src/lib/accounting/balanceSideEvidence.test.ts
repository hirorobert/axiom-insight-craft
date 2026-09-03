/**
 * balanceSideEvidence.test.ts — Phase 3 Tier 7.
 *
 * Proves: sign determines only balanceSide, never a nature; requiresReview
 * and confidence are hardcoded, not derived; a zero balance contributes no
 * evidence at all (Design Gate Step 6's conservative adjudication).
 */

import { describe, it, expect } from "vitest";
import { inferBalanceSideEvidence } from "./balanceSideEvidence";

describe("inferBalanceSideEvidence — directional cases", () => {
  it("positive balance -> DEBIT", () => {
    const e = inferBalanceSideEvidence(1000);
    expect(e).not.toBeNull();
    expect(e!.balanceSide).toBe("DEBIT");
  });

  it("negative balance -> CREDIT", () => {
    const e = inferBalanceSideEvidence(-500);
    expect(e).not.toBeNull();
    expect(e!.balanceSide).toBe("CREDIT");
  });

  it("a small positive fractional balance still resolves to DEBIT (no magnitude threshold)", () => {
    expect(inferBalanceSideEvidence(0.01)!.balanceSide).toBe("DEBIT");
  });

  it("a small negative fractional balance still resolves to CREDIT", () => {
    expect(inferBalanceSideEvidence(-0.01)!.balanceSide).toBe("CREDIT");
  });
});

describe("inferBalanceSideEvidence — zero balance (Design Gate Step 6 adjudication)", () => {
  it("returns null for a zero balance -- no directional evidence exists, none is manufactured", () => {
    expect(inferBalanceSideEvidence(0)).toBeNull();
  });
});

describe("inferBalanceSideEvidence — hardcoded provenance fields", () => {
  it("evidenceTier is always exactly 7", () => {
    expect(inferBalanceSideEvidence(100)!.evidenceTier).toBe(7);
    expect(inferBalanceSideEvidence(-100)!.evidenceTier).toBe(7);
  });

  it("confidence is always LOW, never varying with magnitude", () => {
    expect(inferBalanceSideEvidence(1)!.confidence).toBe("LOW");
    expect(inferBalanceSideEvidence(1_000_000_000)!.confidence).toBe("LOW");
  });

  it("requiresReview is always exactly true, hardcoded -- never derived from confidence or magnitude", () => {
    expect(inferBalanceSideEvidence(1)!.requiresReview).toBe(true);
    expect(inferBalanceSideEvidence(-1)!.requiresReview).toBe(true);
  });
});

describe("inferBalanceSideEvidence — reason text never asserts a nature (sign is evidence only)", () => {
  it("debit reason describes the observation only", () => {
    const reason = inferBalanceSideEvidence(100)!.reason;
    expect(reason).toBe("Net debit balance observed.");
    expect(reason.toLowerCase()).not.toMatch(/asset|expense|liability|revenue|equity|income|likely|probably/);
  });

  it("credit reason describes the observation only", () => {
    const reason = inferBalanceSideEvidence(-100)!.reason;
    expect(reason).toBe("Net credit balance observed.");
    expect(reason.toLowerCase()).not.toMatch(/asset|expense|liability|revenue|equity|income|likely|probably/);
  });
});

describe("inferBalanceSideEvidence — jurisdiction neutrality", () => {
  it("the module source contains zero MUSE/Tanzania/TRA/EFDMS/IPSAS operational terms", () => {
    // Mirrors the EFDMS-contamination-scan precedent from
    // process-trial-balance/l5l6Evidence.test.ts -- checked here at the
    // module-under-test's own source, not a separate file, since this
    // module's whole purpose is to be jurisdiction-neutral.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("node:fs");
    const path = require("node:path");
    const source: string = fs.readFileSync(
      path.join(__dirname, "balanceSideEvidence.ts"),
      "utf-8",
    );
    // Strip comments (this file's own doc comments legitimately name MUSE/
    // IPSAS/Tanzania while explaining the exclusion -- only executable code
    // must be checked).
    const codeOnly = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/MUSE|TRA\b|EFDMS|IPSAS|Tanzania/i);
  });
});
