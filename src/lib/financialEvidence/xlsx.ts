// financialEvidence/xlsx.ts — secure, values-only XLSX intake.
//
// Why not SheetJS (the `xlsx` package already in this repository, used only to WRITE
// exports): version 0.18.5 is affected by CVE-2023-30533 (prototype pollution when reading
// a crafted file) and CVE-2024-22363 (ReDoS), and it hands back IEEE doubles, which cannot
// carry an exact decimal. This reader therefore reads the OOXML package directly on top of
// fflate (a zip inflater, not a spreadsheet stack) and keeps the file's own decimal TEXT.
//
// Policy, all of it enforced here and tested:
//   * only a real OOXML zip is accepted; encrypted packages and legacy binary (.xls / CFB) are refused;
//   * macros (vbaProject), ActiveX, embedded objects and EXTERNAL LINKS refuse the whole file;
//   * a formula in any cell is an ERROR — cached results are never used as accounting authority;
//   * the sheet is chosen explicitly; a hidden sheet is disclosed, a very-hidden one refused;
//   * hidden rows and columns are disclosed; merged cells are an ERROR (header/data ambiguity);
//   * numbers are taken from the stored decimal text, never through a double; dates must be
//     text (a date-formatted numeric cell is an ERROR — no metadata-dependent conversion);
//   * nothing is executed, no XML entity beyond the five predefined ones and numeric references
//     is honoured, and DOCTYPE/ENTITY declarations are refused (no XXE / entity expansion);
//   * output depends only on the cell values: the content hash covers the sheet name and the
//     records, so re-saving the same values in a different application is an exact replay;
//   * every data row carries a "Sheet!A5:H5" locator.

import { unzipSync, strFromU8 } from "fflate";
import { sha256Hex } from "@/lib/canonicalStatement/serialization";
import { canonicalIdentityOf, INTAKE_LIMITS, ingestRecords, type IntakeCommon, type IntakeResult } from "./intake";
import type { EvidenceDiagnostic, EvidenceType } from "./types";

export const XLSX_LIMITS = { maxBytes: 5_000_000, maxEntries: 300, maxEntryBytes: 30_000_000, maxTotalBytes: 60_000_000, maxXmlDepth: 64, maxDisclosed: 20, maxMillis: 5_000 } as const;

/** The five families that accept a workbook. Everything else remains CSV-only. */
export const XLSX_EVIDENCE_TYPES: readonly EvidenceType[] = ["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "BUDGET", "IPSAS_CASH_RECEIPTS_PAYMENTS", "SUPPORTING_SCHEDULE"];

const err = (code: string, message: string, extra: Partial<EvidenceDiagnostic> = {}): EvidenceDiagnostic => ({ code, severity: "ERROR", message, ...extra });
const warn = (code: string, message: string, extra: Partial<EvidenceDiagnostic> = {}): EvidenceDiagnostic => ({ code, severity: "WARNING", message, ...extra });

// ─── minimal, safe XML ─────────────────────────────────────────────────────

interface XmlNode {
  readonly name: string; // local name, namespace prefix removed
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: XmlNode[];
  text: string;
}

class XmlError extends Error {}

function decodeEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_m, e: string) => {
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "amp") return "&";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new XmlError("invalid character reference");
    return String.fromCodePoint(code);
  });
}

function parseXml(xml: string): XmlNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new XmlError("DOCTYPE/ENTITY declarations are not allowed");
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    const top = stack[stack.length - 1];
    if (lt < 0) {
      top.text += decodeEntities(xml.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(xml.slice(i, lt));
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end < 0) throw new XmlError("unterminated comment");
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) throw new XmlError("unterminated CDATA");
      top.text += xml.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end < 0) throw new XmlError("unterminated processing instruction");
      i = end + 2;
      continue;
    }
    const gt = xml.indexOf(">", lt + 1);
    if (gt < 0) throw new XmlError("unterminated tag");
    const inner = xml.slice(lt + 1, gt);
    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim().replace(/^.*:/, "");
      const closed = stack.pop();
      if (!closed || closed.name !== name || stack.length === 0) throw new XmlError(`mismatched closing tag ${name}`);
      i = gt + 1;
      continue;
    }
    const selfClose = inner.endsWith("/");
    const body = selfClose ? inner.slice(0, -1) : inner;
    const m = /^([^\s/>]+)([\s\S]*)$/.exec(body);
    if (!m) throw new XmlError("malformed tag");
    const attrs: Record<string, string> = {};
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    for (let a = attrRe.exec(m[2]); a; a = attrRe.exec(m[2])) attrs[a[1].replace(/^.*:/, "")] = decodeEntities(a[3] ?? a[4] ?? "");
    const node: XmlNode = { name: m[1].replace(/^.*:/, ""), attrs, children: [], text: "" };
    top.children.push(node);
    if (!selfClose) {
      if (stack.length >= XLSX_LIMITS.maxXmlDepth) throw new XmlError("XML nesting too deep");
      stack.push(node);
    }
    i = gt + 1;
  }
  if (stack.length !== 1) throw new XmlError("unclosed element");
  return root;
}

const child = (n: XmlNode | undefined, name: string): XmlNode | undefined => n?.children.find((c) => c.name === name);
const kids = (n: XmlNode | undefined, name: string): XmlNode[] => n?.children.filter((c) => c.name === name) ?? [];
/** Text of a shared/inline string: only <t> content counts (pretty-print whitespace between elements never does); phonetic runs are skipped. */
const textOf = (n: XmlNode): string => (n.name === "t" ? n.text : n.children.filter((c) => c.name !== "rPh" && c.name !== "phoneticPr").map(textOf).join(""));

// ─── package ────────────────────────────────────────────────────────────────

type Files = Record<string, Uint8Array>;
type Opened = { readonly ok: true; readonly files: Files } | { readonly ok: false; readonly diagnostics: EvidenceDiagnostic[] };

function open(bytes: Uint8Array): Opened {
  if (bytes.length === 0) return { ok: false, diagnostics: [err("EMPTY_FILE", "The workbook is empty.")] };
  if (bytes.length > XLSX_LIMITS.maxBytes) return { ok: false, diagnostics: [err("FILE_TOO_LARGE", `The workbook exceeds ${XLSX_LIMITS.maxBytes.toLocaleString("en-US")} bytes.`)] };
  const b = bytes;
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) {
    return { ok: false, diagnostics: [err("ENCRYPTED_OR_LEGACY_BINARY_WORKBOOK", "This is a legacy binary (.xls) or password-protected/encrypted workbook. Neither is accepted: save an unencrypted .xlsx, or export CSV.")] };
  }
  if (!(b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05))) {
    return { ok: false, diagnostics: [err("NOT_A_WORKBOOK", "The file is not an .xlsx (OOXML zip) package.")] };
  }
  let total = 0;
  let entries = 0;
  let violation: EvidenceDiagnostic | null = null;
  let files: Files;
  try {
    files = unzipSync(b, {
      filter(f) {
        entries += 1;
        total += f.originalSize;
        if (entries > XLSX_LIMITS.maxEntries) violation ??= err("ZIP_TOO_MANY_ENTRIES", "The package holds too many parts.");
        if (f.originalSize > XLSX_LIMITS.maxEntryBytes || total > XLSX_LIMITS.maxTotalBytes) violation ??= err("ZIP_TOO_LARGE_UNCOMPRESSED", "The package expands to an unreasonable size and was refused (possible zip bomb).");
        if (/(^|\/)\.\.(\/|$)|^\/|\\/.test(f.name)) violation ??= err("ZIP_PATH_TRAVERSAL", `The package contains an unsafe part name "${f.name.slice(0, 60)}".`);
        // Only what this reader understands is inflated; nothing else is ever decompressed.
        return !violation && (/^\[Content_Types\]\.xml$/.test(f.name) || /^xl\/(workbook\.xml|styles\.xml|sharedStrings\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml|externalLinks\/|vbaProject\.bin|activeX\/|embeddings\/)/.test(f.name) || /EncryptedPackage|EncryptionInfo/.test(f.name));
      },
    });
  } catch {
    return { ok: false, diagnostics: [err("ZIP_CORRUPT", "The package could not be read as a valid zip archive.")] };
  }
  if (violation) return { ok: false, diagnostics: [violation] };
  const names = Object.keys(files);
  if (names.some((x) => /EncryptedPackage|EncryptionInfo/.test(x))) return { ok: false, diagnostics: [err("ENCRYPTED_WORKBOOK", "The workbook is password-protected/encrypted and is refused.")] };
  if (names.some((x) => /^xl\/vbaProject\.bin$/.test(x)) || /macroEnabled|vbaProject/.test(strFromU8(files["[Content_Types].xml"] ?? new Uint8Array()))) {
    return { ok: false, diagnostics: [err("MACROS_NOT_ALLOWED", "The workbook contains macros (VBA). Macro-enabled files are refused; save a plain .xlsx.")] };
  }
  if (names.some((x) => /^xl\/(activeX|embeddings)\//.test(x))) return { ok: false, diagnostics: [err("EMBEDDED_OBJECTS_NOT_ALLOWED", "The workbook contains embedded/ActiveX objects and is refused.")] };
  if (names.some((x) => /^xl\/externalLinks\//.test(x))) return { ok: false, diagnostics: [err("EXTERNAL_LINKS_NOT_ALLOWED", "The workbook links to external workbooks. External links are refused: figures must live in this file as values.")] };
  if (!files["xl/workbook.xml"]) return { ok: false, diagnostics: [err("NOT_A_WORKBOOK", "The package has no workbook part (xl/workbook.xml).")] };
  return { ok: true, files };
}

interface SheetRef {
  readonly name: string;
  readonly state: "visible" | "hidden" | "veryHidden";
  readonly path: string;
}

function listSheets(files: Files): { sheets: SheetRef[]; diagnostics: EvidenceDiagnostic[] } {
  const diagnostics: EvidenceDiagnostic[] = [];
  const wb = parseXml(strFromU8(files["xl/workbook.xml"]));
  const workbook = child(wb, "workbook");
  if (child(workbook, "externalReferences")) throw new XmlError("EXTERNAL_LINKS_NOT_ALLOWED");
  const rels = new Map<string, string>();
  const relsXml = files["xl/_rels/workbook.xml.rels"];
  if (relsXml) for (const r of kids(child(parseXml(strFromU8(relsXml)), "Relationships"), "Relationship")) {
    if (r.attrs.TargetMode === "External") throw new XmlError("EXTERNAL_LINKS_NOT_ALLOWED");
    rels.set(r.attrs.Id, r.attrs.Target);
  }
  const sheets: SheetRef[] = [];
  for (const s of kids(child(workbook, "sheets"), "sheet")) {
    const target = rels.get(s.attrs.id ?? "");
    if (!target) continue;
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
    const state = s.attrs.state === "hidden" ? "hidden" : s.attrs.state === "veryHidden" ? "veryHidden" : "visible";
    sheets.push({ name: s.attrs.name ?? "", state, path });
  }
  if (sheets.length === 0) diagnostics.push(err("NO_SHEETS", "The workbook has no readable worksheets."));
  const dup = sheets.map((s) => s.name).filter((n, i, a) => a.indexOf(n) !== i);
  for (const d of new Set(dup)) diagnostics.push(err("DUPLICATE_SHEET_NAME", `Two sheets are named "${d}".`));
  return { sheets, diagnostics };
}

export interface WorkbookSheetInfo {
  readonly name: string;
  readonly state: "visible" | "hidden" | "veryHidden";
}

export type WorkbookInspection =
  | { readonly ok: true; readonly sheets: readonly WorkbookSheetInfo[]; readonly diagnostics: readonly EvidenceDiagnostic[] }
  | { readonly ok: false; readonly diagnostics: readonly EvidenceDiagnostic[] };

/** Lists the sheets (with their visibility) so the user can choose one explicitly. Reads no cell. */
export function inspectWorkbook(bytes: Uint8Array): WorkbookInspection {
  const opened = open(bytes);
  if (!("files" in opened)) return { ok: false, diagnostics: opened.diagnostics };
  try {
    const { sheets, diagnostics } = listSheets(opened.files);
    const out: EvidenceDiagnostic[] = [...diagnostics];
    for (const s of sheets) {
      if (s.state === "hidden") out.push(warn("HIDDEN_SHEET", `Sheet "${s.name}" is hidden.`));
      if (s.state === "veryHidden") out.push(warn("VERY_HIDDEN_SHEET", `Sheet "${s.name}" is very-hidden and cannot be selected.`));
    }
    return { ok: !out.some((d) => d.severity === "ERROR"), sheets: sheets.map((s) => ({ name: s.name, state: s.state })), diagnostics: out } as WorkbookInspection;
  } catch (e) {
    return { ok: false, diagnostics: [err(e instanceof XmlError && e.message === "EXTERNAL_LINKS_NOT_ALLOWED" ? "EXTERNAL_LINKS_NOT_ALLOWED" : "WORKBOOK_XML_INVALID", e instanceof XmlError && e.message === "EXTERNAL_LINKS_NOT_ALLOWED" ? "The workbook links to external sources and is refused." : `The workbook structure is invalid: ${e instanceof Error ? e.message : "unreadable"}.`)] };
  }
}

// ─── cells ──────────────────────────────────────────────────────────────────

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function dateStyles(files: Files): Set<number> {
  const out = new Set<number>();
  const raw = files["xl/styles.xml"];
  if (!raw) return out;
  const styles = child(parseXml(strFromU8(raw)), "styleSheet");
  const custom = new Map<number, string>();
  for (const f of kids(child(styles, "numFmts"), "numFmt")) custom.set(Number(f.attrs.numFmtId), f.attrs.formatCode ?? "");
  kids(child(styles, "cellXfs"), "xf").forEach((xf, idx) => {
    const id = Number(xf.attrs.numFmtId ?? 0);
    const code = custom.get(id);
    const isDate = code !== undefined ? /[ymdhs]/i.test(code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "")) && !/^(0|#|\?|General)/i.test(code) : BUILTIN_DATE_FORMATS.has(id);
    if (isDate) out.add(idx);
  });
  return out;
}

function sharedStrings(files: Files): string[] {
  const raw = files["xl/sharedStrings.xml"];
  if (!raw) return [];
  return kids(child(parseXml(strFromU8(raw)), "sst"), "si").map((si) => textOf(si));
}

const colIndex = (letters: string): number => [...letters].reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
const colLetters = (idx: number): string => {
  let n = idx + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};
const splitRef = (ref: string): { col: number; row: number } | null => {
  const m = /^([A-Z]{1,3})(\d{1,7})$/.exec(ref);
  return m ? { col: colIndex(m[1]), row: Number(m[2]) } : null;
};

/** Exact decimal text from a stored number: plain decimals pass through; E-notation is shifted arithmetically; nothing goes through a double. */
export function exactDecimalText(raw: string): string | null {
  const v = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  const m = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(v);
  if (!m) return null;
  const [, sign, whole, frac = "", expText] = m;
  const exp = Number(expText);
  if (!Number.isInteger(exp) || Math.abs(exp) > 40) return null;
  const digits = whole + frac;
  const point = whole.length + exp;
  let out: string;
  if (point <= 0) out = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + "0".repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  out = out.replace(/^0+(?=\d)/, "");
  if (out.includes(".")) out = out.replace(/0+$/, "").replace(/\.$/, "");
  return `${sign}${out === "" ? "0" : out}`;
}

export interface SheetRead {
  readonly ok: true;
  readonly sheet: string;
  readonly records: string[][];
  readonly rowLocators: string[];
  readonly diagnostics: EvidenceDiagnostic[];
}

export function readWorkbookSheet(bytes: Uint8Array, sheetName: string, opts: { readonly now?: () => number } = {}): SheetRead | { readonly ok: false; readonly diagnostics: EvidenceDiagnostic[] } {
  const now = opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const started = now();
  const opened = open(bytes);
  if (!("files" in opened)) return { ok: false, diagnostics: [...opened.diagnostics] };
  const diagnostics: EvidenceDiagnostic[] = [];
  try {
    const { sheets, diagnostics: sheetDiags } = listSheets(opened.files);
    if (sheetDiags.some((d) => d.severity === "ERROR")) return { ok: false, diagnostics: sheetDiags };
    const ref = sheets.find((s) => s.name === sheetName);
    if (!ref) return { ok: false, diagnostics: [err("SHEET_NOT_FOUND", `The workbook has no sheet named "${sheetName}".`)] };
    if (ref.state === "veryHidden") return { ok: false, diagnostics: [err("VERY_HIDDEN_SHEET_REFUSED", `Sheet "${sheetName}" is very-hidden and is refused.`)] };
    if (ref.state === "hidden") diagnostics.push(warn("HIDDEN_SHEET", `Sheet "${sheetName}" is hidden; it was read only because you selected it explicitly.`));
    const hiddenOthers = sheets.filter((s) => s.name !== sheetName && s.state !== "visible").map((s) => s.name);
    if (hiddenOthers.length > 0) diagnostics.push(warn("OTHER_HIDDEN_SHEETS", `The workbook also has hidden sheet(s) that were not read: ${hiddenOthers.slice(0, XLSX_LIMITS.maxDisclosed).join(", ")}.`));
    const sheetBytes = opened.files[ref.path];
    if (!sheetBytes) return { ok: false, diagnostics: [err("SHEET_PART_MISSING", `The part for sheet "${sheetName}" is missing from the package.`)] };

    const strings = sharedStrings(opened.files);
    const dates = dateStyles(opened.files);
    const ws = child(parseXml(strFromU8(sheetBytes)), "worksheet");
    const merges = kids(child(ws, "mergeCells"), "mergeCell").map((m) => m.attrs.ref ?? "");
    if (merges.length > 0) diagnostics.push(err("MERGED_CELLS", `The sheet has ${merges.length} merged range(s) (${merges.slice(0, 10).join(", ")}). Merged cells make headers and rows ambiguous; unmerge them.`));
    const hiddenCols = kids(child(ws, "cols"), "col").filter((c) => c.attrs.hidden === "1" || c.attrs.hidden === "true").map((c) => `${colLetters(Number(c.attrs.min) - 1)}${c.attrs.max !== c.attrs.min ? `–${colLetters(Number(c.attrs.max) - 1)}` : ""}`);
    if (hiddenCols.length > 0) diagnostics.push(warn("HIDDEN_COLUMNS", `Hidden column(s): ${hiddenCols.slice(0, XLSX_LIMITS.maxDisclosed).join(", ")}. Their values were read.`));

    const grid = new Map<number, Map<number, string>>();
    const formulaCells: string[] = [];
    const hiddenRows: number[] = [];
    const cellErrors: EvidenceDiagnostic[] = [];
    let maxCol = -1;
    let rowCount = 0;
    let cells = 0;
    const overTime = () => now() - started > XLSX_LIMITS.maxMillis;
    const timeUp: { readonly ok: false; readonly diagnostics: EvidenceDiagnostic[] } = { ok: false, diagnostics: [err("PROCESSING_TIME_LIMIT", `Reading the sheet took longer than ${XLSX_LIMITS.maxMillis / 1000} seconds and was stopped.`)] };
    for (const row of kids(child(ws, "sheetData"), "row")) {
      rowCount += 1;
      if (overTime()) return timeUp;
      if (rowCount > INTAKE_LIMITS.maxRows + 50) return { ok: false, diagnostics: [err("TOO_MANY_ROWS", `The sheet has more than ${INTAKE_LIMITS.maxRows.toLocaleString("en-US")} data rows.`)] };
      const hidden = row.attrs.hidden === "1" || row.attrs.hidden === "true";
      let seq = 0;
      for (const c of kids(row, "c")) {
        cells += 1;
        if ((cells & 255) === 0 && overTime()) return timeUp;
        const rc = splitRef(c.attrs.r ?? "") ?? { col: seq, row: Number(row.attrs.r ?? rowCount) };
        seq = rc.col + 1;
        const at = `${colLetters(rc.col)}${rc.row}`;
        if (child(c, "f")) {
          formulaCells.push(at);
          continue; // the cached result is never used
        }
        const t = c.attrs.t ?? "n";
        const v = child(c, "v");
        let value = "";
        if (t === "s") {
          const idx = Number(v?.text ?? "");
          if (!Number.isInteger(idx) || idx < 0 || idx >= strings.length) cellErrors.push(err("SHARED_STRING_INDEX_INVALID", `Cell ${at} points at a missing shared string.`, { row: rc.row, column: colLetters(rc.col) }));
          else value = strings[idx];
        } else if (t === "inlineStr") value = textOf(child(c, "is") ?? { name: "is", attrs: {}, children: [], text: "" });
        else if (t === "str") value = v?.text ?? "";
        else if (t === "b") cellErrors.push(err("BOOLEAN_CELL", `Cell ${at} is a TRUE/FALSE value; enter text or a number.`, { row: rc.row, column: colLetters(rc.col) }));
        else if (t === "e") cellErrors.push(err("ERROR_CELL", `Cell ${at} holds a spreadsheet error value (${(v?.text ?? "").slice(0, 12)}).`, { row: rc.row, column: colLetters(rc.col) }));
        else if (t === "d") value = v?.text ?? "";
        else if (v && v.text.trim() !== "") {
          if (dates.has(Number(c.attrs.s ?? -1))) cellErrors.push(err("DATE_CELL_NOT_TEXT", `Cell ${at} is a date-formatted number. Store dates as text YYYY-MM-DD; no conversion is guessed from workbook formatting.`, { row: rc.row, column: colLetters(rc.col) }));
          else {
            const dec = exactDecimalText(v.text);
            if (dec === null) cellErrors.push(err("CELL_NOT_EXACT_NUMBER", `Cell ${at} holds a number that is not an exact decimal ("${v.text.slice(0, 40)}").`, { row: rc.row, column: colLetters(rc.col), value: v.text.slice(0, 40) }));
            else value = dec;
          }
        }
        if (value !== "") {
          const r = grid.get(rc.row) ?? new Map<number, string>();
          r.set(rc.col, value);
          grid.set(rc.row, r);
          if (rc.col > maxCol) maxCol = rc.col;
          if (hidden && !hiddenRows.includes(rc.row)) hiddenRows.push(rc.row);
        }
      }
    }
    if (formulaCells.length > 0) diagnostics.push(err("FORMULA_AS_AUTHORITY", `${formulaCells.length} cell(s) contain formulas (${formulaCells.slice(0, 10).join(", ")}${formulaCells.length > 10 ? ", …" : ""}). Cached formula results are not accepted as accounting evidence; paste values instead. No formula was evaluated.`));
    diagnostics.push(...cellErrors.slice(0, 50));
    if (cellErrors.length > 50) diagnostics.push(err("MANY_CELL_ERRORS", `${cellErrors.length - 50} further cell error(s) not listed.`));
    if (hiddenRows.length > 0) diagnostics.push(warn("HIDDEN_ROWS", `Hidden row(s) containing data: ${hiddenRows.slice(0, XLSX_LIMITS.maxDisclosed).join(", ")}${hiddenRows.length > XLSX_LIMITS.maxDisclosed ? ", …" : ""}. Their values were read.`));
    if (maxCol >= INTAKE_LIMITS.maxColumns) return { ok: false, diagnostics: [err("TOO_MANY_COLUMNS", `The sheet uses more than ${INTAKE_LIMITS.maxColumns} columns.`)] };

    const rowNumbers = [...grid.keys()].sort((a, b) => a - b);
    if (rowNumbers.length === 0) return { ok: false, diagnostics: [...diagnostics, err("EMPTY_FILE", `Sheet "${sheetName}" contains no values.`)] };
    const headerRow = rowNumbers[0];
    const headerCells = grid.get(headerRow)!;
    const headerLen = Math.max(...headerCells.keys()) + 1;
    const line = (r: Map<number, string>, width: number) => Array.from({ length: width }, (_, c) => r.get(c) ?? "");
    const records: string[][] = [line(headerCells, headerLen)];
    const q = /^[A-Za-z0-9_]+$/.test(sheetName) ? sheetName : `'${sheetName.replace(/'/g, "''")}'`;
    const locators: string[] = [];
    for (const rn of rowNumbers.slice(1)) {
      const r = grid.get(rn)!;
      const width = Math.max(headerLen, Math.max(...r.keys()) + 1);
      records.push(line(r, width));
      locators.push(`${q}!A${rn}:${colLetters(width - 1)}${rn}`);
    }
    return { ok: true, sheet: sheetName, records, rowLocators: locators, diagnostics };
  } catch (e) {
    return { ok: false, diagnostics: [err(e instanceof XmlError && e.message === "EXTERNAL_LINKS_NOT_ALLOWED" ? "EXTERNAL_LINKS_NOT_ALLOWED" : "WORKBOOK_XML_INVALID", e instanceof XmlError && e.message === "EXTERNAL_LINKS_NOT_ALLOWED" ? "The workbook links to external sources and is refused." : `The sheet could not be read safely: ${e instanceof Error ? e.message : "unreadable"}.`)] };
  }
}

// ─── intake ─────────────────────────────────────────────────────────────────

export interface WorkbookIntakeRequest extends IntakeCommon {
  readonly bytes: Uint8Array;
  /** Required: no sheet is ever chosen for the user. */
  readonly sheetName?: string;
  /** Injectable clock (milliseconds) for the processing-time limit; tests supply one, production uses performance.now(). */
  readonly now?: () => number;
}

export type WorkbookIntakeResult =
  | IntakeResult
  | { readonly outcome: "SHEET_SELECTION_REQUIRED"; readonly sheets: readonly WorkbookSheetInfo[]; readonly diagnostics: readonly EvidenceDiagnostic[] };

export function ingestWorkbook(req: WorkbookIntakeRequest): WorkbookIntakeResult {
  if (!XLSX_EVIDENCE_TYPES.includes(req.evidenceType)) {
    return { outcome: "REJECTED", diagnostics: [err("XLSX_NOT_SUPPORTED_FOR_TYPE", `Workbooks are accepted only for: ${XLSX_EVIDENCE_TYPES.join(", ")}. Provide this evidence type as CSV.`)] };
  }
  const fileSha256 = sha256Hex(req.bytes);
  if (req.sheetName === undefined || req.sheetName === "") {
    const inspected = inspectWorkbook(req.bytes);
    if (!inspected.ok) return { outcome: "REJECTED", diagnostics: inspected.diagnostics };
    return { outcome: "SHEET_SELECTION_REQUIRED", sheets: inspected.sheets, diagnostics: inspected.diagnostics };
  }
  const read = readWorkbookSheet(req.bytes, req.sheetName, { now: req.now });
  if (!read.ok) return { outcome: "REJECTED", diagnostics: read.diagnostics };
  const contentHash = canonicalIdentityOf(read.records);
  return ingestRecords(req, read.records, { contentHash, format: "XLSX", sheet: read.sheet, rowLocators: read.rowLocators, fileSha256, fileName: req.fileName ?? null, extraDiagnostics: read.diagnostics });
}
