// pagedSelect.ts — read EVERY row of a PostgREST select, page by page.
//
// PostgREST answers at most `max-rows` rows per request (1,000 by default on the local stack and on Supabase hosted) and
// says nothing about the rows it left out. A select written as `.from(t).select("*").eq(...)` therefore silently returns
// the first 1,000 matching rows — DEFECT-PTB-MAPPINGS-API-ROW-CAP-001: a company with more than 1,000 reviewed account
// mappings had only the first 1,000 applied by process-trial-balance, and its trial balance stayed "needs review" for
// exactly the rest.
//
// `selectAllRows` asks for `[from, to]` windows of `pageSize` rows through `.range()` until a page comes back short. The
// window never exceeds `max-rows` (a page larger than the cap would be truncated to the cap without an error, and the
// short-page test would then stop early), so `pageSize` must be at most the cap: 1,000. The caller supplies the query for
// one window, with every filter and a deterministic ORDER (a stable order is what makes consecutive windows disjoint);
// any error ends the read with that error and no partial result.
export const POSTGREST_DEFAULT_MAX_ROWS = 1000;

export interface PagedAnswer<T> {
  readonly data: T[] | null;
  readonly error: { code?: string; message: string } | null;
}

export async function selectAllRows<T>(
  page: (from: number, to: number) => PromiseLike<PagedAnswer<T>>,
  pageSize: number = POSTGREST_DEFAULT_MAX_ROWS,
): Promise<{ data: T[]; error: null; pages: number } | { data: null; error: { code?: string; message: string }; pages: number }> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > POSTGREST_DEFAULT_MAX_ROWS) {
    return { data: null, error: { code: "PAGED_SELECT_INVALID_PAGE_SIZE", message: `page size must be an integer between 1 and ${POSTGREST_DEFAULT_MAX_ROWS}` }, pages: 0 };
  }
  const all: T[] = [];
  let pages = 0;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1);
    pages += 1;
    if (error) return { data: null, error, pages };
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < pageSize) return { data: all, error: null, pages };
  }
}
