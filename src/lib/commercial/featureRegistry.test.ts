import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FEATURE_CODES, FEATURE_DESCRIPTIONS, isFeatureCode } from "./featureRegistry";

describe("FEATURE_CODES", () => {
  it("contains exactly the seven Ω1 registry features, no duplicates", () => {
    expect(FEATURE_CODES).toEqual([
      "SAFISHA_PREVIEW",
      "SAFISHA_CERTIFY",
      "HESABU_REPORTING",
      "HESABU_EXPORT",
      "MAONO_INTELLIGENCE",
      "MULTI_COMPANY",
      "MULTI_PERIOD",
    ]);
    expect(new Set(FEATURE_CODES).size).toBe(FEATURE_CODES.length);
  });

  it("every code has a non-empty description and vice versa", () => {
    for (const code of FEATURE_CODES) {
      expect(FEATURE_DESCRIPTIONS[code]).toBeTruthy();
    }
    expect(Object.keys(FEATURE_DESCRIPTIONS).sort()).toEqual([...FEATURE_CODES].sort());
  });
});

describe("isFeatureCode", () => {
  it("accepts every registered code", () => {
    for (const code of FEATURE_CODES) {
      expect(isFeatureCode(code)).toBe(true);
    }
  });

  it("rejects unknown strings, empty string, and casing variants", () => {
    expect(isFeatureCode("UNKNOWN_THING")).toBe(false);
    expect(isFeatureCode("")).toBe(false);
    expect(isFeatureCode("safisha_preview")).toBe(false);
    expect(isFeatureCode("MULTI-COMPANY")).toBe(false);
  });
});

describe("registry stays in sync with the migration's DB-enforced CHECK constraints", () => {
  it("the Ω1 migration's two feature-code CHECK constraints list exactly this registry", () => {
    // PPG-1 (2026-09-06): reads the quarantined historical source file
    // (supabase/migrations_historical/ — never independently live under
    // its own filename; the live Lovable-applied identity is
    // 20260905093408, which expresses the same 7-code vocabulary via a
    // differently-formatted ARRAY[...] CHECK rather than this exact
    // "IN ('SAFISHA_PREVIEW'..." shape — see migrationCollisionGuard.test.ts
    // and docs/operations/PPG1_STABILIZATION_REPORT.md §Finding 3). The
    // quarantined file's content is unchanged (only a non-executable
    // notice was prepended above this constraint text), so it remains a
    // valid, byte-accurate reference for this vocabulary-sync check.
    const migrationPath = path.join(
      __dirname,
      "../../../supabase/migrations_historical/20260904180000_commercial_foundation_wave_omega1.sql.historical",
    );
    const sql = fs.readFileSync(migrationPath, "utf-8");
    const checkBlocks = sql.match(/IN \(\s*'SAFISHA_PREVIEW'[\s\S]*?\)/g) ?? [];
    expect(checkBlocks.length).toBeGreaterThanOrEqual(2);
    for (const block of checkBlocks) {
      const codesInBlock = [...block.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
      expect(codesInBlock.sort()).toEqual([...FEATURE_CODES].sort());
    }
  });
});
