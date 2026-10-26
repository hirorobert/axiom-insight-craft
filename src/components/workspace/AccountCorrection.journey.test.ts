// @vitest-environment jsdom
/**
 * The guided correction journey, end to end on the real rendered component (guided-correction r2, 26 Oct 2026):
 *   problem and recorded facts → explanation → action → explicit decision → server-confirmed save → re-check → honest
 *   outcome. Fake transport only: no network, no hosted data, no AI. Every assertion is on what the page shows.
 */
import { act, createElement as h } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AccountCorrection, type AccountCorrectionProps } from "./AccountCorrection";
import { click, mount, typeInto, type Mounted } from "@/lib/workbench/testkit/dom";
import type { FindingRow, FindingsSummary, RefreshOutcome } from "@/lib/closeReview/findings";
import { ReprocessRefusedError } from "@/lib/workspace/requestReprocess";

const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const UP = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";
const BATCH = "33333333-3333-4333-8333-333333333333";
const RECEIPT = { batch_id: BATCH, mappings_written: 1, decisions_logged: 1, non_reporting_decisions_recorded: 0, treatments_recorded: 0 };
type Resp = { data: unknown; error: { code?: string; message?: string } | null };

/** Account 1510 "Accumulated depreciation — plant": certified as an operating expense, in credit (the A01 case of the brief). */
const DEPRECIATION = { key: "1510", name: "Accumulated depreciation — plant", debit: "0", credit: "2500000" };

/**
 * A fake server with ONE mapping and a sequence of findings runs. Each run is the finding as a check would record it
 * (the classification the check used); a saved correction changes the mapping, and the next run is whatever the test says.
 */
function world(o: { runs: { id: string; classification: string | null; generatedAt: string }[]; refreshOutcome?: RefreshOutcome; afterRefresh?: FindingsSummary["state"] }) {
  const calls = { rpc: [] as Record<string, unknown>[], refresh: 0, startCheck: 0 };
  let saved: { classification: string; decisionId: string | null } = { classification: "operating_expenses", decisionId: "d0" };
  let runIndex = 0;
  let decisionAt = "2026-10-25T10:00:00Z";
  let summaryState: FindingsSummary["state"] = "current";
  const run = () => o.runs[Math.min(runIndex, o.runs.length - 1)];
  const row = (): FindingRow | null => run().classification === null ? null : ({
    id: `f-${run().id}`, run_id: run().id, rule_id: "A01", finding_key: `A01:${DEPRECIATION.key}`, severity: "warning", kind: "risk_indicator", mandatory: false,
    required_resolution: "explanation", account_key: DEPRECIATION.key, account_code: DEPRECIATION.key, account_name: DEPRECIATION.name,
    classification: run().classification, debit_minor: DEPRECIATION.debit, credit_minor: DEPRECIATION.credit, class_side_minor: "-2500000", detail: {},
  });
  const rpc: AccountCorrectionProps["rpc"] = async (_fn, args) => {
    calls.rpc.push(args);
    const d = (args.p_decisions as { classification: string }[])[0];
    saved = { classification: d.classification, decisionId: "d1" }; decisionAt = "2026-10-26T12:00:00Z";
    return { data: RECEIPT, error: null } as Resp;
  };
  const props = (over: Partial<AccountCorrectionProps> = {}): AccountCorrectionProps => ({
    companyId: C, periodYear: 2025, link: { accountKey: DEPRECIATION.key, findingKey: `A01:${DEPRECIATION.key}`, rule: "A01" }, reportVersion: null,
    upload: { id: UP, status: "complete" }, canCorrect: true, currentUserId: "user-a",
    findings: {
      summary: async () => summaryState === "current"
        ? ({ state: "current", runId: run().id, currency: "TZS", exponent: 2, generatedAt: run().generatedAt, total: 1, unresolved: 1, unresolvedBlocking: 0, ruleStatus: {} })
        : ({ state: summaryState }),
      list: async () => { const r = row(); return r ? [r] : []; },
      states: async () => [],
      refresh: async () => { calls.refresh++; runIndex++; if (o.afterRefresh) summaryState = o.afterRefresh; return { outcome: o.refreshOutcome ?? "generated" }; },
    } as never,
    readers: {
      runUpload: async () => UP, latestRun: async () => null,
      mapping: async () => ({ classification: saved.classification, review_decision_id: saved.decisionId }),
      decision: async () => ({ decision_action: "USER_MANUAL_CLASSIFICATION", created_at: decisionAt, firm_member_id: "m1", upload_id: UP, reason: "r" }),
      member: async () => null, uploadStatus: async () => "complete",
    },
    rpc, startCheck: async () => { calls.startCheck++; }, onUploadChanged: () => {}, ...over,
  });
  return { calls, props, setSaved: (c: string) => { saved = { classification: c, decisionId: "d1" }; } };
}
const render = (p: AccountCorrectionProps) => h(MemoryRouter, null, h(AccountCorrection, p));
const q = (m: Mounted, id: string) => m.container.querySelector(`[data-testid="${id}"]`);
const text = (m: Mounted) => m.container.textContent ?? "";
function choose(m: Mounted, cls: string) {
  const select = m.container.querySelector("select")!;
  act(() => { select.value = cls; select.dispatchEvent(new Event("change", { bubbles: true })); });
}
async function confirmCheck(m: Mounted) {
  click(q(m, "correction-check-again")!); await flush();
  const confirm = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === "Check again")!;
  click(confirm); await flush();
}
let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; sessionStorage.clear(); });

const RUN1 = { id: "run-1", classification: "operating_expenses", generatedAt: "2026-10-26T08:00:00Z" };

describe("facts, possibilities and judgement are kept apart on the page", () => {
  it("shows the classification the check used, the saved one, the balance side, and never says the classification is wrong", async () => {
    const w = world({ runs: [RUN1] });
    m = mount(render(w.props())); await flush();
    expect(q(m, "correction-checked-class")!.textContent).toBe("Operating Expenses");
    expect(q(m, "correction-saved-class")!.textContent).toContain("Operating Expenses");
    const g = q(m, "correction-guidance")!.textContent!;
    expect(g).toContain("What the check found. The check used Operating Expenses, which expects a debit balance; the trial balance carries a credit balance");
    expect(g).toContain("What a correction does.");
    expect(g).toContain("When this could be legitimate.");   // inside the expandable detail
    expect(g).toContain("What decides it.");
    expect(m.container.querySelector('[data-testid="correction-guidance"] details')).not.toBeNull();
    expect(g).not.toMatch(/classification is wrong|category is wrong|is misclassified/i);
    // The amount guidance names the real adjustment workflow (Close Review › Adjustments) for a person who may propose there.
    expect(q(m, "correction-amount-guidance")!.textContent).toContain("Changing the classification does not change the uploaded amount");
    expect((q(m, "correction-adjustments") as HTMLAnchorElement).getAttribute("href")).toBe(`/workspace/${C}/2025/close/adjustments`);
    expect(text(m)).not.toMatch(/keep the original/i);
  });
});

describe("a corrected classification whose warning legitimately remains", () => {
  it("expense → non-current asset: saved with the server receipt, certification said to be invalidated, re-checked, and the remaining A01 is explained — not asked to be corrected again", async () => {
    const w = world({ runs: [RUN1, { id: "run-2", classification: "non_current_assets", generatedAt: "2026-10-26T13:00:00Z" }] });
    m = mount(render(w.props())); await flush();
    choose(m, "non_current_assets");
    expect(q(m, "classification-help")!.textContent).toMatch(/accumulated depreciation \(a credit against that cost\)/);
    typeInto(m.container.querySelector("textarea")!, "Accumulated depreciation on plant per the fixed-asset register; reduces the plant cost.");
    click(q(m, "correction-save")!); await flush();
    expect(w.calls.rpc).toHaveLength(1);
    expect(q(m, "correction-saved")!.textContent).toMatch(/Correction saved \(server receipt 33333333\)/);
    expect(q(m, "correction-saved")!.textContent).toMatch(/certification is invalidated/);
    // Saved, not yet checked: the page keeps both classifications apart and offers the one re-check path.
    expect(q(m, "correction-checked-class")!.textContent).toBe("Operating Expenses");
    expect(q(m, "correction-saved-class")!.textContent).toContain("Non-Current Assets");
    expect(q(m, "correction-form")).toBeNull();
    expect(q(m, "correction-saved-not-checked")).not.toBeNull();
    await confirmCheck(m);
    expect(w.calls.startCheck).toBe(1);
    expect(w.calls.refresh).toBe(1);
    const result = q(m, "correction-result")!;
    expect(result.getAttribute("data-result")).toBe("still_raised");
    expect(result.getAttribute("data-finding-key")).toBe("A01:1510");
    expect(result.getAttribute("data-run-id")).toBe("run-2");
    expect(q(m, "correction-result-used")!.textContent).toBe("Non-Current Assets");
    expect(result.textContent).toMatch(/still raises this finding; it uses the same classification as the latest saved mapping \(Non-Current Assets\)/);
    expect(q(m, "correction-result-why")!.textContent).toMatch(/^This check uses the same classification as the latest saved mapping, so no further classification change is asked for here\./);
    expect(q(m, "correction-result-why")!.textContent).toMatch(/accumulated depreciation/);
    expect(result.textContent).not.toMatch(/your correction was used|decision was used/i);
    expect(q(m, "correction-result-remaining")!.textContent).toMatch(/closed by recording an explanation \(Prepare\)/);
    expect(q(m, "correction-result-limits")!.textContent).toMatch(/does not record a contra-account treatment, prove the balance or its presentation/);
    expect(q(m, "correction-form")).toBeNull();
    expect(q(m, "correction-check-again")).toBeNull();
    expect((q(m, "correction-back") as HTMLAnchorElement).getAttribute("href")).toBe(`/workspace/${C}/2025/close/findings?finding=A01%3A1510`);
  });
  it("the deterministic journey has no AI element: nothing on the page offers an assistant or an AI explanation", async () => {
    const w = world({ runs: [RUN1] });
    m = mount(render(w.props())); await flush();
    expect(text(m)).not.toMatch(/\bAI\b|assistant|Explain this|Ask CFOClose/i);
    expect([...m.container.querySelectorAll("button")].map((b) => b.textContent)).toEqual(expect.arrayContaining(["Help me write the reason", "Save correction"]));
  });
});

describe("classification changed but not yet rechecked", () => {
  it("a saved classification newer than the current check is shown as saved, not as checked, with the re-check as the only action", async () => {
    const w = world({ runs: [RUN1] });
    w.setSaved("non_current_assets");
    m = mount(render(w.props())); await flush();
    expect(q(m, "correction-checked-class")!.textContent).toBe("Operating Expenses");
    expect(q(m, "correction-saved-class")!.textContent).toContain("Non-Current Assets");
    expect(q(m, "correction-guidance")!.textContent).toMatch(/The saved classification \(Non-Current Assets\) has not been used by a check yet/);
    expect(q(m, "correction-saved-not-checked")!.textContent).toMatch(/a classification it used has changed|not yet used by a check/);
    expect(q(m, "correction-form")).toBeNull();
    expect(q(m, "correction-check-again")).not.toBeNull();
  });
});

describe("typed reasoning survives help actions", () => {
  it("the aid never overwrites text the person typed, and changing the category keeps the text", async () => {
    const w = world({ runs: [RUN1] });
    m = mount(render(w.props())); await flush();
    choose(m, "non_current_assets");
    const box = m.container.querySelector("textarea")!;
    typeInto(box, "Register of plant shows this is the accumulated depreciation balance.");
    const aid = q(m, "correction-reason-aid") as HTMLButtonElement;
    expect(aid.disabled).toBe(true);
    aid.disabled = false; click(aid); await flush(); // even forced, nothing typed is replaced
    expect(box.value).toBe("Register of plant shows this is the accumulated depreciation balance.");
    choose(m, "current_assets");
    expect(box.value).toBe("Register of plant shows this is the accumulated depreciation balance.");
    expect(w.calls.rpc).toHaveLength(0);
  });
  it("the aid writes only the selected categories; a template with nothing of the person's own cannot be saved", async () => {
    const w = world({ runs: [RUN1] });
    m = mount(render(w.props())); await flush();
    choose(m, "non_current_assets");
    click(q(m, "correction-reason-aid")!); await flush();
    const box = m.container.querySelector("textarea")!;
    expect(box.value).toBe("Changing from Operating Expenses to Non-Current Assets because [describe what this account records and the evidence you checked]");
    expect((q(m, "correction-save") as HTMLButtonElement).disabled).toBe(true);
    typeInto(box, "Changing from Operating Expenses to Non-Current Assets because ok");
    expect((q(m, "correction-save") as HTMLButtonElement).disabled).toBe(true);
    expect(q(m, "correction-reason-incomplete")!.textContent).toMatch(/2 of 10 characters of your own reasoning/);
    typeInto(box, "Changing from Operating Expenses to Non-Current Assets because the register shows accumulated depreciation.");
    expect((q(m, "correction-save") as HTMLButtonElement).disabled).toBe(false);
    expect(w.calls.rpc).toHaveLength(0);
  });
});

describe("an unknown save outcome is resent as the same request, across a reload", () => {
  it("a lost answer keeps the request id; after remounting for the same actor, the retry sends the same id and the receipt settles it", async () => {
    const seen: Record<string, unknown>[] = [];
    let fail = true;
    const rpc: AccountCorrectionProps["rpc"] = async (_fn, args) => { seen.push(args); if (fail) throw new TypeError("Failed to fetch"); return { data: RECEIPT, error: null }; };
    const w = world({ runs: [RUN1] });
    m = mount(render(w.props({ rpc }))); await flush();
    choose(m, "non_current_assets");
    typeInto(m.container.querySelector("textarea")!, "Accumulated depreciation per the plant register.");
    click(q(m, "correction-save")!); await flush();
    expect(q(m, "correction-unknown")!.textContent).toMatch(/could not confirm whether the correction was saved/);
    expect(text(m)).not.toMatch(/nothing was (saved|changed)/i);
    m.unmount(); m = mount(render(w.props({ rpc }))); await flush(); // a reload
    expect(q(m, "correction-unknown")).not.toBeNull();
    fail = false; w.setSaved("non_current_assets");
    click(q(m, "correction-retry")!); await flush();
    expect(seen).toHaveLength(2);
    expect(seen[1].p_client_request_id).toBe(seen[0].p_client_request_id);
    expect(q(m, "correction-unknown")).toBeNull();
    expect(q(m, "correction-saved")).not.toBeNull();
  });
});

describe("stale or unavailable findings after the re-check", () => {
  it("the findings became stale again before they could be read: said as not checked, tied to no run, never as resolved", async () => {
    const w = world({ runs: [RUN1, { id: "run-2", classification: "non_current_assets", generatedAt: "2026-10-26T13:00:00Z" }], afterRefresh: "stale" });
    w.setSaved("non_current_assets");
    m = mount(render(w.props())); await flush();
    await confirmCheck(m);
    const result = q(m, "correction-result")!;
    expect(result.getAttribute("data-result")).toBe("not_checked");
    expect(result.getAttribute("data-run-id")).toBeNull();
    expect(result.textContent).toMatch(/changed again after this check/);
  });
  it("the server refused to check the findings (no reviewed trial balance): said as not checked with the server's reason", async () => {
    const w = world({ runs: [RUN1], refreshOutcome: "no_authority" });
    w.setSaved("non_current_assets");
    m = mount(render(w.props())); await flush();
    await confirmCheck(m);
    expect(q(m, "correction-result")!.getAttribute("data-result")).toBe("not_checked");
    expect(q(m, "correction-result")!.textContent).toMatch(/no reviewed trial balance/);
  });
  it("a refused re-check says nothing changed; an answer that never came back is not called 'nothing changed'", async () => {
    const refused = world({ runs: [RUN1] }); refused.setSaved("non_current_assets");
    m = mount(render(refused.props({ startCheck: async () => { throw new ReprocessRefusedError({ outcome: "refused", code: "IN_PROGRESS", upload_id: null, operation_id: null, invalidated_certification_id: null }); } }))); await flush();
    await confirmCheck(m);
    expect(q(m, "correction-check-failed")!.textContent).toMatch(/already being checked\. Nothing was changed\./);
    m.unmount();
    const lost = world({ runs: [RUN1] }); lost.setSaved("non_current_assets");
    m = mount(render(lost.props({ startCheck: async () => { throw new TypeError("Failed to fetch"); } }))); await flush();
    await confirmCheck(m);
    expect(q(m, "correction-check-failed")!.textContent).toMatch(/could not confirm whether a new check started/);
    expect(q(m, "correction-check-failed")!.textContent).not.toMatch(/Nothing was changed/);
  });
});

describe("restricted users receive no unauthorized action", () => {
  it("without Prepare: the facts are shown, but no form, no re-check, no adjustments link and no save path", async () => {
    const w = world({ runs: [RUN1] });
    m = mount(render(w.props({ canCorrect: false }))); await flush();
    expect(q(m, "correction-guidance")).not.toBeNull();
    expect(q(m, "correction-read-only")!.textContent).toMatch(/needs Prepare/);
    expect(q(m, "correction-form")).toBeNull();
    expect(q(m, "correction-adjustments")).toBeNull();
    expect(q(m, "correction-amount-guidance")!.textContent).toMatch(/Proposing an adjustment needs Prepare/);
    w.setSaved("non_current_assets");
    m.rerender(render(w.props({ canCorrect: false }))); await flush();
    expect(q(m, "correction-check-again")).toBeNull();
    expect(q(m, "correction-saved-not-checked")!.textContent).toMatch(/needs Prepare/);
    expect(w.calls.rpc).toHaveLength(0); expect(w.calls.startCheck).toBe(0);
  });
});
