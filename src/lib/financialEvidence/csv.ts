// financialEvidence/csv.ts — a strict RFC-4180 reader and the text-safety
// checks every evidence cell passes through. Pure, synchronous, no I/O.

export interface CsvParseResult {
  readonly rows: readonly (readonly string[])[];
  /** Set when a quoted field was never closed; the reader stops and reports rather than guessing. */
  readonly unterminatedQuoteAtRecord: number | null;
}

/** Reads CSV text into records of cells. Handles BOM, CRLF/LF/CR, quoted fields, doubled quotes and embedded newlines. */
export function parseCsv(input: string): CsvParseResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let cellWasQuoted = false;
  let i = 0;
  const endCell = () => {
    row.push(cell);
    cell = "";
    cellWasQuoted = false;
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && cell === "" && !cellWasQuoted) {
      inQuotes = true;
      cellWasQuoted = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      endCell();
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      endRow();
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  if (inQuotes) return { rows, unterminatedQuoteAtRecord: rows.length + 1 };
  if (cell !== "" || row.length > 0 || cellWasQuoted) endRow();
  return { rows, unterminatedQuoteAtRecord: null };
}

/** True for a record consisting only of empty cells (a blank line). */
export function isBlankRecord(record: readonly string[]): boolean {
  return record.every((c) => c.trim() === "");
}

// ─── text safety ───────────────────────────────────────────────────────────

const PLAIN_SIGNED_DECIMAL = /^-?\d+(?:\.\d+)?$/;

/**
 * Formula-injection guard. A text cell that a spreadsheet would evaluate — first
 * character `=`, `+`, `@`, tab, carriage return, or `-` followed by something that
 * is not a plain number — is refused at intake, after NFKC normalisation so the
 * full-width and other compatibility look-alikes are caught too.
 */
export function isFormulaLike(value: string): boolean {
  const normalised = value.normalize("NFKC").replace(/^[\s\u00a0]+/u, (m) => (/[\t\r]/.test(m) ? "\t" : ""));
  if (normalised === "") return false;
  const first = normalised[0];
  if (first === "=" || first === "+" || first === "@" || first === "\t" || first === "\r") return true;
  if (first === "-") return !PLAIN_SIGNED_DECIMAL.test(normalised.trim());
  return false;
}

// Zero-width, bidirectional-override and other invisible characters that can disguise text.
const HIDDEN_CHARACTERS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u00ad]/u;
// C0 controls other than tab/newline/carriage return, and DEL / C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

export function hasHiddenCharacter(value: string): boolean {
  return HIDDEN_CHARACTERS.test(value);
}
export function hasControlCharacter(value: string): boolean {
  return CONTROL_CHARACTERS.test(value);
}

/**
 * For EXPORT to a spreadsheet-consumable CSV: neutralises a leading formula
 * trigger by prefixing an apostrophe, and quotes any cell that needs it.
 */
export function csvCell(value: string): string {
  const safe = isFormulaLike(value) || /^[\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) || safe !== safe.trim() ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(records: readonly (readonly string[])[]): string {
  return records.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
