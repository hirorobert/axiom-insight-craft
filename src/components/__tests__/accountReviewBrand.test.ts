/**
 * Regression guard: the account-review panel never shows the retired internal brand "SAFF" to customers.
 *
 * Found while capturing the panel for the landing page (2026-10-11): its column header read "SAFF assessment" and its
 * intro "SAFF could not map these accounts…". Scoped to user-visible string literals; identifiers, comments and backend
 * values (e.g. saff_reference, saff_status) are not policed here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SOURCE = readFileSync(path.join(__dirname, "..", "AccountReviewPanel.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

/** Every double-quoted string literal and every JSX text run. */
const visibleStrings = [...SOURCE.matchAll(/"([^"\n]*)"/g)].map((m) => m[1])
  .concat([...SOURCE.matchAll(/>([^<>{}\n]+)</g)].map((m) => m[1].trim()).filter(Boolean));

describe("account-review panel wording", () => {
  it("never names the retired internal brand SAFF in visible text", () => {
    expect(visibleStrings.filter((s) => /\bSAFF\b/.test(s))).toEqual([]);
  });
  it("labels the suggestion column in plain language", () => {
    expect(visibleStrings).toContain("Suggested classification");
  });
});
