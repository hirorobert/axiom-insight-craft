import { describe, expect, it } from "vitest";
import type { FindingRow, FindingsSummary } from "@/lib/closeReview/findings";
import {
  classifySave, correctionDecision, correctionHref, correctionScopeKey, correctionView, findingReturnHref, parseCorrectionLink, parseFindingKey, parseFocusFinding,
  parsePending, parseReviewBatchReceipt, pendingKey, readCorrectionContext, returnStatus, saveCorrection, type CorrectionContext, type CorrectionReaders,
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
  summary: current, finding: finding(), runUploadId: UP, runGeneratedAt: "2026-10-26T08:00:00Z", runExponent: 2, findingStatus: "open",
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

describe("saving: saved only on the canonical receipt; refused (nothing saved); otherwise unknown (same request id retried)", () => {
  const BATCH = "33333333-3333-4333-8333-333333333333";
  const receipt = { batch_id: BATCH, mappings_written: 1, decisions_logged: 1, non_reporting_decisions_recorded: 0, treatments_recorded: 0 };
  const E = { decisions: 1, mappings: 1 };
  it("saved needs the canonical receipt for exactly one decision; a receipt from a version without treatments_recorded also counts", () => {
    expect(classifySave(null, receipt, E)).toEqual({ kind: "saved", batchId: BATCH });
    const { treatments_recorded: _t, ...older } = receipt;
    expect(classifySave(null, older, E)).toEqual({ kind: "saved", batchId: BATCH });
  });
  it("a success without that receipt is NOT saved: absent, malformed, unrelated, incomplete or other counts stay unknown", () => {
    const bad: unknown[] = [null, undefined, "ok", [receipt], {}, { ...receipt, batch_id: "x" }, { ...receipt, batch_id: undefined },
      { ...receipt, decisions_logged: 2 }, { ...receipt, mappings_written: 0 }, { ...receipt, decisions_logged: "1" },
      { ...receipt, non_reporting_decisions_recorded: 1 }, { ...receipt, treatments_recorded: 1 }, { ...receipt, unexpected: true },
      { batch_id: BATCH }, { ...receipt, mappings_written: 1.5 }];
    for (const data of bad) expect(classifySave(null, data, E), JSON.stringify(data)).toEqual({ kind: "unknown" });
    expect(parseReviewBatchReceipt(receipt, { decisions: 2, mappings: 2 })).toBeNull();
  });
  it("classifies refusals (a server code: nothing was saved) and lost answers (no code, or thrown: unknown)", () => {
    expect(classifySave({ code: "42501", message: "CAPABILITY_REQUIRED_FOR_CLASSIFICATION_DECISIONS" }, null, E)).toEqual({ kind: "refused", words: expect.stringMatching(/needs Prepare.*Nothing was saved/) });
    expect(classifySave({ code: "22023", message: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD" }, null, E)).toEqual({ kind: "refused", words: expect.stringMatching(/already sent/) });
    expect(classifySave({ code: "PGRST301", message: "JWT expired" }, null, E)).toEqual({ kind: "refused", words: expect.stringMatching(/session has ended/) });
    expect(classifySave({ code: "PT402", message: "x" }, null, E).kind).toBe("refused");
    // An error is never read as saved, even with a receipt-shaped body beside it.
    expect(classifySave({ code: "", message: "TypeError: Failed to fetch" }, receipt, E)).toEqual({ kind: "unknown" });
    expect(classifySave({ message: "FetchError" }, null, E)).toEqual({ kind: "unknown" });
    expect(classifySave(null, receipt, E, true)).toEqual({ kind: "unknown" });
  });
  it("calls the one review function with one decision and the caller's request id; the receipt decides; a thrown transport error is unknown", async () => {
    const calls: unknown[] = [];
    const decision = correctionDecision({ account_code: "95000", account_name: "Cost of sales" }, "cost_of_goods_sold", "Reason here", "A01:95000");
    const ok = await saveCorrection(async (fn, args) => { calls.push([fn, args]); return { data: receipt, error: null }; },
      { companyId: C, uploadId: UP, requestId: "11111111-1111-4111-8111-111111111111", decision });
    expect(ok).toEqual({ kind: "saved", batchId: BATCH });
    expect(calls).toEqual([["resolve_account_review_batch", expect.objectContaining({ p_company_id: C, p_upload_id: UP, p_client_request_id: "11111111-1111-4111-8111-111111111111", p_decisions: [expect.objectContaining({ classification: "cost_of_goods_sold" })] })]]);
    expect((await saveCorrection(async () => ({ data: null, error: null }), { companyId: C, uploadId: UP, requestId: "r", decision })).kind).toBe("unknown");
    expect((await saveCorrection(async () => { throw new TypeError("Failed to fetch"); }, { companyId: C, uploadId: UP, requestId: "r", decision })).kind).toBe("unknown");
  });
  it("an unproven attempt is restored only for the same actor, trial balance and account (never another person's)", () => {
    const at = { actor: "user-a", uploadId: UP, accountKey: "95000" };
    const good = { ...at, requestId: "11111111-1111-4111-8111-111111111111", classification: "cost_of_goods_sold", reason: "Reason here" };
    expect(parsePending(JSON.stringify(good), at)).toEqual(good);
    expect(pendingKey("user-a", UP, "95000")).not.toBe(pendingKey("user-b", UP, "95000"));
    for (const other of [{ ...at, actor: "user-b" }, { ...at, uploadId: "other" }, { ...at, accountKey: "91510" }]) expect(parsePending(JSON.stringify(good), other)).toBeNull();
    // The previous, actor-less format is never restored.
    expect(parsePending(JSON.stringify({ requestId: good.requestId, classification: good.classification, reason: good.reason }), at)).toBeNull();
    for (const bad of [null, "{", JSON.stringify({ ...good, requestId: "x" }), JSON.stringify({ ...good, classification: "x" }), JSON.stringify({ ...good, reason: "" })]) expect(parsePending(bad, at)).toBeNull();
  });
  it("the scope key separates workspace, year, trial balance, account, finding and actor", () => {
    const base = { companyId: C, periodYear: 2026, uploadId: UP, accountKey: "95000", findingKey: "A01:95000", actor: "u" };
    const keys = new Set([base, { ...base, companyId: "x" }, { ...base, periodYear: 2025 }, { ...base, uploadId: "y" }, { ...base, uploadId: null },
      { ...base, accountKey: "91510" }, { ...base, findingKey: "A10:95000" }, { ...base, actor: "v" }, { ...base, actor: null }].map(correctionScopeKey));
    expect(keys.size).toBe(9);
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
    // No reviewed result now, but the latest run was on this trial balance: it needs a new check (e.g. after a saved correction).
    expect(correctionView(ctx({ summary: { state: "no_authority" } }), up)).toEqual(expect.objectContaining({ kind: "needs_recheck", savedAfterCheck: false }));
    expect(correctionView(ctx({ summary: { state: "no_authority" }, decision: { decision_action: "USER_MANUAL_CLASSIFICATION", created_at: "2026-10-26T09:00:00Z", firm_member_id: "m1", upload_id: UP, reason: "r" } }), up))
      .toEqual(expect.objectContaining({ kind: "needs_recheck", savedAfterCheck: true }));
    expect(correctionView(ctx({ summary: { state: "no_authority" }, finding: null }), up).kind).toBe("no_authority");
    expect(correctionView(ctx({ summary: { state: "no_authority" }, runUploadId: "another" }), up).kind).toBe("no_authority");
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
      latestRun: async () => { throw new Error("not read while a run is current"); },
      mapping: async () => ({ classification: "revenue", review_decision_id: "d1" }),
      decision: async () => ctx().decision,
      member: async () => ({ id: "m1", user_id: "u1", role: "owner", invited_email: null }),
    };
    const got = await readCorrectionContext(r, C, 2026, parseCorrectionLink("?account=95000&finding=A01%3A95000")!);
    expect(got.finding?.id).toBe("b");
    expect(got.findingStatus).toBe("explained");
    expect(got.runUploadId).toBe(UP);
    expect(got.decidedBy?.role).toBe("owner");
    expect(got.runExponent).toBe(2);
  });
  it("with no reviewed result, reads the account from the latest run of the period (its trial balance, time and exponent)", async () => {
    const r: CorrectionReaders = {
      summary: async () => ({ state: "no_authority" }),
      list: async (id) => (id === "r0" ? [finding({ id: "old", run_id: "r0" })] : []),
      states: async () => { throw new Error("no states without a current run"); },
      runUpload: async () => { throw new Error("unused"); },
      latestRun: async () => ({ id: "r0", upload_id: UP, created_at: "2026-10-25T17:40:00Z", exponent: 0 }),
      mapping: async () => ({ classification: "cost_of_goods_sold", review_decision_id: "d2" }),
      decision: async () => ({ decision_action: "USER_MANUAL_CLASSIFICATION", created_at: "2026-10-26T09:00:00Z", firm_member_id: "m1", upload_id: UP, reason: "r" }),
      member: async () => null,
    };
    const got = await readCorrectionContext(r, C, 2026, parseCorrectionLink("?account=95000&finding=A01%3A95000")!);
    expect(got).toEqual(expect.objectContaining({ runUploadId: UP, runGeneratedAt: "2026-10-25T17:40:00Z", runExponent: 0, findingStatus: null }));
    expect(got.finding?.id).toBe("old");
    expect(correctionView(got, { id: UP, status: "complete" })).toEqual(expect.objectContaining({ kind: "needs_recheck", savedAfterCheck: true }));
  });
});

describe("return status after the findings are checked again", () => {
  it("says whether the current check still raises the finding — never that a person resolved it", () => {
    expect(returnStatus("generated", ctx({ finding: null }))).toEqual({ kind: "no_longer_raised", words: expect.stringMatching(/no longer raises/), runId: "r1" });
    expect(returnStatus("unchanged", ctx())).toMatchObject({ kind: "still_raised", words: expect.stringMatching(/still raises.*with the saved classification \(Revenue\).*open/), runId: "r1", usedSaved: true, findingStatus: "open" });
    // The check used an older classification than the saved one: said, and the next step is the re-check, not an explanation.
    const older = returnStatus("generated", ctx({ mapping: { classification: "cost_of_goods_sold", review_decision_id: "d2" } }));
    expect(older).toMatchObject({ kind: "still_raised", usedSaved: false, words: expect.stringMatching(/used Revenue rather than the saved classification \(Cost of Goods Sold\)/) });
    expect(returnStatus("generated", ctx({ mapping: null }))).toMatchObject({ kind: "still_raised", usedSaved: null });
    expect(returnStatus("generated", ctx({ finding: finding({ rule_id: "A03" }) }))).toMatchObject({ remaining: expect.stringMatching(/approved adjustment/) });
    expect(returnStatus("generated", ctx()).kind === "still_raised" && returnStatus("generated", ctx())).toMatchObject({ remaining: expect.stringMatching(/explanation on the finding/) });
    expect(returnStatus("generated", ctx({ findingStatus: "explained" })).words).toMatch(/explained/);
    expect(returnStatus("no_authority", ctx()).kind).toBe("not_checked");
    expect(returnStatus("forbidden", ctx()).words).toMatch(/needs Prepare/);
    expect(returnStatus("generated", ctx({ summary: { state: "stale" } }))).toMatchObject({ kind: "not_checked", words: expect.stringMatching(/changed again after this check/) });
  });
});
