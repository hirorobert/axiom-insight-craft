/**
 * A REFUSED file (process-trial-balance INGESTION_REFUSED) is a final answer: Blocked, the recorded reason, Replace —
 * never "being confirmed", never a failed check that did not run, never a certification. Launch acceptance F found the
 * over-limit file shown as "Checking · The result is being confirmed" and attributed to an arithmetic failure.
 */
import { describe, expect, it } from "vitest";
import { computeCertificationReadiness } from "./computeCertificationReadiness";
import type { PreflightCheck } from "./computePreflight";
import { REFUSED_BEFORE_CHECKS, deriveTrialBalanceVerdict, refusedFileIssues } from "./trialBalanceVerdict";
import { currentTrialBalanceTask } from "./trialBalanceTask";

const OVER_LIMIT = "The trial balance has more than 2,000 accounts, the most one check can certify today. Nothing from this file was recorded.";
const milestones = (marks: Record<string, string>, detail?: Record<string, string>) =>
  ["read", "columns", "rows", "amounts", "balance", "classification", "recorded"].map((id) => ({
    id, label: id, status: marks[id] ?? "not_reached", ...(detail?.[id] ? { detail: detail[id] } : {}),
  }));
// What the INGESTION_REFUSED branch records on the upload: status blocked, zero accounts, the blocking issues.
const refused = (code: string, message: string, marks: Record<string, string>, detail?: Record<string, string>) => ({
  status: "blocked", statements: null, errors: [{ message }],
  validation_report: { ingestion_check: { passed: false } },
  summary: { total_accounts: 0 },
  ingestion: { issues: [{ code, severity: "blocking", message }], milestones: milestones(marks, detail) },
});
const NEW_RECORD = refused("TOO_MANY_ACCOUNTS", OVER_LIMIT, { read: "failed", recorded: "passed" }, { read: OVER_LIMIT });
// The record written before the milestone correction: every step "passed", then "balance" failed for want of totals.
const LEGACY_RECORD = refused("TOO_MANY_ACCOUNTS", OVER_LIMIT, { read: "passed", columns: "passed", rows: "passed", amounts: "passed", balance: "failed", recorded: "passed" });
const UNREADABLE = refused("MISSING_COLUMN", "No debit and credit columns were found. Use a file with account, debit and credit columns.", { read: "passed", columns: "failed", recorded: "passed" });

// The readiness for an upload with no certification ever committed, computed exactly as the page does.
const pendingReadiness = (processingResult: unknown) => computeCertificationReadiness({
  uploadExists: true, currentUploadId: "u1", authoritative: null, latestForUpload: null, processingResult,
} as Parameters<typeof computeCertificationReadiness>[0]);
const verdictFor = (processingResult: unknown, status = "blocked", readiness: { verdict: PreflightCheck["state"] | string; blocker: string | null; checks: PreflightCheck[] } = pendingReadiness(processingResult)) =>
  deriveTrialBalanceVerdict({
    upload: { id: "u1", version: 2, source_file_hash: "h", status, processing_result: processingResult },
    readiness: readiness as never, canRetry: true,
  });

describe("a refused file is Blocked with its recorded reason", () => {
  it("account limit (current record): Blocked, the named reason, Replace; no check failed or claimed", () => {
    const v = verdictFor(NEW_RECORD);
    expect(v.status).toBe("blocked");
    expect(v.statusLabel).toBe("Blocked");
    expect(v.reason).toBe(OVER_LIMIT);
    expect(v.issues.map((i) => i.code)).toEqual(["TOO_MANY_ACCOUNTS"]);
    expect(v.primaryAction).toEqual({ kind: "replace", label: "Replace with corrected Trial Balance" });
    expect(v.failedCheckId).toBeNull();
    expect(v.checks.length).toBeGreaterThan(0);
    expect(v.checks.every((c) => c.state === "pending" && c.notEvaluated && c.detail === REFUSED_BEFORE_CHECKS)).toBe(true);
    expect(v.balanceStatement).toBeNull();
    expect(v.milestones.find((m) => m.id === "read")).toMatchObject({ status: "failed", detail: OVER_LIMIT });
    expect(currentTrialBalanceTask(v).instruction).toBe("Correct the issue shown below in your file, then replace it.");
    expect(`${v.reason} ${currentTrialBalanceTask(v).instruction}`).not.toMatch(/being confirmed|updates itself|arithmetic/i);
  });

  it("account limit (record written before the correction): no arithmetic attribution, the stale step list is not repeated", () => {
    const v = verdictFor(LEGACY_RECORD);
    expect(v.status).toBe("blocked");
    expect(v.reason).toBe(OVER_LIMIT);
    expect(v.checks.some((c) => c.state === "failed")).toBe(false);
    expect(v.milestones).toEqual([]);
  });

  it("unreadable file (no amount columns): Blocked with the recorded reason and Replace", () => {
    const v = verdictFor(UNREADABLE);
    expect(v.status).toBe("blocked");
    expect(v.reason).toMatch(/No debit and credit columns/);
    expect(v.primaryAction?.kind).toBe("replace");
    expect(v.checks.some((c) => c.state === "failed")).toBe(false);
  });

  it("a re-check whose earlier certification no longer applies (stale) and that was refused is Blocked, not 'Re-check'", () => {
    const stale = { verdict: "stale", blocker: null, checks: pendingReadiness(NEW_RECORD).checks };
    expect(verdictFor(NEW_RECORD, "blocked", stale).status).toBe("blocked");
  });
});

describe("only a refusal is treated as one", () => {
  it("a retry that is running is Processing", () => {
    expect(verdictFor(NEW_RECORD, "validating").status).toBe("processing");
  });
  it("a blocking CERTIFICATION (accounts accepted, certified as blocking) keeps its own Blocked path", () => {
    expect(refusedFileIssues({ ...NEW_RECORD, summary: { total_accounts: 12 } }, "blocked", "blocked")).toBeNull();
    expect(refusedFileIssues(NEW_RECORD, "blocked", "blocked")).toBeNull();
  });
  it("accepted accounts, or an unknown count, are never read as a refusal (NULL is not zero)", () => {
    expect(refusedFileIssues({ ...NEW_RECORD, summary: { total_accounts: 3 } }, "blocked", "pending")).toBeNull();
    expect(refusedFileIssues({ ...NEW_RECORD, summary: {} }, "blocked", "pending")).toBeNull();
  });
  it("a refusal to START a check (no ingestion issues, e.g. a changed dependency) is not a refused file", () => {
    const held = { status: "blocked", statements: null, errors: [{ code: "DEPENDENCY_CHANGED" }], validation_report: {} };
    expect(refusedFileIssues(held, "blocked", "pending")).toBeNull();
    expect(verdictFor(held).status).not.toBe("blocked");
  });
});
