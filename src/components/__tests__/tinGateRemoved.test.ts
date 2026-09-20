/**
 * tinGateRemoved.test.ts — Phase 1 Slice 2 regression guard
 * (DEFECT-GLOBAL-TIN-GATE-001).
 *
 * No React component-rendering harness exists in this project (confirmed
 * during Slice 4B and Phase 1 Slice 1), so this proves the behavioral claim
 * — SAFISHA upload no longer hard-blocks on a missing TRA TIN — at the
 * source-text boundary, matching the precedent from Slice 1's
 * reportingFrameworkNoDefault.test.ts.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TRIAL_BALANCE_UPLOAD = readFileSync(
  join(__dirname, "../TrialBalanceUpload.tsx"),
  "utf-8",
);
const WORKSPACE_OVERVIEW = readFileSync(
  join(__dirname, "../../pages/workspace/WorkspaceOverview.tsx"),
  "utf-8",
);

function extractFunctionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  // Find the matching closing brace for the function body by bracket depth.
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let i = bodyStart;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(bodyStart, i + 1);
}

describe("TrialBalanceUpload.tsx — TIN no longer blocks upload", () => {
  const startProcessing = extractFunctionBody(
    TRIAL_BALANCE_UPLOAD,
    "const startProcessing = async () => {",
  );

  it("startProcessing does not call isTinMissing at all (the removed gate)", () => {
    expect(startProcessing).not.toMatch(/isTinMissing/);
  });

  it("startProcessing does not early-return with a TIN-related error toast", () => {
    expect(startProcessing).not.toMatch(/TRA TIN.*before uploading/i);
  });

  it("the upload surface carries no tax-registration warning at all: it is a global data surface, and a tax-profile warning belongs to an active tax/filing service", () => {
    expect(TRIAL_BALANCE_UPLOAD).not.toMatch(/TIN not set|TRA TIN|before filing with/i);
    expect(TRIAL_BALANCE_UPLOAD).not.toMatch(/isTinMissing/);
  });
});

describe("WorkspaceOverview.tsx — TIN prompt no longer assumes an upload-time gate", () => {
  it("the tax-profile warning derives from evaluateTaxProfile (service + jurisdiction + missing) and never from an upload", () => {
    const match = WORKSPACE_OVERVIEW.match(/const taxProfile = evaluateTaxProfile\(([\s\S]+?)\);/);
    expect(match).not.toBeNull();
    expect(match![1]).not.toMatch(/hasUpload|upload/);
    expect(WORKSPACE_OVERVIEW).toMatch(/taxProfile\.warn/);
    expect(WORKSPACE_OVERVIEW).not.toMatch(/tinBlocksNextAction/);
  });
});
