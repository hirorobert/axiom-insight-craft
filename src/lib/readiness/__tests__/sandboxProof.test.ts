import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Audit defect D3: the sandbox runner manufactured a pass from a header-only CSV given twice with dummy metadata.
 * These tests drive the real runner (scripts/acceptance/rfr-v3/run.mjs --sandbox) as a subprocess.
 */
const RUNNER = resolve(__dirname, "../../../../scripts/acceptance/rfr-v3/run.mjs");
const HEAD = "account_id,currency,opening_minor,debit_minor,credit_minor,closing_minor,entry_count\n";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const POSTINGS = "txn_ref,line,date,account_id,currency,debit_minor,credit_minor\nOPEN-1,1,2025-06-30,1020,TZS,1000,0\nOPEN-1,2,2025-06-30,3000,TZS,0,1000\nJE-1,1,2025-08-01,1020,TZS,500,0\nJE-1,2,2025-08-01,5000,TZS,0,500\n";
// 1020: opening 1000, debit 500, 1 entry, closing 1500. 3000: opening -1000. 5000: credit 500, 1 entry, closing -500.
const TIE = HEAD + "1020,TZS,1000,500,0,1500,1\n3000,TZS,-1000,0,0,-1000,0\n5000,TZS,0,0,500,-500,1\n";
const TIE_INDEP = HEAD + "1020,TZS,1000,500,0,1500,1\r\n3000,TZS,-1000,0,0,-1000,0\r\n5000,TZS,0,0,500,-500,1\r\n";
const REALM = "a".repeat(64);

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rfr-sbx-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function manifest(over: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  const f = { "conn.csv": TIE, "indep.csv": TIE_INDEP, "known.csv": POSTINGS, "raw.json": '{"Rows":[]}', ...files };
  for (const [k, v] of Object.entries(f)) writeFileSync(join(dir, k), v);
  const m = {
    environment: "sandbox", realm_sha256: REALM, period_start: "2025-07-01", period_end: "2026-06-30", accounting_method: "Accrual", operator: "Test Operator", pulled_at: "2026-11-01T10:05:00Z",
    connector_file: "conn.csv", independent_export_file: "indep.csv", known_postings_file: "known.csv",
    independent_provenance: { method: "quickbooks_ui_export", produced_by: "Test Operator", produced_at: "2026-11-01T10:20:00Z", report_name: "General Ledger", file_sha256: sha(f["indep.csv"]) },
    recorded_run: { run_id: "run-1", started_at: "2026-11-01T10:00:00Z", finished_at: "2026-11-01T10:05:00Z", realm_sha256: REALM, endpoint: "GeneralLedger", http_status: 200, intuit_tids: ["1-abc-123"], output_sha256: sha(f["conn.csv"]), raw_response_file: "raw.json", raw_response_sha256: sha(f["raw.json"]) },
    ...over,
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
  return join(dir, "manifest.json");
}
const run = (path: string) => {
  const r = spawnSync(process.execPath, [RUNNER, "--sandbox", path], { encoding: "utf8", env: { ...process.env, RFR_REPORT_DIR: dir } });
  return { code: r.status, out: r.stdout + r.stderr };
};
const report = (name: string) => JSON.parse(readFileSync(join(dir, `report.${name}.json`), "utf8"));

describe("sandbox proof: a pass needs independent files, seeded postings and a recorded run", () => {
  it("passes, as LIVE_SANDBOX_PROOF, only with all three", () => {
    const r = run(manifest());
    expect(r.code).toBe(0);
    expect(report("live_sandbox_proof").rows.map((x: { id: string }) => x.id)).toEqual(["C5-parity", "C5-known-postings", "C5-recorded-run"]);
  });
  it("is NOT_RUN (exit 3), reported as export parity, when no run was recorded and the reason is stated", () => {
    const r = run(manifest({ recorded_run: null, access_unavailable_reason: "no authenticated sandbox company is available to this session" }));
    expect(r.code).toBe(3);
    expect(r.out).toContain("NOT_RUN");
    expect(() => report("live_sandbox_proof")).toThrow();
    expect(report("export_parity").sandbox_status).toBe("NOT_RUN");
  });
  it("refuses a missing recorded run with no stated reason", () => {
    expect(run(manifest({ recorded_run: null })).code).toBe(2);
  });
  it("refuses the same header-only CSV twice with dummy metadata (the audited false pass)", () => {
    const m = manifest({ realm_sha256: "x", period_start: "x", period_end: "x", accounting_method: "x", operator: "x", pulled_at: "x" }, { "conn.csv": HEAD, "indep.csv": HEAD });
    const r = run(m);
    expect(r.code).toBe(2);
  });
  it("refuses empty inputs even with valid metadata", () => {
    expect(run(manifest({}, { "conn.csv": HEAD, "indep.csv": HEAD + "\n" })).code).toBe(2);
  });
  it("refuses identical bytes supplied as both sources", () => {
    const r = run(manifest({ independent_provenance: undefined }, { "indep.csv": TIE }));
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/same bytes/);
  });
  it("refuses duplicate account keys", () => {
    expect(run(manifest({}, { "conn.csv": TIE + "1020,TZS,1000,500,0,1500,1\n" })).code).toBe(2);
  });
  it("refuses missing independent provenance and a provenance hash that does not match the file", () => {
    expect(run(manifest({ independent_provenance: undefined })).code).toBe(2);
    const m = JSON.parse(readFileSync(manifest(), "utf8")); m.independent_provenance.file_sha256 = "0".repeat(64);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
    expect(run(join(dir, "manifest.json")).code).toBe(2);
  });
  it("refuses invalid metadata", () => {
    for (const bad of [{ environment: "production" }, { realm_sha256: "abc" }, { period_start: "2026-07-01" }, { accounting_method: "x" }, { operator: "" }, { pulled_at: "2999-01-01T00:00:00Z" }]) {
      expect(run(manifest(bad)).code, JSON.stringify(bad)).toBe(2);
    }
  });
  it("refuses a recorded run whose output is not the file judged, or whose raw response was altered", () => {
    const base = JSON.parse(readFileSync(manifest(), "utf8"));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...base, recorded_run: { ...base.recorded_run, output_sha256: "1".repeat(64) } }));
    expect(run(join(dir, "manifest.json")).code).toBe(2);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ ...base, recorded_run: { ...base.recorded_run, raw_response_sha256: "2".repeat(64) } }));
    expect(run(join(dir, "manifest.json")).code).toBe(2);
  });
  it("fails when the connector disagrees with the independent export", () => {
    const r = run(manifest({}, { "conn.csv": HEAD + "1020,TZS,1000,501,0,1501,1\n3000,TZS,-1000,0,0,-1000,0\n5000,TZS,0,0,500,-500,1\n" }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/1020 debit_minor/);
  });
  it("fails when both sources agree with each other but not with the postings that were seeded", () => {
    const wrong = HEAD + "1020,TZS,1000,900,0,1900,1\n3000,TZS,-1000,0,0,-1000,0\n5000,TZS,0,0,500,-500,1\n";
    const r = run(manifest({}, { "conn.csv": wrong, "indep.csv": wrong.replace(/\n/g, "\r\n") }));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/seeded postings/);
  });
});
