import { describe, expect, it } from "vitest";
import type { FindingRow, FindingsSummary } from "@/lib/closeReview/findings";
import {
  classifySave, correctionDecision, correctionHref, correctionView, findingReturnHref, parseCorrectionLink, parseFindingKey, parseFocusFinding,
  parsePending, readCorrectionContext, returnStatus, saveCorrection, type CorrectionContext, type CorrectionReaders,
} from "./accountCorrection";

const C = "d7c13682-98f1-4512-9c82-0a187609b5ea";
const UP = "7977ad21-0000-4000-8000-000000000001";
const finding = (o: Partial<FindingRow> = {}): FindingRow => ({
  id: "f1", run_id: "r1", rule_id: "A01", finding_key: "A01:95000", severity: "warning", kind: "risk_indicator", mandatory: false,
  required_resolution: "explanation", account_key: "95000", account_code: "95000", account_name: "Cost of sales", classification: "revenue",
  debit_minor: "1400000", credit_minor: "0", class_side_minor: "-1400000", detail: {}, ...o,
});
const current: FindingsSummary = { state: "current", runId: "r1", currency: "TZS", exponent: 2, generatedAt: "2026-10-26T08:00:00Z", total: 1, unresolved: 1, unresolvedBlocking: 0, ruleStatus: {} };
const ctx = (o: Partial<CorrectionContext> = {}): CorrectionContext => ({
  summary: current, finding: finding(), runUploadId: UP, findingStatus: "open",
  mapping: { classification: "revenue", review_decision_id: "d1" },
  decision: { decision_action: "USER_ACCEPTED_SUGGESTION", created_at: "2026-10-25T17:39:56Z", firm_member_id: "m1", upload_id: UP, reason: null },
  decidedBy: null, ...o,
});

describe("links: bounded, validated, internal only", () => {
  it("parses the server's finding key format for the three account rules only", () => {
    expect(parseFindingKey("A01:95000")).toEqual({ rule: "A01", accountKey: "95000" });
    expect(parseFindingKey("A10:cost of sales")).toEqual({ rule: "A10", accountKey: "cost of sales" });
    for (const bad of [null, "", "T01", "A02:1", "A01", "A01:", "A01: 9", "A01:9 ", "A01:a\u0000b", `A01:${"9".repeat(201)}`, "a01:9"]) expect(parseFindingKey(bad)).toBeNull();
  });
  it("the deep link needs both parameters and the finding must name exactly the account", () => {
    expect(parseCorrectionLink("?account=95000&finding=A01%3A95000")).toEqual({ accountKey: "95000", findingKey: "A01:95000", rule: "A01" });
    expect(parseCorrectionLink("?account=95000")).toBeNull();
    expect(parseCorrectionLink("?finding=A01%3A95000")).toBeNull();
    expect(parseCorrectionLink("?account=94100&finding=A01%3A95000")).toBeNull();
    expect(parseCorrectionLink("?account=https%3A%2F%2Fevil.example&finding=A01%3Ahttps%3A%2F%2Fevil.example")).toEqual(expect.objectContaining({ accountKey: "https://evil.example" }));
  });
  it("hrefs are built from the route identity only, never point elsewhere, and carry the report version", () => {
    const f = finding();
    expect(correctionHref(C, 2026, f, null)).toBe(`/workspace/${C}/2026/trial-balance/review?account=95000&finding=A01%3A95000`);
    expect(correctionHref(C, 2026, f, 3)).toBe(`/workspace/${C}/2026/trial-balance/review?account=95000&finding=A01%3A95000&v=3`);
    // An account key that looks like a URL stays a query value on the same internal path.
    const odd = correctionHref(C, 2026, finding({ finding_key: "A01://evil.example", account_key: "//evil.example" }), null)!;
    expect(odd.startsWith(`/workspace/${C}/2026/trial-balance/review?`)).toBe(true);
    expect(correctionHref("not-a-uuid", 2026, f, null)).toBeNull();
    expect(correctionHref(C, 26, f, null)).toBeNull();
    expect(correctionHref(C, 2026, finding({ rule_id: "T01", finding_key: "T01", account_key: null }), null)).toBeNull();
    expect(correctionHref(C, 2026, finding({ account_key: "94100" }), null)).toBeNull(); // key and account disagree
    expect(findingReturnHref(C, 2026, "A01:95000", null)).toBe(`/workspace/${C}/2026/close/findings?finding=A01%3A95000`);
    expect(findingReturnHref(C, 2026, "T01", null)).toBeNull();
    expect(parseFocusFinding("?finding=A10%3A95000")).toBe("A10:95000");
    expect(parseFocusFinding("?finding=%2F%2Fevil")).toBeNull();
  });
});

describe("the decision is the ordinary manual classification, with a reason and no flags", () => {
  it("cost of sales corrected from revenue: statement and normal side from the class; flags omitted (the server keeps them)", () => {
    const d = correctionDecision({ account_code: "95000", account_name: "Cost of sales" }, "cost_of_goods_sold", "  Cost of goods sold, not revenue  ", "A01:95000");
    expect(d).toEqual({ account_code: "95000", account_name: "Cost of sales", proposal_type: "NONE", decision_action: "USER_MANUAL_CLASSIFICATION",
      statement: "income_statement", classification: "cost_of_goods_sold", line_item: "Cost of sales", normal_balance: "debit",
      reason: "Cost of goods sold, not revenue", source: "close_review_finding:A01:95000" });
    expect(Object.keys(d)).not.toEqual(expect.arrayContaining(["is_cash_account"]));
    for (const k of ["is_cash_account", "is_retained_earnings", "is_payroll_account"]) expect(k in d).toBe(false);
  });
  it("refuses an unknown class and a missing or oversized reason", () => {
    expect(() => correctionDecision({ account_code: "1", account_name: "x" }, "assets" as never, "valid reason", "A01:1")).toThrow();
    expect(() => correctionDecision({ account_code: "1", account_name: "x" }, "revenue", "  ", "A01:1")).toThrow();
    expect(() => correctionDecision({ account_code: "1", account_name: "x" }, "revenue", "x".repeat(501), "A01:1")).toThrow();
  });
});

describe("saving: saved, refused (nothing saved) or unknown (same request id retried)", () => {
  it("classifies the server's answers", () => {
    expect(classifySave(null)).toEqual({ kind: "saved" });
    expect(classifySave({ code: "42501", message: "CAPABILITY_REQUIRED_FOR_CLASSIFICATION_DECISIONS" })).toEqual({ kind: "refused", words: expect.stringMatching(/needs Prepare.*Nothing was saved/) });
    expect(classifySave({ code: "22023", message: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD" })).toEqual({ kind: "refused", words: expect.stringMatching(/already sent/) });
    expect(classifySave({ code: "PGRST301", message: "JWT expired" })).toEqual({ kind: "refused", words: expect.stringMatching(/session has ended/) });
    expect(classifySave({ code: "PT402", message: "x" }).kind).toBe("refused");
    // No code: the request may or may not have reached the database.
    expect(classifySave({ code: "", message: "TypeError: Failed to fetch" })).toEqual({ kind: "unknown" });
    expect(classifySave({ message: "FetchError" })).toEqual({ kind: "unknown" });
    expect(classifySave(null, true)).toEqual({ kind: "unknown" });
  });
  it("calls the one review function with one decision and the caller's request id; a thrown transport error is unknown", async () => {
    const calls: unknown[] = [];
    const ok = await saveCorrection(async (fn, args) => { calls.push([fn, args]); return { data: {}, error: null }; },
      { companyId: C, uploadId: UP, requestId: "11111111-1111-4111-8111-111111111111", decision: correctionDecision({ account_code: "95000", account_name: "Cost of sales" }, "cost_of_goods_sold", "Reason here", "A01:95000") });
    expect(ok.kind).toBe("saved");
    expect(calls).toEqual([["resolve_account_review_batch", expect.objectContaining({ p_company_id: C, p_upload_id: UP, p_client_request_id: "11111111-1111-4111-8111-111111111111", p_decisions: [expect.objectContaining({ classification: "cost_of_goods_sold" })] })]]);
    const lost = await saveCorrection(async () => { throw new TypeError("Failed to fetch"); }, { companyId: C, uploadId: UP, requestId: "r", decision: {} as never });
    expect(lost.kind).toBe("unknown");
  });
  it("a pending save is restored only when it is complete and well formed", () => {
    const good = { requestId: "11111111-1111-4111-8111-111111111111", classification: "cost_of_goods_sold", reason: "Reason here" };
    expect(parsePending(JSON.stringify(good))).toEqual(good);
    for (const bad of [null, "{", JSON.stringify({ ...good, requestId: "x" }), JSON.stringify({ ...good, classification: "x" }), JSON.stringify({ ...good, reason: "" })]) expect(parsePending(bad)).toBeNull();
  });
});

describe("the view comes from the server's answers only", () => {
  const up = { id: UP, status: "complete" };
  it("ready on the current run of the trial balance in use", () => {
    const v = correctionView(ctx(), up);
    expect(v).toEqual(expect.objectContaining({ kind: "ready", savedNotChecked: false }));
  });
  it("a saved class that differs from the checked one, or a decision after the findings, is 'saved, not yet checked'", () => {
    expect(correctionView(ctx({ mapping: { classification: "cost_of_goods_sold", review_decision_id: "d2" } }), up)).toEqual(expect.objectContaining({ kind: "ready", savedNotChecked: true }));
    expect(correctionView(ctx({ decision: { decision_action: "USER_MANUAL_CLASSIFICATION", created_at: "2026-10-26T09:00:00Z", firm_member_id: "m1", upload_id: UP, reason: "r" } }), up))
      .toEqual(expect.objectContaining({ kind: "ready", savedNotChecked: true }));
  });
  it("every other state is named, never shown as ready", () => {
    expect(correctionView(ctx(), { id: UP, status: "processing" }).kind).toBe("checking");
    expect(correctionView(ctx({ summary: { state: "unavailable" } }), up).kind).toBe("unavailable");
    expect(correctionView(ctx({ summary: { state: "no_authority" } }), { id: UP, status: "needs_review" }).kind).toBe("needs_review");
    expect(correctionView(ctx({ summary: { state: "no_authority" } }), up).kind).toBe("no_authority");
    expect(correctionView(ctx({ summary: { state: "stale" } }), up).kind).toBe("findings_out_of_date");
    expect(correctionView(ctx({ summary: { state: "not_generated" } }), up).kind).toBe("findings_out_of_date");
    expect(correctionView(ctx({ runUploadId: "another" }), up).kind).toBe("other_trial_balance");
    expect(correctionView(ctx(), null).kind).toBe("other_trial_balance");
    expect(correctionView(ctx({ finding: null }), up).kind).toBe("not_raised");
  });
  it("reads the finding of THIS link from the current run, its status, the mapping, its decision and who made it", async () => {
    const r: CorrectionReaders = {
      summary: async () => current,
      list: async () => [finding({ id: "a", finding_key: "A10:95000" }), finding({ id: "b" })],
      states: async () => [{ finding_id: "b", status: "explained" }],
      runUpload: async () => UP,
      mapping: async () => ({ classification: "revenue", review_decision_id: "d1" }),
      decision: async () => ctx().decision,
      member: async () => ({ id: "m1", user_id: "u1", role: "owner", invited_email: null }),
    };
    const got = await readCorrectionContext(r, C, 2026, parseCorrectionLink("?account=95000&finding=A01%3A95000")!);
    expect(got.finding?.id).toBe("b");
    expect(got.findingStatus).toBe("explained");
    expect(got.runUploadId).toBe(UP);
    expect(got.decidedBy?.role).toBe("owner");
  });
});

describe("return status after the findings are checked again", () => {
  it("says whether the current check still raises the finding — never that a person resolved it", () => {
    expect(returnStatus("generated", ctx({ finding: null }))).toEqual({ kind: "no_longer_raised", words: expect.stringMatching(/no longer raises/) });
    expect(returnStatus("unchanged", ctx())).toEqual({ kind: "still_raised", words: expect.stringMatching(/still raises.*open/) });
    expect(returnStatus("generated", ctx({ findingStatus: "explained" })).words).toMatch(/explained/);
    expect(returnStatus("no_authority", ctx()).kind).toBe("not_checked");
    expect(returnStatus("forbidden", ctx()).words).toMatch(/needs Prepare/);
    expect(returnStatus("generated", ctx({ summary: { state: "stale" } })).kind).toBe("not_checked");
  });
});
