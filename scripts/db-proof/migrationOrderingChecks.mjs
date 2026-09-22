// Pure, database-free migration-ordering predicates shared by the disposable-database proof
// scripts (run.mjs, serviceEnquiries.mjs) and their regression test
// (src/lib/__tests__/migrationOrderingChecks.test.ts). This module has NO top-level side effects —
// importing it never opens a database connection or runs a proof — so it is safe to import from a
// plain vitest test.
//
// Every predicate here takes an already-sorted array of migration filenames plus one or two EXACT
// filenames, and returns a boolean derived only from `indexOf()` on those named files. None of them
// ever reads `files.length`, uses a negative array index, or takes a `.slice()` — so appending any
// number of new, unrelated migrations to the end of `files` can never change what an existing call
// returns. That append-invariance is exactly what migrationOrderingChecks.test.ts proves.

/** True when `file` is present in the migration filename list. */
export function migrationExists(files, file) {
  return files.includes(file);
}

/** True when `second` sorts immediately after `first` — no other migration is interleaved between them. */
export function sortsImmediatelyAfter(files, first, second) {
  const a = files.indexOf(first);
  const b = files.indexOf(second);
  return a !== -1 && b !== -1 && b === a + 1;
}

/** True when `later` sorts strictly after `earlier`. Any number of other migrations may fall before, between, or after them. */
export function sortsStrictlyAfter(files, earlier, later) {
  const a = files.indexOf(earlier);
  const b = files.indexOf(later);
  return a !== -1 && b !== -1 && b > a;
}
