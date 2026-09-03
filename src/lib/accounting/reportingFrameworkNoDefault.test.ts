/**
 * reportingFrameworkNoDefault.test.ts — Phase 1 Slice 1 regression guard.
 *
 * No React component-rendering harness exists in this project (confirmed
 * during Slice 4B — no @testing-library/react dependency), so the two
 * properties that are genuinely about UI initial state (create-company
 * forms starting with no framework selected, and the creation path
 * preserving null rather than coalescing it) are proven here at the
 * source-text boundary: reading the real .tsx files and asserting the
 * specific silent-default patterns that were removed do not exist, and the
 * specific null-preserving patterns that replaced them do. This mirrors the
 * EFDMS-contamination-scan pattern already established in
 * supabase/functions/process-trial-balance/l5l6Evidence.test.ts.
 *
 * The pure-function properties (null -> UNKNOWN/NONE confidence, no adapter
 * silently maps null -> ifrs_for_smes, all four known values round-trip,
 * existing non-null behavior unchanged, unrelated dimensions stay UNKNOWN)
 * are already covered by detectEntityContext.test.ts and
 * frameworkAdapter.test.ts -- not duplicated here.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const COMPANY_MANAGER = readFileSync(
  join(__dirname, "../../components/CompanyManager.tsx"),
  "utf-8",
);
const FIRST_RUN_ENGAGEMENT = readFileSync(
  join(__dirname, "../../components/workspace/FirstRunEngagement.tsx"),
  "utf-8",
);

describe("CompanyManager.tsx — no silent reporting_framework default", () => {
  it("does not initialize form state with the literal default value", () => {
    // This exact literal appeared at all four of the pre-fix silent-default
    // sites (create-dialog init, resetForm, insert payload, update payload
    // all read from the same formData object) -- its absence proves none of
    // them independently reintroduced a hardcoded default.
    expect(COMPANY_MANAGER).not.toMatch(/reporting_framework:\s*"ifrs_for_smes"/);
  });

  it("initializes form state with reporting_framework: null", () => {
    expect(COMPANY_MANAGER).toMatch(/reporting_framework:\s*null/);
  });

  it("does not coalesce the edit-dialog prefill to a fake default", () => {
    expect(COMPANY_MANAGER).not.toMatch(
      /reporting_framework\s*\|\|\s*"ifrs_for_smes"/,
    );
  });

  it("the reporting_framework type is nullable, not a bare string", () => {
    expect(COMPANY_MANAGER).toMatch(/reporting_framework:\s*string \| null/);
  });
});

describe("FirstRunEngagement.tsx — no silent reporting_framework default", () => {
  it("does not initialize the framework selection state with the literal default value", () => {
    expect(FIRST_RUN_ENGAGEMENT).not.toMatch(/useState\(\s*"ifrs_for_smes"\s*\)/);
  });

  it("initializes the framework selection state as null", () => {
    expect(FIRST_RUN_ENGAGEMENT).toMatch(
      /useState<string \| null>\(null\)/,
    );
  });

  it("does not require a framework selection to enable submission (creation must tolerate genuine unknown)", () => {
    const canSubmitMatch = FIRST_RUN_ENGAGEMENT.match(/const canSubmit = ([^;]+);/);
    expect(canSubmitMatch).not.toBeNull();
    expect(canSubmitMatch![1]).not.toMatch(/framework/);
  });

  it("the insert payload passes the framework state through unmodified (no ?? fallback)", () => {
    expect(FIRST_RUN_ENGAGEMENT).not.toMatch(
      /reporting_framework:\s*framework\s*\?\?/,
    );
    expect(FIRST_RUN_ENGAGEMENT).toMatch(/reporting_framework:\s*framework,/);
  });
});
