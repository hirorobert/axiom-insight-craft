/**
 * CompanyManager.test.ts — static proof that the period/framework contract's "Start corrected
 * engagement" path is pure navigation, never a mutation, and that no in-place "reason unlocks it"
 * escape hatch exists anywhere in the source. No jsdom in this repo's test environment (see
 * vitest.config's `environment: "node"`), so — matching the established pattern for this file's own
 * stateful dialogs (DiscardUploadDialog.test.ts tests only its exported pure functions) — this reads
 * the real source rather than mounting the component, and the companion companyFieldLock.test.ts
 * covers the actual enforcement logic (deriveCompanyFieldLock / guardCompanyFieldChange) directly.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = fs.readFileSync(path.resolve(__dirname, "./CompanyManager.tsx"), "utf8");

function extractFunctionBody(fnName: string): string {
  const start = SRC.indexOf(`const ${fnName} = `);
  expect(start, `${fnName} not found`).toBeGreaterThan(-1);
  // Grab up to the next top-level `const X = (` or `return (` at the same 2-space indent — good
  // enough to isolate one small handler in this file's consistent formatting.
  const rest = SRC.slice(start);
  const end = rest.indexOf("\n  const ", 1);
  return rest.slice(0, end > -1 ? end : 1200);
}

describe("startCorrectedEngagement — pure navigation, never a mutation", () => {
  const body = extractFunctionBody("startCorrectedEngagement");

  it("contains a navigate() call to the workspace route", () => {
    expect(body).toMatch(/navigate\(`\/workspace\/\$\{editingCompany\.id\}\/\$\{year\}`\)/);
  });

  it("never calls a Supabase write primitive — no mutation of companies.reporting_framework or fiscal_year_end, no copy of any derived result", () => {
    expect(body).not.toMatch(/\.update\(|\.insert\(|\.upsert\(|\.delete\(|supabase\.rpc\(/);
  });

  it("never reads or references certifications, drafts, reconciliations or processing status in executable code — nothing is copied from the original engagement", () => {
    const code = body
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/certif|reconcil|processing_result|processing_status|\bdraft\b/i);
  });
});

describe("the period/framework lock has no reason-based override anywhere in this file", () => {
  it("no 'Correct instead' / reason-unlocks-the-field affordance exists", () => {
    expect(SRC).not.toMatch(/Correct instead/);
    expect(SRC).not.toMatch(/CorrectionReason/);
    expect(SRC).not.toMatch(/correctingField/);
  });

  it("guardCompanyFieldChange is called with no reason-shaped argument — TypeScript's own FieldChangeGuardInput type has no such field, so this call site cannot carry one", () => {
    const callSite = SRC.slice(SRC.indexOf("const guard = guardCompanyFieldChange("), SRC.indexOf("if (!guard.allowed)"));
    expect(callSite).not.toMatch(/[Rr]eason/);
  });

  it("the Select controls for reporting_framework and fiscal_year_end are disabled purely from the lock derivation — !frameworkEditable / !fiscalYearEndEditable, both defined as exactly `!fieldLock.locked`", () => {
    expect(SRC).toMatch(/const frameworkEditable = !fieldLock\.locked;/);
    expect(SRC).toMatch(/const fiscalYearEndEditable = !fieldLock\.locked;/);
  });
});

describe("fail-closed default on opening the edit dialog", () => {
  it("handleEdit sets processingCertainty to \"checking\" before the read resolves — never optimistically unlocked", () => {
    const handleEdit = extractFunctionBody("handleEdit");
    expect(handleEdit).toMatch(/setProcessingCertainty\("checking"\)/);
  });

  it("a query error sets \"check_failed\", and a rejected promise (network failure) also sets \"check_failed\" via the second .then() handler — never left silently unlocked", () => {
    const handleEdit = extractFunctionBody("handleEdit");
    expect(handleEdit).toMatch(/setProcessingCertainty\("check_failed"\)/g);
    // Two distinct call sites: the {error} branch and the promise-rejection handler.
    expect(handleEdit.match(/setProcessingCertainty\("check_failed"\)/g)?.length).toBe(2);
  });
});
