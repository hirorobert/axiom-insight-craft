import { IntakeError } from "./errors";

/**
 * Strict RFC 4180 reader for frozen exports. It REFUSES instead of repairing:
 *   ragged rows, blank lines, stray quotes (inside an unquoted field, or text after a closing quote), an unterminated
 *   quote, a lone carriage return, an empty file, and duplicate or empty column names.
 * A UTF-8 byte-order mark is dropped. CRLF and LF are both accepted. Quoted fields may contain commas, doubled quotes and
 * line breaks. One line break after the last record is normal; a second one is a blank line.
 */
export interface CsvRecord { line: number; fields: string[] }
export interface CsvTable { file: string; header: string[]; records: CsvRecord[] }

export function parseCsv(text: string, file: string): CsvTable {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.length === 0) throw new IntakeError("the file is empty", file, 1);
  const raw: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let line = 1, recordLine = 1, col = 1;
  let inQuotes = false, quoted = false, afterClose = false, pending = false;

  const endField = () => { fields.push(field); field = ""; quoted = false; afterClose = false; };
  const endRecord = () => {
    const wasQuoted = quoted;
    endField();
    if (fields.length === 1 && fields[0] === "" && !wasQuoted) throw new IntakeError("blank line", file, recordLine);
    raw.push({ line: recordLine, fields });
    fields = []; pending = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; col += 2; continue; }
        inQuotes = false; afterClose = true; col++; continue;
      }
      field += c;
      if (c === "\n") { line++; col = 1; } else col++;
      continue;
    }
    if (c === '"') {
      if (field !== "" || quoted) throw new IntakeError("stray quote inside a field", file, line, col);
      inQuotes = true; quoted = true; pending = true; col++; continue;
    }
    if (c === "\r") {
      if (text[i + 1] !== "\n") throw new IntakeError("a lone carriage return", file, line, col);
      continue;
    }
    if (afterClose && c !== "," && c !== "\n") throw new IntakeError("text after a closing quote", file, line, col);
    if (c === ",") { endField(); pending = true; col++; continue; }
    if (c === "\n") { endRecord(); line++; recordLine = line; col = 1; continue; }
    field += c; pending = true; col++;
  }
  if (inQuotes) throw new IntakeError("unterminated quote", file, recordLine);
  if (pending) endRecord();

  if (raw.length === 0) throw new IntakeError("the file is empty", file, 1);
  const header = raw[0].fields.map((h) => h.trim());
  header.forEach((h, i) => { if (h === "") throw new IntakeError("empty column name", file, raw[0].line, i + 1); });
  const seen = new Set<string>();
  header.forEach((h, i) => { if (seen.has(h)) throw new IntakeError(`duplicate column name "${h}"`, file, raw[0].line, i + 1); seen.add(h); });
  const records = raw.slice(1);
  for (const r of records) {
    if (r.fields.length !== header.length) throw new IntakeError(`has ${r.fields.length} fields, the header has ${header.length}`, file, r.line);
  }
  return { file, header, records };
}

export function requireColumns(t: CsvTable, names: readonly string[]): Record<string, number> {
  const idx: Record<string, number> = {};
  for (const n of names) {
    const i = t.header.indexOf(n);
    if (i < 0) throw new IntakeError(`missing column "${n}" (found: ${t.header.join(", ")})`, t.file, 1);
    idx[n] = i;
  }
  return idx;
}
