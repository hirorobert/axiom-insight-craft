import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { exactDecimalText, inspectWorkbook, ingestWorkbook, readWorkbookSheet, XLSX_LIMITS } from "./xlsx";
import { ingestEvidence } from "./intake";
import type { EvidenceType } from "./types";

// ── a tiny OOXML writer, used only to build fixtures ────────────────────────
type Cell = string | { n: string; style?: number } | { f: string; v?: string } | { b: boolean } | { e: string } | null;
interface SheetSpec {
  readonly name: string;
  readonly rows: readonly (readonly Cell[])[];
  readonly state?: "hidden" | "veryHidden";
  readonly hiddenRows?: readonly number[];
  readonly hiddenCols?: readonly [number, number][];
  readonly merges?: readonly string[];
}
const L = (i: number) => String.fromCharCode(65 + i);

function build(sheets: readonly SheetSpec[], opts: { extra?: Record<string, Uint8Array | string>; styles?: string; contentTypesExtra?: string; workbookExtra?: string; meta?: string; inline?: boolean } = {}): Uint8Array {
  const sst: string[] = [];
  const sidx = (t: string) => {
    let i = sst.indexOf(t);
    if (i < 0) i = sst.push(t) - 1;
    return i;
  };
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const files: Record<string, Uint8Array> = {};
  sheets.forEach((sh, si) => {
    const rows = sh.rows
      .map((r, ri) => {
        const cells = r
          .map((c, ci) => {
            if (c === null) return "";
            const ref = `${L(ci)}${ri + 1}`;
            if (typeof c === "string") return opts.inline ? `<c r="${ref}" t="inlineStr"><is><t>${esc(c)}</t></is></c>` : `<c r="${ref}" t="s"><v>${sidx(c)}</v></c>`;
            if ("n" in c) return `<c r="${ref}"${c.style !== undefined ? ` s="${c.style}"` : ""}><v>${c.n}</v></c>`;
            if ("f" in c) return `<c r="${ref}"><f>${esc(c.f)}</f>${c.v !== undefined ? `<v>${c.v}</v>` : ""}</c>`;
            if ("b" in c) return `<c r="${ref}" t="b"><v>${c.b ? 1 : 0}</v></c>`;
            return `<c r="${ref}" t="e"><v>${c.e}</v></c>`;
          })
          .join("");
        return `<row r="${ri + 1}"${sh.hiddenRows?.includes(ri + 1) ? ' hidden="1"' : ""}>${cells}</row>`;
      })
      .join("");
    const cols = sh.hiddenCols ? `<cols>${sh.hiddenCols.map(([a, b]) => `<col min="${a}" max="${b}" hidden="1" width="9"/>`).join("")}</cols>` : "";
    const merges = sh.merges ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "";
    files[`xl/worksheets/sheet${si + 1}.xml`] = strToU8(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${rows}</sheetData>${merges}</worksheet>`);
  });
  files["xl/workbook.xml"] = strToU8(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ""} r:id="rId${i + 1}"/>`).join("")}</sheets>${opts.workbookExtra ?? ""}</workbook>`);
  files["xl/_rels/workbook.xml.rels"] = strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`);
  files["xl/sharedStrings.xml"] = strToU8(`<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sst.map((t) => `<si><t>${esc(t)}</t></si>`).join("")}</sst>`);
  files["[Content_Types].xml"] = strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/>${opts.contentTypesExtra ?? ""}</Types>`);
  files["xl/styles.xml"] = strToU8(opts.styles ?? `<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`);
  files["docProps/app.xml"] = strToU8(opts.meta ?? "<Properties><Application>Microsoft Excel</Application></Properties>");
  for (const [k, v] of Object.entries(opts.extra ?? {})) files[k] = typeof v === "string" ? strToU8(v) : v;
  return zipSync(files);
}

const LEDGER_HEADER = ["transaction_id", "date", "cash_account_code", "description", "receipt", "payment", "activity", "cash_flow_line"];
const ledgerRows = (): Cell[][] => [
  LEDGER_HEADER,
  ["T1", "2025-03-01", "1000", "Customers", { n: "1500000.50" }, null, "OPERATING", "Receipts from customers"],
  ["T2", "2025-04-01", "1000", "Suppliers", null, { n: "400000" }, "OPERATING", "Payments to suppliers"],
];
const base = { companyId: "c1", periodRole: "CURRENT", reportingPeriodId: "FY2025", currency: "TZS", scale: 2 } as const;
const ingest = (bytes: Uint8Array, over: Partial<{ sheetName: string; evidenceType: EvidenceType; fileName: string }> = {}) =>
  ingestWorkbook({ ...base, evidenceType: over.evidenceType ?? "TRANSACTION_LEDGER", bytes, sheetName: over.sheetName ?? "Ledger", fileName: over.fileName ?? "ledger.xlsx" });
const codes = (r: ReturnType<typeof ingest>) => (r.outcome === "PARSED" ? r.batch.diagnostics.map((d) => d.code) : r.diagnostics.map((d) => d.code));

describe("xlsx intake — happy path and determinism", () => {
  it("reads the chosen sheet into exact decimal strings with a Sheet!row locator per data row", () => {
    const r = ingest(build([{ name: "Ledger", rows: ledgerRows() }]));
    expect(r.outcome).toBe("PARSED");
    if (r.outcome !== "PARSED") return;
    expect(r.batch.validationStatus).toBe("VALID");
    expect(r.batch.document.rows[0][4]).toBe("1500000.50");
    expect(r.batch.document.sourceFormat).toBe("XLSX");
    expect(r.batch.document.sourceSheet).toBe("Ledger");
    expect(r.batch.document.rowLocators).toEqual(["Ledger!A2:H2", "Ledger!A3:H3"]);
    expect(JSON.stringify(r.batch.document)).not.toMatch(/:\s*\d/); // no JSON numbers
  });

  it("output depends only on cell values: workbook metadata, inline-vs-shared strings and part order do not change the content hash", () => {
    const a = ingest(build([{ name: "Ledger", rows: ledgerRows() }]));
    const b = ingest(build([{ name: "Ledger", rows: ledgerRows() }], { meta: "<Properties><Application>LibreOffice</Application><Created>2001-01-01</Created></Properties>", inline: true }));
    if (a.outcome !== "PARSED" || b.outcome !== "PARSED") throw new Error("not parsed");
    expect(b.batch.contentHash).toBe(a.batch.contentHash);
    expect(b.batch.replayIdentity).toBe(a.batch.replayIdentity);
    expect(b.batch.document.sourceFileSha256).not.toBe(a.batch.document.sourceFileSha256); // the container differs; the content identity does not
  });

  it("requires an explicit sheet: with none given it lists them and reads nothing", () => {
    const r = ingestWorkbook({ ...base, evidenceType: "BUDGET", bytes: build([{ name: "A", rows: [["x"]] }, { name: "B", rows: [["y"]], state: "hidden" }]) });
    expect(r).toMatchObject({ outcome: "SHEET_SELECTION_REQUIRED", sheets: [{ name: "A", state: "visible" }, { name: "B", state: "hidden" }] });
  });

  it("supports the five accepted families and refuses the rest with a clear code", () => {
    const eq = ingestWorkbook({ ...base, evidenceType: "EQUITY_MOVEMENTS", sheetName: "E", bytes: build([{ name: "E", rows: [["component", "movement_type", "amount"], ["Share capital", "OPENING_BALANCE", { n: "1000" }]] }]) });
    expect(eq.outcome === "PARSED" && eq.batch.validationStatus).toBe("VALID");
    for (const t of ["NOTES_AND_POLICIES", "PRIOR_PERIOD_STATEMENTS", "CASH_ACCOUNT_MAP", "EXTRACTED_CANDIDATES"] as const) {
      expect(ingestWorkbook({ ...base, evidenceType: t, sheetName: "x", bytes: build([{ name: "x", rows: [["a"]] }]) }), t).toMatchObject({ outcome: "REJECTED", diagnostics: [{ code: "XLSX_NOT_SUPPORTED_FOR_TYPE" }] });
    }
  });

  it("CSV intake is unchanged and still refuses a workbook passed as text", () => {
    expect(ingestEvidence({ ...base, evidenceType: "BUDGET", text: "line_key,line_label,nature,original_budget\nk,l,REVENUE,1\n" }).outcome).toBe("PARSED");
    expect(ingestEvidence({ ...base, evidenceType: "BUDGET", fileName: "b.xlsx", text: "x" })).toMatchObject({ outcome: "REJECTED" });
  });
});

describe("xlsx intake — exact numbers", () => {
  it("exactDecimalText: plain decimals pass, E-notation is shifted arithmetically, junk is refused", () => {
    const cases: [string, string | null][] = [["12.50", "12.50"], ["-0.1", "-0.1"], ["1.2345E+7", "12345000"], ["1.5e-3", "0.0015"], ["1E2", "100"], ["-2.5E1", "-25"], ["123456789012345678901234.56", "123456789012345678901234.56"], ["1e99", null], ["abc", null], ["1,5", null], ["0x10", null], [" 7 ", "7"]];
    for (const [raw, want] of cases) expect(exactDecimalText(raw), raw).toBe(want);
  });

  it("a 30-digit amount survives untouched (no double in the path)", () => {
    const r = ingest(build([{ name: "Ledger", rows: [LEDGER_HEADER, ["T1", "2025-03-01", "1000", "x", { n: "123456789012345678901234.56" }, null, "OPERATING", "Big"]] }]));
    expect(r.outcome === "PARSED" && r.batch.document.rows[0][4]).toBe("123456789012345678901234.56");
  });

  it("floating-point noise is refused by the scale rule, never rounded", () => {
    const r = ingest(build([{ name: "Ledger", rows: [LEDGER_HEADER, ["T1", "2025-03-01", "1000", "x", { n: "0.30000000000000004" }, null, "OPERATING", "L"]] }]));
    expect(codes(r)).toContain("AMOUNT_PRECISION_EXCEEDS_SCALE");
  });

  it("date-formatted numbers are an error (dates must be text); booleans and error cells are errors", () => {
    const r = ingest(build([{ name: "Ledger", rows: [LEDGER_HEADER, ["T1", { n: "45731", style: 1 }, "1000", "x", { n: "1" }, null, "OPERATING", "L"], ["T2", "2025-03-02", "1000", "y", { b: true }, null, "OPERATING", "L"], ["T3", "2025-03-03", "1000", "z", { e: "#DIV/0!" }, null, "OPERATING", "L"]] }]));
    expect(codes(r)).toEqual(expect.arrayContaining(["DATE_CELL_NOT_TEXT", "BOOLEAN_CELL", "ERROR_CELL"]));
    expect(r.outcome === "PARSED" && r.batch.validationStatus).toBe("INVALID");
  });
});

describe("xlsx intake — formulas, structure and disclosure", () => {
  it("formulas are an ERROR and their cached results are never used", () => {
    const r = ingest(build([{ name: "Ledger", rows: [LEDGER_HEADER, ["T1", "2025-03-01", "1000", "x", { f: "SUM(1,2)", v: "999" }, null, "OPERATING", "L"]] }]));
    expect(codes(r)).toContain("FORMULA_AS_AUTHORITY");
    if (r.outcome !== "PARSED") throw new Error("not parsed");
    expect(r.batch.validationStatus).toBe("INVALID");
    expect(JSON.stringify(r.batch.document.rows)).not.toContain("999");
    expect(r.batch.diagnostics.find((d) => d.code === "FORMULA_AS_AUTHORITY")!.message).toContain("E2");
  });

  it("merged cells are an error; hidden rows and columns are disclosed but read", () => {
    const r = ingest(build([{ name: "Ledger", rows: ledgerRows(), merges: ["A1:B1"], hiddenRows: [3], hiddenCols: [[4, 4]] }]));
    expect(codes(r)).toEqual(expect.arrayContaining(["MERGED_CELLS", "HIDDEN_ROWS", "HIDDEN_COLUMNS"]));
    if (r.outcome !== "PARSED") throw new Error("not parsed");
    expect(r.batch.document.rows).toHaveLength(2);
    expect(r.batch.diagnostics.find((d) => d.code === "HIDDEN_ROWS")!.message).toContain("3");
  });

  it("a hidden sheet needs explicit selection and is disclosed; a very-hidden sheet is refused; other hidden sheets are disclosed", () => {
    const wb = build([{ name: "Ledger", rows: ledgerRows(), state: "hidden" }, { name: "Vault", rows: ledgerRows(), state: "veryHidden" }, { name: "Other", rows: [["x"]] }]);
    expect(codes(ingest(wb))).toContain("HIDDEN_SHEET");
    expect(ingest(wb, { sheetName: "Vault" })).toMatchObject({ outcome: "REJECTED", diagnostics: [{ code: "VERY_HIDDEN_SHEET_REFUSED" }] });
    expect(codes(ingest(wb, { sheetName: "Other" }))).toContain("OTHER_HIDDEN_SHEETS");
    expect(ingest(wb, { sheetName: "Nope" })).toMatchObject({ diagnostics: [{ code: "SHEET_NOT_FOUND" }] });
  });

  it("duplicate headers and untrusted text are caught by the same contract as CSV", () => {
    const dup = ingest(build([{ name: "Ledger", rows: [["transaction_id", "transaction_id", ...LEDGER_HEADER.slice(2)], ["T1", "T1", "1000", "x", { n: "1" }, null, "OPERATING", "L"]] }]));
    expect(codes(dup)).toContain("DUPLICATE_COLUMN");
    const inj = ingest(build([{ name: "Ledger", rows: [LEDGER_HEADER, ["T1", "2025-03-01", "1000", "=HYPERLINK(\"http://evil\")", { n: "1" }, null, "OPERATING", "L"]] }]));
    expect(codes(inj)).toContain("FORMULA_INJECTION");
    const html = ingest(build([{ name: "Ledger", rows: [LEDGER_HEADER, ["T1", "2025-03-01", "1000", "<script>alert(1)</script>", { n: "1" }, null, "OPERATING", "L"]] }]));
    expect(codes(html)).toContain("MARKUP_IN_TEXT");
    expect(html.outcome === "PARSED" && html.batch.document.rows[0][3]).toBe("<script>alert(1)</script>"); // stored and shown as text only
  });

  it("row, column and size limits are enforced", () => {
    const wide = build([{ name: "Ledger", rows: [Array.from({ length: 41 }, (_, i) => `c${i}`), Array.from({ length: 41 }, () => "x")] }]);
    expect(ingest(wide)).toMatchObject({ outcome: "REJECTED", diagnostics: [{ code: "TOO_MANY_COLUMNS" }] });
    expect(ingest(new Uint8Array(XLSX_LIMITS.maxBytes + 1))).toMatchObject({ outcome: "REJECTED", diagnostics: [{ code: "FILE_TOO_LARGE" }] });
  });
});

describe("xlsx intake — hostile packages", () => {
  const ok = (): Record<string, string> => ({});
  it("legacy binary / encrypted (CFB), non-zip and empty files are refused", () => {
    const cfb = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]);
    expect(ingest(cfb)).toMatchObject({ outcome: "REJECTED", diagnostics: [{ code: "ENCRYPTED_OR_LEGACY_BINARY_WORKBOOK" }] });
    expect(ingest(strToU8("hello,world\n1,2"))).toMatchObject({ diagnostics: [{ code: "NOT_A_WORKBOOK" }] });
    expect(ingest(new Uint8Array())).toMatchObject({ diagnostics: [{ code: "EMPTY_FILE" }] });
  });

  it("an OOXML package that carries an EncryptedPackage part is refused as encrypted", () => {
    expect(ingest(build([{ name: "Ledger", rows: ledgerRows() }], { extra: { EncryptedPackage: "x" } }))).toMatchObject({ diagnostics: [{ code: "ENCRYPTED_WORKBOOK" }] });
  });

  it("macros, ActiveX, embedded objects and external links refuse the whole file", () => {
    const sheets = [{ name: "Ledger", rows: ledgerRows() }];
    expect(ingest(build(sheets, { extra: { "xl/vbaProject.bin": new Uint8Array([1, 2, 3]) } }))).toMatchObject({ diagnostics: [{ code: "MACROS_NOT_ALLOWED" }] });
    expect(ingest(build(sheets, { contentTypesExtra: '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/>' }))).toMatchObject({ diagnostics: [{ code: "MACROS_NOT_ALLOWED" }] });
    expect(ingest(build(sheets, { extra: { "xl/activeX/activeX1.xml": "<x/>" } }))).toMatchObject({ diagnostics: [{ code: "EMBEDDED_OBJECTS_NOT_ALLOWED" }] });
    expect(ingest(build(sheets, { extra: { "xl/embeddings/oleObject1.bin": new Uint8Array([1]) } }))).toMatchObject({ diagnostics: [{ code: "EMBEDDED_OBJECTS_NOT_ALLOWED" }] });
    expect(ingest(build(sheets, { extra: { "xl/externalLinks/externalLink1.xml": "<externalLink/>" } }))).toMatchObject({ diagnostics: [{ code: "EXTERNAL_LINKS_NOT_ALLOWED" }] });
    expect(ingest(build(sheets, { workbookExtra: '<externalReferences><externalReference r:id="rId9"/></externalReferences>' }))).toMatchObject({ diagnostics: [{ code: "EXTERNAL_LINKS_NOT_ALLOWED" }] });
    void ok;
  });

  it("XML entity attacks (XXE / billion laughs) and malformed XML are refused, not expanded", () => {
    const evil = build([{ name: "Ledger", rows: ledgerRows() }], { extra: { "xl/sharedStrings.xml": '<?xml version="1.0"?><!DOCTYPE sst [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><sst><si><t>&b;</t></si></sst>' } });
    expect(ingest(evil)).toMatchObject({ outcome: "REJECTED", diagnostics: [{ code: "WORKBOOK_XML_INVALID" }] });
    const broken = build([{ name: "Ledger", rows: ledgerRows() }], { extra: { "xl/worksheets/sheet1.xml": "<worksheet><sheetData><row></sheetData></worksheet>" } });
    expect(ingest(broken)).toMatchObject({ diagnostics: [{ code: "WORKBOOK_XML_INVALID" }] });
  });

  it("a zip bomb (declared uncompressed size beyond the limit) is refused before it is inflated", () => {
    const bomb = build([{ name: "Ledger", rows: ledgerRows() }], { extra: { "xl/worksheets/bomb.xml": new Uint8Array(XLSX_LIMITS.maxEntryBytes + 1024) } });
    expect(bomb.length).toBeLessThan(XLSX_LIMITS.maxBytes);
    expect(ingest(bomb)).toMatchObject({ outcome: "REJECTED", diagnostics: [{ code: "ZIP_TOO_LARGE_UNCOMPRESSED" }] });
  });

  it("path-traversal part names are refused", () => {
    expect(ingest(build([{ name: "Ledger", rows: ledgerRows() }], { extra: { "../evil.xml": "<x/>" } }))).toMatchObject({ diagnostics: [{ code: "ZIP_PATH_TRAVERSAL" }] });
  });

  it("inspectWorkbook reads no cell and discloses visibility", () => {
    const i = inspectWorkbook(build([{ name: "A", rows: [["x"]] }, { name: "B", rows: [["y"]], state: "hidden" }]));
    expect(i.ok && i.sheets.map((s) => s.state)).toEqual(["visible", "hidden"]);
  });

  it("readWorkbookSheet is deterministic", () => {
    const wb = build([{ name: "Ledger", rows: ledgerRows() }]);
    expect(JSON.stringify(readWorkbookSheet(wb, "Ledger"))).toBe(JSON.stringify(readWorkbookSheet(wb, "Ledger")));
  });
});

describe("one canonical ingestion contract: CSV and XLSX converge", () => {
  const CSV = "transaction_id,date,cash_account_code,description,receipt,payment,activity,cash_flow_line\nT1,2025-03-01,1000,Customers,1500000.50,,OPERATING,Receipts from customers\nT2,2025-04-01,1000,Suppliers,,400000,OPERATING,Payments to suppliers\n";
  const csv = () => {
    const r = ingestEvidence({ ...base, evidenceType: "TRANSACTION_LEDGER", text: CSV, fileName: "ledger.csv" });
    if (r.outcome !== "PARSED") throw new Error("csv rejected");
    return r.batch;
  };
  const xlsx = (rows = ledgerRows()) => {
    const r = ingest(build([{ name: "Ledger", rows }]));
    if (r.outcome !== "PARSED") throw new Error("xlsx rejected");
    return r.batch;
  };

  it("the same reviewed evidence as CSV and as a workbook has ONE canonical identity (content hash, replay identity, batch id)", () => {
    const a = csv();
    const b = xlsx();
    expect(a.validationStatus).toBe("VALID");
    expect(b.validationStatus).toBe("VALID");
    expect(b.contentHash).toBe(a.contentHash);
    expect(b.replayIdentity).toBe(a.replayIdentity);
    expect(b.evidenceBatchId).toBe(a.evidenceBatchId);
    expect(b.document.rows).toEqual(a.document.rows);
    // provenance differs and is recorded, but never enters the identity
    expect(a.document.sourceFormat).toBe("CSV");
    expect(b.document.sourceFormat).toBe("XLSX");
    expect(b.document.sourceSheet).toBe("Ledger");
    expect(b.document.sourceFileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.document.sourceFileSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("supplying the same evidence again in the OTHER format is an exact replay, and a different value is a different identity", () => {
    expect(xlsx().replayIdentity).toBe(csv().replayIdentity);
    const changed = ledgerRows();
    changed[1][4] = { n: "1500000.51" };
    expect(xlsx(changed).replayIdentity).not.toBe(csv().replayIdentity);
    expect(xlsx(changed).contentHash).not.toBe(csv().contentHash);
  });

  it("the workbook's sheet name, hidden sheets and metadata never change the identity", () => {
    const withHidden = ingest(build([{ name: "Ledger", rows: ledgerRows() }, { name: "Scratch", rows: [["x"]], state: "hidden" }]));
    if (withHidden.outcome !== "PARSED") throw new Error("rejected");
    expect(withHidden.batch.contentHash).toBe(csv().contentHash);
    const renamed = ingestWorkbook({ ...base, evidenceType: "TRANSACTION_LEDGER", bytes: build([{ name: "Q1 ledger", rows: ledgerRows() }]), sheetName: "Q1 ledger" });
    if (renamed.outcome !== "PARSED") throw new Error("rejected");
    expect(renamed.batch.contentHash).toBe(csv().contentHash);
  });
});

describe("xlsx intake — further hostile inputs, with strict limits", () => {
  const cellsOf = (value: string): Cell[][] => [LEDGER_HEADER, ["T1", "2025-03-01", "1000", value, { n: "10" }, null, "OPERATING", "Receipts"]];
  const rowsWith = (col: number, value: string): Cell[][] => {
    const r = ledgerRows();
    r[1][col] = value;
    return r;
  };
  const invalid = (rows: Cell[][]) => {
    const r = ingest(build([{ name: "Ledger", rows }]));
    return r.outcome === "PARSED" && r.batch.validationStatus === "INVALID" ? r.batch.diagnostics.filter((d) => d.severity === "ERROR").map((d) => d.code) : null;
  };

  it("malformed and truncated zip archives are refused, never partially read", () => {
    const good = build([{ name: "Ledger", rows: ledgerRows() }]);
    const truncated = good.slice(0, Math.floor(good.length / 2));
    expect(ingest(truncated)).toMatchObject({ outcome: "REJECTED", diagnostics: [{ code: "ZIP_CORRUPT" }] });
    const noDirectory = good.slice(0, good.length - 30); // the end-of-central-directory record is gone
    expect(ingest(noDirectory)).toMatchObject({ outcome: "REJECTED" });
    const corrupted = good.slice();
    for (let i = 0; i < 40; i++) corrupted[good.length - 60 + i] = 0xff; // central directory smashed
    expect(ingest(corrupted)).toMatchObject({ outcome: "REJECTED" });
    expect(ingest(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]))).toMatchObject({ outcome: "REJECTED" });
    for (const bytes of [good.slice(0, 4), good.slice(0, 22), new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)])]) expect(ingest(bytes).outcome).toBe("REJECTED");
  });

  it("a package with too many parts and one that expands beyond the total limit are refused before inflation", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < XLSX_LIMITS.maxEntries + 5; i++) many[`xl/worksheets/extra${i}.xml`] = "<x/>";
    expect(ingest(build([{ name: "Ledger", rows: ledgerRows() }], { extra: many }))).toMatchObject({ outcome: "REJECTED", diagnostics: [{ code: "ZIP_TOO_MANY_ENTRIES" }] });
    const parts: Record<string, Uint8Array> = {};
    for (let i = 0; i < 3; i++) parts[`xl/worksheets/big${i}.xml`] = new Uint8Array(XLSX_LIMITS.maxEntryBytes - 1024); // each under the entry limit, together over the total
    expect(ingest(build([{ name: "Ledger", rows: ledgerRows() }], { extra: parts }))).toMatchObject({ outcome: "REJECTED", diagnostics: [{ code: "ZIP_TOO_LARGE_UNCOMPRESSED" }] });
  });

  it("a header that lies about the uncompressed size cannot make the reader inflate or accept more than it declared", () => {
    const wb = build([{ name: "Ledger", rows: ledgerRows() }], { extra: { "xl/worksheets/lie.xml": new Uint8Array(200_000) } });
    // shrink every declared uncompressed size (central directory 0x02014b50 @ +24, local header 0x04034b50 @ +22) to 10 bytes
    const lied = wb.slice();
    const view = new DataView(lied.buffer);
    for (let i = 0; i + 30 < lied.length; i++) {
      const sig = view.getUint32(i, true);
      if (sig === 0x02014b50) view.setUint32(i + 24, 10, true);
      if (sig === 0x04034b50) view.setUint32(i + 22, 10, true);
    }
    const started = Date.now();
    const r = ingest(lied);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.outcome === "PARSED" ? r.batch.validationStatus !== "VALID" : true).toBe(true);
  });

  it("formula-like text, direction overrides, zero-width and control characters in any cell are refused (never stored as usable evidence)", () => {
    for (const payload of ["=cmd|' /C calc'!A0", "+1+1", "-2+3+cmd", "@SUM(A1)", "＝1+1", "\t=1+1"]) expect(invalid(cellsOf(payload)), payload).toContain("FORMULA_INJECTION");
    expect(invalid(cellsOf("Customers\u202Efdp.exe"))).toContain("HIDDEN_CHARACTER");
    expect(invalid(cellsOf("Customers\u200Bltd"))).toContain("HIDDEN_CHARACTER");
    expect(invalid(cellsOf("Customers\u0007"))).toContain("CONTROL_CHARACTER");
  });

  it("locale-dependent numbers and dates are NEVER interpreted: they must be given in the one explicit form", () => {
    for (const amount of ["1.234,56", "1,5", "1 234.56", "(500.00)", "١٢٣", "1e3x", "1_000"]) expect(invalid(rowsWith(4, amount)), amount).not.toBeNull();
    for (const date of ["01/02/2025", "2025/03/01", "1 Mar 2025", "2025-3-1", "2025-02-30", "٢٠٢٥-٠٣-٠١"]) expect(invalid(rowsWith(1, date)), date).toContain("DATE_NOT_ISO");
    const eNotation = ledgerRows();
    eNotation[1][4] = { n: "1.5E+6" };
    const r = ingest(build([{ name: "Ledger", rows: eNotation }]));
    expect(r.outcome === "PARSED" && r.batch.document.rows[0][4]).toBe("1500000"); // exact arithmetic, no float
  });

  it("no silent coercion: a blank required cell, a boolean and a spreadsheet error are errors, not zero or false", () => {
    expect(invalid(rowsWith(4, ""))).not.toBeNull(); // receipt AND payment both blank
    const r = ledgerRows();
    r[1][4] = { b: true };
    expect(codes(ingest(build([{ name: "Ledger", rows: r }])))).toContain("BOOLEAN_CELL");
    const e = ledgerRows();
    e[1][4] = { e: "#DIV/0!" };
    expect(codes(ingest(build([{ name: "Ledger", rows: e }])))).toContain("ERROR_CELL");
  });

  it("processing time is bounded: a clock that runs past the limit stops the read with a precise refusal and no partial result", () => {
    const rows: Cell[][] = [LEDGER_HEADER];
    for (let i = 0; i < 600; i++) rows.push([`T${i}`, "2025-03-01", "1000", "x", { n: "1" }, null, "OPERATING", "Receipts"]);
    const wb = build([{ name: "Ledger", rows }]);
    let t = 0;
    const r = ingestWorkbook({ ...base, evidenceType: "TRANSACTION_LEDGER", bytes: wb, sheetName: "Ledger", now: () => (t += XLSX_LIMITS.maxMillis) });
    expect(r).toMatchObject({ outcome: "REJECTED", diagnostics: [{ code: "PROCESSING_TIME_LIMIT" }] });
    // a fast clock reads the very same file completely
    expect(ingestWorkbook({ ...base, evidenceType: "TRANSACTION_LEDGER", bytes: wb, sheetName: "Ledger", now: () => 0 }).outcome).toBe("PARSED");
  });

  it("strict structural limits: rows, columns, bytes — each refused with its own code", () => {
    const wide: Cell[][] = [Array.from({ length: 41 }, (_, i) => `c${i}`), Array.from({ length: 41 }, () => "1")];
    expect(ingest(build([{ name: "Ledger", rows: wide }]))).toMatchObject({ outcome: "REJECTED", diagnostics: [{ code: "TOO_MANY_COLUMNS" }] });
    const long: Cell[][] = [["a"]];
    for (let i = 0; i < 20_100; i++) long.push([`v${i}`]);
    expect(ingest(build([{ name: "Ledger", rows: long }]))).toMatchObject({ outcome: "REJECTED", diagnostics: [{ code: "TOO_MANY_ROWS" }] });
    expect(ingest(new Uint8Array(XLSX_LIMITS.maxBytes + 1).fill(0x50))).toMatchObject({ outcome: "REJECTED", diagnostics: [{ code: "FILE_TOO_LARGE" }] });
  });

  it("unsupported binary spreadsheet formats are refused by content even when misnamed as .xlsx", () => {
    expect(ingest(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]), { fileName: "ledger.xlsx" })).toMatchObject({ outcome: "REJECTED", diagnostics: [{ code: "ENCRYPTED_OR_LEGACY_BINARY_WORKBOOK" }] });
    for (const name of ["a.xlsb", "a.xls", "a.ods"]) expect(ingestEvidence({ ...base, evidenceType: "BUDGET", fileName: name, text: "x" })).toMatchObject({ outcome: "REJECTED" });
  });
});
