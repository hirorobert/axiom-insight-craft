/**
 * processingEntitlement.test.ts — PR #34 release blocker P-1: processing an existing trial balance needs a current
 * plan, refused with the controlled 402 BEFORE any source binding, Storage access, write, hash, parse or engine run.
 * The database side (authorize_trial_balance_processing and the trg_tbu_processing_wall) is proven on real PostgreSQL
 * in scripts/db-proof/planCapabilities.mjs.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isEntitlementWallError, processingEntitlementRefusal } from "../../../supabase/functions/_shared/paidAction";
import { PROCESSING_FORBIDDEN } from "../../../supabase/functions/_shared/uploadLifecycle";

const USER = "11111111-1111-4111-8111-111111111111";
const UPLOAD = "22222222-2222-4222-8222-222222222222";
const answer = (data: unknown, error: unknown = null) => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const rpc = async (fn: string, args: Record<string, unknown>) => { calls.push([fn, args]); return { data, error }; };
  return { rpc, calls };
};

describe("the refusal contract (the canonical paid-action mapping, no second pricing authority)", () => {
  it("no current plan → HTTP 402, entitlement_required, CLOSE_ASSURANCE, SOLO, the exact message", async () => {
    const a = answer({ allowed: false, code: "ENTITLEMENT_REQUIRED", required_plan: "SOLO", capability: "CLOSE_ASSURANCE" });
    const r = await processingEntitlementRefusal(a.rpc, USER, UPLOAD);
    expect(r).toEqual({ httpStatus: 402, body: { status: "entitlement_required", error: "Entitlement Required", capability: "CLOSE_ASSURANCE", required_plan: "SOLO",
      message: "Preparing and validating a close needs a current plan. Existing records remain readable." } });
    expect(a.calls).toEqual([["authorize_trial_balance_processing", { p_user: USER, p_upload_id: UPLOAD }]]);
  });
  it("a current plan → proceed", async () => {
    expect(await processingEntitlementRefusal(answer({ allowed: true, code: "ALLOWED" }).rpc, USER, UPLOAD)).toBeNull();
  });
  it("anything else fails closed: a transport error or malformed answer never proceeds and never exposes the raw error", async () => {
    const e = await processingEntitlementRefusal(answer(null, { message: "relation does not exist", code: "42P01" }).rpc, USER, UPLOAD);
    expect(e?.httpStatus).toBe(500);
    expect(JSON.stringify(e)).not.toMatch(/relation|42P01/);
    expect((await processingEntitlementRefusal(answer({ allowed: "yes" }).rpc, USER, UPLOAD))?.httpStatus).toBe(500);
    expect((await processingEntitlementRefusal(answer({ allowed: false, code: "WORKSPACE_ACCESS_DENIED" }).rpc, USER, UPLOAD))?.httpStatus).toBe(403);
  });
  it("a database wall refusal is recognised by SQLSTATE only", () => {
    expect(isEntitlementWallError({ code: "PT402", message: "ENTITLEMENT_REQUIRED" })).toBe(true);
    expect(isEntitlementWallError({ code: "42501", message: "PT402" })).toBe(false);
    expect(isEntitlementWallError(null)).toBe(false);
  });
});

describe("static order contract: the refusal precedes every Storage read, binding lookup and processing write", () => {
  const src = readFileSync(resolve(__dirname, "../../../supabase/functions/process-trial-balance/index.ts"), "utf8");
  const at = (needle: string, from = 0) => { const i = src.indexOf(needle, from); expect(i, needle).toBeGreaterThan(-1); return i; };
  const check = at("await processingEntitlementRefusal(");
  it("comes after authentication, the constant-shape row lookup and the caller's authorization", () => {
    expect(at("await validateAuth(")).toBeLessThan(check);
    expect(at('.from("trial_balance_uploads").select("*")')).toBeLessThan(check);
    expect(at("resolveProcessingActor(")).toBeLessThan(check);
    expect(at("personalUploadRefusal((upload as { user_id?: unknown }).user_id, userId)")).toBeLessThan(check);
  });
  it("comes before the lifecycle check, the binding lookup, every write, Storage, hashing, parsing, idempotency and engines", () => {
    // Within the request handler: nothing of these happens between the start of the handler and the refusal.
    const handler = at("serve(async (req) => {");
    const before = src.slice(handler, check);
    for (const step of ["processingRefusal(", 'rpc("tbu_upload_source_bound"', ".update(", ".insert(", ".upsert(", ".storage", ".download(",
      "createSignedUrl", "sha256HexBytes(", "parseCSV(", "parseXLSX(", "claimIdempotency(", "recordEngineRun", 'rpc("commit_tb_certification"']) {
      expect(before.includes(step), `${step} must not precede the entitlement refusal`).toBe(false);
    }
    // ...and each of them that the handler performs comes after it.
    for (const later of ["processingRefusal(", 'rpc("tbu_upload_source_bound"', '.from("trial_balance_uploads").update(', ".download(", "sha256HexBytes(", "claimIdempotency("]) {
      expect(src.indexOf(later, check), later).toBeGreaterThan(check);
    }
  });
  it("its refusal is returned (402 as mapped; a 403 answers with the one constant-shape forbidden body)", () => {
    expect(src.slice(check, check + 500)).toMatch(/if \(noPlan\) \{[\s\S]*noPlan\.httpStatus === 403 \? PROCESSING_FORBIDDEN : noPlan\.body[\s\S]*status: noPlan\.httpStatus/);
    expect(PROCESSING_FORBIDDEN).toEqual({ error: "Forbidden", message: "You don't have permission to process this trial balance." });
  });
  it("the first write is checked: a database wall refusal answers the same 402 before Storage is touched", () => {
    const claim = at('const { error: claimErr } = await supabase.from("trial_balance_uploads").update({ status: "validating" })');
    const wall = at("if (isEntitlementWallError(claimErr))", claim);
    expect(wall).toBeLessThan(at(".download(", claim));
    // No unchecked status claim remains (a bare `await ... update(...)` statement whose error is dropped).
    expect(src).not.toMatch(/\n\s*await supabase\.from\("trial_balance_uploads"\)\.update\(\{ status: "validating" \}\)/);
  });
  it("a missing Storage object (entitled account) is a controlled 409 source_missing, distinct from the 402, and never a raw error", () => {
    const dl = at(".download(upload.file_path)");
    expect(src.slice(dl, dl + 600)).toMatch(/JSON\.stringify\(SOURCE_MISSING\)[\s\S]*status: 409/);
    expect(src).toMatch(/const SOURCE_MISSING = \{ status: "source_missing"/);
    expect(src).not.toMatch(/throw new Error\(`Failed to download file/);
    expect(src).not.toMatch(/error: error instanceof Error \? error\.message/);
  });
});
