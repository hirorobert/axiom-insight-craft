// @vitest-environment jsdom
/**
 * The engagement stated once in the workspace rail, with its settings: entity, period, currency, framework; the review
 * policy for clearing balances changed only with a reason by someone the server allows; nothing of it for a Prepare-only
 * grant. Invented data only.
 */
import { act, createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations, click, mount, typeInto, type Mounted } from "@/lib/workbench/testkit/dom";

const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
let policyAnswer: unknown = { outcome: "ok", may_change: true, policies: [{ code: "CLEARING_ACCOUNT_BALANCE", mode: "review", revision: 0, reason: null }] };
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      if (fn === "get_tb_finding_policies") return { data: policyAnswer, error: null };
      if (fn === "set_tb_finding_policy") return { data: { outcome: "recorded", revision: 1 }, error: null };
      return { data: null, error: null };
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { reporting_start: "2025-07-01", reporting_end: "2026-06-30", reporting_currency: "TZS" } }) }) }) }),
  },
}));

const flush = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); };
const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid=${id}]`) as HTMLElement | null;

describe("EngagementContextPanel", () => {
  let m: Mounted | null = null;
  afterEach(() => { m?.unmount(); m = null; rpcCalls.length = 0; });
  const render = async (prepareOnly = false) => {
    const { EngagementContextPanel } = await import("./EngagementContextPanel");
    m = mount(createElement(MemoryRouter, null, createElement(EngagementContextPanel, {
      companyId: "c1", periodYear: 2026, companyName: "Invented Kilimo Ltd", framework: "ifrs_for_smes", companyCreatedAt: "2026-01-01T00:00:00Z",
      fiscalPeriodId: "p1", prepareOnly })));
    await flush();
    return m.container;
  };

  it("states the entity, the period's dates and currency, and the framework; settings are in the rail, not the page", async () => {
    const el = await render();
    expect(q(el, "engagement-context-entity")!.textContent).toBe("Invented Kilimo Ltd");
    expect(q(el, "engagement-context-period")!.textContent).toBe("1 Jul 2025 – 30 Jun 2026");
    expect(q(el, "engagement-context-currency")!.textContent).toBe("TZS");
    expect(q(el, "engagement-context-framework")).not.toBeNull();
    expect(el.querySelector('a[href="/workspace/c1/2026/trial-balance/intake"]')).not.toBeNull();
    expect(el.querySelector('a[href="/settings"]')).not.toBeNull();
    expect(await axeViolations(el)).toEqual([]);
  });
  it("the clearing-balance policy is a review note by default; changing it needs a reason and says what it re-checks", async () => {
    const el = await render();
    expect(q(el, "clearing-policy-mode")!.textContent).toBe("Review note (default)");
    click(q(el, "clearing-policy-change")!);
    expect(el.textContent).toContain("will need a re-check");
    expect((q(el, "clearing-policy-save") as HTMLButtonElement).disabled).toBe(true);
    typeInto(q(el, "clearing-policy-reason") as HTMLTextAreaElement, "Engagement letter requires evidence");
    click(q(el, "clearing-policy-save")!); await flush();
    const set = rpcCalls.find((c) => c.fn === "set_tb_finding_policy");
    expect(set?.args).toMatchObject({ p_company_id: "c1", p_code: "CLEARING_ACCOUNT_BALANCE", p_mode: "require_decision", p_expected_revision: 0 });
    expect(q(el, "clearing-policy-mode")!.textContent).toBe("An explanation with evidence is required");
  });
  it("without review authority the policy is shown but cannot be changed; a Prepare-only grant sees no framework and no settings", async () => {
    policyAnswer = { outcome: "ok", may_change: false, policies: [{ code: "CLEARING_ACCOUNT_BALANCE", mode: "review", revision: 0, reason: null }] };
    let el = await render();
    expect(q(el, "clearing-policy-mode")).not.toBeNull();
    expect(q(el, "clearing-policy-change")).toBeNull();
    m!.unmount(); m = null; rpcCalls.length = 0;
    el = await render(true);
    expect(q(el, "engagement-context-framework")).toBeNull();
    expect(q(el, "engagement-settings")).toBeNull();
    expect(rpcCalls.some((c) => c.fn === "get_tb_finding_policies")).toBe(false);
  });
});
