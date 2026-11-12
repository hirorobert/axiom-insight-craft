import type { BridgeLine } from "../../../../supabase/functions/_shared/readiness/types";
import { parseMinor } from "./amount";
import { parseCsv, requireColumns } from "./csv";
import { IntakeError } from "./errors";
import { sha256Hex } from "./sha256";

/**
 * Approved prior-year figures: `Line,Account codes,Amount,Level,Source`. Account codes are separated by `;`. Amount is the
 * approved CLOSING balance, signed, debit positive (it is this period's opening). Level says how far the figure is verified:
 * line, account, subledger or item. Each line becomes an opening-bridge line the engine compares with the ledger's opening.
 * The classification of a difference is a reviewer's decision and is added afterwards, never read from this file.
 */
export const APPROVED_COLUMNS = ["Line", "Account codes", "Amount", "Level", "Source"] as const;
const LEVELS = ["line", "account", "subledger", "item"] as const;
export interface ApprovedResult { basis: string; lines: BridgeLine[]; sources: Record<string, string>; fileSha256: string }

export function parseApprovedFigures(text: string, opts: { file: string; exponent: number; basis?: string }): ApprovedResult {
  const { file, exponent } = opts;
  const t = parseCsv(text, file);
  const ix = requireColumns(t, APPROVED_COLUMNS);
  if (t.records.length === 0) throw new IntakeError("no approved figures (a header-only file is not evidence)", file, 1);
  const lines: BridgeLine[] = [];
  const sources: Record<string, string> = {};
  for (const r of t.records) {
    const cell = (n: (typeof APPROVED_COLUMNS)[number]) => r.fields[ix[n]];
    const id = cell("Line").trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new IntakeError(`Line "${id}" must be lower-case letters, digits and hyphens`, file, r.line, ix.Line + 1);
    if (lines.some((l) => l.line === id)) throw new IntakeError(`duplicate line "${id}"`, file, r.line, ix.Line + 1);
    const accounts = cell("Account codes").split(";").map((a) => a.trim());
    if (accounts.length === 0 || accounts.some((a) => a === "")) throw new IntakeError("Account codes must name at least one account, separated by semicolons", file, r.line, ix["Account codes"] + 1);
    if (new Set(accounts).size !== accounts.length) throw new IntakeError("an account is named twice in Account codes", file, r.line, ix["Account codes"] + 1);
    const amount = parseMinor(cell("Amount"), exponent, { file, line: r.line, column: ix.Amount + 1 }, "Amount", { signed: true, blank: "refuse" });
    const level = cell("Level").trim();
    if (!(LEVELS as readonly string[]).includes(level)) throw new IntakeError(`Level "${level}" must be one of ${LEVELS.join(", ")}`, file, r.line, ix.Level + 1);
    const source = cell("Source").trim();
    if (!source) throw new IntakeError("Source is empty: say which approved document the figure comes from", file, r.line, ix.Source + 1);
    lines.push({ line: id, approved: amount.toString(), accounts, level: level as BridgeLine["level"] });
    sources[id] = source;
  }
  return { basis: opts.basis ?? "external_signed_fs", lines, sources, fileSha256: sha256Hex(text) };
}
