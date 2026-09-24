/**
 * personalUploadAuthority.test.ts — PR #32 P-01 and N-05/N-06 (re-review of fc4cbd4).
 *   * process-trial-balance processes a PERSONAL upload (company_id NULL) only for its own uploader (user_id),
 *     refusing everyone else — and a missing row — with one identical 403 before any actor lookup, storage read,
 *     parse, write or disclosure;
 *   * the Edge Functions' path rule is the exact mirror of the database's tbu_path_well_formed (same corpus file,
 *     also asserted against PostgreSQL in scripts/db-proof/uploadLifecycle.mjs).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PROCESSING_FORBIDDEN, personalUploadRefusal } from "../../../supabase/functions/_shared/uploadLifecycle";
import { isWellFormedSourcePath } from "../../../supabase/functions/_shared/sourcePath";
import corpus from "./__fixtures__/sourcePathCorpus.json";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("P-01: a personal upload is processed only for its own uploader", () => {
  it("user A may process A's personal upload (case-insensitive UUID match)", () => {
    expect(personalUploadRefusal(A, A)).toBeNull();
    expect(personalUploadRefusal(A.toUpperCase(), A)).toBeNull();
  });
  it("user B is refused A's upload", () => expect(personalUploadRefusal(A, B)).toBe(PROCESSING_FORBIDDEN));
  it.each([[null], [undefined], [""], ["not-a-uuid"], [42], [{}]])("a NULL / malformed owner %j fails closed", (owner) =>
    expect(personalUploadRefusal(owner, A)).toBe(PROCESSING_FORBIDDEN));
  it.each([[null], [undefined], [""], ["x"]])("a missing / malformed caller %j fails closed", (caller) =>
    expect(personalUploadRefusal(A, caller)).toBe(PROCESSING_FORBIDDEN));
  it("the refusal names no owner, file or existence", () => {
    expect(JSON.stringify(PROCESSING_FORBIDDEN)).not.toMatch(/own|exist|file_path|storage|user_id/i);
  });

  const src = readFileSync(resolve(__dirname, "../../../supabase/functions/process-trial-balance/index.ts"), "utf8");
  const at = (needle: string, from = 0) => { const i = src.indexOf(needle, from); expect(i, needle).toBeGreaterThan(-1); return i; };
  it("the non-existent uploaded_by column is no longer read", () => expect(src).not.toMatch(/upload\.uploaded_by/));
  it("anonymous callers are refused by validateAuth before the row is even read", () => {
    expect(at("await validateAuth(")).toBeLessThan(at('.from("trial_balance_uploads").select("*")'));
    expect(src.slice(at("await validateAuth("), at("await validateAuth(") + 200)).toMatch(/if \(auth\.error\) return auth\.error;/);
  });
  it("a missing row answers the SAME 403 body, not a 500 naming it", () => {
    const read = at('.from("trial_balance_uploads").select("*")');
    const miss = at("if (uploadError || !upload)", read);
    expect(src.slice(miss, miss + 250)).toMatch(/JSON\.stringify\(PROCESSING_FORBIDDEN\)[\s\S]*status: 403/);
    expect(src).not.toMatch(/throw new Error\("Upload not found"\)/);
  });
  it("the personal refusal is the company-less branch of the authorization block, and precedes every later step", () => {
    const branch = at("if (upload.company_id) {");
    const actor = at("resolveProcessingActor(", branch);
    const refusal = at("personalUploadRefusal((upload as { user_id?: unknown }).user_id, userId)");
    expect(refusal).toBeGreaterThan(actor); // the else-branch: no actor lookup happens for a personal upload
    expect(src.slice(refusal, refusal + 250)).toMatch(/status: 403/);
    for (const later of ["processingRefusal(", 'rpc("tbu_upload_source_bound"', '.from("trial_balance_uploads").update(',
      '.from("trial-balance-files").download(', "parseCSV(", "claimIdempotency("]) {
      const i = src.indexOf(later, refusal);
      if (i >= 0) expect(i, later).toBeGreaterThan(refusal);
    }
    expect(src.slice(0, refusal)).not.toMatch(/\.download\(|\.from\("trial_balance_uploads"\)\.update\(/);
  });
  it("workspace uploads keep their unchanged authorization (resolveProcessingActor → 403 with its own message)", () => {
    const actor = at("resolveProcessingActor(");
    expect(src.slice(actor, actor + 600)).toMatch(/You don't have permission to validate trial balances in this workspace\./);
  });
});

describe("N-05 / N-06: the Edge Functions' path rule mirrors the database exactly", () => {
  it.each(corpus.wellFormed.map((p) => [p]))("accepts %j", (p) => expect(isWellFormedSourcePath(p)).toBe(true));
  it.each(corpus.malformed.map((p) => [p]))("refuses %j", (p) => expect(isWellFormedSourcePath(p)).toBe(false));
  it("non-strings are refused", () => { for (const v of [null, undefined, 1, {}]) expect(isWellFormedSourcePath(v)).toBe(false); });
  it("both TypeScript consumers use it; neither keeps a substring '..' check", () => {
    for (const f of ["sourceSweeper.ts", "sourceUpload.ts"]) {
      const s = readFileSync(resolve(__dirname, `../../../supabase/functions/_shared/${f}`), "utf8");
      expect(s, f).toMatch(/isWellFormedSourcePath\(/);
      expect(s, f).not.toMatch(/includes\("\.\."\)/);
    }
  });
  it("the database defines the rule once and the binding functions delegate to it", () => {
    const sql = readFileSync(resolve(__dirname, "../../../supabase/migrations/20260923170000_upload_binding_and_personal_authority.sql"), "utf8");
    for (const fn of ["tbu_path_well_formed", "tbu_personal_source_path", "tbu_workspace_source_path_shape", "tbu_source_path_bound", "tbu_bound_storage_path"]) {
      expect(sql.includes(`CREATE OR REPLACE FUNCTION public.${fn}(`), fn).toBe(true);
    }
    expect(sql).not.toMatch(/position\('\.\.'/);
  });
});
