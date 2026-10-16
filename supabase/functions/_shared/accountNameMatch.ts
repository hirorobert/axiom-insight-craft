/**
 * accountNameMatch — the name fallback for account mappings, by COUNTING candidates (repair B, 20261108100000).
 *
 * A name is an account's identity only when the account has no code. Since accounts with different codes may share a
 * name, a name can point at several mappings, and two different names can normalise to the same key (the JavaScript
 * normaliser drops non-ASCII letters; the database's keeps them). So a name lookup answers one of:
 *   none       no candidate;
 *   one        exactly one candidate (exact, or the single nearest within the fuzzy distance);
 *   ambiguous  several candidates — never resolved here by picking the first or the last; the caller asks for review.
 * Pure; no I/O. Candidates keep their input order (for display only; order never chooses).
 */

export type NameMatch<T> =
  | { kind: "none" }
  | { kind: "one"; mapping: T; fuzzy: boolean }
  | { kind: "ambiguous"; candidates: T[]; fuzzy: boolean };

/** Every mapping under its normalised name — a list, never one entry overwriting another. */
export function indexByName<T>(rows: readonly T[], nameOf: (row: T) => string | null | undefined, normalize: (s: string) => string): Map<string, T[]> {
  const index = new Map<string, T[]>();
  for (const row of rows) {
    const raw = nameOf(row);
    if (raw == null) continue;
    const key = normalize(raw);
    if (key === "") continue;
    const list = index.get(key);
    if (list) list.push(row); else index.set(key, [row]);
  }
  return index;
}

/** Levenshtein distance, O(n) space. */
export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const row = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const cur = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, row[j], row[j - 1]);
      prev = cur;
    }
  }
  return row[n];
}

/**
 * Exact name first; then, only when no exact candidate exists, the candidates at the smallest distance ≤ maxDistance.
 * One candidate → one; several (exact duplicates, or a tie at the nearest distance) → ambiguous.
 */
export function matchByName<T>(normName: string, index: ReadonlyMap<string, readonly T[]>, maxDistance = 2): NameMatch<T> {
  if (normName === "") return { kind: "none" };
  const exact = index.get(normName);
  if (exact && exact.length > 0) return exact.length === 1 ? { kind: "one", mapping: exact[0], fuzzy: false } : { kind: "ambiguous", candidates: [...exact], fuzzy: false };
  let best = maxDistance + 1;
  let nearest: T[] = [];
  for (const [key, rows] of index) {
    const d = editDistance(normName, key);
    if (d > maxDistance) continue;
    if (d < best) { best = d; nearest = [...rows]; }
    else if (d === best) nearest.push(...rows);
  }
  if (nearest.length === 0) return { kind: "none" };
  return nearest.length === 1 ? { kind: "one", mapping: nearest[0], fuzzy: true } : { kind: "ambiguous", candidates: nearest, fuzzy: true };
}

/** Normalised names carried by more than one account of one upload: a name decision cannot tell those accounts apart. */
export function namesSharedInUpload(accounts: readonly { account_code: string | null; account_name: string }[], normalize: (s: string) => string): Set<string> {
  const seen = new Map<string, number>();
  for (const a of accounts) {
    const key = normalize(a.account_name ?? "");
    if (key !== "") seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
}
