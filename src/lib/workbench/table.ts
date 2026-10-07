/**
 * Data-table rules shared by every workbench table. Pure.
 */

/** Roving focus: the row index a key moves to (null: the key does not move focus). */
export function rovingIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown": return Math.min(current + 1, count - 1);
    case "ArrowUp": return Math.max(current - 1, 0);
    case "Home": return 0;
    case "End": return count - 1;
    case "PageDown": return Math.min(current + 10, count - 1);
    case "PageUp": return Math.max(current - 10, 0);
    default: return null;
  }
}

export type BatchCheck<Row> = (row: Row) => true | string;

export type BatchEligibility = { readonly ok: true } | { readonly ok: false; readonly reason: string; readonly failing: readonly string[] };

/**
 * A batch action is allowed only when EVERY selected row satisfies the same rule (authorization and validation as the
 * server will apply them). Otherwise the first reason and the failing row ids are returned; nothing is partially applied.
 */
export function batchEligibility<Row>(selected: readonly Row[], idOf: (r: Row) => string, check: BatchCheck<Row>): BatchEligibility {
  if (selected.length === 0) return { ok: false, reason: "Select at least one row.", failing: [] };
  const failing: string[] = [];
  let reason: string | null = null;
  for (const r of selected) {
    const v = check(r);
    if (v !== true) { failing.push(idOf(r)); reason ??= v; }
  }
  return failing.length === 0 ? { ok: true } : { ok: false, reason: reason!, failing };
}

/** Case-insensitive match of a query against the given fields (whitespace-separated terms must all match). */
export function matchesQuery(query: string, fields: readonly (string | null | undefined)[]): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = fields.filter(Boolean).join(" ").toLowerCase();
  return terms.every((t) => hay.includes(t));
}
