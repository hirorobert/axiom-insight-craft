/**
 * processingSource.test.ts — findings L-1 / L-2: process-trial-balance's source-download failure path. Classification
 * uses structured fields only; the status restoration is a CHECKED write; no raw Storage or database text is returned.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PROCESSING_UNAVAILABLE, SOURCE_MISSING, classifyDownloadFailure, sourceFailureOutcome } from "../../../supabase/functions/_shared/processingSource";

// Storage errors as the Supabase client surfaces them (StorageApiError / StorageUnknownError shapes).
const NOT_FOUND = { name: "StorageApiError", message: "Object not found", status: 400, statusCode: "404", error: "not_found" };
const NOT_FOUND_404 = { name: "StorageApiError", message: "Object not found", status: 404 };
const NETWORK = { name: "StorageUnknownError", message: "fetch failed: getaddrinfo ENOTFOUND xyz.supabase.co bucket trial-balance-files/u/f.csv", originalError: { name: "TypeError" } };
const TIMEOUT = { name: "StorageUnknownError", message: "The operation was aborted due to timeout" };
const OUTAGE = { name: "StorageApiError", message: "Internal Server Error", status: 503, statusCode: "503", error: "internal" };
const DENIED = { name: "StorageApiError", message: "new row violates row-level security policy", status: 403, statusCode: "403", error: "Unauthorized" };
const PLAN_ENDED = { code: "PT402", message: "ENTITLEMENT_REQUIRED", details: "CLOSE_ASSURANCE", hint: "SOLO" };
const DB_DOWN = { code: "08006", message: "connection to server at \"10.0.0.7\", port 5432 failed: FATAL password authentication failed for user \"postgres\"" };
const RAW = /Object not found|fetch failed|ENOTFOUND|supabase\.co|trial-balance-files|aborted|Internal Server Error|row-level|10\.0\.0\.7|password|postgres/i;

describe("L-2: only a confirmed not-found is source_missing", () => {
  it("classifies from structured fields", () => {
    expect(classifyDownloadFailure(NOT_FOUND)).toBe("missing");
    expect(classifyDownloadFailure(NOT_FOUND_404)).toBe("missing");
    for (const e of [NETWORK, TIMEOUT, OUTAGE, DENIED, null, undefined, {}, { message: "Object not found" }]) expect(classifyDownloadFailure(e)).toBe("unavailable");
  });
});

describe("L-1: the recovery write is checked and decides the answer", () => {
  it("1. confirmed missing object → recovery succeeds → 409 source_missing", () => {
    const o = sourceFailureOutcome(classifyDownloadFailure(NOT_FOUND), null, NOT_FOUND);
    expect(o).toMatchObject({ httpStatus: 409, body: SOURCE_MISSING });
    expect(o.log).toEqual({ classification: "missing", storage_status: "404", restore: "restored", restore_sqlstate: null });
  });
  it("2. transient Storage / network failure → recovery succeeds → processing_unavailable, never source_missing", () => {
    for (const e of [NETWORK, TIMEOUT, OUTAGE, DENIED]) {
      const o = sourceFailureOutcome(classifyDownloadFailure(e), null, e);
      expect(o.httpStatus).toBe(503);
      expect(o.body).toEqual({ ...PROCESSING_UNAVAILABLE });
      expect(o.body.status).not.toBe("source_missing");
    }
  });
  it("3. missing object → the recovery write is refused because the plan ended concurrently → the controlled 402 (fail closed); the classification stays in the log only", () => {
    const o = sourceFailureOutcome(classifyDownloadFailure(NOT_FOUND), PLAN_ENDED, NOT_FOUND);
    expect(o.httpStatus).toBe(402);
    expect(o.body).toEqual({ status: "entitlement_required", error: "Entitlement Required", capability: "CLOSE_ASSURANCE", required_plan: "SOLO",
      message: "Preparing and validating a close needs a current plan. Existing records remain readable." });
    expect(o.log).toMatchObject({ classification: "missing", restore: "failed", restore_sqlstate: "PT402" });
  });
  it("4. transient failure → the recovery write fails for another reason → processing_unavailable (never a claimed restoration)", () => {
    const o = sourceFailureOutcome(classifyDownloadFailure(NETWORK), DB_DOWN, NETWORK);
    expect(o).toMatchObject({ httpStatus: 503, body: PROCESSING_UNAVAILABLE });
    expect(o.log).toMatchObject({ classification: "unavailable", restore: "failed", restore_sqlstate: "08006" });
    const m = sourceFailureOutcome("missing", DB_DOWN, NOT_FOUND);
    expect(m.httpStatus).toBe(503);   // a missing object whose restoration failed is not reported as a clean source_missing
  });
  it("5. no raw Storage or database text appears in any response body or log line", () => {
    for (const d of [NOT_FOUND, NETWORK, TIMEOUT, OUTAGE, DENIED]) for (const r of [null, PLAN_ENDED, DB_DOWN]) {
      const o = sourceFailureOutcome(classifyDownloadFailure(d), r, d);
      expect(JSON.stringify(o.body)).not.toMatch(RAW);
      expect(JSON.stringify(o.log)).not.toMatch(RAW);
    }
  });
});

describe("the handler uses exactly this path, after the entitlement refusal", () => {
  const src = readFileSync(resolve(__dirname, "../../../supabase/functions/process-trial-balance/index.ts"), "utf8");
  it("E2: a download failure writes nothing (no claim precedes the attempt) and the classified outcome decides the response", () => {
    const dl = src.indexOf(".download(upload.file_path)");
    const block = src.slice(dl, dl + 1400);
    expect(block).toMatch(/const classification = classifyDownloadFailure\(downloadError\);/);
    expect(block).toMatch(/sourceFailureOutcome\(classification, null, downloadError\)[\s\S]*status: outcome\.httpStatus/);
    expect(block.slice(0, block.indexOf("status: outcome.httpStatus"))).not.toMatch(/\.update\(|\.rpc\(/);
    expect(src).not.toMatch(/\n\s*await supabase\.from\("trial_balance_uploads"\)\.update\(\{ status: upload\.status \}\)/);
    expect(src).not.toMatch(/JSON\.stringify\(SOURCE_MISSING\)/);
  });
  it("6. the no-plan refusal still comes before any Storage request or status write", () => {
    const check = src.indexOf("await processingEntitlementRefusal(");
    expect(check).toBeGreaterThan(-1);
    expect(src.indexOf(".download(", check)).toBeGreaterThan(check);
    expect(src.slice(src.indexOf("serve(async (req) => {"), check)).not.toMatch(/\.download\(|\.update\(/);
  });
  it("7. the successful processing path after the download is unchanged (parse follows the download)", () => {
    const dl = src.indexOf(".download(upload.file_path)");
    expect(src.indexOf("── STEP 1: Read the source and run the ingestion core", dl)).toBeGreaterThan(dl);
  });
  it("8–9. the forward migration and every applied migration are byte-identical", () => {
    const sha = (f: string) => createHash("sha256").update(readFileSync(resolve(__dirname, "../../../supabase/migrations", f))).digest("hex");
    expect(sha("20260926160000_trial_balance_processing_entitlement_wall.sql")).toBe("d032fb0821210b59937e8f513d5de126fb31bbcffff151a91d459dd33914e868");
    expect(sha("20260925140000_workspace_capability_authorization.sql")).toBe("c26e47f3a78b4fd0d47a5a2fab82a69caf13bfe2344e69687f9b30c13a8e5f9a");
  });
});
