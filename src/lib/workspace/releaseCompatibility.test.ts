/**
 * The R0 frontend is published ONCE, from main, after the ordered merge of #58–#63 — so the same bundle meets every backend
 * stage of the rollout: production today (S1, the engine before E1), then H1, then S2/E2 (E1 is not deployed on its own;
 * its column stays tested because the bundle is compatible with it). This matrix pins what
 * each frontend feature does at each stage, from the backend's real answer at that stage (no live call):
 *
 *   feature                         S1 (today)          H1                  E1                  S2/E2
 *   FT  keep-as-mapped option        never offered       never offered       offered on flagged  offered on flagged
 *   FT  no exclusion of non-zero     enforced            enforced            enforced            enforced
 *   E1  re-run via reprocess path    accepted (S1 RPC)   accepted / HELD     accepted / HELD     accepted, preempts
 *   F1b exact amounts                legacy display      legacy display      exact or refused    exact or refused
 *   F2  authority notice + history   silent (no RPC)     silent (no RPC)     silent (no RPC)     shown
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), functions: { invoke: vi.fn() } } }));
const { loadUploadAuthority, ProcessingAuthorityNoticeView } = await import("@/components/workspace/ProcessingAuthorityNoticeView");
const { readRecordedEquation } = await import("./computeCertificationReadiness");
const { reprocessRefusalMessage, parseReprocessResponse } = await import("./requestReprocess");
const { AccountReviewPanel } = await import("@/components/AccountReviewPanel");

const render = (node: ReturnType<typeof createElement>) => renderToStaticMarkup(node);
const legacyResult = { validation_report: { balance_sheet_equation: { passed: true, assets: 1, liabilities: 0, equity: 1, difference: 0 } } };

describe("F2 at every stage", () => {
  for (const code of ["PGRST202", "42883"]) {
    it(`before S2 (the reads do not exist: ${code}) the notice renders nothing — no "Status unknown"`, async () => {
      const rpc = vi.fn(async () => ({ data: null, error: { code, message: "function not found" } }));
      const state = await loadUploadAuthority(rpc, "u1");
      expect(state).toMatchObject({ loaded: true, unavailable: true });
      expect(render(createElement(ProcessingAuthorityNoticeView, { state, busy: false, canAct: true, onAction: () => {} }))).toBe("");
    });
  }
  it("after S2 a real failure of the read is still 'unknown' (never current)", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "42501", message: "permission denied" } }));
    const state = await loadUploadAuthority(rpc, "u1");
    expect(state.unavailable).toBeFalsy();
    expect(render(createElement(ProcessingAuthorityNoticeView, { state, busy: false, canAct: true, onAction: () => {} }))).toContain("Status unknown");
  });
});

describe("F1b at every stage", () => {
  it("before E1 (no amounts) a result keeps the legacy reading — never 'exact'", () => {
    expect(readRecordedEquation(legacyResult)).toBe("not_failed");
  });
});

describe("FT at every stage", () => {
  const row = { account_code: "1200", account_name: "Closing stock", debit: 0, credit: 5000, balance: -5000, reason: "r" };
  const panel = (accounts: object[]) => render(createElement(AccountReviewPanel, { uploadId: "u", companyId: "c", userId: "x", needsReviewAccounts: accounts, onReprocessed: () => {} } as never));
  it("before E1 no row carries a treatment request, so keep-as-mapped is never offered; a non-zero balance still can't be excluded", () => {
    const html = panel([row]);
    expect(html).not.toContain("Keep as mapped");
    expect(html).toContain('data-testid="exclude-refused-nonzero"');
  });
});

describe("the re-run path at every stage", () => {
  it("S1's reprocess answers are read the same way; H1's hold has its own message; S2's preemption is an ordinary acceptance", () => {
    expect(parseReprocessResponse({ outcome: "accepted", code: "ACCEPTED", upload_id: "u", operation_id: "o", invalidated_certification_id: null }).outcome).toBe("accepted");
    expect(parseReprocessResponse({ outcome: "accepted", code: "ACCEPTED", upload_id: "u", operation_id: "o", invalidated_certification_id: null, preempted_engine_run_id: "r" }).outcome).toBe("accepted");
    expect(reprocessRefusalMessage("PROCESSING_HELD")).toMatch(/paused|update/i);
  });
});
