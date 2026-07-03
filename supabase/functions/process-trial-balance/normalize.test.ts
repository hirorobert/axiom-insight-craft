// Golden fixture test for normalizeAccountName (Deno side).
//
// CANONICAL NORMALIZE v1 — keep in sync with
//   supabase/functions/process-trial-balance/index.ts (normalizeAccountName)
//   src/lib/normalizeAccountName.ts
//
// The function body below MUST be byte-for-byte identical to the inline
// normalizeAccountName() in index.ts. Because index.ts does not export it,
// this test inlines the body; if the production copy changes, update here too.
//
// Run: deno test supabase/functions/process-trial-balance/normalize.test.ts

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import cases from "../_shared/normalize-golden.json" with { type: "json" };

// ── Inline copy of normalizeAccountName from index.ts ─────────────────────
// CANONICAL NORMALIZE v1 — keep in sync with index.ts and src/lib/normalizeAccountName.ts
function normalizeAccountName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s]/g, "") // strip punctuation
    .replace(/\s+/g, " ")   // collapse whitespace
    .trim();
}
// ─────────────────────────────────────────────────────────────────────────────

for (const { input, expected, note } of cases) {
  Deno.test(`normalizeAccountName: ${note ?? input}`, () => {
    assertEquals(normalizeAccountName(input), expected);
  });
}
