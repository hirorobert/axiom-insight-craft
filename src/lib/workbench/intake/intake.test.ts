import { describe, expect, it } from "vitest";
import { interpret, layoutClient, type InspectSheet } from "./layoutClient";
import { EMPTY_DRAFT, draftFromProfile, draftFromSuggestion, draftProblems, headerCells, toProfile } from "./layoutDraft";
import { latestTemplateVersions } from "./templates";
import { periodFormProblems } from "./periodForm";

const httpError = (status: number, body: unknown) => ({ name: "FunctionsHttpError", context: new Response(JSON.stringify(body), { status }) });

describe("layout client — every answer typed, never a raw error", () => {
  it("not deployed (404, or the database authority missing) is 'unavailable', not an error", async () => {
    expect(await interpret({ data: null, error: httpError(404, { message: "Function not found" }) })).toEqual({ kind: "unavailable" });
    expect(await interpret({ data: null, error: httpError(503, { code: "LAYOUT_AUTHORITY_UNAVAILABLE", message: "x" }) })).toEqual({ kind: "unavailable" });
  });
  it("a changed record is a conflict carrying the server's current number; nothing else is inferred", async () => {
    expect(await interpret({ data: null, error: httpError(409, { code: "VERSION_CONFLICT", message: "changed", currentConfirmationNo: 3 }) })).toEqual({ kind: "conflict", current: 3, message: "changed" });
  });
  it("incomplete layouts list the server's reasons; refusals keep their code, copy and report", async () => {
    expect(await interpret({ data: null, error: httpError(400, { code: "INVALID_REQUEST", message: "incomplete", errors: ["a", "b"] }) })).toEqual({ kind: "invalid", message: "incomplete", errors: ["a", "b"] });
    const report = { layoutFits: false };
    expect(await interpret({ data: null, error: httpError(422, { code: "LAYOUT_DOES_NOT_FIT", message: "no", report }) })).toMatchObject({ kind: "refused", code: "LAYOUT_DOES_NOT_FIT", report });
    expect(await interpret({ data: null, error: httpError(403, { code: "FORBIDDEN", message: "no" }) })).toMatchObject({ kind: "refused", code: "FORBIDDEN" });
  });
  it("a transport failure with no answer is thrown (the caller shows 'nothing was changed')", async () => {
    await expect(interpret({ data: null, error: new Error("network") })).rejects.toThrow("network");
  });
  it("sends exactly the action, the layout and the expected confirmation number; never an actor", async () => {
    const sent: unknown[] = [];
    const c = layoutClient(async (_n, o) => { sent.push(o.body); return { data: { status: "confirmed" }, error: null }; });
    const layout = toProfile({ ...EMPTY_DRAFT, headerRow: 1, columns: { ...EMPTY_DRAFT.columns, accountName: "Name", balance: "Bal" }, numberFormat: "plain_dot", balanceSign: "debit_positive" }, "csv")!;
    await c.confirm("u", layout, 2, null);
    expect(sent).toEqual([{ action: "confirm", uploadId: "u", layout, expectedConfirmationNo: 2, templateId: null, numberFormatConfirmed: false }]);
    expect(JSON.stringify(sent)).not.toMatch(/firmMember|userId|actor/i);
  });
});

const sheet = (over: Partial<InspectSheet> = {}): InspectSheet => ({
  name: null, rowCount: 3,
  preview: [{ rowNumber: 1, cells: ["Code", "Name", "Soll", "Haben"] }, { rowNumber: 2, cells: ["1000", "Bank", "1.234,50", null] }],
  suggestion: { headerRow: 1, columns: { account_code: "Code", account_name: "Name" } },
  numberFormats: { consistent: ["dot_comma", "plain_comma"], ambiguous: false, textCells: 2 }, ...over,
});

describe("layout draft", () => {
  it("starts from the automatic reading; the format is pre-selected only when it is unambiguous", () => {
    const d = draftFromSuggestion(sheet());
    expect(d).toMatchObject({ headerRow: 1, columns: { accountCode: "Code", accountName: "Name", debit: null }, numberFormat: "dot_comma" });
    expect(draftFromSuggestion(sheet({ numberFormats: { consistent: ["comma_dot", "dot_comma"], ambiguous: true, textCells: 2 } })).numberFormat).toBeNull();
    // No evidence (no text amounts found) is never read as "unambiguous": the person chooses.
    expect(draftFromSuggestion(sheet({ numberFormats: { consistent: ["comma_dot", "dot_comma"], ambiguous: false, textCells: 0 } })).numberFormat).toBeNull();
  });
  it("names what is missing, in order, and becomes a layout only when complete", () => {
    const d = draftFromSuggestion(sheet());
    expect(draftProblems(d, "csv")).toEqual(["Choose Debit and Credit columns, or a single Balance column."]);
    expect(toProfile(d, "csv")).toBeNull();
    const complete = { ...d, columns: { ...d.columns, debit: "Soll", credit: "Haben" } };
    expect(toProfile(complete, "csv")).toEqual({ format: "layout-template/1", sheet: { kind: "csv" }, headerRow: 1, numberFormat: "dot_comma", balanceSign: null,
      columns: { accountCode: "Code", accountName: "Name", debit: "Soll", credit: "Haben", balance: null, dimensions: [] } });
    expect(draftProblems({ ...complete, columns: { ...complete.columns, credit: "Soll" } }, "csv")).toContain("Each column of the file can have only one role.");
    expect(draftProblems({ ...complete, sheetName: null }, "workbook")[0]).toBe("Choose the sheet that holds the trial balance.");
  });
  it("a single Balance column needs its sign; the sign is dropped when Debit and Credit are used", () => {
    const d = { ...EMPTY_DRAFT, headerRow: 1, columns: { ...EMPTY_DRAFT.columns, accountName: "Name", balance: "Bal" }, numberFormat: "plain_dot" as const };
    expect(draftProblems(d, "csv")).toEqual(["Say whether a positive balance is a debit or a credit."]);
    expect(toProfile({ ...d, balanceSign: "credit_positive" }, "csv")?.balanceSign).toBe("credit_positive");
  });
  it("a template round-trips into the editor; header cells come from the chosen row", () => {
    const p = toProfile({ ...draftFromSuggestion(sheet()), columns: { accountCode: "Code", accountName: "Name", debit: "Soll", credit: "Haben", balance: null } }, "csv")!;
    expect(toProfile(draftFromProfile(p), "csv")).toEqual(p);
    expect(headerCells(sheet(), 1)).toEqual(["Code", "Name", "Soll", "Haben"]);
    expect(headerCells(sheet(), 9)).toEqual([]);
  });
});

describe("templates and period form", () => {
  it("lists the newest version of each template", () => {
    const p = {} as never;
    expect(latestTemplateVersions([
      { id: "a1", template_key: "k1", version: 1, name: "B", profile: p }, { id: "a2", template_key: "k1", version: 2, name: "B", profile: p },
      { id: "c1", template_key: "k2", version: 1, name: "A", profile: p },
    ]).map((t) => [t.id, t.version])).toEqual([["c1", 1], ["a2", 2]]);
  });
  it("the period form has no default currency or dates and names what is missing", () => {
    const empty = { start: "", end: "", currency: "", withPrior: false, priorStart: "", priorEnd: "" };
    expect(periodFormProblems(empty)).toEqual(["Enter the period's start and end dates.", "Choose the reporting currency."]);
    expect(periodFormProblems({ ...empty, start: "2025-07-01", end: "2026-06-30", currency: "KES" })).toEqual([]);
    expect(periodFormProblems({ ...empty, start: "2025-07-01", end: "2026-06-30", currency: "KES", withPrior: true, priorStart: "2024-07-01", priorEnd: "2025-07-01" }))
      .toEqual(["The prior period must end before this period starts."]);
  });
});
