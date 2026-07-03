// CANONICAL NORMALIZE v1 — keep in sync with
//   supabase/functions/process-trial-balance/index.ts (normalizeAccountName)
//
// These two environments cannot share a module directly (Deno vs. browser),
// so both carry this identical function body. If you change the logic here,
// change it there too and re-run the golden fixture tests in both suites:
//   • Deno  : deno test supabase/functions/process-trial-balance/normalize.test.ts
//   • Vitest: npx vitest run src/lib/__tests__/normalizeAccountName.test.ts
//
// Note: /[^\w\s]/g strips non-ASCII letters (e.g. accented characters).
// The SQL mirror (regexp_replace … '[[:punct:]]') does not — this is a
// known pre-existing discrepancy; both sides of the JS match use this
// function so lookups are internally consistent.

export function normalizeAccountName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s]/g, "") // strip punctuation
    .replace(/\s+/g, " ")   // collapse whitespace
    .trim();
}
