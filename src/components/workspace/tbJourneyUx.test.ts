// @vitest-environment jsdom
/**
 * Trial-balance journey UX: behaviour changed by the cleanup, driven through real clicks where it is interactive.
 *
 *  - Upload and check: one submission however many times it is clicked in one tick; a failed attempt retried once.
 *  - The card and the classification check state the file-level count, not one account's suggestion text.
 *  - Without review access, no "Resolve account classifications" action that leads nowhere; the step says why.
 *  - Account review: pre-selected suggestions are shown, and the status never claims decisions the reviewer has not made.
 */
import { act, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { click, mount, type Mounted } from "@/lib/workbench/testkit/dom";
import { classificationSummary, deriveTrialBalanceVerdict, distinctSentences, CLASSIFICATION_NEXT } from "@/lib/workspace/trialBalanceVerdict";
import { cardVerdictForAccess, currentTrialBalanceTask, CLASSIFICATION_NEEDS_REVIEW_ACCESS } from "@/lib/workspace/trialBalanceTask";

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.resetModules();
  for (const m of ["@/contexts/AuthContext", "@/hooks/useAuditLog", "@/integrations/supabase/client", "@/lib/ensureFreshSession", "@/lib/workspace/sourceUpload", "@/lib/workspace/processingInvoke", "@/components/safisha/SafishaGate", "@/lib/workspace/requestReprocess"]) vi.doUnmock(m);
});

/** A chainable stand-in for the read the uploader makes when a file is chosen (no earlier upload of that name). */
function readChain(): unknown {
  const result = Promise.resolve({ data: [], error: null });
  const chain: Record<string, unknown> = {};
  for (const k of ["select", "eq", "in", "order", "limit", "maybeSingle"]) chain[k] = () => chain;
  chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => result.then(res, rej);
  return chain;
}

async function mountUploader(upload: () => Promise<{ reservationId: string }>) {
  const uploadWorkspaceSource = vi.fn(upload);
  vi.doMock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
  vi.doMock("@/hooks/useAuditLog", () => ({ useAuditLog: () => ({ logAction: vi.fn() }) }));
  vi.doMock("@/integrations/supabase/client", () => ({ supabase: { from: () => readChain(), rpc: vi.fn() } }));
  vi.doMock("@/lib/ensureFreshSession", () => ({ ensureFreshSession: async () => undefined }));
  vi.doMock("@/lib/workspace/sourceUpload", () => ({ uploadWorkspaceSource, registerWorkspaceUpload: vi.fn(() => new Promise(() => undefined)) }));
  vi.doMock("@/lib/workspace/processingInvoke", () => ({ invokeProcessing: vi.fn(() => new Promise(() => undefined)) }));
  vi.doMock("@/components/safisha/SafishaGate", () => ({ default: () => null }));
  const { TrialBalanceUpload } = await import("../TrialBalanceUpload");
  mounted = mount(createElement(TrialBalanceUpload, { embedded: true, lockedCompanyId: "c1", periodYear: 2025 }));
  const input = mounted.container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(["Account Code,Account Name,Debit,Credit\n1000,Cash,10.00,\n4000,Sales,,10.00\n"], "tb.csv", { type: "text/csv" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  await flush();
  return { uploadWorkspaceSource, primary: () => mounted!.container.querySelector<HTMLButtonElement>('[data-testid="trial-balance-upload-primary"]') };
}

describe("Upload and check: one submission", () => {
  it("five clicks in the same tick start exactly one upload, and the step in progress is announced", async () => {
    const { uploadWorkspaceSource, primary } = await mountUploader(() => new Promise(() => undefined));
    const button = primary()!;
    expect(button.textContent).toContain("Upload and check");
    act(() => { for (let i = 0; i < 5; i++) button.click(); });
    await flush();
    expect(uploadWorkspaceSource).toHaveBeenCalledTimes(1);
    const announced = mounted!.container.querySelector('[data-testid="trial-balance-upload-announcement"]');
    expect(announced?.getAttribute("role")).toBe("status");
    expect(announced?.textContent).toBe("Upload the file: In progress");
  });

  it("after a failed upload, repeated clicks on Try again start exactly one new attempt", async () => {
    let calls = 0;
    const { uploadWorkspaceSource, primary } = await mountUploader(() => (++calls === 1 ? Promise.reject(Object.assign(new Error("network"), { code: "network" })) : new Promise(() => undefined)));
    click(primary()!);
    await flush();
    const retry = primary()!;
    expect(retry.textContent).toContain("Try again");
    expect(mounted!.container.querySelector('[data-testid="trial-balance-upload-error"]')?.getAttribute("role")).toBe("alert");
    act(() => { for (let i = 0; i < 3; i++) retry.click(); });
    await flush();
    expect(uploadWorkspaceSource).toHaveBeenCalledTimes(2);
  });
});

const reviewUpload = {
  id: "up2",
  status: "needs_review",
  processing_result: {
    ingestion: {
      milestones: [
        { id: "read", label: "File read", status: "passed", detail: "5 rows" },
        { id: "classification", label: "Accounts classified", status: "needs_review", detail: "3 of 5 accounts need a reviewer's confirmation" },
      ],
    },
  },
};
const SUGGESTION = "Suggested from the account name — confirm before the trial balance is accepted.";
const reviewReadiness = {
  verdict: "review",
  blocker: SUGGESTION,
  checks: [
    { id: "l1_structure", label: "l1", state: "passed", detail: "" },
    { id: "l2_data_quality", label: "l2", state: "passed", detail: "" },
    { id: "l3_arithmetic", label: "l3", state: "passed", detail: "" },
    { id: "l4_classification", label: "l4", state: "review", detail: `${SUGGESTION} ${SUGGESTION} ${SUGGESTION}` },
  ],
};

describe("classification status is stated for the whole file", () => {
  it("the card's reason and the classification check name the recorded count, not one account's suggestion", () => {
    const v = deriveTrialBalanceVerdict({ upload: reviewUpload, readiness: reviewReadiness, canRetry: true } as never);
    expect(v.reason).toBe(`3 of 5 accounts need a reviewer's confirmation. ${CLASSIFICATION_NEXT}`);
    expect(v.checks.find((c) => c.id === "l4_classification")?.detail).toBe("3 of 5 accounts need a reviewer's confirmation.");
    expect(v.primaryAction?.kind).toBe("review_classifications");
  });
  it("without a recorded count (an earlier engine), the stored text is kept, each sentence once", () => {
    const v = deriveTrialBalanceVerdict({ upload: { ...reviewUpload, processing_result: { ingestion: { milestones: [] } } }, readiness: reviewReadiness, canRetry: true } as never);
    expect(v.reason).toBe(SUGGESTION);
    expect(v.checks.find((c) => c.id === "l4_classification")?.detail).toBe(SUGGESTION);
    expect(distinctSentences("A. B. A. C.")).toBe("A. B. C.");
    expect(classificationSummary([{ id: "classification", label: "x", status: "passed", detail: "5 accounts on reviewed mappings" }])).toBeNull();
  });
});

describe("without review access", () => {
  it("the card offers no action that leads nowhere, and the step says what blocks progress and who can resolve it", () => {
    const v = deriveTrialBalanceVerdict({ upload: reviewUpload, readiness: reviewReadiness, canRetry: true } as never);
    expect(cardVerdictForAccess(v, false).primaryAction).toBeNull();
    expect(cardVerdictForAccess(v, true).primaryAction?.label).toBe("Resolve account classifications");
    const blocked = currentTrialBalanceTask(v, { reviewAccess: false });
    expect(blocked.instruction).toBe(CLASSIFICATION_NEEDS_REVIEW_ACCESS);
    expect(blocked.instruction).not.toMatch(/listed below/);
    expect(currentTrialBalanceTask(v).instruction).toBe("Confirm the classification of the accounts listed below.");
  });
  it("a replace action is never withdrawn (only the review action depends on review access)", () => {
    const replace = { primaryAction: { kind: "replace", label: "Replace with corrected Trial Balance" } };
    expect(cardVerdictForAccess(replace, false)).toBe(replace);
  });
});

async function mountPanel(accounts: { account_code: string; account_name: string; suggested_classification?: string }[], reviewRpc = vi.fn()) {
  vi.doMock("@/integrations/supabase/client", () => ({ supabase: { rpc: reviewRpc, from: () => readChain() } }));
  vi.doMock("@/lib/ensureFreshSession", () => ({ ensureFreshSession: async () => undefined }));
  vi.doMock("@/lib/workspace/requestReprocess", () => ({ requestReprocess: vi.fn() }));
  const { AccountReviewPanel } = await import("../AccountReviewPanel");
  mounted = mount(createElement(AccountReviewPanel, {
    uploadId: "up2", companyId: "c1", userId: "u1", onReprocessed: () => undefined,
    needsReviewAccounts: accounts.map((a) => ({ ...a, debit: 10, credit: 0, balance: 10, reason: "x" })),
  } as never));
  await flush();
  const q = (id: string) => mounted!.container.querySelector(`[data-testid="${id}"]`);
  return { q, text: () => mounted!.container.textContent ?? "" };
}

describe("account review: pre-selected suggestions", () => {
  it("locks same-tick review submissions and reuses the request identity after an uncertain answer", async () => {
    let reject!: (e: Error) => void;
    const rpc = vi.fn().mockImplementationOnce(() => new Promise((_r, no) => { reject = no; })).mockRejectedValue(new Error("answer lost"));
    const { q } = await mountPanel([{ account_code: "1000", account_name: "Cash", suggested_classification: "current_assets" }], rpc);
    act(() => { (q("account-review-save") as HTMLButtonElement).click(); (q("account-review-save") as HTMLButtonElement).click(); });
    await flush(); expect(rpc).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error("answer lost"))); await flush();
    click(q("account-review-save")!); await flush();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[1][1].p_client_request_id).toBe(rpc.mock.calls[0][1].p_client_request_id);
    expect(rpc.mock.calls[1][1].p_decisions).toEqual(rpc.mock.calls[0][1].p_decisions);
  });

  it("when every account starts on a suggestion, they are listed to check, and saving is described truthfully", async () => {
    const { q, text } = await mountPanel([
      { account_code: "1000", account_name: "Cash at bank", suggested_classification: "current_assets" },
      { account_code: "4000", account_name: "Sales revenue", suggested_classification: "revenue" },
    ]);
    expect(text()).toContain("Cash at bank");
    expect(text()).toContain("Sales revenue");
    expect(q("account-review-empty")).toBeNull();
    expect(q("account-review-submission")?.textContent).toBe("2 pre-selected suggestions not yet checked. Saving records them as your decisions.");
    expect(text()).not.toMatch(/All decisions recorded/);
    expect(text()).toContain("2 suggested, not yet checked");
    // Every visible picker is named for its account (the full list is now the default view here).
    expect(mounted!.container.querySelector('[role="combobox"][aria-label="Classification for Cash at bank (1000)"]')).not.toBeNull();
    expect([...mounted!.container.querySelectorAll('[role="combobox"]')].every((c) => !!c.getAttribute("aria-label"))).toBe(true);
  });
  it("an account with no suggestion still leads, one at a time, and the count names what is undecided", async () => {
    const { q, text } = await mountPanel([
      { account_code: "1000", account_name: "Cash at bank", suggested_classification: "current_assets" },
      { account_code: "9100", account_name: "Sundry clearing" },
    ]);
    expect(text()).toContain("Sundry clearing");
    expect(q("account-review-submission")?.textContent).toBe("1 account still need a decision");
    expect((q("account-review-save") as HTMLButtonElement | null)?.disabled).toBe(true);
  });
});

describe("processing ledger: a finished 'Needs review' run (DEFECT-UX-TB-LEDGER-NEEDS-REVIEW-SPINNER-001)", () => {
  const base = { id: "u", file_name: "tb.csv", uploaded_at: "2026-10-18T09:00:00Z", processed_at: "2026-10-18T09:00:30Z" };
  const result = {
    summary: { total_accounts: 5 },
    validation_report: {
      mapping_completeness: { total_accounts: 5, mapped_accounts: 2, needs_review: 3, non_reporting: 0 },
      tb_balance_check: { passed: true, total_debits: 2100, total_credits: 2100, exact: { currency: "TZS", total_debits: "2100.00", total_credits: "2100.00", difference: "0.00" } },
    },
  };
  async function render(upload: Record<string, unknown>) {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { default: Ledger, deriveTrialBalanceSteps } = await import("./TrialBalanceProgressLedger");
    return { html: renderToStaticMarkup(createElement(Ledger, { upload: upload as never })), steps: deriveTrialBalanceSteps(upload as never) };
  }

  it("is terminal: no spinner, no Processing phase or clock; review is attention; unexecuted stages are Not applicable, out of the count", async () => {
    const { html, steps } = await render({ ...base, status: "needs_review", processing_result: result });
    expect(html).not.toContain("animate-spin");
    expect(html).not.toMatch(/Processing ·|elapsed/);
    expect(html).toContain("Needs review ·");
    expect(steps.find((s) => s.key === "classified")?.state).toBe("attention");
    expect(steps.some((s) => s.state === "running" || s.state === "pending")).toBe(false);
    const notApplicable = steps.filter((s) => s.state === "not_applicable");
    expect(notApplicable.map((s) => s.key)).toEqual(["statements", "complete"]);
    expect(html).toContain("Not applicable");
    const done = steps.filter((s) => s.state === "done").length;
    expect(html).toContain(`${done} of ${steps.length - notApplicable.length} processing checks`);
    expect(done).toBe(4);
  });
  it("unchanged: a running check still spins; a complete one is Completed; a failed one has no Not applicable", async () => {
    const running = await render({ ...base, status: "processing", processing_result: null, processed_at: null });
    expect(running.html).toContain("animate-spin");
    expect(running.html).toContain("Processing ·");
    const complete = await render({ ...base, status: "complete", processing_result: { ...result, statements: {}, validation_report: { ...result.validation_report, mapping_completeness: { total_accounts: 5, mapped_accounts: 5, needs_review: 0, non_reporting: 0 } } } });
    expect(complete.html).toContain("Completed · 7 of 7 processing checks");
    const failed = await render({ ...base, status: "blocked", processing_result: { summary: { total_accounts: 5 } } });
    expect(failed.steps.some((s) => s.state === "not_applicable")).toBe(false);
    expect(failed.html).toContain("Failed ·");
  });
});
