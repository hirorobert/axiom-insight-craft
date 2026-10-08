// @vitest-environment jsdom
/**
 * Close Review adjustments (I3) in the browser: exact amount entry, the draft rules (the server decides), approval
 * offered only to whom the server would allow, the self-approval acknowledgement, reversal, and no browser write to a
 * financial table anywhere in Close Review.
 */
import { act, createElement as h } from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdjustmentsView } from "@/components/closeReview/AdjustmentsView";
import { axeViolations, click, mount, typeInto, type Mounted } from "@/lib/workbench/testkit/dom";
import { RELEASED_WORKBENCH_PAGES } from "@/lib/workbench/routes";
import { checkDraft, parseAmountToMinor, type AdjustmentsClient, type AdjustmentView } from "./adjustments";

describe("exact amounts", () => {
  it("parses grouped decimal text to minor units; refuses extra decimals, signs, exponents and junk", () => {
    expect(parseAmountToMinor("1,234.56", 2)).toBe(123456n);
    expect(parseAmountToMinor("1234", 2)).toBe(123400n);
    expect(parseAmountToMinor("0.5", 3)).toBe(500n);
    expect(parseAmountToMinor("12", 0)).toBe(12n);
    expect(parseAmountToMinor("99999999999999.99", 2)).toBe(9999999999999999n);
    for (const bad of ["1.234", "-5", "1e3", "", "1,23a", "0x10", ".5"]) expect(parseAmountToMinor(bad, 2), bad).toBeNull();
  });
  it("a draft needs two lines, accounts, positive amounts, and equal debits and credits", () => {
    expect(checkDraft([{ accountKey: "6000", side: "debit", amount: "100", memo: "" }], 2).ok).toBe(false);
    const unbalanced = checkDraft([{ accountKey: "6000", side: "debit", amount: "100", memo: "" }, { accountKey: "2000", side: "credit", amount: "99.99", memo: "" }], 2);
    expect(unbalanced.ok).toBe(false);
    expect(unbalanced.problems).toContain("Debits and credits must be equal.");
    const ok = checkDraft([{ accountKey: "6000", side: "debit", amount: "100", memo: "rent" }, { accountKey: "2000", side: "credit", amount: "100.00", memo: "" }], 2);
    expect(ok).toEqual({ ok: true, debitMinor: 10000n, creditMinor: 10000n, problems: [], lines: [{ accountKey: "6000", debitMinor: "10000", creditMinor: "0", memo: "rent" }, { accountKey: "2000", debitMinor: "0", creditMinor: "10000" }] });
  });
  it("no browser write to any financial table in Close Review; the pages are not released yet", () => {
    const root = path.resolve(__dirname, "../../..");
    for (const f of ["src/lib/closeReview/adjustments.ts", "src/lib/closeReview/findings.ts", "src/lib/closeReview/timeline.ts", "src/components/closeReview/AdjustmentsView.tsx",
      "src/components/closeReview/FindingsView.tsx", "src/components/closeReview/ReviewTimeline.tsx", "src/pages/workspace/CloseAdjustments.tsx", "src/pages/workspace/CloseFindings.tsx"]) {
      const src = fs.readFileSync(path.join(root, f), "utf8");
      expect(src, f).not.toMatch(/\.(insert|update|upsert|delete)\(/);
      expect(src, f).not.toMatch(/adjusting_journal_entries|aje_lines|tax_computations/);
    }
    expect(RELEASED_WORKBENCH_PAGES.has("close-adjustments")).toBe(false);
  });
});

const A = (o: Partial<AdjustmentView> & { id: string; number: number }): AdjustmentView => ({
  kind: "adjustment", reverses: null, status: "proposed", current: true, totalMinor: "10000", proposer: "u-prep", reason: "Accrue rent",
  evidenceRef: null, findingIds: [], selfApproved: false, reversedBy: null,
  lines: [{ lineNo: 1, accountKey: "6000", accountCode: "6000", accountName: "Rent", classification: "operating_expenses", debitMinor: "10000", creditMinor: "0", memo: null },
          { lineNo: 2, accountKey: "2000", accountCode: "2000", accountName: "Trade payables", classification: "current_liabilities", debitMinor: "0", creditMinor: "10000", memo: null }], ...o,
});
function fake(adjs: AdjustmentView[], over: Partial<Record<string, unknown>> = {}) {
  return {
    summary: vi.fn(async () => ({ state: "current", certificationId: "c", currency: "TZS", exponent: 2, policy: "two_person", selfApprovalAvailable: false, approvers: 2, adjustments: adjs })),
    adjusted: vi.fn(async () => [
      { account_key: "6000", account_code: "6000", account_name: "Rent", classification: "operating_expenses", certified_debit_minor: "700000", certified_credit_minor: "0", adjustment_debit_minor: "10000", adjustment_credit_minor: "0", adjusted_debit_minor: "710000", adjusted_credit_minor: "0" },
      { account_key: "2000", account_code: "2000", account_name: "Trade payables", classification: "current_liabilities", certified_debit_minor: "0", certified_credit_minor: "300000", adjustment_debit_minor: "0", adjustment_credit_minor: "0", adjusted_debit_minor: "0", adjusted_credit_minor: "300000" },
    ]),
    propose: vi.fn(async () => ({ outcome: "proposed", adjustmentId: "n", number: 2 })),
    decide: vi.fn(async () => ({ outcome: "recorded", status: "approved", selfApproved: false })),
    ...over,
  } as unknown as AdjustmentsClient & Record<string, ReturnType<typeof vi.fn>>;
}
let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; document.body.innerHTML = ""; });
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); }); };
const view = (c: AdjustmentsClient, allowed: string[], user = "u-rev") => h(AdjustmentsView, { companyId: "co", periodYear: 2025, client: c, allowed, currentUserId: user, newRequestId: () => "req-1" });
const btn = (re: RegExp) => [...document.querySelectorAll("button")].find((b) => re.test(b.textContent ?? "")) as HTMLButtonElement | undefined;
const choose = (el: HTMLSelectElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
});

describe("AdjustmentsView", () => {
  it("a reviewer sees Approve and Reject on someone else's proposal; the adjusted accounts show reviewed, adjustment and adjusted (net); no axe violations", async () => {
    m = mount(view(fake([A({ id: "a1", number: 1 })]), ["review_close"]));
    await flush();
    expect(btn(/^Approve$/)).toBeDefined();
    expect(btn(/^Reject$/)).toBeDefined();
    expect(btn(/^Withdraw$/)).toBeUndefined();
    const t = document.querySelector("[aria-label='Adjusted accounts']")!;
    expect(t.textContent).toContain("7,000.00");
    expect(t.textContent).toContain("100.00");
    expect(t.textContent).toContain("7,100.00");
    expect(t.textContent).not.toContain("Trade payables"); // only adjusted accounts are listed
    expect(await axeViolations(m.container)).toEqual([]);
  });
  it("the proposer sees Withdraw, not Approve, under two-person approval", async () => {
    m = mount(view(fake([A({ id: "a1", number: 1 })]), ["prepare_close", "review_close", "approve_certification"], "u-prep"));
    await flush();
    expect(btn(/^Approve$/)).toBeUndefined();
    expect(btn(/^Withdraw$/)).toBeDefined();
  });
  it("self-approval (policy available): Approve stays disabled until the disclosure is acknowledged, and sends the acknowledgement", async () => {
    const c = fake([A({ id: "a1", number: 1 })], {
      summary: vi.fn(async () => ({ state: "current", certificationId: "c", currency: "TZS", exponent: 2, policy: "owner_self_approval", selfApprovalAvailable: true, approvers: 1, adjustments: [A({ id: "a1", number: 1 })] })),
    });
    m = mount(view(c, ["prepare_close", "approve_certification"], "u-prep"));
    await flush();
    typeInto(document.querySelector("[data-testid=adjustment-1] input:not([type=checkbox])") as HTMLInputElement, "Agreed to the lease");
    expect(btn(/^Approve$/)!.disabled).toBe(true);
    click(document.querySelector("[data-testid=adjustment-1] input[type=checkbox]")!);
    click(btn(/^Approve$/)!); await flush();
    expect(c.decide).toHaveBeenCalledWith("a1", "approve", "Agreed to the lease", true, "req-1");
  });
  it("proposing: exact amounts, balanced check shown live, sent as minor-unit strings", async () => {
    const c = fake([]);
    m = mount(view(c, ["prepare_close"], "u-prep"));
    await flush();
    const selects = [...document.querySelectorAll("fieldset select")] as HTMLSelectElement[];
    choose(selects[0], "6000"); choose(selects[2], "2000");
    const amounts = [...document.querySelectorAll("fieldset input[inputmode=decimal]")] as HTMLInputElement[];
    typeInto(amounts[0], "1,250.50"); typeInto(amounts[1], "1250.49");
    expect(document.querySelector("[data-testid=draft-problems]")!.textContent).toContain("Debits and credits must be equal.");
    expect(btn(/Propose adjustment/)!.disabled).toBe(true);
    typeInto(amounts[1], "1250.50");
    typeInto(document.querySelector("textarea")!, "Accrue the December rent");
    click(btn(/Propose adjustment/)!); await flush();
    expect(c.propose).toHaveBeenCalledWith("co", 2025, "Accrue the December rent", null,
      [{ accountKey: "6000", debitMinor: "125050", creditMinor: "0" }, { accountKey: "2000", debitMinor: "0", creditMinor: "125050" }], [], "req-1");
    expect(document.body.textContent).toContain("Adjustment 2 proposed.");
  });
  it("an approved adjustment can be reversed (a new proposal naming it); a stale one says it is not applied", async () => {
    const c = fake([A({ id: "a1", number: 1, status: "approved" }), A({ id: "a0", number: 3, status: "approved", current: false })]);
    m = mount(view(c, ["prepare_close"], "u-prep"));
    await flush();
    expect(document.querySelector("[data-testid=adjustment-3]")!.textContent).toContain("on an earlier trial balance — not applied");
    click(btn(/Propose a reversal/)!); await flush();
    expect(c.propose).toHaveBeenCalledWith("co", 2025, "Reversal of adjustment 1", null, [], [], "req-1", "a1");
  });
});
