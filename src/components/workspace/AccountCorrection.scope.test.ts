// @vitest-environment jsdom
/**
 * Scope ownership of the account correction (review of #202, 26 Oct 2026): every asynchronous read, save and check is
 * owned by one scope (workspace, year, trial balance, account, finding, signed-in actor). A completion that belongs to
 * an earlier scope may not update the view, clear a draft, or start another read or check. "Saved" needs the server's
 * canonical receipt, and an unproven attempt is resent only by the same actor, as the same request.
 * Fake transport only: no network, no hosted data.
 */
import { act, createElement as h } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AccountCorrection, type AccountCorrectionProps } from "./AccountCorrection";
import { click, mount, typeInto, type Mounted } from "@/lib/workbench/testkit/dom";
import { pendingKey } from "@/lib/workspace/accountCorrection";

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const UP = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";
const BATCH = "33333333-3333-4333-8333-333333333333";
const RECEIPT = { batch_id: BATCH, mappings_written: 1, decisions_logged: 1, non_reporting_decisions_recorded: 0, treatments_recorded: 0 };
type Resp = { data: unknown; error: { code?: string; message?: string } | null };

function world() {
  const calls = { mapping: [] as string[], refresh: 0, rpc: [] as Record<string, unknown>[], uploadStatus: 0 };
  let saved: string | null = null; // the classification the fake server holds for the account last written
  const row = (code: string) => ({ id: `f${code}`, run_id: "run", rule_id: "A01", finding_key: `A01:${code}`, severity: "warning", kind: "risk_indicator",
    mandatory: false, required_resolution: "explanation", account_key: code, account_code: code, account_name: `Account ${code}`, classification: "revenue",
    debit_minor: "1400000", credit_minor: "0", class_side_minor: "-1400000", detail: {} });
  const props = (code: string, rpc: AccountCorrectionProps["rpc"], o: Partial<AccountCorrectionProps> = {}): AccountCorrectionProps => ({
    companyId: C, periodYear: 2025, link: { accountKey: code, findingKey: `A01:${code}`, rule: "A01" }, reportVersion: null,
    upload: { id: UP, status: "complete" }, canCorrect: true, currentUserId: "user-a",
    findings: {
      summary: async () => ({ state: "current", runId: "run", currency: "TZS", exponent: 2, generatedAt: "2026-10-26T08:00:00Z", total: 1, unresolved: 1, unresolvedBlocking: 0, ruleStatus: {} }),
      list: async () => [row(code)], states: async () => [], refresh: async () => { calls.refresh++; return { outcome: "generated" }; },
    } as never,
    readers: {
      runUpload: async () => UP, latestRun: async () => null,
      mapping: async (_c, k) => { calls.mapping.push(k); return { classification: saved ?? "revenue", review_decision_id: null }; },
      decision: async () => null, member: async () => null, uploadStatus: async () => { calls.uploadStatus++; return "complete"; },
    },
    rpc, startCheck: async () => {}, onUploadChanged: () => {}, ...o,
  });
  return { calls, props, setSaved: (v: string | null) => { saved = v; } };
}
const render = (p: AccountCorrectionProps) => h(MemoryRouter, null, h(AccountCorrection, p));
const q = (m: Mounted, id: string) => m.container.querySelector(`[data-testid="${id}"]`);
function fill(m: Mounted, cls: string, why: string) {
  const select = m.container.querySelector("select")!;
  act(() => { select.value = cls; select.dispatchEvent(new Event("change", { bubbles: true })); });
  typeInto(m.container.querySelector("textarea")!, why);
}
function deferredRpc() {
  const pending: { args: Record<string, unknown>; resolve: (r: Resp) => void }[] = [];
  const rpc: AccountCorrectionProps["rpc"] = (_fn, args) => new Promise<Resp>((resolve) => { pending.push({ args, resolve }); });
  return { rpc, pending };
}
let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; sessionStorage.clear(); });

describe("an earlier account's completions never reach the account now shown", () => {
  it("a late save for 95000 starts no read for 95000, keeps 91510 shown, and keeps the 91510 draft", async () => {
    const w = world(); const t = deferredRpc();
    m = mount(render(w.props("95000", t.rpc))); await flush();
    fill(m, "cost_of_goods_sold", "Correct the saved expense classification");
    click(q(m, "correction-save")!); await flush();
    expect(t.pending).toHaveLength(1);
    m.rerender(render(w.props("91510", t.rpc))); await flush();
    fill(m, "non_current_assets", "A draft for the newly selected account");
    const readsBefore = w.calls.mapping.filter((k) => k === "95000").length;
    await act(async () => t.pending[0].resolve({ data: RECEIPT, error: null })); await flush();
    expect(q(m, "correction-account")!.textContent).toContain("91510");
    expect(q(m, "correction-account")!.textContent).not.toContain("95000");
    expect(w.calls.mapping.filter((k) => k === "95000").length).toBe(readsBefore); // the obsolete completion started no read
    expect((m.container.querySelector("select") as HTMLSelectElement).value).toBe("non_current_assets");
    expect((m.container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("A draft for the newly selected account");
    expect(q(m, "correction-saved")).toBeNull();
  });
  it("a late lost answer for 95000 does not show 'could not confirm' on 91510; it stays recoverable on 95000 for the same actor", async () => {
    const w = world(); const t = deferredRpc();
    m = mount(render(w.props("95000", t.rpc))); await flush();
    fill(m, "cost_of_goods_sold", "Correct the saved expense classification");
    click(q(m, "correction-save")!); await flush();
    m.rerender(render(w.props("91510", t.rpc))); await flush();
    await act(async () => t.pending[0].resolve({ data: null, error: { message: "TypeError: Failed to fetch" } })); await flush(); // answer lost: unproven
    expect(q(m, "correction-unknown")).toBeNull();
    expect(sessionStorage.getItem(pendingKey("user-a", UP, "95000"))).not.toBeNull();
    m.rerender(render(w.props("95000", t.rpc))); await flush();
    expect(q(m, "correction-unknown")).not.toBeNull();
  });
  it("a check started for 95000 that finishes after moving to 91510 starts no findings refresh and shows no result", async () => {
    const w = world();
    let release!: () => void;
    const startCheck = () => new Promise<void>((r) => { release = r; });
    const rpc: AccountCorrectionProps["rpc"] = async () => ({ data: RECEIPT, error: null });
    m = mount(render(w.props("95000", rpc, { startCheck }))); await flush();
    fill(m, "cost_of_goods_sold", "Correct the saved expense classification");
    w.setSaved("cost_of_goods_sold");
    click(q(m, "correction-save")!); await flush();
    click(q(m, "correction-check-again")!); await flush();
    const confirm = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === "Check again")!;
    click(confirm); await flush();
    w.setSaved(null);
    m.rerender(render(w.props("91510", rpc, { startCheck }))); await flush();
    const statusReads = w.calls.uploadStatus;
    await act(async () => release()); await flush();
    expect(w.calls.refresh).toBe(0);
    expect(w.calls.uploadStatus).toBe(statusReads);
    expect(q(m, "correction-result")).toBeNull();
    expect(q(m, "correction-account")!.textContent).toContain("91510");
  });
});

describe("saved means the canonical receipt; otherwise the same request is sent again", () => {
  it("an empty success shows 'could not confirm'; sending again reuses the request id and the receipt settles it", async () => {
    const w = world();
    const seen: Record<string, unknown>[] = [];
    let answer: Resp = { data: null, error: null };
    const rpc: AccountCorrectionProps["rpc"] = async (_fn, args) => { seen.push(args); return answer; };
    m = mount(render(w.props("95000", rpc))); await flush();
    fill(m, "cost_of_goods_sold", "Correct the saved expense classification");
    click(q(m, "correction-save")!); await flush();
    expect(q(m, "correction-unknown")).not.toBeNull();
    expect(q(m, "correction-saved")).toBeNull();
    answer = { data: RECEIPT, error: null };
    w.setSaved("cost_of_goods_sold");
    click(q(m, "correction-retry")!); await flush();
    expect(seen).toHaveLength(2);
    expect(seen[1].p_client_request_id).toBe(seen[0].p_client_request_id);
    expect(q(m, "correction-unknown")).toBeNull();
    expect(q(m, "correction-saved-not-checked")).not.toBeNull();
    expect(sessionStorage.getItem(pendingKey("user-a", UP, "95000"))).toBeNull();
  });
});

describe("an unproven attempt belongs to the actor who made it", () => {
  it("another person signed in on the same browser sees no earlier attempt and cannot resend it; the original actor can", async () => {
    const w = world();
    const rpc: AccountCorrectionProps["rpc"] = async () => { throw new TypeError("Failed to fetch"); }; // answer lost: unproven
    m = mount(render(w.props("95000", rpc))); await flush();
    fill(m, "cost_of_goods_sold", "Correct the saved expense classification");
    click(q(m, "correction-save")!); await flush();
    expect(q(m, "correction-unknown")).not.toBeNull();
    m.rerender(render(w.props("95000", rpc, { currentUserId: "user-b" }))); await flush();
    expect(q(m, "correction-unknown")).toBeNull();
    expect(q(m, "correction-retry")).toBeNull();
    expect((m.container.querySelector("select") as HTMLSelectElement).value).toBe("");
    expect((m.container.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
    m.rerender(render(w.props("95000", rpc, { currentUserId: null }))); await flush();
    expect(q(m, "correction-unknown")).toBeNull(); // no actor: nothing restored
    m.rerender(render(w.props("95000", rpc, { currentUserId: "user-a" }))); await flush();
    expect(q(m, "correction-unknown")).not.toBeNull();
  });
  it("without a signed-in actor an unproven attempt is never stored", async () => {
    const w = world();
    const rpc: AccountCorrectionProps["rpc"] = async () => { throw new TypeError("Failed to fetch"); };
    m = mount(render(w.props("95000", rpc, { currentUserId: null }))); await flush();
    fill(m, "cost_of_goods_sold", "Correct the saved expense classification");
    click(q(m, "correction-save")!); await flush();
    expect(q(m, "correction-unknown")).not.toBeNull(); // still said on the page
    expect(sessionStorage.length).toBe(0);
  });
});


describe("reason writing assistance", () => {
  it("does not choose or save a category, and blocks the incomplete draft until the user supplies their reasoning", async () => {
    const w = world(); const t = deferredRpc();
    m = mount(render(w.props("95000", t.rpc))); await flush();
    expect(m.container.querySelector("select")!.value).toBe("");
    fill(m, "cost_of_goods_sold", "");
    const help = [...m.container.querySelectorAll("button")].find(b => b.textContent === "Help me write the reason")!;
    click(help); await flush();
    expect(m.container.querySelector("textarea")!.value).toContain("[describe");
    expect((q(m, "correction-save") as HTMLButtonElement).disabled).toBe(true);
    expect(t.pending).toHaveLength(0);
    typeInto(m.container.querySelector("textarea")!, "Cost of inventory sold; checked against the cost ledger.");
    expect((q(m, "correction-save") as HTMLButtonElement).disabled).toBe(false);
    expect(help.disabled).toBe(true);
    expect(t.pending).toHaveLength(0);
  });
});
