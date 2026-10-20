// @vitest-environment jsdom
/**
 * Finding decisions and the imbalance investigation, browser side (20261118100000): nothing pre-selected; a decision is
 * sent only with its explicit confirmation (or explanation and evidence) and a reason; the request carries the finding's
 * identity, the evaluation and the expected revision; one request id per attempt (a lost answer is retried with the
 * same id, a changed decision gets a new one); refusals in words; the investigation lists leads and never a plug.
 * Invented data only.
 */
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations, click, mount, typeInto, type Mounted } from "@/lib/workbench/testkit/dom";
import { FindingDecisionControl } from "@/components/workspace/FindingDecisionControl";
import { ImbalanceInvestigation } from "@/components/workspace/ImbalanceInvestigation";
import { clearingPayload, decidable, readFindingDecisions, revisionKey } from "@/lib/workspace/findingDecisions";
import type { TrialBalanceIssue } from "@/lib/workspace/trialBalanceVerdict";

type Args = Record<string, unknown>;
const U = "00000000-0000-4000-8000-0000000000a1", CERT = "00000000-0000-4000-8000-0000000000c1";
const entity = { code: "ENTITY_NAME_DIFFERS", message: "This file names Invented Beta Trading.", rows: [1], kind: "needs_confirmation", subject: "invented beta trading", fileEntity: "Invented Beta Trading", decisionRequired: true } as TrialBalanceIssue & { code: "ENTITY_NAME_DIFFERS"; subject: string };
const clearing = { code: "CLEARING_ACCOUNT_BALANCE", message: "1190 Cash in transit has a balance.", rows: [9], kind: "review", subject: "code:1190", accountCode: "1190", decisionRequired: false } as TrialBalanceIssue & { code: "CLEARING_ACCOUNT_BALANCE"; subject: string };
const flush = async () => { await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); }); };
const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid=${id}]`) as HTMLElement | null;

describe("findingDecisions helpers", () => {
  it("only a decision-taking finding WITH the engine's identity is decidable (an older result has none)", () => {
    expect(decidable(entity)).toBe(true);
    expect(decidable({ ...entity, subject: undefined })).toBe(false);
    expect(decidable({ ...entity, code: "TRIAL_BALANCE_IMBALANCE" })).toBe(false);
  });
  it("a clearing explanation needs a nature, 10+ characters, an evidence kind and a 3+ character reference", () => {
    expect(clearingPayload(null, "Deposit banked 31 Dec", "document", "Bank stmt")).toBeNull();
    expect(clearingPayload("in_transit", "short", "document", "Bank stmt")).toBeNull();
    expect(clearingPayload("in_transit", "Deposit banked 31 Dec", null, "Bank stmt")).toBeNull();
    expect(clearingPayload("in_transit", "Deposit banked 31 Dec", "document", "ab")).toBeNull();
    expect(clearingPayload("in_transit", " Deposit banked 31 Dec ", "document", " Bank stmt ")).toEqual({ nature: "in_transit", explanation: "Deposit banked 31 Dec", evidence: { kind: "document", reference: "Bank stmt" } });
  });
  it("the decisions read is strict; anything else is unavailable", async () => {
    const ok = await readFindingDecisions(async () => ({ data: { outcome: "ok", decisions: [{ decision_id: "d", code: "ENTITY_NAME_DIFFERS", subject: "s", action: "same_entity", resolves: true, revision: 2, reason: "r", created_at: "t" }],
      latest_revisions: [{ code: "ENTITY_NAME_DIFFERS", subject: "s", revision: 3 }] }, error: null }), U);
    expect(ok).toMatchObject({ kind: "ok", decisions: [{ decisionId: "d", revision: 2, resolves: true }] });
    expect(ok.kind === "ok" && ok.latest.get(revisionKey("ENTITY_NAME_DIFFERS", "s"))).toBe(3);
    expect(await readFindingDecisions(async () => ({ data: { outcome: "not_found" }, error: null }), U)).toEqual({ kind: "unavailable" });
  });
});

describe("FindingDecisionControl", () => {
  let m: Mounted | null = null;
  afterEach(() => { m?.unmount(); m = null; });
  const render = (issue: typeof entity | typeof clearing, rpc: (f: string, a: Args) => Promise<{ data: unknown; error: unknown }>, onRecorded = vi.fn(), current?: Parameters<typeof FindingDecisionControl>[0]["current"], expectedRevision = current?.revision ?? 0) => {
    m = mount(createElement(MemoryRouter, null, createElement(FindingDecisionControl, {
      issue, uploadId: U, certificationId: CERT, current, expectedRevision, workspaceEntity: "Invented Alpha Ltd", reconcileHref: "/workspace/c/2025/reconcile", rpc, onRecorded,
    })));
    return m.container;
  };

  it("each finding says whether it must be decided: the entity holds acceptance; a clearing balance is optional by default", () => {
    let el = render(entity, vi.fn());
    expect(q(el, "decision-requirement-ENTITY_NAME_DIFFERS")!.textContent).toBe("Needed before this trial balance can be accepted.");
    m!.unmount(); m = null;
    el = render(clearing, vi.fn());
    expect(q(el, "decision-requirement-CLEARING_ACCOUNT_BALANCE")!.textContent).toMatch(/^Optional/);
  });
  it("after a context change the next decision is sent against the latest recorded revision, not the (absent) current one", async () => {
    const rpc = vi.fn(async (_f: string, _a: Args) => ({ data: { outcome: "recorded", decision_id: "d9", revision: 3 }, error: null }));
    const el = render(entity, rpc, vi.fn(), undefined, 2);
    click(q(el, "decision-open-ENTITY_NAME_DIFFERS")!);
    click(q(el, "decision-choice-same_entity")!); click(q(el, "decision-confirm")!);
    typeInto(q(el, "decision-reason") as HTMLTextAreaElement, "Re-confirmed after the rename");
    click(q(el, "decision-record")!); await flush();
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_expected_revision: 2 });
  });
  it("entity: nothing pre-selected; Record is disabled until a choice, its confirmation and a reason; the request names the finding", async () => {
    const rpc = vi.fn(async (_f: string, _a: Args) => ({ data: { outcome: "recorded", decision_id: "d1", revision: 1 }, error: null }));
    const onRecorded = vi.fn();
    const el = render(entity, rpc, onRecorded);
    click(q(el, "decision-open-ENTITY_NAME_DIFFERS")!);
    const record = () => q(el, "decision-record") as HTMLButtonElement;
    expect((q(el, "decision-choice-same_entity") as HTMLInputElement).checked).toBe(false);
    expect((q(el, "decision-choice-different_entity") as HTMLInputElement).checked).toBe(false);
    expect(record().disabled).toBe(true);
    click(q(el, "decision-choice-same_entity")!);
    expect(record().disabled).toBe(true);
    click(q(el, "decision-confirm")!);
    expect(record().disabled).toBe(true);
    typeInto(q(el, "decision-reason") as HTMLTextAreaElement, "Trading name of the same company");
    expect(record().disabled).toBe(false);
    expect(q(el, "decision-form-ENTITY_NAME_DIFFERS")!.textContent).toContain("I confirm “Invented Beta Trading” is Invented Alpha Ltd.");
    expect(await axeViolations(el)).toEqual([]);
    click(record()); await flush();
    expect(rpc).toHaveBeenCalledWith("record_tb_finding_decision", expect.objectContaining({
      p_upload_id: U, p_certification_id: CERT, p_code: "ENTITY_NAME_DIFFERS", p_subject: "invented beta trading", p_action: "same_entity",
      p_payload: { confirmed: true, file_entity: "Invented Beta Trading", workspace_entity: "Invented Alpha Ltd" },
      p_reason: "Trading name of the same company", p_expected_revision: 0,
    }));
    expect(onRecorded).toHaveBeenCalledTimes(1);
    expect(q(el, "decision-recorded-ENTITY_NAME_DIFFERS")!.textContent).toContain("being checked again");
  });

  it("a lost answer keeps the request id (no double record); a refusal is said in words and a new attempt gets a new id", async () => {
    const calls: Args[] = [];
    let mode: "throw" | "refuse" = "throw";
    const rpc = vi.fn(async (_f: string, a: Args) => { calls.push(a); if (mode === "throw") return { data: null, error: { message: "network" } }; return { data: { outcome: "refused", code: "STALE_EVALUATION" }, error: null }; });
    const el = render(entity, rpc);
    click(q(el, "decision-open-ENTITY_NAME_DIFFERS")!);
    click(q(el, "decision-choice-same_entity")!); click(q(el, "decision-confirm")!);
    typeInto(q(el, "decision-reason") as HTMLTextAreaElement, "Same company");
    click(q(el, "decision-record")!); await flush();
    expect(q(el, "decision-error")!.textContent).toContain("will not be recorded twice");
    mode = "refuse";
    click(q(el, "decision-record")!); await flush();
    expect(calls[1].p_request_id).toBe(calls[0].p_request_id);
    expect(q(el, "decision-error")!.textContent).toContain("replaced by a newer check");
    click(q(el, "decision-record")!); await flush();
    expect(calls[2].p_request_id).not.toBe(calls[1].p_request_id);
  });

  it("an existing decision is shown with Change decision, and a change is sent against its revision", async () => {
    const rpc = vi.fn(async (_f: string, _a: Args) => ({ data: { outcome: "recorded", decision_id: "d2", revision: 2 }, error: null }));
    const el = render(entity, rpc, vi.fn(), { decisionId: "d1", code: "ENTITY_NAME_DIFFERS", subject: "invented beta trading", action: "same_entity", resolves: true, revision: 1, reason: "r", createdAt: "t" });
    expect(q(el, "decision-current-ENTITY_NAME_DIFFERS")!.textContent).toBe("Decided: Same entity.");
    expect(q(el, "decision-open-ENTITY_NAME_DIFFERS")!.textContent).toBe("Change decision");
    click(q(el, "decision-open-ENTITY_NAME_DIFFERS")!);
    click(q(el, "decision-choice-different_entity")!); click(q(el, "decision-confirm")!);
    typeInto(q(el, "decision-reason") as HTMLTextAreaElement, "Belongs to a sister company");
    click(q(el, "decision-record")!); await flush();
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_action: "different_entity", p_expected_revision: 1 });
  });

  it("a recorded explanation is shown as an explanation with a recorded reference, never as a matched transaction", () => {
    const el = render(clearing, vi.fn(), vi.fn(), { decisionId: "d4", code: "CLEARING_ACCOUNT_BALANCE", subject: "code:1190", action: "explained", resolves: true, revision: 1, reason: "r", createdAt: "t" });
    expect(q(el, "decision-current-CLEARING_ACCOUNT_BALANCE")!.textContent).toMatch(/a reference you recorded, not a matched bank transaction/);
  });

  it("clearing: explanation and evidence are required, the Reconcile link is offered for a reconciliation, and the balance is never changed", async () => {
    const rpc = vi.fn(async (_f: string, _a: Args) => ({ data: { outcome: "recorded", decision_id: "d3", revision: 1 }, error: null }));
    const el = render(clearing, rpc);
    click(q(el, "decision-open-CLEARING_ACCOUNT_BALANCE")!);
    const record = () => q(el, "decision-record") as HTMLButtonElement;
    click(q(el, "decision-nature-in_transit")!);
    typeInto(q(el, "decision-explanation") as HTMLTextAreaElement, "Deposit of 31 December cleared on 2 January");
    click(q(el, "decision-evidence-reconciliation")!);
    expect(el.querySelector("a[href='/workspace/c/2025/reconcile']")).not.toBeNull();
    typeInto(q(el, "decision-reason") as HTMLTextAreaElement, "Period-end deposit");
    expect(record().disabled).toBe(true); // no reference yet
    typeInto(q(el, "decision-reference") as HTMLInputElement, "Bank reconciliation December");
    expect(record().disabled).toBe(false);
    // A recorded reference is said to be what it is: not a matched bank transaction, not a checked document.
    expect(q(el, "decision-reference-hint")!.textContent).toMatch(/not matched to a bank transaction/);
    expect((q(el, "decision-reference") as HTMLInputElement).getAttribute("aria-describedby")).toBe(q(el, "decision-reference-hint")!.id);
    expect(await axeViolations(el)).toEqual([]);
    click(record()); await flush();
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_action: "explained", p_payload: { nature: "in_transit", evidence: { kind: "reconciliation", reference: "Bank reconciliation December" } } });
    expect(JSON.stringify(rpc.mock.calls[0][1])).not.toMatch(/amount|adjust/i);
  });
});

const invResult = (extra: Record<string, unknown> = {}) => ({ format: "tb-investigation/2" as const, currency: "TZS", exponent: 2, difference: "120.00", larger: "debits" as const, more: 0,
  read: { debit: "2,020.25", credit: "1,900.25" }, printed: [], cause: "no_printed_totals" as const,
  causeText: "The file has no printed totals to compare with, so the leads below are the evidence available.",
  leads: [{ kind: "amount_equals_difference", rows: [4], check: "An amount of 120.00 — the whole difference — is on this row." }],
  row_count: 3, included_count: 2, excluded_count: 1,
  statement: "These are leads in this file to check against your accounting system, not conclusions.", ...extra });
const invRow = (n: number, included: boolean, extra: Args = {}) => ({ ordinal: n, row_number: n + 2, included, disposition: included ? "account" : "blank",
  account_code: included ? `10${n}0` : null, account_name: included ? `Invented ${n}` : null, debit_minor: included ? "12000" : null, credit_minor: null,
  reason: included ? null : "no account and no amounts", ...extra });

describe("ImbalanceInvestigation", () => {
  let m: Mounted | null = null;
  afterEach(() => { m?.unmount(); m = null; });
  it("shows the read and printed totals, the labelled possible cause, and every stored row page by page — filtered, keyset-paged, never re-investigated", async () => {
    const result = invResult({ printed: [{ row: 9, debit: "1,900.25", credit: "1,900.25" }], cause: "reading_differs_from_printed_totals",
      causeText: "The file's printed totals on row 9 are not what the rows read add up to." });
    const investigate = vi.fn(async () => ({ kind: "ok", value: { status: "completed", investigationId: "inv1", result } }) as never);
    const rpc = vi.fn(async (_f: string, a: Args) => {
      if (a.p_filter === "excluded") return { data: { outcome: "ok", rows: [invRow(3, false)], next_after: null, total: 1 }, error: null };
      return a.p_after === 0
        ? { data: { outcome: "ok", rows: [invRow(1, true), invRow(2, true)], next_after: 2, total: 3 }, error: null }
        : { data: { outcome: "ok", rows: [invRow(3, false)], next_after: null, total: 3 }, error: null };
    });
    m = mount(createElement(ImbalanceInvestigation, { client: { investigate }, uploadId: U, certificationId: CERT, rpc }));
    const el = m.container;
    click(q(el, "investigation-run")!); await flush();
    expect(q(el, "investigation-totals")!.textContent).toMatch(/Rows read as accounts2,020\.251,900\.25/);
    expect(q(el, "investigation-totals")!.textContent).toContain("Printed totals (row 9)");
    expect(q(el, "investigation-cause")!.dataset.cause).toBe("reading_differs_from_printed_totals");
    expect(q(el, "investigation-cause")!.textContent).toMatch(/^Possible cause:/);
    expect(rpc).toHaveBeenLastCalledWith("get_tb_investigation_rows", { p_investigation_id: "inv1", p_filter: "all", p_after: 0, p_limit: 50 });
    expect(q(el, "investigation-row-3")!.textContent).toMatch(/1010 Invented 1120\.00/);
    expect(q(el, "investigation-rows-count")!.textContent).toBe("Showing 2 of 3.");
    click(q(el, "investigation-rows-more")!); await flush();
    expect(rpc).toHaveBeenLastCalledWith("get_tb_investigation_rows", expect.objectContaining({ p_filter: "all", p_after: 2 }));
    expect(q(el, "investigation-row-5")!.textContent).toContain("Excluded — no account and no amounts");
    expect(q(el, "investigation-rows-count")!.textContent).toBe("Showing 3 of 3.");
    expect(q(el, "investigation-rows-more")).toBeNull();
    click(q(el, "investigation-filter-excluded")!); await flush();
    expect(rpc).toHaveBeenLastCalledWith("get_tb_investigation_rows", expect.objectContaining({ p_filter: "excluded", p_after: 0 }));
    expect(el.querySelectorAll('[data-testid^="investigation-row-"][data-included]').length).toBe(1);
    expect(investigate).toHaveBeenCalledTimes(1);
    expect(el.textContent).not.toMatch(/plug|suspense entry|ledger is (out of balance|unbalanced)/i);
    expect(await axeViolations(el)).toEqual([]);
  });
  it("a failed page read says so and leaves the findings unchanged; a malformed page is never shown in part", async () => {
    const investigate = vi.fn(async () => ({ kind: "ok", value: { status: "completed", investigationId: "inv1", result: invResult() } }) as never);
    const rpc = vi.fn(async () => ({ data: { outcome: "ok", rows: [invRow(1, true, { debit_minor: "12.5" })], next_after: null, total: 1 }, error: null }));
    m = mount(createElement(ImbalanceInvestigation, { client: { investigate }, uploadId: U, certificationId: CERT, rpc }));
    click(q(m.container, "investigation-run")!); await flush();
    expect(q(m.container, "investigation-rows-error")).not.toBeNull();
    expect(m.container.querySelectorAll('[data-testid^="investigation-row-"][data-included]').length).toBe(0);
    expect(q(m.container, "investigation-cause")!.textContent).toContain("No printed totals");
  });
  it("one request for the result on screen; leads by row with the file-not-ledger statement; in-progress and errors in words", async () => {
    const result = invResult();
    let answer: unknown = { kind: "ok", value: { status: "in_progress", investigationId: "i1" } };
    const investigate = vi.fn(async () => answer as never);
    m = mount(createElement(ImbalanceInvestigation, { client: { investigate }, uploadId: U, certificationId: CERT }));
    const el = m.container;
    click(q(el, "investigation-run")!); await flush();
    expect(q(el, "investigation-busy")).not.toBeNull();
    answer = { kind: "ok", value: { status: "completed", investigationId: "i1", result } };
    click(q(el, "investigation-run")!); await flush();
    expect(investigate.mock.calls[0]).toEqual([U, CERT, expect.any(String)]);
    expect(investigate.mock.calls[1][2]).toBe(investigate.mock.calls[0][2]);
    expect(q(el, "investigation-leads")!.textContent).toContain("Row 4.");
    expect(q(el, "investigation-statement")!.textContent).toContain("not conclusions");
    expect(el.textContent).not.toMatch(/plug|suspense entry/i);
    expect(await axeViolations(el)).toEqual([]);
  });
});

describe("evaluationCertification", () => {
  it("an accepted result's decisions bind to the authoritative certification when it is this upload's; otherwise the upload's latest; never another upload's", async () => {
    const { evaluationCertification } = await import("@/lib/workspace/findingDecisions");
    const auth = { id: "c-auth", upload_id: "u1" }, latest = { id: "c-latest", upload_id: "u1" }, other = { id: "c-other", upload_id: "u2" };
    expect(evaluationCertification({ authoritative: auth, latestForUpload: null }, "u1")).toBe(auth);
    expect(evaluationCertification({ authoritative: other, latestForUpload: latest }, "u1")).toBe(latest);
    expect(evaluationCertification({ authoritative: null, latestForUpload: latest }, "u1")).toBe(latest);
    expect(evaluationCertification({ authoritative: other, latestForUpload: null }, "u1")).toBeNull();
    expect(evaluationCertification({ authoritative: auth, latestForUpload: latest }, null)).toBeNull();
  });
});
