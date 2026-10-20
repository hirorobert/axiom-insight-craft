// pagedSelect.test.ts — the keyset read against a PostgREST-shaped source that caps every answer at max-rows, with the
// table changing between pages.
//
//   deno test supabase/functions/_shared/pagedSelect.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { POSTGREST_DEFAULT_MAX_ROWS, selectAllRowsByKey } from "./pagedSelect.ts";

type R = { id: string; code: string };
const key = (i: number) => String(i).padStart(6, "0"); // text keys that order like the server orders them

/** A table of n rows behind a PostgREST that returns at most `cap` rows of any answer, as the real one does; mutable between pages. */
function source(n: number, cap = POSTGREST_DEFAULT_MAX_ROWS) {
  const rows: R[] = Array.from({ length: n }, (_, i) => ({ id: key(i), code: String(100000 + i) }));
  const requests: { after: string | null; limit: number }[] = [];
  const hooks: ((pageNo: number) => void)[] = [];
  const sorted = () => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    rows, requests, hooks,
    byKey: (after: string | null, limit: number) => {
      for (const h of hooks) h(requests.length + 1);
      requests.push({ after, limit });
      const page = sorted().filter((r) => after === null || r.id > after).slice(0, Math.min(limit, cap));
      return Promise.resolve({ data: page, error: null });
    },
    // the first correction's OFFSET window, kept here only to show the defect it had
    byOffset: (from: number, to: number) => {
      for (const h of hooks) h(requests.length + 1);
      requests.push({ after: String(from), limit: to - from + 1 });
      return Promise.resolve({ data: sorted().slice(from, Math.min(to + 1, from + cap)), error: null });
    },
  };
}

Deno.test("an unpaged read of 2,000 rows yields exactly 1,000 (the defect); the keyset read yields all 2,000, in order, in two full pages and one short one", async () => {
  const s = source(2000);
  const unpaged = await s.byKey(null, 1_000_000);
  assertEquals(unpaged.data?.length, 1000);
  const t = source(2000);
  const r = await selectAllRowsByKey(t.byKey, (x) => x.id);
  assertEquals(r.error, null);
  assertEquals(r.data?.length, 2000);
  assertEquals(r.data?.map((x) => x.id), Array.from({ length: 2000 }, (_, i) => key(i)));
  assertEquals(t.requests, [{ after: null, limit: 1000 }, { after: key(999), limit: 1000 }, { after: key(1999), limit: 1000 }]);
  assertEquals(r.pages, 3);
});

Deno.test("sizes around the page boundary: 0, 1, 999, 1000, 1001, 2500 rows are all read completely, none twice", async () => {
  for (const n of [0, 1, 999, 1000, 1001, 2500]) {
    const t = source(n);
    const r = await selectAllRowsByKey(t.byKey, (x) => x.id);
    assertEquals(r.error, null, `n=${n}`);
    assertEquals(r.data?.length, n, `n=${n}`);
    assertEquals(new Set(r.data?.map((x) => x.id)).size, n, `n=${n}`);
  }
});

Deno.test("a row deleted AHEAD of the page boundary between two reads: the offset window skips a row (the defect of the first correction); the keyset read loses nothing", async () => {
  // Offsets: deleting row 0 after page 1 shifts every later row down by one; row 1000 moves into [0, 999] and is never read.
  const o = source(1500);
  o.hooks.push((pageNo) => { if (pageNo === 2) o.rows.splice(0, 1); });
  let from = 0;
  const got: R[] = [];
  for (;;) {
    const p = await o.byOffset(from, from + 999);
    got.push(...(p.data ?? []));
    if ((p.data ?? []).length < 1000) break;
    from += 1000;
  }
  // The count equals the 1,499 remaining rows, which is exactly what hides the defect: the read holds the deleted row 0 (a
  // phantom, read before the deletion) and lacks row 1000, which slid across the boundary into the window already read.
  assertEquals(got.length, 1499);
  assertEquals(got.some((x) => x.id === key(0)), true);
  assertEquals(got.some((x) => x.id === key(1000)), false);
  // Keyset: the cursor is the last key read; deleting a row behind it cannot move anything still to be read. Row 1000 is
  // read; row 0, read before its deletion, stays in the result (a cursor, not a snapshot): 1,500 distinct rows, none skipped.
  const k = source(1500);
  k.hooks.push((pageNo) => { if (pageNo === 2) k.rows.splice(0, 1); });
  const r = await selectAllRowsByKey(k.byKey, (x) => x.id);
  assertEquals(r.error, null);
  assertEquals(r.data?.length, 1500);
  assertEquals(r.data?.some((x) => x.id === key(1000)), true);
  assertEquals(new Set(r.data?.map((x) => x.id)).size, 1500);
});

Deno.test("a row inserted AHEAD of the cursor between pages is read once; one inserted BEHIND it is not read (the keyset is a cursor, not a snapshot)", async () => {
  const t = source(1500);
  t.hooks.push((pageNo) => { if (pageNo === 2) { t.rows.push({ id: key(1200) + "b", code: "ahead" }); t.rows.push({ id: key(10) + "b", code: "behind" }); } });
  const r = await selectAllRowsByKey(t.byKey, (x) => x.id);
  assertEquals(r.error, null);
  assertEquals(r.data?.filter((x) => x.code === "ahead").length, 1);
  assertEquals(r.data?.filter((x) => x.code === "behind").length, 0);
  assertEquals(new Set(r.data?.map((x) => x.id)).size, r.data?.length);
});

Deno.test("a smaller page size works the same way; a page size over the cap is refused (a truncated page would end the read early)", async () => {
  const t = source(2500);
  const r = await selectAllRowsByKey(t.byKey, (x) => x.id, 400);
  assertEquals(r.data?.length, 2500);
  assertEquals(r.pages, 7);
  const bad = await selectAllRowsByKey(source(10).byKey, (x) => x.id, 1001);
  assertEquals(bad.data, null);
  assertEquals(bad.error?.code, "PAGED_SELECT_INVALID_PAGE_SIZE");
});

Deno.test("an error on any page ends the read with that error and no partial rows", async () => {
  let calls = 0;
  const r = await selectAllRowsByKey<R>((after, limit) => {
    calls += 1;
    if (after !== null) return Promise.resolve({ data: null, error: { code: "08006", message: "connection failure" } });
    return Promise.resolve({ data: Array.from({ length: limit }, (_, i) => ({ id: key(i), code: "" })), error: null });
  }, (x) => x.id);
  assertEquals(r.data, null);
  assertEquals(r.error?.code, "08006");
  assertEquals(calls, 2);
});

Deno.test("a page whose keys do not follow the cursor (unordered, repeated or missing) ends the read with PAGED_SELECT_KEY_ORDER and no partial rows", async () => {
  const repeat = await selectAllRowsByKey<R>((after, limit) => Promise.resolve({ data: after === null ? Array.from({ length: limit }, (_, i) => ({ id: key(i), code: "" })) : [{ id: key(5), code: "again" }], error: null }), (x) => x.id);
  assertEquals(repeat.data, null);
  assertEquals(repeat.error?.code, "PAGED_SELECT_KEY_ORDER");
  const missing = await selectAllRowsByKey<{ id?: string }>(() => Promise.resolve({ data: [{}], error: null }), (x) => String(x.id ?? ""));
  assertEquals(missing.error?.code, "PAGED_SELECT_KEY_ORDER");
});
