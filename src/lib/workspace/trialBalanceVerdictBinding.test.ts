/**
 * Identity binding, failure precedence and fail-closed totals for the trial-balance verdict.
 *
 * The replacement race: the certification read for upload A is in flight when A is replaced by B (or re-processed into
 * a new version). A's result arriving late must never be displayed as B's verdict — not in the reader's state
 * (readinessReducer), not in the readiness projection (computeCertificationReadiness), not in the verdict.
 */
import { describe, expect, it, vi } from "vitest";
import type { PreflightCheck } from "./computePreflight";
import type { TbCertificationRow } from "./computeCertificationReadiness";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
const { readinessReducer, EMPTY_READINESS } = await import("@/hooks/useCertificationReadiness");
const { computeCertificationReadiness } = await import("./computeCertificationReadiness");
const { deriveTrialBalanceVerdict, readTrialBalanceTotals, uploadSubjectKey, CHECK_PRECEDENCE } = await import("./trialBalanceVerdict");

const row = (upload_id: string, is_blocking: boolean): TbCertificationRow => ({
  id: `c-${upload_id}`, sequence_no: 1, company_id: "co", upload_id, period_year: 2025, is_blocking, requires_review: false,
  exceptions: is_blocking ? [{ code: "L3_TB_IMBALANCE", layer: 3, severity: "error", accountCode: null, message: "Debits 12 != Credits 10 (difference: 2)" }] : [],
  certified_at: "2026-09-30T10:00:00Z",
});
const A = { id: "upload-A", version: 3, source_file_hash: "a".repeat(64) };
const B = { id: "upload-B", version: 1, source_file_hash: "b".repeat(64) };
const kA = uploadSubjectKey(A)!, kB = uploadSubjectKey(B)!;

describe("late-result replacement race", () => {
  it("the reader drops A's late result once B is requested, and never shows A's rows while B loads", () => {
    let s = readinessReducer(EMPTY_READINESS, { type: "request", subject: kA });
    s = readinessReducer(s, { type: "request", subject: kB });            // A replaced by B before A's read returned
    expect(s).toMatchObject({ requested: kB, subjectKey: null, latestForUpload: null, authoritative: null, loading: true });
    s = readinessReducer(s, { type: "resolved", subject: kA, uploadId: A.id, reads: { authoritative: null, latestForUpload: row(A.id, true) } });
    expect(s.latestForUpload).toBeNull();                                  // late A result dropped
    expect(s.subjectKey).toBeNull();
    s = readinessReducer(s, { type: "failed", subject: kA });              // a late A failure is dropped too
    expect(s.fetchFailed).toBe(false);
    s = readinessReducer(s, { type: "resolved", subject: kB, uploadId: B.id, reads: { authoritative: null, latestForUpload: row(B.id, false) } });
    expect(s).toMatchObject({ subjectKey: kB, loading: false });
    expect(s.latestForUpload?.upload_id).toBe(B.id);
  });

  it("a re-processed upload (same id, new version/hash) is a new subject: the previous version's rows are cleared at once", () => {
    const A2 = uploadSubjectKey({ ...A, version: 4, source_file_hash: "c".repeat(64) })!;
    let s = readinessReducer(EMPTY_READINESS, { type: "request", subject: kA });
    s = readinessReducer(s, { type: "resolved", subject: kA, uploadId: A.id, reads: { authoritative: null, latestForUpload: row(A.id, true) } });
    s = readinessReducer(s, { type: "request", subject: A2 });
    expect(s).toMatchObject({ subjectKey: null, latestForUpload: null, loading: true });
    // A same-subject refetch keeps the held rows while revalidating (the readiness downgrades "certified" meanwhile).
    const same = readinessReducer(readinessReducer(EMPTY_READINESS, { type: "request", subject: kA }), { type: "resolved", subject: kA, uploadId: A.id, reads: { authoritative: null, latestForUpload: row(A.id, true) } });
    expect(readinessReducer(same, { type: "request", subject: kA })).toMatchObject({ subjectKey: kA, loading: true });
  });

  it("a per-upload row for another upload is refused by the reader and by the readiness projection", () => {
    const s = readinessReducer(readinessReducer(EMPTY_READINESS, { type: "request", subject: kB }), { type: "resolved", subject: kB, uploadId: B.id, reads: { authoritative: null, latestForUpload: row(A.id, true) } });
    expect(s.latestForUpload).toBeNull();
    const r = computeCertificationReadiness({ uploadExists: true, currentUploadId: B.id, authoritative: null, latestForUpload: row(A.id, true) });
    expect(r.verdict).toBe("pending");                                     // never A's "blocked"
  });

  it("the verdict refuses a readiness read for another subject: 'Checking', no checks, no action — never A's Blocked", () => {
    const readiness = computeCertificationReadiness({ uploadExists: true, currentUploadId: A.id, authoritative: null, latestForUpload: row(A.id, true) });
    expect(readiness.verdict).toBe("blocked");
    const onB = deriveTrialBalanceVerdict({ upload: { ...B, status: "blocked" }, readiness, readinessSubject: kA, canRetry: true });
    expect(onB).toMatchObject({ status: "checking", statusLabel: "Checking", primaryAction: null, checks: [], failedCheckId: null });
    const onA = deriveTrialBalanceVerdict({ upload: { ...A, status: "blocked" }, readiness, readinessSubject: kA, canRetry: true });
    expect(onA.status).toBe("blocked");
    const onNewVersionOfA = deriveTrialBalanceVerdict({ upload: { ...A, version: 4, status: "blocked" }, readiness, readinessSubject: kA, canRetry: true });
    expect(onNewVersionOfA.status).toBe("checking");
    // Nothing held yet (readinessSubject null) is also not evidence.
    expect(deriveTrialBalanceVerdict({ upload: { ...B, status: "blocked" }, readiness, readinessSubject: null, canRetry: true }).status).toBe("checking");
  });
});

describe("failure precedence (deterministic)", () => {
  const L = (id: string, state: PreflightCheck["state"]): PreflightCheck => ({ id, label: id, state, detail: `${id} detail` });
  const verdictFor = (checks: PreflightCheck[], verdict: "blocked" | "review" = "blocked") =>
    deriveTrialBalanceVerdict({ upload: { status: verdict === "blocked" ? "blocked" : "needs_review" }, readiness: { verdict, blocker: "reason", checks }, canRetry: true });

  it("checks are ordered by CHECK_PRECEDENCE whatever the input order; the most fundamental failing check is named", () => {
    expect(CHECK_PRECEDENCE).toEqual(["l1_structure", "l2_data_quality", "l3_arithmetic", "l4_classification"]);
    const v = verdictFor([L("l4_classification", "failed"), L("l3_arithmetic", "failed"), L("l2_data_quality", "failed"), L("l1_structure", "passed")]);
    expect(v.checks.map((c) => c.id)).toEqual(CHECK_PRECEDENCE);
    expect(v.failedCheckId).toBe("l2_data_quality");
    expect(v.primaryAction?.kind).toBe("replace");
  });
  it("a failure outranks a review item; with no failure, the first review item is named", () => {
    expect(verdictFor([L("l1_structure", "passed"), L("l2_data_quality", "review"), L("l3_arithmetic", "failed"), L("l4_classification", "passed")]).failedCheckId).toBe("l3_arithmetic");
    expect(verdictFor([L("l1_structure", "passed"), L("l2_data_quality", "passed"), L("l3_arithmetic", "passed"), L("l4_classification", "review")], "review").failedCheckId).toBe("l4_classification");
  });
  it("a classification-only block is resolved by classification decisions, not by a new file", () => {
    const v = verdictFor([L("l1_structure", "passed"), L("l2_data_quality", "passed"), L("l3_arithmetic", "passed"), L("l4_classification", "failed")]);
    expect(v.primaryAction).toEqual({ kind: "review_classifications", label: "Resolve account classifications" });
  });
  it("status precedence: running and engine error win over any certification verdict", () => {
    const blockedReadiness = { verdict: "blocked" as const, blocker: "x", checks: [L("l3_arithmetic", "failed")] };
    expect(deriveTrialBalanceVerdict({ upload: { status: "processing" }, readiness: blockedReadiness, canRetry: true }).status).toBe("processing");
    expect(deriveTrialBalanceVerdict({ upload: { status: "error" }, readiness: blockedReadiness, canRetry: true }).status).toBe("processing_failed");
  });
});

describe("fail-closed tb_balance_check parsing", () => {
  const pr = (tb: unknown) => ({ validation_report: { tb_balance_check: tb } });
  it.each([
    ["missing processing_result", null],
    ["validation_report not an object", { validation_report: "x" }],
    ["tb_balance_check is an array", pr([1, 2])],
    ["debits missing", pr({ total_credits: 1 })],
    ["numeric string refused, never coerced", pr({ total_debits: "10", total_credits: 10 })],
    ["NaN / Infinity", pr({ total_debits: Number.NaN, total_credits: Number.POSITIVE_INFINITY })],
    ["negative total", pr({ total_debits: -1, total_credits: 1 })],
    ["recorded difference inconsistent with the totals", pr({ total_debits: 10, total_credits: 8, difference: 5 })],
    ["recorded difference not a number", pr({ total_debits: 10, total_credits: 8, difference: "2" })],
  ])("%s → NOT COMPUTED (null)", (_label, input) => {
    expect(readTrialBalanceTotals(input)).toBeNull();
  });
  it("valid shapes: a consistent recorded difference (either sign) or an absent one", () => {
    expect(readTrialBalanceTotals(pr({ total_debits: 12.5, total_credits: 10, difference: 2.5 }))).toEqual({ debits: 12.5, credits: 10, difference: 2.5 });
    expect(readTrialBalanceTotals(pr({ total_debits: 10, total_credits: 12.5, difference: 2.5 }))).toEqual({ debits: 10, credits: 12.5, difference: -2.5 });
    expect(readTrialBalanceTotals(pr({ total_debits: 7, total_credits: 7 }))).toEqual({ debits: 7, credits: 7, difference: 0 });
  });
  it("a refused totals block never produces an arithmetic sentence; the certification's own reason is used", () => {
    const v = deriveTrialBalanceVerdict({
      upload: { status: "blocked", processing_result: pr({ total_debits: "10", total_credits: 8 }) },
      readiness: { verdict: "blocked", blocker: "L3_TB_IMBALANCE: the trial balance does not balance", checks: [] }, canRetry: true,
    });
    expect(v.totals).toBeNull();
    expect(v.reason).toBe("the trial balance does not balance");
  });
});
