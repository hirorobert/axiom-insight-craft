/**
 * Printed-report metadata: the one configurable rule set that recognises page numbering, print or run dates,
 * end-of-report markers, signature and date lines in a printed trial balance export.
 *
 * Recognition is evidence, not a guess. A rule only says what a TEXT looks like. Whether a ROW is a footer is decided
 * by the ingestion core from its position (after the last row with an amount or an account code) and its structure
 * (no amount, no account code). A row is never discarded because its text matches a phrase or because it contains
 * a standalone number. Nothing here names a particular accounting system.
 */

export interface PrintedFooterRule {
  /** Stable identifier, recorded in row lineage. */
  readonly id: string;
  /** Plain description, shown in row lineage. */
  readonly label: string;
  /** Tested against the trimmed text of one cell. */
  readonly pattern: RegExp;
}

export const PRINTED_FOOTER_RULES: readonly PrintedFooterRule[] = Object.freeze([
  { id: "page_number", label: "Page number", pattern: /^(page|pg\.?)\s*\d{1,5}(\s*(of|\/)\s*\d{1,5})?\s*$/i },
  { id: "page_marker", label: "Page number", pattern: /^[-–—]\s*\d{1,5}\s*[-–—]$/ },
  { id: "print_date", label: "Print or run date", pattern: /^(printed|run|generated|exported|report)\s*(on|at|date|time)?\s*[:.]?\s*(\d|$)|^(print|run|report)\s+(date|time)\b/i },
  { id: "end_of_report", label: "End of report", pattern: /^[*=\s-]*end\s+of\s+(the\s+)?(report|listing|trial\s+balance|document)[*=\s.-]*$|^\*{2,}\s*end\s*\*{2,}$/i },
  { id: "signature_line", label: "Signature line", pattern: /^(prepared|checked|reviewed|verified|approved|authori[sz]ed)\s+by\b|^signature\s*[:.]?\s*_*$|^signed\s*[:.]/i },
  { id: "date_line", label: "Date line", pattern: /^date\s*[:.]?\s*([\d/.\-\s_]*|_+)$/i },
  { id: "rule_line", label: "Rule line", pattern: /^[_–—=.-]{3,}$/ },
  { id: "generated_by", label: "Report attribution", pattern: /^(report\s+)?(generated|produced|printed)\s+(by|from|using)\b/i },
]);

/** The rule a cell's text matches, or null. Numbers are never matched here: see isStandalonePageNumber. */
export function footerRuleFor(text: string, rules: readonly PrintedFooterRule[] = PRINTED_FOOTER_RULES): PrintedFooterRule | null {
  const t = text.trim();
  if (!t) return null;
  return rules.find((r) => r.pattern.test(t)) ?? null;
}

/** A whole number small enough to be a page number (1–99999), written as a number or as digits only. */
export function isStandalonePageNumber(cell: unknown): boolean {
  if (typeof cell === "number") return Number.isInteger(cell) && cell >= 1 && cell <= 99999;
  return typeof cell === "string" && /^\d{1,5}$/.test(cell.trim()) && Number(cell.trim()) >= 1;
}
