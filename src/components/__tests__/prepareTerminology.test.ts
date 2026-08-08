/**
 * Regression guard: user-facing Prepare/assessment terminology.
 *
 * Fails if deprecated verdict wording reappears in the Prepare/assessment
 * presentation surfaces, and asserts the approved wording is present.
 *
 * Deliberately scoped to user-visible presentation strings. Internal
 * identifiers, enum values, data-verdict values, status-machine keys,
 * backend values and code comments are NOT policed here.
 *
 * Text-level assertions on purpose: immune to unrelated layout changes.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { computePreflight } from "@/lib/workspace/computePreflight";

const SURFACES = [
  "src/components/workspace/TrialBalancePreflight.tsx",
  "src/components/certification/CertificationHeader.tsx",
  "src/components/certification/RecentUploadsList.tsx",
  "src/components/UploadsStatusPanel.tsx",
  "src/lib/workspace/computePreflight.ts",
];

const DEPRECATED = ["Pre-flight certification", "Certification Console", "Not certified"];

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function read(file: string): string {
  return stripComments(readFileSync(path.resolve(process.cwd(), file), "utf8"));
}

describe("Prepare/assessment terminology", () => {
  for (const file of SURFACES) {
    it(`${file} has no deprecated verdict wording`, () => {
      const code = read(file);
      for (const phrase of DEPRECATED) {
        expect(code).not.toContain(phrase);
      }
    });
  }

  it("pre-flight surface uses the approved heading and pass label", () => {
    const code = read("src/components/workspace/TrialBalancePreflight.tsx");
    expect(code).toContain("Pre-flight status");
    expect(code).toContain("Checks passed");
    expect(code).toContain("Checks failed");
    // selector contract preserved
    expect(code).toContain('data-testid="tb-preflight"');
    expect(code).toContain("data-verdict");
  });

  it("trial balance status header uses the approved wording", () => {
    const code = read("src/components/certification/CertificationHeader.tsx");
    expect(code).toContain("Trial balance status");
    expect(code).toContain("Checks passed");
  });

  it("upload list surfaces use the approved pass label", () => {
    for (const file of [
      "src/components/certification/RecentUploadsList.tsx",
      "src/components/UploadsStatusPanel.tsx",
    ]) {
      expect(read(file)).toContain("Checks passed");
    }
  });

  it("computePreflight emits approved user-facing headlines without renaming verdicts", () => {
    const blocked = computePreflight({
      status: "error",
      isValid: false,
      processedAt: null,
      processingResult: null,
      validationReport: null,
      accountingErrors: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(blocked.verdict).toBe("blocked");
    expect(blocked.headline).not.toContain("Not certified");
    expect(blocked.headline).toContain("Checks failed");
  });
});
