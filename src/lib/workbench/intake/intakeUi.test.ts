// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LayoutEditor, type LayoutTemplateRow } from "@/components/workbench/intake/LayoutEditor";
import { PeriodSetup } from "@/components/workbench/intake/PeriodSetup";
import { axeViolations, click, key, mount, type Mounted } from "../testkit/dom";
import type { InspectResult, LayoutAnswer, LayoutClient, LayoutReport } from "./layoutClient";

let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; document.body.innerHTML = ""; });
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };

const INSPECT: InspectResult = {
  status: "ok", kind: "csv", sourceFileHash: "f".repeat(64), currentConfirmationNo: 0,
  sheets: [{
    name: null, rowCount: 3,
    preview: [{ rowNumber: 1, cells: ["Code", "Name", "Soll", "Haben"] }, { rowNumber: 2, cells: ["1000", "Bank", "1.500,25", null] }, { rowNumber: 3, cells: ["3000", "Capital", null, "1.500,25"] }],
    suggestion: { headerRow: 1, columns: { account_code: "Code", account_name: "Name" } },
    numberFormats: { consistent: ["dot_comma", "plain_comma"], ambiguous: false, textCells: 2 },
  }],
};
const REPORT = (over: Partial<LayoutReport> = {}): LayoutReport => ({
  layoutFits: true, profileSha256: "a".repeat(64), resolvedProfileSha256: "b".repeat(64), sourceFileHash: "f".repeat(64), currency: "TZS",
  issues: [], lineageSummary: { rowsRead: 3 }, totals: { debit: "1500.25", credit: "1500.25", difference: "0.00" }, accounts: 2,
  rows: [[1, "header", null], [2, "account", "code:1000"], [3, "account", "code:3000"]], ...over,
});
const ok = <T,>(value: T): LayoutAnswer<T> => ({ kind: "ok", value });
function fakeClient(over: Partial<Record<keyof LayoutClient, unknown>> = {}) {
  return {
    inspect: vi.fn(async () => ok(INSPECT)),
    validate: vi.fn(async () => ok({ status: "validated" as const, report: REPORT() })),
    confirm: vi.fn(async () => ok({ status: "confirmed" as const, confirmationId: "c", confirmationNo: 1, replay: false, unchanged: false, report: REPORT() })),
    saveTemplate: vi.fn(async () => ok({ status: "saved" as const, templateId: "t", templateKey: "k", version: 1, replay: false, unchanged: false })),
    ...over,
  } as unknown as LayoutClient & Record<string, ReturnType<typeof vi.fn>>;
}
const editor = (client: LayoutClient, uploadId = "u1", templates: LayoutTemplateRow[] = []) =>
  h(LayoutEditor, { client, companyId: "c1", uploadId, periodLabel: "FY2025", templates, newKey: () => "key-1" });
const byText = (re: RegExp) => [...document.querySelectorAll("button")].find((b) => re.test(b.textContent ?? "")) as HTMLButtonElement;
const select = (label: string) => {
  const l = [...document.querySelectorAll("label")].find((x) => x.textContent === label)!;
  return document.getElementById(l.htmlFor) as HTMLSelectElement;
};
const choose = (el: HTMLSelectElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
});

describe("LayoutEditor", () => {
  it("starts from the automatic reading; only a complete layout can be checked; no axe violations", async () => {
    const c = fakeClient();
    m = mount(editor(c));
    await flush();
    expect(document.body.textContent).toContain("Confirmed layouts for this file: none (the automatic reading is used)");
    expect(byText(/Check against the whole file/).disabled).toBe(true);
    expect(document.body.textContent).toContain("Choose Debit and Credit columns, or a single Balance column.");
    choose(select("Debit"), "Soll"); choose(select("Credit"), "Haben");
    expect(byText(/Check against the whole file/).disabled).toBe(false);
    expect(byText(/Confirm layout for this file/).disabled).toBe(true); // nothing confirmed before a passing check
    expect(await axeViolations(m.container)).toEqual([]);
  });

  it("check → the report opens (every row, zero as 0.00, focus to Close); Esc returns focus; confirm sends the expected number", async () => {
    const c = fakeClient();
    m = mount(editor(c));
    await flush();
    choose(select("Debit"), "Soll"); choose(select("Credit"), "Haben");
    click(byText(/Check against the whole file/));
    await flush();
    expect(c.validate).toHaveBeenCalledWith("u1", expect.objectContaining({ numberFormat: "dot_comma", columns: expect.objectContaining({ debit: "Soll", credit: "Haben" }) }));
    const panel = document.querySelector("aside[role=complementary]")!;
    expect(panel.querySelector("[aria-label='Every row of the file']")).not.toBeNull();
    expect(panel.textContent).toContain("code:3000");
    expect(panel.textContent).toContain("0.00");
    expect(document.activeElement?.textContent).toMatch(/Close/);
    key(document.activeElement!, "Escape");
    expect(document.querySelector("aside[role=complementary]")).toBeNull();
    click(byText(/Confirm layout for this file/));
    expect(document.body.textContent).toContain("A current result for it will need a new check.");
    click(byText(/^Confirm layout$/));
    await flush();
    expect(c.confirm).toHaveBeenCalledWith("u1", expect.any(Object), 0, null, false);
    expect(document.body.textContent).toContain("Layout confirmed for this file (confirmation 1)");
  });

  it("a layout that does not fit: the report says why, missing totals shown as — with the reason; confirm stays disabled", async () => {
    const bad = REPORT({ layoutFits: false, totals: null, issues: [{ code: "LAYOUT_NUMBER_FORMAT_MISMATCH", severity: "blocking", message: "Amounts are written in another format." }] });
    const c = fakeClient({ validate: vi.fn(async () => ok({ status: "validated" as const, report: bad })) });
    m = mount(editor(c));
    await flush();
    choose(select("Debit"), "Soll"); choose(select("Credit"), "Haben");
    click(byText(/Check against the whole file/));
    await flush();
    const panel = document.querySelector("aside[role=complementary]")!;
    expect(panel.textContent).toContain("— (not computed: the file could not be read with this layout)");
    expect(panel.textContent).toContain("Blocking: Amounts are written in another format.");
    expect(byText(/Confirm layout for this file/).disabled).toBe(true);
  });

  it("someone else confirmed first: the conflict notice says nothing was recorded and Reload re-reads", async () => {
    const c = fakeClient({ confirm: vi.fn(async () => ({ kind: "conflict", current: 1, message: "changed" })) });
    m = mount(editor(c));
    await flush();
    choose(select("Debit"), "Soll"); choose(select("Credit"), "Haben");
    click(byText(/Check against the whole file/)); await flush();
    key(document.activeElement!, "Escape");
    click(byText(/Confirm layout for this file/)); click(byText(/^Confirm layout$/)); await flush();
    const alert = document.querySelector("[role=alert]")!;
    expect(alert.textContent).toContain("Your change was not recorded.");
    expect(c.inspect).toHaveBeenCalledTimes(1);
    click(byText(/Reload the latest version/)); await flush();
    expect(c.inspect).toHaveBeenCalledTimes(2);
  });

  it("a backend without layouts: 'not available yet', the automatic reading unchanged; no error state", async () => {
    m = mount(editor(fakeClient({ inspect: vi.fn(async () => ({ kind: "unavailable" })) })));
    await flush();
    expect(document.body.textContent).toContain("Manual layouts are not available yet. The automatic reading of your file still works as before.");
    expect(document.querySelector("[role=alert]")).toBeNull();
  });

  it("an answer for a previous file is discarded when the upload changes before it arrives", async () => {
    let releaseOld!: (v: LayoutAnswer<InspectResult>) => void;
    const old = new Promise<LayoutAnswer<InspectResult>>((r) => { releaseOld = r; });
    const inspect = vi.fn((id: string) => (id === "u-old" ? old : Promise.resolve(ok({ ...INSPECT, currentConfirmationNo: 7 }))));
    const c = fakeClient({ inspect });
    m = mount(editor(c, "u-old"));
    m.rerender(editor(c, "u-new"));
    await flush();
    releaseOld(ok({ ...INSPECT, currentConfirmationNo: 99 }));
    await flush();
    expect(document.body.textContent).toContain("Confirmed layouts for this file: 7");
    expect(document.body.textContent).not.toContain("99");
  });

  it("a template is disclosed as reused and re-checked; saving the same name is a new version with its expected version", async () => {
    const t: LayoutTemplateRow = { id: "t1", templateKey: "k1", version: 2, name: "German export", profile: {
      format: "layout-template/1", sheet: { kind: "csv" }, headerRow: 1, numberFormat: "dot_comma", balanceSign: null,
      columns: { accountCode: "Code", accountName: "Name", debit: "Soll", credit: "Haben", balance: null, dimensions: [] } } };
    const c = fakeClient();
    m = mount(editor(c, "u1", [t]));
    await flush();
    choose(select("Start from a saved template"), "t1");
    expect(document.body.textContent).toContain("Using template “German export” (version 2). It is checked again against this file before anything is confirmed.");
    click(byText(/Save as a new version/)); await flush();
    expect(c.saveTemplate).toHaveBeenCalledWith("c1", "k1", 2, "German export", expect.objectContaining({ numberFormat: "dot_comma" }));
  });

  it("the header row is chosen by keyboard-operable buttons that report their state", async () => {
    m = mount(editor(fakeClient()));
    await flush();
    const row2 = byText(/^Row 2$/);
    expect(byText(/^Row 1$/).getAttribute("aria-pressed")).toBe("true");
    row2.focus(); click(row2);
    expect(row2.getAttribute("aria-pressed")).toBe("true");
    expect(document.body.textContent).toContain("Header row: 2");
  });
});

describe("PeriodSetup", () => {
  it("no default currency or dates; submit stays disabled until complete; axe clean", async () => {
    m = mount(h(PeriodSetup, { client: { rpc: vi.fn() } as never, companyId: "c1" }));
    expect(select("Reporting currency").value).toBe("");
    expect(byText(/Set up the period/).disabled).toBe(true);
    expect(await axeViolations(m.container)).toEqual([]);
  });
  it("a server refusal is shown in plain words; an older backend shows 'not available yet'", async () => {
    const rpc = vi.fn(async () => ({ data: { outcome: "refused", code: "PERIOD_OVERLAP" }, error: null }));
    m = mount(h(PeriodSetup, { client: { rpc } as never, companyId: "c1" }));
    const set = (label: string, v: string) => {
      const el = select(label) as unknown as HTMLInputElement;
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      act(() => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
    };
    set("Start date", "2025-07-01"); set("End date", "2026-06-30"); set("Reporting currency", "KES");
    click(byText(/Set up the period/)); await flush();
    expect(rpc).toHaveBeenCalledWith("open_engagement_with_period", expect.objectContaining({ p_reporting_currency: "KES", p_period_start: "2025-07-01" }));
    expect(document.querySelector("[role=alert]")?.textContent).toContain("These dates overlap another reporting period");
    m.unmount(); m = null;
    const missing = vi.fn(async () => ({ data: null, error: { code: "PGRST202", message: "not found" } }));
    m = mount(h(PeriodSetup, { client: { rpc: missing } as never, companyId: "c1" }));
    set("Start date", "2025-07-01"); set("End date", "2026-06-30"); set("Reporting currency", "KES");
    click(byText(/Set up the period/)); await flush();
    expect(document.body.textContent).toContain("Setting up a period with explicit dates is not available yet.");
  });
});

describe("Intake navigation keeps the workbench context", () => {
  it("the link to the single uploader carries the company, the period and the report version", async () => {
    const src = (await import("node:fs")).readFileSync((await import("node:path")).resolve(__dirname, "../../../pages/workspace/TrialBalanceIntake.tsx"), "utf8");
    expect(src).toMatch(/withContext\(`\/workspace\/\$\{companyId\}\/\$\{periodYear\}\/trial-balance\/review`, \{ reportVersion: parseReportVersion\(search\) \}\)/);
    expect(src).toContain("to={reviewHref}");
    const { withContext, parseReportVersion } = await import("../context");
    expect(withContext("/workspace/c/2025/trial-balance/review", { reportVersion: parseReportVersion("?v=3") })).toBe("/workspace/c/2025/trial-balance/review?v=3");
  });
});

describe("LayoutEditor — number-format ambiguity requires an explicit choice", () => {
  const AMBIGUOUS = REPORT({ currency: "BHD", numberFormats: { declared: "dot_comma", consistent: ["comma_dot", "dot_comma", "plain_comma"], ambiguous: true, textCells: 2,
    examples: [{ row: 2, column: "debit", text: "500,000", readings: { comma_dot: "500000", dot_comma: "500.000", plain_comma: "500.000" } }] } });
  it("shows every reading of an ambiguous amount; Confirm stays disabled until the person confirms the declared format; the confirmation says so", async () => {
    const c = fakeClient({ validate: vi.fn(async () => ok({ status: "validated" as const, report: AMBIGUOUS })) });
    m = mount(editor(c));
    await flush();
    choose(select("Debit"), "Soll"); choose(select("Credit"), "Haben");
    click(byText(/Check against the whole file/)); await flush();
    key(document.activeElement!, "Escape");
    const box = document.querySelector("[data-testid=number-format-ambiguity]")!;
    expect(box.textContent).toContain("Row 2 (debit) “500,000”");
    expect(box.textContent).toContain("500000 as 1,234,567.89");
    expect(box.textContent).toContain("500.000 as 1.234.567,89");
    expect(byText(/Confirm layout for this file/).disabled).toBe(true);
    click(box.querySelector("input[type=checkbox]")!);
    expect(byText(/Confirm layout for this file/).disabled).toBe(false);
    click(byText(/Confirm layout for this file/)); click(byText(/^Confirm layout$/)); await flush();
    expect(c.confirm).toHaveBeenCalledWith("u1", expect.objectContaining({ numberFormat: "dot_comma" }), 0, null, true);
    expect(await axeViolations(m.container)).toEqual([]);
  });
  it("changing the layout after confirming the format clears that confirmation (a new check is needed)", async () => {
    const c = fakeClient({ validate: vi.fn(async () => ok({ status: "validated" as const, report: AMBIGUOUS })) });
    m = mount(editor(c));
    await flush();
    choose(select("Debit"), "Soll"); choose(select("Credit"), "Haben");
    click(byText(/Check against the whole file/)); await flush();
    key(document.activeElement!, "Escape");
    click(document.querySelector("[data-testid=number-format-ambiguity] input[type=checkbox]")!);
    choose(select("Account name"), "");
    expect(document.querySelector("[data-testid=number-format-ambiguity]")).toBeNull();
    expect(byText(/Confirm layout for this file/).disabled).toBe(true);
  });
});
