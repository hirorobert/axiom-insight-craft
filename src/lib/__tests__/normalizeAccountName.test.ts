// Golden fixture test for normalizeAccountName (Vitest / browser side).
// Run: npm test  (requires `npm install` once to pull vitest)
//
// CANONICAL NORMALIZE v1 — keep in sync with
//   supabase/functions/process-trial-balance/index.ts (normalizeAccountName)
//   supabase/functions/process-trial-balance/normalize.test.ts (Deno suite)

import { describe, it, expect } from "vitest";
import { normalizeAccountName } from "../normalizeAccountName";
import cases from "../../../supabase/functions/_shared/normalize-golden.json";

describe("normalizeAccountName — golden fixture", () => {
  for (const { input, expected, note } of cases) {
    it(`${note ?? input}`, () => {
      expect(normalizeAccountName(input)).toBe(expected);
    });
  }
});
