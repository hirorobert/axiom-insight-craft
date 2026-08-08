/**
 * Regression guard: user-facing Prepare/assessment terminology.
 *
 * Fails if deprecated verdict wording reappears in the Prepare/assessment
 * presentation surfaces, and asserts the approved wording is rendered.
 * Deliberately scoped: internal identifiers, enum values, data-verdict values,
 * backend values and code comments are NOT policed here.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TrialBalancePreflight } from "../workspace/TrialBalancePreflight";
import { CertificationHeader } from "../certification/CertificationHeader";

const SURFACES = [
  "src/components/workspace/TrialBalancePreflight.tsx",
  "src/components/certification/CertificationHeader.tsx",
  "src/components/certification/RecentUploadsList.tsx",
  "src/components/UploadsStatusPanel.tsx",
  "src/lib/workspace/computePreflight.ts",
];

const DEPRECATED = ["Pre-flight certification", "Certification Console", "Not certified"];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("Prepare/assessment terminology", () => {
  for (const file of SURFACES) {
    it(`${file} contains no deprecated verdict wording`, () => {
      const code = stripComments(readFileSync(path.resolve(process.cwd(), file), "utf8"));
      for (const phrase of DEPRECATED) {
        expect(code).not.toContain(phrase);
      }
    });
  }

  it("pre-flight surface renders the approved heading and passed label", () => {
    render(
      <TrialBalancePreflight
        upload={{
          status: "complete",
          is_valid: true,
          processed_at: "2026-01-01T00:00:00Z",
          processing_result: {},
          validation_report: {},
          accounting_errors: [],
        }}
      />,
    );
    expect(screen.getByTestId("tb-preflight")).toBeInTheDocument();
    expect(screen.getByText(/Pre-flight status/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Checks passed/i).length).toBeGreaterThan(0);
  });

  it("trial balance status header renders approved wording for a valid run", () => {
    render(
      <CertificationHeader
        upload={{
          id: "u1",
          file_name: "tb.csv",
          company_name: "Arusha DC",
          status: "complete",
          is_valid: true,
          uploaded_at: "2026-01-01T00:00:00Z",
          processed_at: "2026-01-01T00:00:00Z",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any}
      />,
    );
    expect(screen.getByText(/Trial balance status/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Checks passed/i).length).toBeGreaterThan(0);
  });
});
