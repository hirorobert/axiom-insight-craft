// @vitest-environment jsdom
/**
 * DEFECT-UX-TB-REVIEW-CONFIRMATION-VISIBILITY-001: the account review makes explicit what "Save & reprocess" confirms,
 * and afterwards what was confirmed, how and by whom, apart from accounts that stood on a previously reviewed mapping.
 * Presentation only — no review authority, RPC or processing change.
 */
import { act, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { axeViolations, click, mount, type Mounted } from "@/lib/workbench/testkit/dom";
import {
  buildReviewRecord, confirmActionLabel, recordSummary, rowConfirmation, statementAccounts, ROW_CONFIRMATION_LABEL,
  type StoredDecision,
} from "@/lib/workspace/reviewConfirmation";

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const src = (f: string) => fs.readFileSync(path.join(__dirname, "../../..", f), "utf8");
let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.resetModules();
  for (const m of ["@/integrations/supabase/client", "@/lib/ensureFreshSession", "@/lib/workspace/requestReprocess"]) vi.doUnmock(m);
});

const decision = (o: Partial<StoredDecision>): StoredDecision => ({
  account_code: "4000", normalized_account_name: "sales", review_account_key: "4000", decision_action: "USER_ACCEPTED_SUGGESTION",
  new_value: { classification: "revenue" }, firm_member_id: "fm-owner", created_at: "2026-10-18T13:13:45Z", sequence_no: 1, ...o,
});
const OWNER = { id: "fm-owner", user_id: "u-owner", role: "owner", invited_email: null };

describe("before saving: each row says it is not yet confirmed; the action states the count", () => {
  it("row states", () => {
    expect(rowConfirmation({ suggested: "revenue", choice: "revenue", excluded: false })).toBe("suggested_unconfirmed");
    expect(rowConfirmation({ suggested: "revenue", choice: "other_income", excluded: false })).toBe("changed_unsaved");
    expect(rowConfirmation({ suggested: null, choice: "revenue", excluded: false })).toBe("changed_unsaved");
    expect(rowConfirmation({ suggested: "revenue", choice: "revenue", excluded: true })).toBe("excluded_unsaved");
    expect(rowConfirmation({ suggested: "revenue", choice: "__keep__", excluded: false, keepChoice: "__keep__" })).toBe("kept_unsaved");
    expect(rowConfirmation({ suggested: null, choice: undefined, excluded: false })).toBeNull();
    expect(ROW_CONFIRMATION_LABEL.suggested_unconfirmed).toBe("Suggested — not yet confirmed");
  });
  it("the action names what it will confirm", () => {
    expect(confirmActionLabel({ classifications: 3, excluded: 0 })).toBe("Confirm 3 classifications and reprocess");
    expect(confirmActionLabel({ classifications: 1, excluded: 0 })).toBe("Confirm 1 classification and reprocess");
    expect(confirmActionLabel({ classifications: 2, excluded: 1 })).toBe("Confirm 2 classifications, exclude 1 account and reprocess");
    expect(confirmActionLabel({ classifications: 0, excluded: 2 })).toBe("Exclude 2 accounts and reprocess");
  });

  it("the panel marks pre-selected suggestions and states the count on its action (real component)", async () => {
    vi.doMock("@/integrations/supabase/client", () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
    vi.doMock("@/lib/ensureFreshSession", () => ({ ensureFreshSession: async () => undefined }));
    vi.doMock("@/lib/workspace/requestReprocess", () => ({ requestReprocess: vi.fn() }));
    const { AccountReviewPanel } = await import("@/components/AccountReviewPanel");
    const accounts = [
      { account_code: "4000", account_name: "Sales", debit: 0, credit: 100, balance: -100, suggested_classification: "revenue", reason: "Suggested from the account name" },
      { account_code: "4100", account_name: "Sales", debit: 0, credit: 50, balance: -50, suggested_classification: "revenue", reason: "Suggested from the account name" },
      { account_code: "1000", account_name: "Invented bank", debit: 150, credit: 0, balance: 150, suggested_classification: "current_assets", reason: "Suggested from the account name" },
    ];
    mounted = mount(createElement(AccountReviewPanel, { uploadId: "u1", companyId: "c1", userId: "u-owner", needsReviewAccounts: accounts, onReprocessed: () => undefined }));
    const full = [...mounted.container.querySelectorAll("button")].find((b) => /^Show the full list$/.test(b.textContent?.trim() ?? ""));
    if (full) click(full);
    for (const code of ["4000", "4100", "1000"]) {
      const marks = mounted.container.querySelectorAll(`[data-testid="row-confirmation-${code}"]`);
      expect(marks.length).toBeGreaterThan(0); // desktop table and mobile record
      expect(marks[0].textContent).toBe("Suggested — not yet confirmed");
    }
    expect(mounted.container.querySelector('[data-testid="account-review-save"]')?.textContent).toContain("Confirm 3 classifications and reprocess");
  });
});

describe("after saving: what was confirmed, how and by whom; what stood on a previously reviewed mapping", () => {
  const accounts = [
    { account_code: "4000", account_name: "Sales", classification: "revenue" },
    { account_code: "4100", account_name: "Sales", classification: "revenue" },
    { account_code: "1000", account_name: "Invented bank", classification: "current_assets" },
    { account_code: "2000", account_name: "Trade payables", classification: "current_liabilities" },
    { account_code: "3000", account_name: "Share capital", classification: "equity" },
  ];
  const mappings = [{ account_code: "2000", normalized_account_name: "trade payables", review_decision_id: "d-old" }, { account_code: "3000", normalized_account_name: "share capital", review_decision_id: null }];

  it("confirmed here (latest decision wins, with the action and the member), previously reviewed, or no review record", () => {
    const r = buildReviewRecord({
      accounts, mappings, currentUserId: "u-owner",
      members: [OWNER, { id: "fm-b", user_id: "u-b", role: "manager", invited_email: "b@example.test" }],
      decisions: [
        decision({ account_code: "4000", sequence_no: 1, decision_action: "USER_MANUAL_CLASSIFICATION" }),
        decision({ account_code: "4000", sequence_no: 4 }), // later decision for the same account wins
        decision({ account_code: "4100", sequence_no: 2, firm_member_id: "fm-b" }),
        decision({ account_code: "1000", sequence_no: 3, firm_member_id: "fm-unknown", new_value: { classification: "current_assets" } }),
        decision({ account_code: "9100", normalized_account_name: "sundry clearing", sequence_no: 5, decision_action: "MARK_NON_REPORTING_ACCOUNT", new_value: null }),
      ],
    });
    const by = (code: string) => r.rows.find((x) => x.account_code === code)!;
    expect(by("4000")).toMatchObject({ basis: "confirmed_here", action: "Suggestion confirmed", by: "you (owner)" });
    expect(by("4100")).toMatchObject({ basis: "confirmed_here", by: "b@example.test (manager)" });
    expect(by("1000")).toMatchObject({ basis: "confirmed_here", by: "a member of this workspace" }); // never someone else
    expect(by("9100")).toMatchObject({ basis: "confirmed_here", action: "Excluded as non-reporting" });
    expect(by("2000").basis).toBe("previously_reviewed");
    expect(by("3000").basis).toBe("no_review_record"); // a mapping without review provenance is not called reviewed
    expect([r.confirmed, r.previouslyReviewed, r.noRecord]).toEqual([4, 1, 1]);
    expect(r.rows.map((x) => x.basis).slice(0, 4)).toEqual(["confirmed_here", "confirmed_here", "confirmed_here", "confirmed_here"]);
    expect(recordSummary(r, () => "18 Oct 2026, 13:13")).toMatch(/^4 accounts confirmed in this review by .*you \(owner\).*, 18 Oct 2026, 13:13\. 1 account stood on a previously reviewed mapping\.$/);
  });

  it("the stored result's accounts are read from processing_result.statements, by section", () => {
    expect(statementAccounts({ statements: { balance_sheet: { equity: { accounts: [{ account_code: "3000", account_name: "Share capital" }] } }, income_statement: { revenue: { accounts: [{ account_code: "4000", account_name: "Sales" }] } } } }))
      .toEqual([{ account_code: "3000", account_name: "Share capital", classification: "equity" }, { account_code: "4000", account_name: "Sales", classification: "revenue" }]);
    expect(statementAccounts({ statements: null })).toEqual([]);
  });

  async function mountRecord(tables: Record<string, { data: unknown[] | null; error: unknown }>) {
    const calls: string[] = [];
    const chain = (t: string) => { const c: Record<string, unknown> = {}; for (const k of ["select", "eq", "in"]) c[k] = () => c; c.order = () => c; c.then = (res: (v: unknown) => unknown) => Promise.resolve(tables[t] ?? { data: [], error: null }).then(res); calls.push(t); return c; };
    vi.doMock("@/integrations/supabase/client", () => ({ supabase: { from: (t: string) => chain(t), rpc: vi.fn(() => { throw new Error("no RPC from the record"); }) } }));
    const { ClassificationRecord } = await import("./ClassificationRecord");
    const result = { statements: { balance_sheet: { current_assets: { accounts: [{ account_code: "1000", account_name: "Invented bank" }] }, current_liabilities: { accounts: [{ account_code: "2000", account_name: "Trade payables" }] } }, income_statement: { revenue: { accounts: [{ account_code: "4000", account_name: "Sales" }, { account_code: "4100", account_name: "Sales" }] } } } };
    mounted = mount(createElement(ClassificationRecord, { uploadId: "u1", companyId: "c1", currentUserId: "u-owner", processingResult: result, refreshKey: "complete|t" }));
    await flush(); await flush();
    return { calls, q: (s: string) => mounted!.container.querySelector<HTMLElement>(s) };
  }

  it("the record (real component): a live summary, each account with its basis; reads only", async () => {
    const { calls, q } = await mountRecord({
      account_review_decisions: { data: ["4000", "4100", "1000"].map((c, i) => decision({ account_code: c, sequence_no: i + 1 })), error: null },
      firm_members: { data: [OWNER], error: null },
      account_mappings: { data: [{ account_code: "2000", normalized_account_name: "trade payables", review_decision_id: "d-old" }], error: null },
    });
    const summary = q('[data-testid="classification-record-summary"]')!;
    expect(summary.getAttribute("role")).toBe("status");
    expect(summary.textContent).toMatch(/^3 accounts confirmed in this review by you \(owner\)/);
    expect(summary.textContent).toMatch(/1 account stood on a previously reviewed mapping\.$/);
    expect(q('[data-testid="record-c:4000"]')?.dataset.basis).toBe("confirmed_here");
    expect(q('[data-testid="record-c:4000"]')?.textContent).toMatch(/Suggestion confirmed by you \(owner\)/);
    expect(q('[data-testid="record-c:2000"]')?.textContent).toMatch(/Previously reviewed/);
    expect(new Set(calls)).toEqual(new Set(["account_review_decisions", "firm_members", "account_mappings"]));
    expect(await axeViolations(mounted!.container)).toEqual([]);
  });

  it("a read it cannot make is said, never guessed", async () => {
    const { q } = await mountRecord({ account_review_decisions: { data: null, error: { message: "denied" } } });
    expect(q('[data-testid="classification-record-summary"]')?.textContent).toMatch(/could not be read/);
    expect(q('[data-testid="classification-record-list"]')).toBeNull();
  });

  it("no write and no authority change: the record only selects; the save payload is unchanged", () => {
    const rec = src("src/components/workspace/ClassificationRecord.tsx");
    expect(rec).not.toMatch(/\.(insert|update|upsert|delete|rpc)\s*\(/);
    const panel = src("src/components/AccountReviewPanel.tsx");
    expect(panel).toMatch(/"resolve_account_review_batch" as never/);
    expect(panel).toMatch(/p_decisions:\s+decisions,/);
    expect(src("src/pages/workspace/PrepareWorkspace.tsx")).toMatch(/\{!showReviewPanel && upload\.company_id && \(\n\s*<ClassificationRecord/);
  });
});
