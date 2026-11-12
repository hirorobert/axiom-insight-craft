import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FIRST_PERIOD_NEXT_ACTIONS } from "@/lib/comparatives/firstPeriodNextActions";
import { blockerSentence } from "./serverBlockers";

const SQL = readFileSync(resolve(__dirname, "../../../supabase/migrations/20261217100000_first_period_governed_review.sql"), "utf8");

function catalogue(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of SQL.matchAll(/WHEN '([A-Z_]+)' THEN '((?:[^']|'')*)'/g)) out[m[1]] = m[2].replace(/''/g, "'");
  return out;
}

describe("first-period and opening-balance items: one next action each, the server's own words", () => {
  it("the client's sentences are exactly the server catalogue (_fs_fp_next_action), no more and no fewer", () => {
    expect(FIRST_PERIOD_NEXT_ACTIONS).toEqual(catalogue());
  });

  it("every reason code the server can emit has a next action", () => {
    const emitted = new Set<string>();
    // Codes the assessments append: v_issues / v_pending ... || 'CODE' (optionally followed by a detail), and the literal arrays they return.
    for (const m of SQL.matchAll(/'((?:FIRST_PERIOD|OPENING_SUPPORT)_[A-Z_]+)(?::'|'|\b)/g)) emitted.add(m[1]);
    const missing = [...emitted].filter((c) => !(c in FIRST_PERIOD_NEXT_ACTIONS));
    expect(missing).toEqual([]);
  });

  it("each reason reaches the page as a sentence, with or without the server's detail", () => {
    expect(blockerSentence("FIRST_PERIOD_LEGACY_DECLARATION_UNVERIFIED")).toMatch(/kept as a claim only/);
    expect(blockerSentence("FIRST_PERIOD_PRIOR_ACTIVITY_CONTRADICTS:2")).toMatch(/activity before the entity's stated start date/);
    expect(blockerSentence("OPENING_SUPPORT_NOT_RECONCILED:100000")).toMatch(/do not add up/);
    expect(blockerSentence("FIRST_PERIOD_UNKNOWN_CODE")).toBeNull();
  });

  it("the comparative blocker no longer promises that a declaration is enough", () => {
    const words = blockerSentence("COMPARATIVE_PERIOD_MISSING") ?? "";
    expect(words).toMatch(/different partner or manager/);
    expect(words).toMatch(/A declaration alone does not/);
  });

  it("the migration keeps the legacy declaration as a claim: the predicate answers only from the verified assessment", () => {
    expect(SQL).toMatch(/CREATE OR REPLACE FUNCTION public\.fs_first_period_declared[\s\S]*?_fs_first_period_assess[\s\S]*?= 'verified'/);
    expect(SQL).not.toMatch(/INSERT INTO public\.fs_first_period_claims[\s\S]{0,200}fs_first_period_declarations/);
    expect(SQL).not.toMatch(/UPDATE public\.fs_first_period_declarations|DELETE FROM public\.fs_first_period_declarations/);
  });
});
