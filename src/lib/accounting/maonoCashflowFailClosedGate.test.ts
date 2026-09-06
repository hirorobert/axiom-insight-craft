/**
 * PPG-1R HIGH-2 — static source-text proof that maono-cashflow/index.ts
 * actually wires assessArAp() as a hard gate BEFORE any write to
 * cashflow_forecasts (the DB column is NUMERIC NOT NULL DEFAULT 0 — this
 * repository does not apply migrations in this pass, so a NULL AR/AP
 * cannot be persisted; the only schema-compliant way to honor "no
 * fabricated number" is to never insert a row at all when either side is
 * CANNOT_ASSESS, exactly as the two pre-existing CANNOT_ASSESS early
 * returns in this same file already do for the certification/cash-
 * perimeter cases).
 *
 * Tests the ACTUAL edge-function file's source text directly — this
 * complements maonoCashflowMath.test.ts's behavioral proof of assessArAp()
 * itself with structural proof of how the caller uses it.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC_PATH = path.join(__dirname, "../../../supabase/functions/maono-cashflow/index.ts");
const SRC = fs.readFileSync(SRC_PATH, "utf-8");

describe("maono-cashflow/index.ts — fail-closed gate structure (PPG-1R HIGH-2)", () => {
  it("calls assessArAp() exactly once, after bucketing and before building the 13-week forecast", () => {
    const assessCallIndex = SRC.indexOf("assessArAp(bucketed)");
    const bucketCallIndex = SRC.indexOf("bucketCurrentBalances(");
    const forecastBuildIndex = SRC.indexOf("Build 13-week forecast");
    expect(assessCallIndex).toBeGreaterThan(-1);
    expect(bucketCallIndex).toBeGreaterThan(-1);
    expect(forecastBuildIndex).toBeGreaterThan(-1);
    expect(bucketCallIndex).toBeLessThan(assessCallIndex);
    expect(assessCallIndex).toBeLessThan(forecastBuildIndex);
  });

  it("checks BOTH arState and apState for CANNOT_ASSESS — neither side alone is sufficient to proceed", () => {
    expect(SRC).toMatch(/arAp\.arState === "CANNOT_ASSESS" \|\| arAp\.apState === "CANNOT_ASSESS"/);
  });

  it("the CANNOT_ASSESS branch returns before reaching the cashflow_forecasts insert", () => {
    const gateIndex = SRC.indexOf('if (arAp.arState === "CANNOT_ASSESS"');
    const insertMatch = SRC.match(/\.from\("cashflow_forecasts"\)\s*\.insert\(forecastRows\)/);
    expect(gateIndex).toBeGreaterThan(-1);
    expect(insertMatch).not.toBeNull();
    const insertIndex = SRC.indexOf(insertMatch![0]);
    expect(gateIndex).toBeLessThan(insertIndex);

    // The CANNOT_ASSESS branch itself must contain its own `return`
    // statement (JSON 409) so control never falls through to the insert.
    const gateBlock = SRC.slice(gateIndex, insertIndex);
    expect(gateBlock).toMatch(/return json\(/);
  });

  it("the CANNOT_ASSESS response preserves independently-knowable facts (opening cash, statutory schedule) rather than withholding everything", () => {
    const gateIndex = SRC.indexOf('if (arAp.arState === "CANNOT_ASSESS"');
    const forecastBuildIndex = SRC.indexOf("Build 13-week forecast");
    const gateBlock = SRC.slice(gateIndex, forecastBuildIndex);
    expect(gateBlock).toMatch(/opening_cash:\s*cashBalance/);
    expect(gateBlock).toMatch(/statutory_this_month:/);
  });

  it("the CANNOT_ASSESS response never fabricates an AR/AP number for the failing side — only unclassified_account_count and the limitation text", () => {
    const gateIndex = SRC.indexOf('if (arAp.arState === "CANNOT_ASSESS"');
    const forecastBuildIndex = SRC.indexOf("Build 13-week forecast");
    const gateBlock = SRC.slice(gateIndex, forecastBuildIndex);
    expect(gateBlock).toMatch(/unclassified_account_count/);
    expect(gateBlock).toMatch(/RECEIVABLE_CLASSIFICATION_LIMITATION/);
    expect(gateBlock).toMatch(/PAYABLE_CLASSIFICATION_LIMITATION/);
  });

  it("the success (200) path derives arBalance/apBalance from arAp.arKnownAmount/apKnownAmount, never from the raw bucketed totals directly", () => {
    const successPathStart = SRC.indexOf("Both sides are KNOWN");
    expect(successPathStart).toBeGreaterThan(-1);
    const successBlock = SRC.slice(successPathStart, SRC.indexOf("Build 13-week forecast"));
    expect(successBlock).toMatch(/arAp\.arKnownAmount/);
    expect(successBlock).toMatch(/arAp\.apKnownAmount/);
  });

  it("the tax-exclusion (double-count) protection is still applied on the success path", () => {
    expect(SRC).toMatch(/excludeScheduledTaxFromCurrentLiabilities\(\s*arAp\.apKnownAmount/);
  });
});
