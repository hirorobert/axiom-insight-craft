// pagedSelect.test.ts — the paged read against a PostgREST-shaped source that caps every answer at max-rows.
//
//   deno test supabase/functions/_shared/pagedSelect.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { POSTGREST_DEFAULT_MAX_ROWS, selectAllRows } from "./pagedSelect.ts";

/** A table of n rows behind a PostgREST that returns at most `cap` rows of any window, as the real one does. */
function source(n: number, cap = POSTGREST_DEFAULT_MAX_ROWS) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: i, code: String(100000 + i) }));
  const windows: [number, number][] = [];
  return {
    windows,
    page: (from: number, to: number) => {
      windows.push([from, to]);
      return Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + cap)), error: null });
    },
  };
}

Deno.test("an unpaged read of 2,000 rows yields exactly 1,000 (the defect); the paged read yields all 2,000, in order, in two full pages and one empty one", async () => {
  const s = source(2000);
  const unpaged = await s.page(0, 1_000_000);
  assertEquals(unpaged.data?.length, 1000);
  const t = source(2000);
  const r = await selectAllRows(t.page);
  assertEquals(r.error, null);
  assertEquals(r.data?.length, 2000);
  assertEquals(r.data?.map((x) => x.id), Array.from({ length: 2000 }, (_, i) => i));
  assertEquals(t.windows, [[0, 999], [1000, 1999], [2000, 2999]]);
  assertEquals(r.pages, 3);
});

Deno.test("sizes around the page boundary: 0, 1, 999, 1000, 1001, 2500 rows are all read completely", async () => {
  for (const n of [0, 1, 999, 1000, 1001, 2500]) {
    const t = source(n);
    const r = await selectAllRows(t.page);
    assertEquals(r.error, null, `n=${n}`);
    assertEquals(r.data?.length, n, `n=${n}`);
  }
});

Deno.test("a smaller page size works the same way; a page size over the cap is refused (a truncated page would end the read early)", async () => {
  const t = source(2500);
  const r = await selectAllRows(t.page, 400);
  assertEquals(r.data?.length, 2500);
  assertEquals(r.pages, 7);
  const bad = await selectAllRows(source(10).page, 1001);
  assertEquals(bad.data, null);
  assertEquals(bad.error?.code, "PAGED_SELECT_INVALID_PAGE_SIZE");
});

Deno.test("an error on any page ends the read with that error and no partial rows", async () => {
  let calls = 0;
  const r = await selectAllRows<{ id: number }>((from, to) => {
    calls += 1;
    return Promise.resolve(from === 1000 ? { data: null, error: { code: "08006", message: "connection failure" } } : { data: Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i })), error: null });
  });
  assertEquals(r.data, null);
  assertEquals(r.error?.code, "08006");
  assertEquals(calls, 2);
});
