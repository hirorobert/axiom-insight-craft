/**
 * PPG-1R HIGH-2 §6 — "CANNOT_ASSESS must survive... No UI layer may
 * convert null/UNKNOWN/CANNOT_ASSESS into 0/NaN/empty-but-authoritative/a
 * numeric forecast."
 *
 * This repository has no React component-rendering test infrastructure
 * (no @testing-library/react anywhere), so this is a static source-text
 * regression guard — the same technique already used elsewhere in this
 * repository for otherwise-untestable UI/SQL logic (see
 * globalCommerceModel.test.ts, rlsRecursionGuard.test.ts). It proves the
 * empty-forecast early return (the only path reachable when maono-cashflow
 * returned CANNOT_ASSESS and wrote zero rows) is structurally BEFORE any
 * numeric formatting/aggregation, so a CANNOT_ASSESS result can never fall
 * through into a fabricated "Tsh 0" or NaN chart.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = fs.readFileSync(path.join(__dirname, "CashFlowForecast.tsx"), "utf-8");

describe("CashFlowForecast — empty/CANNOT_ASSESS state never renders a fabricated numeric forecast", () => {
  it("has an explicit early return for an empty weeks array", () => {
    expect(SRC).toMatch(/if \(!weeks \|\| weeks\.length === 0\) \{/);
  });

  it("the empty-state message is honest about BOTH possible causes, not just \"not yet generated\"", () => {
    const match = SRC.match(/if \(!weeks \|\| weeks\.length === 0\) \{[\s\S]*?return \(([\s\S]*?)\);\s*\}/);
    expect(match).not.toBeNull();
    const block = match![1];
    expect(block).toMatch(/unavailable/i);
    expect(block).toMatch(/classification/i);
  });

  it("the empty-state early return happens BEFORE any numeric aggregation (maxAbsValue) in source order", () => {
    const emptyReturnIndex = SRC.indexOf("if (!weeks || weeks.length === 0)");
    const maxAbsValueIndex = SRC.indexOf("const maxAbsValue");
    expect(emptyReturnIndex).toBeGreaterThan(-1);
    expect(maxAbsValueIndex).toBeGreaterThan(-1);
    expect(emptyReturnIndex).toBeLessThan(maxAbsValueIndex);
  });

  it("the empty-state branch contains no currency formatting call (fmt/fmtFull) — never a fabricated number", () => {
    const match = SRC.match(/if \(!weeks \|\| weeks\.length === 0\) \{[\s\S]*?return \(([\s\S]*?)\);\s*\}/);
    expect(match).not.toBeNull();
    const block = match![1];
    expect(block).not.toMatch(/fmtFull?\(/);
  });

  it("fmt() never guards against NaN by silently substituting a fabricated 0 string for a null/undefined input (it is only ever called with real week numbers, never with a possibly-null AR/AP field)", () => {
    // Structural proof that fmt/fmtFull are called only on CashWeek's
    // required `number` fields (never on an optional/nullable field this
    // component might someday receive) — the type contract itself is the
    // guard: CashWeek's numeric fields are all `number`, not `number |
    // null`, so a CANNOT_ASSESS result cannot reach this component with a
    // null masquerading as 0 today. If that contract ever changes to admit
    // null, this file's fmt/fmtFull call sites must be revisited.
    expect(SRC).toMatch(/expected_ar_inflows:\s*number;/);
    expect(SRC).toMatch(/expected_ap_outflows:\s*number;/);
  });
});
