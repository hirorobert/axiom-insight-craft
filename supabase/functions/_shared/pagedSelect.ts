// pagedSelect.ts — read EVERY row of a PostgREST select, page by page, by KEY.
//
// PostgREST answers at most `max-rows` rows per request (1,000 by default on the local stack and on Supabase hosted) and
// says nothing about the rows it left out. A select written as `.from(t).select("*").eq(...)` therefore silently returns
// the first 1,000 matching rows — DEFECT-PTB-MAPPINGS-API-ROW-CAP-001: a company with more than 1,000 reviewed account
// mappings had only the first 1,000 applied by process-trial-balance, and its trial balance stayed "needs review" for
// exactly the rest.
//
// The first correction read `[from, to]` OFFSET windows (`.range()`). Offsets are not stable against concurrent changes to
// the same table: a row deleted (or inserted) ahead of a page boundary between two reads shifts every later row by one, so a
// relevant row slides into the window already read and is skipped — or is read twice. Codex's review of PR #176 (blocker 2).
//
// `selectAllRowsByKey` pages by a KEYSET instead: every page is ordered by one immutable, unique key (the row id) and asks
// for the rows whose key is STRICTLY GREATER than the last key already seen, with the same filters on every page. A change
// to rows outside the keys still to be read cannot move the cursor, so no row is skipped or repeated. This is not a
// transaction-wide snapshot: a row inserted or changed AHEAD of the cursor during the read is seen as it is at that moment,
// and one behind the cursor is not; the caller's dependency validation (the recorded revisions of the keys the run uses)
// remains what guards a result against a change that matters. Each page asks for exactly `pageSize` rows (at most the cap:
// a larger page would be truncated to the cap without an error, and the short-page test would then stop early); a page
// shorter than `pageSize` ends the read. Any error, and a cursor that fails to advance, end the read with that error and no
// partial result.
export const POSTGREST_DEFAULT_MAX_ROWS = 1000;

export interface PagedAnswer<T> {
  readonly data: T[] | null;
  readonly error: { code?: string; message: string } | null;
}

export type PagedResult<T> =
  | { data: T[]; error: null; pages: number }
  | { data: null; error: { code?: string; message: string }; pages: number };

/**
 * `page(afterKey, limit)` must return the first `limit` rows whose key is strictly greater than `afterKey` (every row when
 * `afterKey` is null), ordered by that key ascending, with the caller's filters applied on every page. `keyOf` reads the
 * key of a row as the string the server orders and compares (a uuid's text form).
 */
export async function selectAllRowsByKey<T>(
  page: (afterKey: string | null, limit: number) => PromiseLike<PagedAnswer<T>>,
  keyOf: (row: T) => string,
  pageSize: number = POSTGREST_DEFAULT_MAX_ROWS,
): Promise<PagedResult<T>> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > POSTGREST_DEFAULT_MAX_ROWS) {
    return { data: null, error: { code: "PAGED_SELECT_INVALID_PAGE_SIZE", message: `page size must be an integer between 1 and ${POSTGREST_DEFAULT_MAX_ROWS}` }, pages: 0 };
  }
  const all: T[] = [];
  let pages = 0;
  let after: string | null = null;
  for (;;) {
    const { data, error } = await page(after, pageSize);
    pages += 1;
    if (error) return { data: null, error, pages };
    const rows = data ?? [];
    for (const row of rows) {
      const key = keyOf(row);
      if (typeof key !== "string" || key.length === 0 || (after !== null && !(key > after))) {
        return { data: null, error: { code: "PAGED_SELECT_KEY_ORDER", message: `page ${pages} returned a row whose key does not follow the cursor (unordered, duplicate or missing key)` }, pages };
      }
      after = key;
      all.push(row);
    }
    if (rows.length < pageSize) return { data: all, error: null, pages };
  }
}
