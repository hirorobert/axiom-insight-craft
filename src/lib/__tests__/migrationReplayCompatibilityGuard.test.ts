/**
 * Migration replay-compatibility guard.
 *
 * Static, non-executing regression coverage for the 10 replay-hardening
 * blockers identified by the read-only local replay-compatibility audit
 * and resolved by the subsequent authorized correction pass:
 *
 *   A. Two migrations (20260626150000, 20260701000000) committed their
 *      production DML inside their own BEGIN/COMMIT block, then followed
 *      it with an executable "smoke test" section that deliberately
 *      triggers a statutory-rule/FK error and rolls back. A fail-fast
 *      migration runner aborts on that uncaught error — but the earlier
 *      COMMIT has already made the production data live, creating a
 *      partial-commit / provenance mismatch between the migration-history
 *      ledger and the database's real state. The smoke sections were
 *      removed; their negative-test invariants are captured here instead.
 *
 *   B. Seven migrations re-declared RLS policy names already created by an
 *      earlier migration on the same relation, without first dropping
 *      them. A bare `CREATE POLICY` has no `IF NOT EXISTS` form, so a
 *      clean sequential replay from an empty database hits `policy "..."
 *      already exists` (SQLSTATE 42710) on the first such statement. Each
 *      of the 44 affected re-declarations was given its own preceding
 *      relation-qualified `DROP POLICY IF EXISTS`. Covered in depth by
 *      storagePolicyReplayGuard.test.ts's generalized describe block;
 *      referenced here only for the resolved-blocker inventory.
 *
 *   C. 20260627100000_module_c_dedup.sql self-documents having failed in
 *      production (42703 — finding_category did not yet exist). It is
 *      fully superseded by 20260627120000_findings_category_column.sql,
 *      which adds the prerequisite column before creating the identical
 *      index. The superseded file was reduced to a version-preserving,
 *      side-effect-free no-op.
 *
 * This test reads the real migration files directly from
 * supabase/migrations/ and the real test source tree — no copied
 * fixtures.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const REPO_ROOT = path.join(__dirname, "../../../");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase/migrations");

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/**
 * Strips line comments, block comments, single-quoted string literals, and
 * dollar-quoted (PL/pgSQL) bodies, replacing each with a single space so
 * that top-level SQL structure (BEGIN/COMMIT, CREATE ..., etc.) can be
 * distinguished from text that merely resembles it inside a comment,
 * string literal, or function body.
 */
function stripCommentsStringsAndDollarQuotes(sql: string): string {
  let out = "";
  let i = 0;
  const dollarTagRe = /\$([a-zA-Z_]*)\$/y;
  while (i < sql.length) {
    if (sql[i] === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j += 1;
          break;
        }
        j++;
      }
      out += " ";
      i = j;
      continue;
    }
    if (sql[i] === "$") {
      dollarTagRe.lastIndex = i;
      const m = dollarTagRe.exec(sql);
      if (m && m.index === i) {
        const tag = m[0];
        const endIdx = sql.indexOf(tag, i + tag.length);
        i = endIdx === -1 ? sql.length : endIdx + tag.length;
        out += " ";
        continue;
      }
    }
    out += sql[i];
    i++;
  }
  return out;
}

function readMigration(fileName: string): string {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, fileName), "utf-8");
}

describe("migration directory integrity", () => {
  it("contains exactly 113 migration files", () => {
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    expect(files.length).toBe(113);
  });
});

describe("stripCommentsStringsAndDollarQuotes correctly excludes comments, string literals, and dollar-quoted bodies", () => {
  it("removes line comments but keeps real statements", () => {
    const input = "SELECT 1; -- this is a comment with BEGIN; and COMMIT; inside it\nSELECT 2;";
    const stripped = stripCommentsStringsAndDollarQuotes(input);
    expect(stripped).toContain("SELECT 1;");
    expect(stripped).toContain("SELECT 2;");
    expect(stripped).not.toMatch(/this is a comment/);
  });

  it("removes block comments", () => {
    const input = "SELECT 1; /* CREATE POLICY \"fake\" ON fake_table; */ SELECT 2;";
    const stripped = stripCommentsStringsAndDollarQuotes(input);
    expect(stripped).not.toMatch(/fake_table/);
  });

  it("removes single-quoted string literal contents (including embedded escaped quotes)", () => {
    const input = "UPDATE t SET notes = 'contains a BEGIN; and a '' escaped quote and COMMIT;' WHERE id = 1;";
    const stripped = stripCommentsStringsAndDollarQuotes(input);
    // The literal's contents must not surface as top-level BEGIN/COMMIT tokens.
    const beginCount = (stripped.match(/\bBEGIN\b/g) ?? []).length;
    const commitCount = (stripped.match(/\bCOMMIT\b/g) ?? []).length;
    expect(beginCount).toBe(0);
    expect(commitCount).toBe(0);
    expect(stripped).toContain("UPDATE t SET notes =");
    expect(stripped).toContain("WHERE id = 1;");
  });

  it("removes dollar-quoted PL/pgSQL bodies, so an ordinary BEGIN...END inside a function is not mistaken for transaction control", () => {
    const input = `
      CREATE OR REPLACE FUNCTION f() RETURNS void AS $$
      BEGIN
        RAISE EXCEPTION 'boom';
      END;
      $$ LANGUAGE plpgsql;
      SELECT 1;
    `;
    const stripped = stripCommentsStringsAndDollarQuotes(input);
    expect(stripped).not.toMatch(/RAISE EXCEPTION/);
    expect(stripped).not.toMatch(/\bBEGIN\b/);
    expect(stripped).not.toMatch(/\bEND\b/);
    expect(stripped).toContain("SELECT 1;");
  });

  it("handles a tagged dollar-quote (not just the bare $$ form)", () => {
    const input = "DO $body$ BEGIN NULL; END; $body$; SELECT 1;";
    const stripped = stripCommentsStringsAndDollarQuotes(input);
    expect(stripped).not.toMatch(/\bBEGIN\b/);
    expect(stripped).toContain("SELECT 1;");
  });
});

describe("Correction A — smoke-test-after-COMMIT hazard removed from 20260626150000_fa2026_statutory_rules.sql", () => {
  const FILE = "20260626150000_fa2026_statutory_rules.sql";
  const text = readMigration(FILE);
  const stripped = stripCommentsStringsAndDollarQuotes(text);

  it("has exactly one BEGIN; and exactly one COMMIT;, with COMMIT after BEGIN", () => {
    const beginMatches = stripped.match(/^BEGIN;/gm) ?? [];
    const commitMatches = stripped.match(/^COMMIT;/gm) ?? [];
    expect(beginMatches.length).toBe(1);
    expect(commitMatches.length).toBe(1);
    expect(stripped.indexOf("BEGIN;")).toBeLessThan(stripped.indexOf("COMMIT;"));
  });

  it("contains no BEGIN; or ROLLBACK; anywhere after the production COMMIT; (the smoke-test hazard)", () => {
    const commitIndex = stripped.indexOf("COMMIT;");
    const afterCommit = stripped.slice(commitIndex + "COMMIT;".length);
    expect(afterCommit).not.toMatch(/^\s*BEGIN;/m);
    expect(afterCommit).not.toMatch(/^\s*ROLLBACK;/m);
  });

  it("the production BEGIN...COMMIT block is unchanged from before this correction pass (content hash pin)", () => {
    const beginIdx = text.indexOf("BEGIN;");
    const commitIdx = text.indexOf("COMMIT;", beginIdx);
    const prodBlock = text.slice(beginIdx, commitIdx + "COMMIT;".length);
    expect(sha256(prodBlock)).toBe(
      "46d60ffb849112b600c50f85295ab1d05d5795fbe1edf025bfd7279280370bb2",
    );
  });

  it("still contains the harmless post-commit V1-V4 verification SELECT queries (only the smoke tests were removed)", () => {
    // These headers live inside `--` comments, which the structural
    // stripper deliberately removes — check the raw source instead.
    expect(text).toMatch(/VERIFICATION QUERIES/);
    expect(text).toMatch(/V1\./);
    expect(text).toMatch(/V4\./);
  });

  it("points to the relocated static test file instead of containing executable smoke SQL", () => {
    expect(text).toMatch(/migrationReplayCompatibilityGuard\.test\.ts/);
    expect(stripped).not.toMatch(/SMOKE TESTS[\s\S]*BEGIN;/);
  });
});

describe("Correction A — smoke-test-after-COMMIT hazard removed from 20260701000000_fa2026_enacted_verify.sql", () => {
  const FILE = "20260701000000_fa2026_enacted_verify.sql";
  const text = readMigration(FILE);
  const stripped = stripCommentsStringsAndDollarQuotes(text);

  it("has exactly one BEGIN; and exactly one COMMIT;, with COMMIT after BEGIN", () => {
    const beginMatches = stripped.match(/^BEGIN;/gm) ?? [];
    const commitMatches = stripped.match(/^COMMIT;/gm) ?? [];
    expect(beginMatches.length).toBe(1);
    expect(commitMatches.length).toBe(1);
    expect(stripped.indexOf("BEGIN;")).toBeLessThan(stripped.indexOf("COMMIT;"));
  });

  it("contains no BEGIN; or ROLLBACK; anywhere after the production COMMIT; (the smoke-test hazard)", () => {
    const commitIndex = stripped.indexOf("COMMIT;");
    const afterCommit = stripped.slice(commitIndex + "COMMIT;".length);
    expect(afterCommit).not.toMatch(/^\s*BEGIN;/m);
    expect(afterCommit).not.toMatch(/^\s*ROLLBACK;/m);
  });

  it("the production BEGIN...COMMIT block (UPDATE + row-count assertion) is unchanged from before this correction pass (content hash pin)", () => {
    const beginIdx = text.indexOf("BEGIN;");
    const commitIdx = text.indexOf("COMMIT;", beginIdx);
    const prodBlock = text.slice(beginIdx, commitIdx + "COMMIT;".length);
    expect(sha256(prodBlock)).toBe(
      "7fc0e655dd66f409e0c8758d0336982396ff02646efe95e2ee9ce562be79dedb",
    );
  });

  it("still contains the harmless post-commit V1 verification SELECT query (only the V2 smoke test was removed)", () => {
    // These headers live inside `--` comments, which the structural
    // stripper deliberately removes — check the raw source instead.
    expect(text).toMatch(/VERIFICATION QUERIES/);
    expect(text).toMatch(/V1\./);
  });

  it("points to the relocated static test file instead of containing an executable V2 smoke test", () => {
    expect(text).toMatch(/migrationReplayCompatibilityGuard\.test\.ts/);
    // The V2 smoke test previously ran a live INSERT designed to hit an FK
    // error; that executable statement must be gone from this file.
    expect(stripped).not.toMatch(/V2\.[\s\S]*INSERT INTO public\.findings/);
  });
});

describe("negative-test invariants relocated from the removed smoke tests (static assertions, not live SQL)", () => {
  // These document, as static facts checkable from source, the exact
  // invariants the removed smoke tests exercised live against a database.
  // They do not run against a database — they assert that the mechanism
  // each smoke test was probing still exists in the relevant migration's
  // source, so a future edit that silently removes that mechanism is
  // caught here instead of only being caught by a live replay.

  it("enforce_verified_statutory_rule() raises SQLSTATE 23000 (integrity_constraint_violation) for an unverified rule — the exact error the removed Smoke A/B/C tests expected", () => {
    const text = readMigration("20260625140000_c4e8a291-6d3b-4f7e-a052-b9e1d5c7f384.sql");
    const stripped = stripCommentsStringsAndDollarQuotes(text);
    expect(stripped).toMatch(/enforce_verified_statutory_rule/);
    expect(text).toMatch(/ERRCODE\s*=\s*'integrity_constraint_violation'/);
  });

  it("20260626150000 inserts the 9 FA2026 statutory rules with verified_at left NULL (the Bill-status gate the removed smoke tests proved blocks findings until lifted)", () => {
    const text = readMigration("20260626150000_fa2026_statutory_rules.sql");
    const beginIdx = text.indexOf("BEGIN;");
    const commitIdx = text.indexOf("COMMIT;", beginIdx);
    const prodBlock = stripCommentsStringsAndDollarQuotes(text.slice(beginIdx, commitIdx));
    expect(prodBlock).toMatch(/verified_at/);
    expect(prodBlock).not.toMatch(/verified_at\s*=\s*now\(\)/i);
  });

  it("20260701000000 lifts the gate by setting verified_at on exactly the 9 FA2026 rows, and asserts the row count itself (the mechanism the removed V2 smoke test relied on being correctly enabled)", () => {
    const text = readMigration("20260701000000_fa2026_enacted_verify.sql");
    const stripped = stripCommentsStringsAndDollarQuotes(text);
    expect(stripped).toMatch(/UPDATE public\.statutory_rules/);
    expect(stripped).toMatch(/verified_at\s*=/);
    // The row-count assertion lives inside a DO $$ ... $$ block, which the
    // structural stripper deliberately blanks out (it can't be told apart
    // from an opaque PL/pgSQL body in general) — check the raw source,
    // stripped only of line comments, for this specific content.
    const commentsOnlyStripped = text.replace(/--.*$/gm, "");
    expect(commentsOnlyStripped).toMatch(/v_verified\s*<>\s*9/);
  });
});

describe("Correction C — 20260627100000_module_c_dedup.sql reduced to a version-preserving no-op, superseded by 20260627120000", () => {
  const DEDUP_FILE = "20260627100000_module_c_dedup.sql";
  const SUPERSEDING_FILE = "20260627120000_findings_category_column.sql";

  it("the module_c_dedup migration file still exists at its original filename/version", () => {
    const files = fs.readdirSync(MIGRATIONS_DIR);
    expect(files).toContain(DEDUP_FILE);
  });

  it("no longer creates the uq_statutory_payable_per_period index itself (that effect is fully superseded)", () => {
    const stripped = stripCommentsStringsAndDollarQuotes(readMigration(DEDUP_FILE));
    expect(stripped).not.toMatch(/CREATE UNIQUE INDEX/i);
  });

  it("is side-effect-free: contains BEGIN; and COMMIT; wrapping only a no-op statement, no DDL/DML", () => {
    const stripped = stripCommentsStringsAndDollarQuotes(readMigration(DEDUP_FILE));
    const beginIdx = stripped.indexOf("BEGIN;");
    const commitIdx = stripped.indexOf("COMMIT;", beginIdx);
    expect(beginIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(beginIdx);
    const body = stripped.slice(beginIdx + "BEGIN;".length, commitIdx).trim();
    expect(body).toMatch(/^SELECT\s+1\s*;$/i);
  });

  it("identifies the superseding migration by name in its own text", () => {
    const text = readMigration(DEDUP_FILE);
    expect(text).toContain(SUPERSEDING_FILE);
  });

  it("the superseding migration adds finding_category BEFORE creating any index that depends on it, and creates the identical index definition", () => {
    const text = readMigration(SUPERSEDING_FILE);
    const stripped = stripCommentsStringsAndDollarQuotes(text);

    const addColumnIndex = stripped.search(/ALTER TABLE public\.findings\s+ADD COLUMN IF NOT EXISTS finding_category/i);
    const createIndexIndex = stripped.search(/CREATE UNIQUE INDEX IF NOT EXISTS uq_statutory_payable_per_period/i);

    expect(addColumnIndex, "expected an ADD COLUMN IF NOT EXISTS finding_category in the superseding migration").toBeGreaterThan(-1);
    expect(createIndexIndex, "expected the superseding migration to (re-)create the OD-13 dedup index").toBeGreaterThan(-1);
    expect(addColumnIndex, "the prerequisite column must be added before the dependent index is created").toBeLessThan(createIndexIndex);

    // Same index definition (table, columns, partial-index predicate) as
    // the one removed from the superseded file — proving full supersession
    // of its intended schema/index effect, not just a similarly-named one.
    // The predicate's string literal is stripped by the structural
    // sanitizer, so check the raw source (comments only removed) here.
    const commentsOnlyStripped = text.replace(/--.*$/gm, "");
    expect(commentsOnlyStripped).toMatch(
      /ON public\.findings \(company_id, finding_category, period_start, period_end\)\s+WHERE statutory_rule_id IS NULL\s+AND finding_type = 'statutory_payable'/,
    );
  });
});

describe("all 10 resolved replay-hardening blockers are explicitly covered by name", () => {
  const RESOLVED_BLOCKERS: Array<{ id: string; file: string }> = [
    { id: "1 — smoke-test-after-COMMIT hazard", file: "20260626150000_fa2026_statutory_rules.sql" },
    { id: "2 — smoke-test-after-COMMIT hazard", file: "20260701000000_fa2026_enacted_verify.sql" },
    { id: "3 — duplicate CREATE POLICY (capital_allowances)", file: "20260629042520_7c1fccd0-e91a-42cb-b09e-93fa907ae316.sql" },
    { id: "4 — duplicate CREATE POLICY (period_closing_balances/aje/aje_lines/statement_sign_offs)", file: "20260707200000_iron_dome_nuclear_full.sql" },
    { id: "5 — duplicate CREATE POLICY (management_inputs)", file: "20260708100000_iron_dome_sprint2.sql" },
    { id: "6 — duplicate CREATE POLICY (maono phase A tables)", file: "20260711300000_maono_phase_a.sql" },
    { id: "7 — duplicate CREATE POLICY (maono phase B tables)", file: "20260711300100_maono_phase_b.sql" },
    { id: "8 — duplicate CREATE POLICY (maono phase C tables)", file: "20260711300200_maono_phase_c.sql" },
    { id: "9 — duplicate CREATE POLICY (account_mapping_memory)", file: "20260811054356_e4768bc4-04df-4222-b2e6-482e35dde61a.sql" },
    { id: "10 — module_c_dedup superseded-in-production, reduced to no-op", file: "20260627100000_module_c_dedup.sql" },
  ];

  it("lists exactly 10 resolved blockers, one per authorized migration file", () => {
    expect(RESOLVED_BLOCKERS.length).toBe(10);
    const uniqueFiles = new Set(RESOLVED_BLOCKERS.map((b) => b.file));
    expect(uniqueFiles.size).toBe(10);
  });

  it.each(RESOLVED_BLOCKERS)("blocker $id: $file exists and was part of this correction pass", ({ file }) => {
    const files = fs.readdirSync(MIGRATIONS_DIR);
    expect(files).toContain(file);
  });
});

/**
 * Trigger replay guard — generalized across ALL migrations.
 *
 * Exactly the same replay hazard as bare `CREATE POLICY` applies to bare
 * `CREATE TRIGGER`: PostgreSQL has no `IF NOT EXISTS` form for it, so any
 * migration that re-declares a trigger name already created (on the same
 * relation) by an earlier migration will hit `trigger "..." already
 * exists for relation "..."` (SQLSTATE 42710) on a clean sequential
 * replay from an empty database, unless it drops that exact name, on
 * that exact relation, first.
 *
 * Identity key = exact trigger name + exact schema-qualified relation,
 * NOT name alone — two different tables may legitimately share a trigger
 * name. The first creator of any given name+relation needs no guard;
 * every later creator must contain its own relation-qualified
 * `DROP TRIGGER IF EXISTS` strictly before its own `CREATE TRIGGER` for
 * that exact name. This is NOT whitelisted or narrowed to any known
 * subset of files — it is evaluated against every migration in the
 * repository, and fails on any unguarded later creator, wherever it
 * occurs.
 */
function extractTriggerOccurrences(strippedText: string): PolicyOccurrence[] {
  const results: PolicyOccurrence[] = [];
  const re = /CREATE TRIGGER\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+(?:BEFORE|AFTER|INSTEAD OF)\s+[\s\S]*?\bON\s+([a-zA-Z_][a-zA-Z0-9_.]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(strippedText)) !== null) {
    const name = m[1];
    const relation = m[2].includes(".") ? m[2] : `public.${m[2]}`;
    results.push({ name, relation, index: m.index });
  }
  return results;
}

interface PolicyOccurrence {
  name: string;
  relation: string;
  index: number;
}

/** Extracts the full `CREATE TRIGGER ... ;` statement text starting at a known index. */
function extractTriggerStatementAt(strippedText: string, startIndex: number): string {
  let depth = 0;
  let endIndex = -1;
  for (let i = startIndex; i < strippedText.length; i++) {
    const ch = strippedText[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === ";" && depth === 0) {
      endIndex = i;
      break;
    }
  }
  return strippedText.slice(startIndex, endIndex + 1);
}

function normalizeSqlWhitespace(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

describe("trigger replay guard — every migration file, keyed by exact trigger name + exact schema/relation", () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const strippedByFile = new Map<string, string>();
  for (const f of files) {
    strippedByFile.set(f, stripCommentsStringsAndDollarQuotes(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf-8")));
  }

  const creatorsByKey = new Map<string, string[]>();
  for (const f of files) {
    const text = strippedByFile.get(f)!;
    for (const occ of extractTriggerOccurrences(text)) {
      const key = `${occ.name}::${occ.relation}`;
      if (!creatorsByKey.has(key)) creatorsByKey.set(key, []);
      const list = creatorsByKey.get(key)!;
      if (!list.includes(f)) list.push(f);
    }
  }

  const duplicateKeys = [...creatorsByKey.entries()].filter(([, fs2]) => fs2.length > 1);

  it("finds exactly 20 duplicate trigger name+relation identities across the repository", () => {
    expect(duplicateKeys.length).toBe(20);
  });

  it("the first creator of any trigger name+relation needs no guard; every later creator of that same name+relation contains its own same-relation DROP TRIGGER IF EXISTS strictly before its corresponding CREATE TRIGGER — evaluated against every migration, no exclusions", () => {
    const failures: string[] = [];
    for (const [key, creatorFiles] of duplicateKeys) {
      const [name, relation] = key.split("::");
      const relBare = relation.startsWith("public.") ? relation.slice("public.".length) : relation;
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const createRe = new RegExp(`CREATE TRIGGER\\s+"?${escapedName}"?\\s+(?:BEFORE|AFTER|INSTEAD OF)`);
      const dropRe = new RegExp(`DROP TRIGGER IF EXISTS\\s+"?${escapedName}"?\\s+ON\\s+(public\\.)?${relBare.replace(".", "\\.")}\\s*;`);

      for (let i = 1; i < creatorFiles.length; i++) {
        const laterFile = creatorFiles[i];
        const laterText = strippedByFile.get(laterFile)!;
        const createIndex = laterText.search(createRe);
        const dropMatch = laterText.match(dropRe);
        const dropIndex = dropMatch ? laterText.indexOf(dropMatch[0]) : -1;

        if (createIndex === -1) {
          failures.push(`${laterFile}: expected to find CREATE TRIGGER "${name}" ON ${relation}`);
          continue;
        }
        if (dropIndex === -1) {
          failures.push(`${laterFile}: re-creates trigger "${name}" on ${relation} but has no relation-qualified DROP TRIGGER IF EXISTS for it in its own text`);
          continue;
        }
        if (!(dropIndex < createIndex)) {
          failures.push(`${laterFile}: drop for trigger "${name}" on ${relation} must precede its own recreate`);
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  // The migrations touched by this correction pass — three SAFISHA
  // triggers plus the nine additionally-discovered duplicates in the
  // maono phase a/b/c and account_mapping_memory migrations. For each,
  // the later CREATE TRIGGER must still encode the exact same trigger
  // (timing, event, relation, function) as its original creator —
  // proving the correction inserted DROP TRIGGER statements only, and
  // never touched the CREATE TRIGGER definitions themselves.
  const TRIGGER_CORRECTED_FILES: Record<string, string> = {
    "20260711200000_safisha_core.sql": "20260711162832_180fac0d-7745-4e36-9902-e35e98cfac33.sql",
    "20260711300000_maono_phase_a.sql": "20260711163040_9ec82b5f-ee11-45e7-942a-65f09f24dddf.sql",
    "20260711300100_maono_phase_b.sql": "20260711163133_b0024d19-b5fa-4904-a8b7-6adce235fd64.sql",
    "20260711300200_maono_phase_c.sql": "20260711163223_9a12e0e2-cf5f-41dc-8fc5-17d8798a27b2.sql",
    "20260811054356_e4768bc4-04df-4222-b2e6-482e35dde61a.sql": "20260811000000_account_mapping_memory.sql",
  };

  const EXPECTED_TRIGGER_NAMES_BY_FILE: Record<string, string[]> = {
    "20260711200000_safisha_core.sql": [
      "safisha_transactions_immutable",
      "safisha_exceptions_resolve_gate",
      "safisha_audit_log_immutable",
    ],
    "20260711300000_maono_phase_a.sql": [
      "budget_enforce_immutability",
      "budget_enforce_no_delete",
      "maono_runs_append_only",
      "maono_analyses_append_only",
    ],
    "20260711300100_maono_phase_b.sql": ["maono_insights_append_only", "maono_alerts_append_only"],
    "20260711300200_maono_phase_c.sql": ["board_packs_append_only", "maono_monitor_runs_no_delete"],
    "20260811054356_e4768bc4-04df-4222-b2e6-482e35dde61a.sql": ["trg_amm_immutable"],
  };

  it("all 5 trigger-hardening-corrected files' duplicated CREATE TRIGGER definitions still encode the exact same trigger (timing, event, relation, function) as their original creator — the correction added only DROP TRIGGER statements", () => {
    let checkedCount = 0;
    for (const [laterFile, creatorFile] of Object.entries(TRIGGER_CORRECTED_FILES)) {
      const laterText = strippedByFile.get(laterFile)!;
      const creatorText2 = strippedByFile.get(creatorFile)!;
      const expectedNames = EXPECTED_TRIGGER_NAMES_BY_FILE[laterFile];
      const laterOccurrences = extractTriggerOccurrences(laterText).filter((o) => expectedNames.includes(o.name));
      const creatorOccurrences = extractTriggerOccurrences(creatorText2);

      expect(laterOccurrences.length, `${laterFile}: expected exactly ${expectedNames.length} corrected trigger(s)`).toBe(expectedNames.length);

      for (const laterOcc of laterOccurrences) {
        const creatorOcc = creatorOccurrences.find(
          (c) => c.name === laterOcc.name && c.relation === laterOcc.relation,
        );
        expect(creatorOcc, `${laterFile}: "${laterOcc.name}" ON ${laterOcc.relation} must have a matching creator occurrence in ${creatorFile}`).toBeDefined();

        const laterBody = normalizeSqlWhitespace(extractTriggerStatementAt(laterText, laterOcc.index));
        const creatorBody = normalizeSqlWhitespace(extractTriggerStatementAt(creatorText2, creatorOcc!.index));
        expect(
          laterBody,
          `${laterFile}: CREATE TRIGGER "${laterOcc.name}" ON ${laterOcc.relation} must encode the same trigger as its creator (${creatorFile}), aside from whitespace`,
        ).toBe(creatorBody);
        checkedCount++;
      }
    }
    // 3 (safisha) + 4 (maono phase a) + 2 (maono phase b) + 2 (maono phase c) + 1 (amm) = 12.
    expect(checkedCount).toBe(12);
  });

  it("each of the 12 trigger-hardening guards added by this correction pass is present in its file", () => {
    for (const [file, names] of Object.entries(EXPECTED_TRIGGER_NAMES_BY_FILE)) {
      const text = strippedByFile.get(file)!;
      for (const name of names) {
        expect(text, `${file} must contain a DROP TRIGGER IF EXISTS guard for "${name}"`).toMatch(
          new RegExp(`DROP TRIGGER IF EXISTS\\s+"?${name}"?\\s+ON`),
        );
      }
    }
  });
});

describe("idx_safisha_tx_dqc — corrected to reconciliation_id, matching its creator and every real application query", () => {
  // A live sequential db push against an empty staging database reached
  // migration #62 (20260711300200_maono_phase_c.sql) and failed at
  // `column "upload_id" does not exist` (SQLSTATE 42703). safisha_transactions
  // has never had an upload_id column — every real query against it
  // (safisha-match, safisha-ingest, ExceptionQueue.tsx) scopes by
  // reconciliation_id, and the earlier creator migration (20260711163223)
  // already defines this exact index correctly on reconciliation_id. The
  // later file's duplicate declaration of the same index name had drifted
  // to the wrong column. This is a static, source-only proof that the
  // corrected later definition now matches its creator exactly and no
  // longer references the nonexistent column.
  const CREATOR_FILE = "20260711163223_9a12e0e2-cf5f-41dc-8fc5-17d8798a27b2.sql";
  const LATER_FILE = "20260711300200_maono_phase_c.sql";
  const SAFISHA_TRANSACTIONS_CREATOR_FILE = "20260711162832_180fac0d-7745-4e36-9902-e35e98cfac33.sql";

  function extractIndexStatement(fileName: string, indexName: string): string {
    const stripped = stripCommentsStringsAndDollarQuotes(readMigration(fileName));
    const escapedName = indexName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS ${escapedName}[\\s\\S]*?;`);
    const match = stripped.match(re);
    if (!match) throw new Error(`Index statement for ${indexName} not found in ${fileName}`);
    return match[0];
  }

  it("the creator migration (20260711163223) defines idx_safisha_tx_dqc on (reconciliation_id, dqc_polarity_warning) with predicate WHERE dqc_polarity_warning = TRUE", () => {
    const stmt = normalizeSqlWhitespace(extractIndexStatement(CREATOR_FILE, "idx_safisha_tx_dqc"));
    expect(stmt).toBe(
      normalizeSqlWhitespace(
        "CREATE INDEX IF NOT EXISTS idx_safisha_tx_dqc ON safisha_transactions(reconciliation_id, dqc_polarity_warning) WHERE dqc_polarity_warning = TRUE;",
      ),
    );
  });

  it("the later migration (20260711300200) now defines the exact same normalized index as its creator — corrected from the previously live-failing upload_id column to reconciliation_id", () => {
    const creatorStmt = normalizeSqlWhitespace(extractIndexStatement(CREATOR_FILE, "idx_safisha_tx_dqc"));
    const laterStmt = normalizeSqlWhitespace(extractIndexStatement(LATER_FILE, "idx_safisha_tx_dqc"));
    expect(laterStmt).toBe(creatorStmt);
  });

  it("the later index definition no longer references upload_id", () => {
    const laterStmt = extractIndexStatement(LATER_FILE, "idx_safisha_tx_dqc");
    expect(laterStmt).not.toMatch(/upload_id/i);
  });

  it("safisha_transactions has a reconciliation_id column as of its own creating migration, which sorts before the 20260711300200 boundary", () => {
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    expect(files.indexOf(SAFISHA_TRANSACTIONS_CREATOR_FILE)).toBeLessThan(files.indexOf(LATER_FILE));
    const creatorTableText = stripCommentsStringsAndDollarQuotes(readMigration(SAFISHA_TRANSACTIONS_CREATOR_FILE));
    expect(creatorTableText).toMatch(/CREATE TABLE IF NOT EXISTS safisha_transactions\s*\([\s\S]*?reconciliation_id\s+UUID/);
  });

  it("no migration in the repository ever adds or depends on safisha_transactions.upload_id — the two identifiers never co-occur within the same statement anywhere", () => {
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    const failures: string[] = [];
    for (const f of files) {
      const stripped = stripCommentsStringsAndDollarQuotes(readMigration(f));
      for (const stmt of stripped.split(";")) {
        if (/safisha_transactions/i.test(stmt) && /\bupload_id\b/i.test(stmt)) {
          failures.push(`${f}: a single statement references both safisha_transactions and upload_id: ${stmt.trim().slice(0, 200)}`);
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});

describe("hesabu_gate_before_signoff — corrected original trigger no longer references the nonexistent sign_off_tier column", () => {
  // A live sequential db push against an empty staging database reached
  // migration #63 (20260711400000_hesabu_validate.sql) and failed with
  // `column "new.sign_off_tier" does not exist` (SQLSTATE 42703) at
  // CREATE TRIGGER time — statement_sign_offs has never had a sign_off_tier
  // column; the trigger encodes tier-1-only gating structurally (it is
  // BEFORE INSERT, and only the preparer's initial signature is ever an
  // INSERT — reviewer/approver sign via UPDATE on the same row). This exact
  // defect was already diagnosed and fixed by 20260713000000, whose own
  // header comment documents it; that fix's form is proven correct and
  // reused verbatim here for the original migration.
  const ORIGINAL_FILE = "20260711400000_hesabu_validate.sql";
  const FIX_FILE = "20260713000000_hesabu_trigger_fix.sql";
  const THIRD_CREATOR_FILE = "20260713090437_914640ba-74cf-4649-8570-30ea18e3fd1d.sql";

  it("the original trigger in 20260711400000 no longer has a WHEN clause referencing sign_off_tier", () => {
    const stripped = stripCommentsStringsAndDollarQuotes(readMigration(ORIGINAL_FILE));
    const triggerMatch = stripped.match(/CREATE TRIGGER hesabu_gate_before_signoff[\s\S]*?;/);
    expect(triggerMatch, "expected to find CREATE TRIGGER hesabu_gate_before_signoff in 20260711400000").toBeTruthy();
    const triggerText = triggerMatch![0];
    expect(triggerText).not.toMatch(/WHEN/i);
    expect(triggerText).not.toMatch(/sign_off_tier/i);
  });

  it("hesabu_block_signoff() in 20260711400000 returns NEW when NEW.preparer_signed_at IS NULL, as its first executable statement", () => {
    // The dollar-quoted function body is opaque to stripCommentsStringsAndDollarQuotes
    // by design (it can't be told apart from an arbitrary PL/pgSQL body in
    // general) — check the raw source, stripped only of line comments.
    const commentsOnlyStripped = readMigration(ORIGINAL_FILE).replace(/--.*$/gm, "");
    const fnMatch = commentsOnlyStripped.match(/CREATE OR REPLACE FUNCTION hesabu_block_signoff\(\)[\s\S]*?^\$\$;/m);
    expect(fnMatch, "expected to find hesabu_block_signoff() function body").toBeTruthy();
    const fnBody = fnMatch![0];
    const beginIdx = fnBody.indexOf("BEGIN");
    expect(beginIdx, "expected a BEGIN in the function body").toBeGreaterThan(-1);
    const afterBegin = fnBody.slice(beginIdx + "BEGIN".length);
    const firstStatement = afterBegin.match(/^\s*IF\s+NEW\.preparer_signed_at\s+IS\s+NULL\s+THEN\s+RETURN\s+NEW;\s*END\s+IF;/i);
    expect(
      firstStatement,
      `expected the preparer_signed_at guard as the first statement after BEGIN, got: ${afterBegin.slice(0, 200)}`,
    ).toBeTruthy();
  });

  it("no migration anywhere references NEW.sign_off_tier or statement_sign_offs.sign_off_tier", () => {
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    const failures: string[] = [];
    for (const f of files) {
      const stripped = stripCommentsStringsAndDollarQuotes(readMigration(f));
      if (/sign_off_tier/i.test(stripped)) failures.push(f);
    }
    expect(failures, `sign_off_tier must not appear in any migration's executable SQL: ${failures.join(", ")}`).toEqual([]);
  });

  it("the three hesabu_gate_before_signoff creators remain consistent: all three install the trigger with no WHEN clause, BEFORE INSERT, executing hesabu_block_signoff()", () => {
    for (const f of [ORIGINAL_FILE, FIX_FILE, THIRD_CREATOR_FILE]) {
      const stripped = stripCommentsStringsAndDollarQuotes(readMigration(f));
      const triggerMatch = stripped.match(/CREATE TRIGGER hesabu_gate_before_signoff[\s\S]*?;/);
      expect(triggerMatch, `expected CREATE TRIGGER hesabu_gate_before_signoff in ${f}`).toBeTruthy();
      const triggerText = normalizeSqlWhitespace(triggerMatch![0]);
      expect(triggerText, `${f}: trigger must have no WHEN clause`).not.toMatch(/WHEN/i);
      expect(triggerText, `${f}: trigger must fire BEFORE INSERT on statement_sign_offs`).toMatch(
        /BEFORE INSERT ON (public\.)?statement_sign_offs/i,
      );
      expect(triggerText, `${f}: trigger must execute hesabu_block_signoff()`).toMatch(
        /EXECUTE FUNCTION (public\.)?hesabu_block_signoff\(\)/i,
      );
    }
  });

  it("both later trigger creators (20260713000000 and 20260713090437) retain their own relation-qualified DROP TRIGGER IF EXISTS guard before their CREATE TRIGGER", () => {
    for (const f of [FIX_FILE, THIRD_CREATOR_FILE]) {
      const stripped = stripCommentsStringsAndDollarQuotes(readMigration(f));
      const dropIndex = stripped.search(/DROP TRIGGER IF EXISTS hesabu_gate_before_signoff ON (public\.)?statement_sign_offs\s*;/i);
      const createIndex = stripped.search(/CREATE TRIGGER hesabu_gate_before_signoff/i);
      expect(dropIndex, `${f}: expected a relation-qualified DROP TRIGGER IF EXISTS for hesabu_gate_before_signoff`).toBeGreaterThan(-1);
      expect(createIndex, `${f}: expected CREATE TRIGGER hesabu_gate_before_signoff`).toBeGreaterThan(-1);
      expect(dropIndex, `${f}: drop must precede its own recreate`).toBeLessThan(createIndex);
    }
  });

  it("the corrected original function's preparer-gate logic matches the authoritative behavior already proven in 20260713000000 (token-normalized), and both triggers omit the WHEN clause", () => {
    const originalCommentsOnly = readMigration(ORIGINAL_FILE).replace(/--.*$/gm, "");
    const fixCommentsOnly = readMigration(FIX_FILE).replace(/--.*$/gm, "");

    const originalGuard = originalCommentsOnly.match(/IF\s+NEW\.preparer_signed_at\s+IS\s+NULL\s+THEN\s+RETURN\s+NEW;\s*END\s+IF;/i);
    const fixGuard = fixCommentsOnly.match(/IF\s+NEW\.preparer_signed_at\s+IS\s+NULL\s+THEN\s+RETURN\s+NEW;\s*END\s+IF;/i);
    expect(originalGuard, "expected the preparer_signed_at guard in the corrected original").toBeTruthy();
    expect(fixGuard, "expected the preparer_signed_at guard in the authoritative fix").toBeTruthy();
    expect(normalizeSqlWhitespace(originalGuard![0])).toBe(normalizeSqlWhitespace(fixGuard![0]));

    const originalTrigger = stripCommentsStringsAndDollarQuotes(readMigration(ORIGINAL_FILE)).match(
      /CREATE TRIGGER hesabu_gate_before_signoff[\s\S]*?;/,
    )![0];
    const fixTrigger = stripCommentsStringsAndDollarQuotes(readMigration(FIX_FILE)).match(
      /CREATE TRIGGER hesabu_gate_before_signoff[\s\S]*?;/,
    )![0];
    expect(originalTrigger).not.toMatch(/WHEN/i);
    expect(fixTrigger).not.toMatch(/WHEN/i);
    expect(normalizeSqlWhitespace(originalTrigger)).toMatch(/BEFORE INSERT ON statement_sign_offs/i);
    expect(normalizeSqlWhitespace(fixTrigger)).toMatch(/BEFORE INSERT ON public\.statement_sign_offs/i);
  });
});

describe("csf_tz_coa_seed — global company_id scope and the real uppercase pl_category vocabulary", () => {
  // A live sequential db push against an empty staging database reached
  // migration #64 (20260711400100_csf_tz_coa_seed.sql) and failed with
  // `column "slug" does not exist` (SQLSTATE 42703): the migration looked up
  // a "saff_default company" by a companies.slug column that has never
  // existed. A second, independent defect was found on read-only audit: even
  // after fixing that lookup, every one of the 78 seed rows used an invented
  // lowercase pl_category vocabulary that matches none of the real 15-value
  // uppercase enum defined by account_pl_mapping's own CHECK constraint (and
  // consumed as such by maono-cashflow/maono-compute/maono-monitor). Neither
  // defect had gone unnoticed by chance — sibling seed migrations for the
  // same table already establish the correct pattern: company_id = NULL for
  // global default rule-sets. This correction removes the invalid lookup
  // entirely (literal NULL, no runtime dependency to fail on), and maps each
  // of the 78 rows to its evidenced real category, preserving every
  // match_value, match_priority, is_credit_normal, and source value exactly.
  const SEED_FILE = "20260711400100_csf_tz_coa_seed.sql";
  const CREATOR_FILE = "20260711163040_9ec82b5f-ee11-45e7-942a-65f09f24dddf.sql";

  const VALID_PL_CATEGORIES = [
    "REVENUE", "COST_OF_SALES", "OTHER_INCOME", "PERSONNEL_COSTS", "DEPRECIATION",
    "AMORTISATION", "OTHER_OPEX", "FINANCE_INCOME", "FINANCE_COSTS", "TAX_EXPENSE",
    "WITHHOLDING_TAX", "BALANCE_SHEET_ASSET", "BALANCE_SHEET_LIAB", "BALANCE_SHEET_EQUITY", "STATISTICAL",
  ];

  interface SeedRow {
    companyIdToken: string;
    matchValue: string;
    priority: string;
    category: string;
    creditNormal: string;
    source: string;
  }

  function extractSeedRows(): SeedRow[] {
    // The row values (including the pl_category literal) live inside single
    // quotes, which stripCommentsStringsAndDollarQuotes blanks out by design
    // — read the raw source with only line comments removed instead.
    const commentsOnlyStripped = readMigration(SEED_FILE).replace(/--.*$/gm, "");
    const rowRe = /VALUES \((NULL|v_company), 'pattern', '([^']*)', (\d+), '([A-Za-z_]+)', (TRUE|FALSE), '(csf_tz_coa)'\)/g;
    const rows: SeedRow[] = [];
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(commentsOnlyStripped)) !== null) {
      rows.push({
        companyIdToken: m[1],
        matchValue: m[2],
        priority: m[3],
        category: m[4],
        creditNormal: m[5],
        source: m[6],
      });
    }
    return rows;
  }

  // The exact 78 (match_value, is_credit_normal) pairs as they existed before
  // this correction — captured directly from the pre-fix file during audit.
  // Every row's match_value, match_priority (always 80), and is_credit_normal
  // must still be present, completely unchanged, after the correction —
  // proving nothing was silently dropped or altered beyond company_id and
  // pl_category.
  const ORIGINAL_ROWS: Array<[string, "TRUE" | "FALSE"]> = [
    ["nssf", "FALSE"], ["pssf", "FALSE"], ["wcf", "FALSE"], ["lapf", "FALSE"], ["gepf", "FALSE"],
    ["nhif", "FALSE"], ["sdl", "FALSE"], ["skills development levy", "FALSE"],
    ["paye payable", "TRUE"], ["paye expense", "FALSE"],
    ["output vat", "TRUE"], ["vat payable", "TRUE"], ["kodi ya ongezeko la thamani", "TRUE"],
    ["input vat", "FALSE"], ["vat receivable", "FALSE"],
    ["withholding tax payable", "TRUE"], ["wht payable", "TRUE"], ["withholding tax", "TRUE"],
    ["tra payable", "TRUE"],
    ["m-pesa", "FALSE"], ["mpesa", "FALSE"], ["tigo pesa", "FALSE"], ["tigopesa", "FALSE"],
    ["airtel money", "FALSE"], ["halopesa", "FALSE"], ["t-pesa", "FALSE"], ["mobile money", "FALSE"],
    ["pesa ya simu", "FALSE"], ["e-float", "FALSE"],
    ["mapato", "TRUE"], ["mauzo", "TRUE"], ["faida", "TRUE"],
    ["gharama", "FALSE"], ["mishahara", "FALSE"], ["mshahara", "FALSE"], ["posho", "FALSE"],
    ["pango", "FALSE"], ["umeme", "FALSE"], ["maji", "FALSE"], ["usafiri", "FALSE"],
    ["uchakamavu", "FALSE"],
    ["fedha taslimu", "FALSE"], ["akaunti ya benki", "FALSE"], ["wadai", "FALSE"], ["bidhaa", "FALSE"],
    ["hisa", "FALSE"], ["mali", "FALSE"],
    ["madeni", "TRUE"], ["deni", "TRUE"], ["mkopo", "TRUE"],
    ["mtaji", "TRUE"], ["akiba ya faida", "TRUE"],
    ["crdb", "FALSE"], ["nmb bank", "FALSE"], ["stanbic", "FALSE"], ["equity bank", "FALSE"],
    ["dtb tanzania", "FALSE"], ["exim bank", "FALSE"], ["kcb tanzania", "FALSE"], ["absa bank", "FALSE"],
    ["standard chartered", "FALSE"], ["azania bank", "FALSE"], ["tpb bank", "FALSE"], ["uchumi commercial", "FALSE"],
    ["efd sales", "TRUE"], ["fiscal sales", "TRUE"], ["z-report discrepancy", "FALSE"], ["efd difference", "FALSE"],
    ["tanesco", "FALSE"], ["dawasa", "FALSE"], ["dawasco", "FALSE"],
    ["income tax payable", "TRUE"], ["current tax payable", "TRUE"], ["kodi ya mapato", "TRUE"],
    ["income tax expense", "FALSE"], ["current tax charge", "FALSE"],
    ["deferred tax liability", "TRUE"], ["deferred tax asset", "FALSE"],
  ];

  it("finds exactly 78 account_pl_mapping INSERT statements", () => {
    const insertCount = (readMigration(SEED_FILE).match(/INSERT INTO account_pl_mapping/g) ?? []).length;
    expect(insertCount).toBe(78);
    expect(extractSeedRows().length).toBe(78);
  });

  it("every INSERT uses literal NULL for company_id — none reference v_company", () => {
    const rows = extractSeedRows();
    for (const row of rows) {
      expect(row.companyIdToken, `${row.matchValue}: company_id must be literal NULL`).toBe("NULL");
    }
    expect(rows.filter((r) => r.companyIdToken === "v_company")).toHaveLength(0);
  });

  it("no companies.slug reference, v_company variable, or saff_default-company lookup remains anywhere in the file", () => {
    const raw = readMigration(SEED_FILE);
    expect(raw).not.toMatch(/\bslug\b/i);
    expect(raw).not.toMatch(/\bv_company\b/);
    expect(raw).not.toMatch(/saff_default company/i);
    expect(raw).not.toMatch(/FROM\s+companies\s+WHERE/i);
    expect(raw).not.toMatch(/DECLARE/i);
  });

  it("every pl_category belongs to the real 15-value account_pl_mapping enum", () => {
    const rows = extractSeedRows();
    const invalid = rows.filter((r) => !VALID_PL_CATEGORIES.includes(r.category));
    expect(invalid, JSON.stringify(invalid)).toEqual([]);
  });

  it("the exact resulting category distribution matches 31/15/12/8/4/2/2/2/1/1", () => {
    const rows = extractSeedRows();
    const tally: Record<string, number> = {};
    for (const row of rows) tally[row.category] = (tally[row.category] ?? 0) + 1;
    expect(tally).toEqual({
      BALANCE_SHEET_ASSET: 31,
      BALANCE_SHEET_LIAB: 15,
      PERSONNEL_COSTS: 12,
      OTHER_OPEX: 8,
      REVENUE: 4,
      TAX_EXPENSE: 2,
      STATISTICAL: 2,
      BALANCE_SHEET_EQUITY: 2,
      OTHER_INCOME: 1,
      DEPRECIATION: 1,
    });
    const total = Object.values(tally).reduce((a, b) => a + b, 0);
    expect(total).toBe(78);
  });

  it("every identified tax, WHT, VAT, depreciation, and statistical special case maps exactly as specified", () => {
    const rows = extractSeedRows();
    const byValue = (v: string) => rows.find((r) => r.matchValue === v);

    // WHT payable patterns — balance-sheet liability, NOT the WITHHOLDING_TAX P&L category
    expect(byValue("withholding tax payable")?.category).toBe("BALANCE_SHEET_LIAB");
    expect(byValue("wht payable")?.category).toBe("BALANCE_SHEET_LIAB");
    expect(byValue("withholding tax")?.category).toBe("BALANCE_SHEET_LIAB");

    // VAT
    expect(byValue("input vat")?.category).toBe("BALANCE_SHEET_ASSET");
    expect(byValue("vat receivable")?.category).toBe("BALANCE_SHEET_ASSET");
    expect(byValue("output vat")?.category).toBe("BALANCE_SHEET_LIAB");
    expect(byValue("vat payable")?.category).toBe("BALANCE_SHEET_LIAB");
    expect(byValue("kodi ya ongezeko la thamani")?.category).toBe("BALANCE_SHEET_LIAB");
    expect(byValue("tra payable")?.category).toBe("BALANCE_SHEET_LIAB");

    // Income tax expense vs payable
    expect(byValue("income tax expense")?.category).toBe("TAX_EXPENSE");
    expect(byValue("current tax charge")?.category).toBe("TAX_EXPENSE");
    expect(byValue("income tax payable")?.category).toBe("BALANCE_SHEET_LIAB");
    expect(byValue("current tax payable")?.category).toBe("BALANCE_SHEET_LIAB");
    expect(byValue("kodi ya mapato")?.category).toBe("BALANCE_SHEET_LIAB");

    // Deferred tax
    expect(byValue("deferred tax asset")?.category).toBe("BALANCE_SHEET_ASSET");
    expect(byValue("deferred tax liability")?.category).toBe("BALANCE_SHEET_LIAB");

    // Depreciation (not the combined/invalid category, not AMORTISATION)
    expect(byValue("uchakamavu")?.category).toBe("DEPRECIATION");

    // Statistical (EFD rounding/discrepancy — excluded from real P&L, not deleted)
    expect(byValue("z-report discrepancy")?.category).toBe("STATISTICAL");
    expect(byValue("efd difference")?.category).toBe("STATISTICAL");
  });

  it("all 78 source values remain 'csf_tz_coa'", () => {
    const rows = extractSeedRows();
    expect(rows.every((r) => r.source === "csf_tz_coa")).toBe(true);
    expect(rows).toHaveLength(78);
  });

  it("every ON CONFLICT (company_id, match_type, match_value) DO NOTHING clause remains structurally correct and present exactly 78 times", () => {
    const raw = readMigration(SEED_FILE);
    const conflictCount = (raw.match(/ON CONFLICT \(company_id, match_type, match_value\) DO NOTHING;/g) ?? []).length;
    expect(conflictCount).toBe(78);
  });

  it("the UNIQUE NULLS NOT DISTINCT (company_id, match_type, match_value) constraint exists in the real creator, which sorts before this seed migration", () => {
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    expect(files.indexOf(CREATOR_FILE)).toBeLessThan(files.indexOf(SEED_FILE));
    const creatorText = stripCommentsStringsAndDollarQuotes(readMigration(CREATOR_FILE));
    expect(creatorText).toMatch(/UNIQUE NULLS NOT DISTINCT \(company_id, match_type, match_value\)/);
  });

  it("no match_value, match_priority, or is_credit_normal flag was lost — all 78 original rows are still present, unchanged, keyed by match_value", () => {
    const rows = extractSeedRows();
    expect(rows).toHaveLength(ORIGINAL_ROWS.length);

    const currentByValue = new Map(rows.map((r) => [r.matchValue, r]));
    for (const [matchValue, creditNormal] of ORIGINAL_ROWS) {
      const current = currentByValue.get(matchValue);
      expect(current, `expected match_value "${matchValue}" to still be present`).toBeDefined();
      expect(current!.priority, `${matchValue}: match_priority must remain 80`).toBe("80");
      expect(current!.creditNormal, `${matchValue}: is_credit_normal must be unchanged`).toBe(creditNormal);
    }

    // No extra or renamed rows either — the two sets are exactly equal.
    const originalValues = new Set(ORIGINAL_ROWS.map(([v]) => v));
    const currentValues = new Set(rows.map((r) => r.matchValue));
    expect(currentValues).toEqual(originalValues);
  });

  it("no executable or documentation reference to companies.slug or a nonexistent saff_default company remains", () => {
    const raw = readMigration(SEED_FILE);
    expect(raw).not.toMatch(/companies\.slug/i);
    expect(raw).not.toMatch(/saff_default\s+company/i);
    expect(raw).not.toMatch(/Resolve the saff_default company/i);
    // The 'csf_tz_coa' source tag itself is unrelated and must remain untouched.
    expect(raw).toContain("csf_tz_coa");
  });

  it("the CREATE INDEX idx_account_pl_mapping_csf_tz statement is unchanged", () => {
    const raw = readMigration(SEED_FILE);
    expect(raw).toMatch(/CREATE INDEX IF NOT EXISTS idx_account_pl_mapping_csf_tz\s*\n\s*ON account_pl_mapping\(company_id, match_priority, pl_category\)\s*\n\s*WHERE source = 'csf_tz_coa';/);
  });
});

describe("Correction — chk_rate_or_threshold widened to represent unverified, rate-pending placeholders (20260712000000_gated_unverified_rates.sql)", () => {
  const FILE = "20260712000000_gated_unverified_rates.sql";
  const raw = readMigration(FILE);

  function currentCheck(r: { rateIsThreshold: boolean; ratePct: number | null; flatTaxTzs: number | null }): boolean {
    return r.rateIsThreshold === true || r.ratePct !== null || r.flatTaxTzs !== null;
  }
  function proposedCheck(r: {
    verifiedAt: string | null;
    rateIsThreshold: boolean;
    ratePct: number | null;
    flatTaxTzs: number | null;
  }): boolean {
    return r.verifiedAt === null || r.rateIsThreshold === true || r.ratePct !== null || r.flatTaxTzs !== null;
  }

  it("drops and recreates chk_rate_or_threshold before the INSERT, all inside the same implicit per-file transaction", () => {
    const dropIdx = raw.indexOf("DROP CONSTRAINT chk_rate_or_threshold");
    const addIdx = raw.indexOf("ADD CONSTRAINT chk_rate_or_threshold");
    const insertIdx = raw.indexOf("INSERT INTO public.statutory_rules");
    expect(dropIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(dropIdx);
    expect(insertIdx).toBeGreaterThan(addIdx);
    // No explicit BEGIN/COMMIT split — the DDL and INSERT share one implicit
    // per-file transaction, so a failure anywhere rolls back both together.
    expect(raw).not.toMatch(/^\s*BEGIN;/m);
    expect(raw).not.toMatch(/^\s*COMMIT;/m);
  });

  it("uses a plain DROP CONSTRAINT (no IF EXISTS), preserves the exact constraint name, and adds no NOT VALID", () => {
    expect(raw).toMatch(/DROP CONSTRAINT chk_rate_or_threshold;/);
    expect(raw).not.toMatch(/DROP CONSTRAINT IF EXISTS/);
    expect(raw).not.toMatch(/NOT VALID/);
  });

  it("the recreated predicate is exactly verified_at-aware, and this migration does not touch the other three CHECK constraints", () => {
    const checkMatch = raw.match(/ADD CONSTRAINT chk_rate_or_threshold\s*\n\s*CHECK \(([\s\S]*?)\);/);
    expect(checkMatch).not.toBeNull();
    const predicate = checkMatch![1].replace(/\s+/g, " ").trim();
    expect(predicate).toBe(
      "verified_at IS NULL OR rate_is_threshold = TRUE OR rate_pct IS NOT NULL OR flat_tax_tzs IS NOT NULL",
    );
    expect(raw).not.toMatch(/chk_threshold_has_amount/);
    expect(raw).not.toMatch(/chk_no_threshold_and_flat_tax/);
    expect(raw).not.toMatch(/chk_effective_dates/);
  });

  const TRUTH_TABLE_CASES: Array<{
    label: string;
    row: { verifiedAt: string | null; rateIsThreshold: boolean; ratePct: number | null; flatTaxTzs: number | null };
    current: boolean;
    proposed: boolean;
  }> = [
    { label: "unverified, no rate", row: { verifiedAt: null, rateIsThreshold: false, ratePct: null, flatTaxTzs: null }, current: false, proposed: true },
    { label: "unverified, rate_pct set", row: { verifiedAt: null, rateIsThreshold: false, ratePct: 5, flatTaxTzs: null }, current: true, proposed: true },
    { label: "unverified, threshold set", row: { verifiedAt: null, rateIsThreshold: true, ratePct: null, flatTaxTzs: null }, current: true, proposed: true },
    { label: "unverified, flat-tax set", row: { verifiedAt: null, rateIsThreshold: false, ratePct: null, flatTaxTzs: 100000 }, current: true, proposed: true },
    { label: "verified, no rate", row: { verifiedAt: "2026-01-01", rateIsThreshold: false, ratePct: null, flatTaxTzs: null }, current: false, proposed: false },
    { label: "verified, rate_pct set", row: { verifiedAt: "2026-01-01", rateIsThreshold: false, ratePct: 5, flatTaxTzs: null }, current: true, proposed: true },
    { label: "verified, threshold set", row: { verifiedAt: "2026-01-01", rateIsThreshold: true, ratePct: null, flatTaxTzs: null }, current: true, proposed: true },
    { label: "verified, flat-tax set", row: { verifiedAt: "2026-01-01", rateIsThreshold: false, ratePct: null, flatTaxTzs: 100000 }, current: true, proposed: true },
  ];

  it.each(TRUTH_TABLE_CASES)("truth table: $label", ({ row, current, proposed }) => {
    expect(currentCheck(row)).toBe(current);
    expect(proposedCheck(row)).toBe(proposed);
  });

  it("exactly one of the eight truth-table cases changes behavior (unverified/no-rate), and verified/no-rate remains rejected under both the current and proposed predicate", () => {
    const changed = TRUTH_TABLE_CASES.filter((c) => c.current !== c.proposed);
    expect(changed).toHaveLength(1);
    expect(changed[0]!.label).toBe("unverified, no rate");
    const verifiedNoRate = TRUTH_TABLE_CASES.find((c) => c.label === "verified, no rate")!;
    expect(verifiedNoRate.current).toBe(false);
    expect(verifiedNoRate.proposed).toBe(false);
  });

  // All 24 statutory_rules rows statically reconstructable from every
  // INSERT/UPDATE before migration #67 (20260625110000: 9 rows;
  // 20260626150000: 9 rows, later verified by 20260701000000;
  // 20260626160000: 6 rows). Field values transcribed directly from the
  // migration source read during the read-only audit.
  const PRE_EXISTING_ROWS: Array<{
    key: string;
    rateIsThreshold: boolean;
    ratePct: number | null;
    flatTaxTzs: null;
    verifiedAt?: string;
  }> = [
    { key: "sdl", rateIsThreshold: false, ratePct: 4.0, flatTaxTzs: null },
    { key: "vat_withholding_goods_fa2025", rateIsThreshold: false, ratePct: 3.0, flatTaxTzs: null },
    { key: "vat_withholding_services_fa2025", rateIsThreshold: false, ratePct: 6.0, flatTaxTzs: null },
    { key: "vat_reduced_rate_electronic_b2c", rateIsThreshold: false, ratePct: 16.0, flatTaxTzs: null },
    { key: "wht_undistributed_earnings", rateIsThreshold: false, ratePct: 10.0, flatTaxTzs: null },
    { key: "wht_hired_motor_vehicles", rateIsThreshold: false, ratePct: 10.0, flatTaxTzs: null },
    { key: "vat_registration_threshold", rateIsThreshold: true, ratePct: null, flatTaxTzs: null },
    { key: "cpa_certification_required_individual", rateIsThreshold: true, ratePct: null, flatTaxTzs: null },
    { key: "cpa_certification_required_corporate", rateIsThreshold: true, ratePct: null, flatTaxTzs: null },
    { key: "retained_earnings_deemed_distribution", rateIsThreshold: false, ratePct: 15.0, flatTaxTzs: null, verifiedAt: "2026-07-01" },
    { key: "vat_withholding_goods_fa2026", rateIsThreshold: false, ratePct: 15.0, flatTaxTzs: null, verifiedAt: "2026-07-01" },
    { key: "vat_withholding_services_fa2026", rateIsThreshold: false, ratePct: 12.0, flatTaxTzs: null, verifiedAt: "2026-07-01" },
    { key: "presumptive_tax_threshold", rateIsThreshold: true, ratePct: null, flatTaxTzs: null, verifiedAt: "2026-07-01" },
    { key: "presumptive_tax_top_band_rate", rateIsThreshold: false, ratePct: 4.5, flatTaxTzs: null, verifiedAt: "2026-07-01" },
    { key: "withholding_crops_livestock_fishery", rateIsThreshold: false, ratePct: 1.0, flatTaxTzs: null, verifiedAt: "2026-07-01" },
    { key: "single_instalment_food_crops", rateIsThreshold: false, ratePct: 1.0, flatTaxTzs: null, verifiedAt: "2026-07-01" },
    { key: "single_instalment_forest_produce", rateIsThreshold: false, ratePct: 2.0, flatTaxTzs: null, verifiedAt: "2026-07-01" },
    { key: "nonresident_digital_service_tax", rateIsThreshold: false, ratePct: 3.0, flatTaxTzs: null, verifiedAt: "2026-07-01" },
    { key: "presumptive_tax_band1", rateIsThreshold: false, ratePct: 0.0, flatTaxTzs: null },
    { key: "presumptive_tax_band2_new_tin", rateIsThreshold: false, ratePct: 0.0, flatTaxTzs: null },
    { key: "presumptive_tax_band3_compliant", rateIsThreshold: false, ratePct: 3.0, flatTaxTzs: null },
    { key: "presumptive_tax_band3_noncompliant", rateIsThreshold: true, ratePct: null, flatTaxTzs: null },
    { key: "presumptive_tax_band4_compliant", rateIsThreshold: true, ratePct: 3.0, flatTaxTzs: null },
    { key: "presumptive_tax_band4_noncompliant", rateIsThreshold: true, ratePct: null, flatTaxTzs: null },
  ];

  it("has exactly 24 statically reconstructable pre-existing statutory_rules rows from before migration #67", () => {
    expect(PRE_EXISTING_ROWS).toHaveLength(24);
    expect(new Set(PRE_EXISTING_ROWS.map((r) => r.key)).size).toBe(24);
  });

  it("every pre-existing row satisfies the proposed constraint, both in its originally-unverified state and (for the 9 FA2026 rows) after 20260701000000 sets verified_at", () => {
    for (const r of PRE_EXISTING_ROWS) {
      expect(
        proposedCheck({ verifiedAt: null, rateIsThreshold: r.rateIsThreshold, ratePct: r.ratePct, flatTaxTzs: r.flatTaxTzs }),
        `${r.key} (unverified) must satisfy the proposed constraint`,
      ).toBe(true);
      if (r.verifiedAt) {
        expect(
          proposedCheck({ verifiedAt: r.verifiedAt, rateIsThreshold: r.rateIsThreshold, ratePct: r.ratePct, flatTaxTzs: r.flatTaxTzs }),
          `${r.key} (verified) must satisfy the proposed constraint`,
        ).toBe(true);
      }
    }
  });

  interface PlaceholderRow {
    triggerCategory: string;
    statute: string;
    obligation: string;
    ratePct: string;
    thresholdAmount: string;
    rateIsThreshold: string;
    jurisdiction: string;
    industryPack: string;
    effectiveFrom: string;
    effectiveTo: string;
    verifiedAt: string;
    verifiedBy: string;
  }

  const ROW_RE =
    /^'([^']*)',\s*\n\s*'([^']*)',\s*\n\s*'([^']*)',\s*\n\s*(NULL|-?[\d.]+),[^\n]*\n\s*(NULL|-?[\d.]+),[^\n]*\n\s*(true|false),\s*\n\s*'([^']*)',\s*\n\s*'([^']*)',\s*\n\s*'([^']*)',\s*\n\s*(NULL),\s*\n\s*(NULL),[^\n]*\n\s*(NULL),[^\n]*\n/;

  function extractPlaceholderRows(): PlaceholderRow[] {
    const names = ["min_tax", "thin_cap", "mgmt_fee_cap"];
    const anchors = names.map((n) => raw.indexOf(`'${n}',`));
    anchors.forEach((idx, i) => expect(idx, `expected to find row for ${names[i]}`).toBeGreaterThan(-1));
    const conflictIdx = raw.indexOf("ON CONFLICT (trigger_category");
    expect(conflictIdx).toBeGreaterThan(-1);
    const boundaries = [...anchors, conflictIdx];

    return anchors.map((start, i) => {
      const chunk = raw.slice(start, boundaries[i + 1]);
      const m = chunk.match(ROW_RE);
      expect(m, `failed to parse row for ${names[i]}`).not.toBeNull();
      const [
        ,
        triggerCategory,
        statute,
        obligation,
        ratePct,
        thresholdAmount,
        rateIsThreshold,
        jurisdiction,
        industryPack,
        effectiveFrom,
        effectiveTo,
        verifiedAt,
        verifiedBy,
      ] = m!;
      return {
        triggerCategory,
        statute,
        obligation,
        ratePct,
        thresholdAmount,
        rateIsThreshold,
        jurisdiction,
        industryPack,
        effectiveFrom,
        effectiveTo,
        verifiedAt,
        verifiedBy,
      };
    });
  }

  it("all three placeholders (min_tax, thin_cap, mgmt_fee_cap) exist exactly once, each with every rate field NULL and verified_at/verified_by NULL", () => {
    const rows = extractPlaceholderRows();
    expect(rows.map((r) => r.triggerCategory)).toEqual(["min_tax", "thin_cap", "mgmt_fee_cap"]);
    for (const r of rows) {
      expect(r.ratePct).toBe("NULL");
      expect(r.thresholdAmount).toBe("NULL");
      expect(r.rateIsThreshold).toBe("false");
      expect(r.verifiedAt).toBe("NULL");
      expect(r.verifiedBy).toBe("NULL");
      expect(r.jurisdiction).toBe("TZ");
      expect(r.industryPack).toBe("general");
      expect(r.effectiveFrom).toBe("2024-07-01");
      expect(r.effectiveTo).toBe("NULL");
    }
    for (const name of ["min_tax", "thin_cap", "mgmt_fee_cap"]) {
      const count = (raw.match(new RegExp(`'${name}',`, "g")) ?? []).length;
      expect(count, `${name} must occur exactly once`).toBe(1);
    }
  });

  it("all three placeholders pass every applicable CHECK constraint under the proposed predicate (chk_rate_or_threshold, chk_threshold_has_amount, chk_no_threshold_and_flat_tax, chk_effective_dates)", () => {
    const rows = extractPlaceholderRows();
    for (const r of rows) {
      const parsed = {
        verifiedAt: r.verifiedAt === "NULL" ? null : r.verifiedAt,
        rateIsThreshold: r.rateIsThreshold === "true",
        ratePct: r.ratePct === "NULL" ? null : Number(r.ratePct),
        flatTaxTzs: null as number | null, // column omitted from this INSERT's column list -> defaults NULL
      };
      expect(proposedCheck(parsed), `${r.triggerCategory}: chk_rate_or_threshold`).toBe(true);
      expect(parsed.rateIsThreshold, `${r.triggerCategory}: rate_is_threshold must be false so chk_threshold_has_amount/chk_no_threshold_and_flat_tax pass trivially`).toBe(false);
      expect(r.effectiveTo, `${r.triggerCategory}: chk_effective_dates`).toBe("NULL");
    }
  });

  it("a placeholder cannot be changed to verified_at NOT NULL while all rate fields remain NULL — the proposed constraint still rejects it", () => {
    const attemptedVerify = { verifiedAt: "2026-09-08T00:00:00Z", rateIsThreshold: false, ratePct: null, flatTaxTzs: null };
    expect(proposedCheck(attemptedVerify)).toBe(false);
  });

  it("is_mandatory does not appear anywhere in the corrected migration", () => {
    expect(raw).not.toMatch(/is_mandatory/);
  });

  it("introduces no fabricated numeric rate or threshold value for any of the three placeholders", () => {
    const rows = extractPlaceholderRows();
    for (const r of rows) {
      expect(r.ratePct).toBe("NULL");
      expect(r.thresholdAmount).toBe("NULL");
    }
  });

  it("the ON CONFLICT target columns and WHERE effective_to IS NULL predicate exactly match the uq_statutory_rule_active partial unique index", () => {
    expect(raw).toMatch(
      /ON CONFLICT \(trigger_category, jurisdiction, industry_pack\)\s*\n\s*WHERE effective_to IS NULL\s*\nDO NOTHING;/,
    );
    const creatorFile = "20260625100000_b3e5c891-7f4a-4d2e-9c18-a6f0d2e8b347.sql";
    const creatorText = readMigration(creatorFile);
    expect(creatorText).toMatch(
      /CREATE UNIQUE INDEX uq_statutory_rule_active\s*\nON public\.statutory_rules \(trigger_category, jurisdiction, industry_pack\)\s*\nNULLS NOT DISTINCT\s*\nWHERE effective_to IS NULL;/,
    );
  });

  it("trigger_category, statute, obligation, notes, effective_from, jurisdiction, and industry_pack are unchanged for all three rows", () => {
    expect(raw).toContain("'Income Tax Act Cap.332 First Schedule para 3(3)'");
    expect(raw).toContain(
      "'Alternative Minimum Tax: 1% of turnover when entity has unrelieved losses in current and preceding 2 years. Exempt: agriculture, health, education, tea processing.'",
    );
    expect(raw).toContain("'Income Tax Act Cap.332 s.12(2)'");
    expect(raw).toContain(
      "'Thin capitalisation: interest disallowance on debt exceeding 7:3 debt-to-equity ratio for exempt-controlled resident entities (25%+ non-resident/exempt ownership). Local bank debt excluded by s.12(5)(ii).'",
    );
    expect(raw).toContain("'Income Tax Act Cap.332 s.33'");
    expect(raw).toContain(
      "'Management and professional fee cap: fees paid to foreign related parties deductible only up to specified percentage of gross income.'",
    );
    expect(raw).toContain("'GATED pending primary-source verification — see kinga-tax-engine gating diff 2026-07-12. '");
    expect((raw.match(/'2024-07-01'/g) ?? []).length).toBe(3);
    expect((raw.match(/'TZ'/g) ?? []).length).toBe(3);
    expect((raw.match(/'general'/g) ?? []).length).toBe(3);
  });

  it("the enforce_verified_statutory_rule trigger and the findings engine's verified_at query filter remain present and untouched elsewhere in the repo", () => {
    const triggerFile = "20260625140000_c4e8a291-6d3b-4f7e-a052-b9e1d5c7f384.sql";
    const triggerText = readMigration(triggerFile);
    expect(triggerText).toMatch(/CREATE OR REPLACE FUNCTION public\.enforce_verified_statutory_rule\(\)/);
    expect(triggerText).toMatch(/v_rule\.verified_at IS NULL THEN/);

    const findingsEnginePath = path.join(REPO_ROOT, "supabase/functions/kinga-findings-engine/index.ts");
    const findingsEngineText = fs.readFileSync(findingsEnginePath, "utf-8");
    expect(findingsEngineText).toMatch(/\.not\(\s*"verified_at"\s*,\s*"is"\s*,\s*null\s*\)/);

    // This migration touches only public.statutory_rules — it never creates,
    // drops, or alters the findings table, the trigger, or its function
    // (its header comment merely names the trigger to explain the gate).
    expect(raw).not.toMatch(/public\.findings/);
    expect(raw).not.toMatch(/CREATE (OR REPLACE )?(FUNCTION|TRIGGER)/);
    expect(raw).not.toMatch(/DROP TRIGGER/);
  });

  it("no later migration references public.statutory_rules at all — nothing supersedes this correction", () => {
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    const idx = files.indexOf(FILE);
    expect(idx).toBeGreaterThan(-1);
    for (const f of files.slice(idx + 1)) {
      const text = readMigration(f);
      expect(text, `${f} unexpectedly references statutory_rules`).not.toMatch(/statutory_rules/);
    }
  });
});

/**
 * Normalizes SQL by replacing comment contents, single-quoted string
 * literals, and double-quoted identifiers with placeholder tokens, and
 * RECURSIVELY doing the same inside dollar-quoted bodies — while preserving
 * the dollar-quote tag markers and every keyword/structural token
 * (DECLARE, BEGIN, END, PROCEDURE, FUNCTION, DO, etc.) at every nesting
 * level. Unlike stripCommentsStringsAndDollarQuotes (which blanks an entire
 * dollar-quoted body to a single space), this preserves enough structure to
 * detect keyword-level defects *inside* PL/pgSQL block bodies, such as a
 * subprogram illegally declared inside a DO block's DECLARE section.
 */
function normalizeSqlKeepingStructure(sql: string): string {
  let out = "";
  let i = 0;
  const dollarTagRe = /\$([a-zA-Z_]*)\$/y;
  while (i < sql.length) {
    if (sql[i] === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      out += "\n";
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      out += " ";
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j += 1; break; }
        j++;
      }
      out += " STR ";
      i = j;
      continue;
    }
    if (sql[i] === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"' && sql[j + 1] === '"') { j += 2; continue; }
        if (sql[j] === '"') { j += 1; break; }
        j++;
      }
      out += " IDENT ";
      i = j;
      continue;
    }
    if (sql[i] === "$") {
      dollarTagRe.lastIndex = i;
      const m = dollarTagRe.exec(sql);
      if (m && m.index === i) {
        const tag = m[0];
        const bodyStart = i + tag.length;
        const end = sql.indexOf(tag, bodyStart);
        const bodyEnd = end === -1 ? sql.length : end;
        const normalizedBody = normalizeSqlKeepingStructure(sql.slice(bodyStart, bodyEnd));
        out += tag + normalizedBody + tag;
        i = end === -1 ? sql.length : end + tag.length;
        continue;
      }
    }
    out += sql[i];
    i++;
  }
  return out;
}

/** Extracts every top-level `DO $tag$ ... $tag$` block body from already-normalized SQL. */
function findDoBlockBodies(normalizedSql: string): string[] {
  const bodies: string[] = [];
  const re = /\bDO\s+(\$[a-zA-Z_]*\$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalizedSql))) {
    const tag = m[1];
    const start = m.index + m[0].length;
    const end = normalizedSql.indexOf(tag, start);
    if (end === -1) continue;
    bodies.push(normalizedSql.slice(start, end));
    re.lastIndex = end + tag.length;
  }
  return bodies;
}

/**
 * True if a DO block's DECLARE section (the span from its own `DECLARE` to
 * its own first `BEGIN`) contains a PROCEDURE or FUNCTION keyword — the
 * exact shape of an illegal nested-subprogram declaration. PL/pgSQL has no
 * such feature; only Oracle PL/SQL supports declaring local
 * procedures/functions inside a block's declaration section.
 */
function doBlockDeclaresNestedSubprogram(doBody: string): boolean {
  const declIdx = doBody.search(/\bDECLARE\b/);
  if (declIdx === -1) return false;
  const afterDecl = doBody.slice(declIdx);
  const beginMatch = afterDecl.match(/\bBEGIN\b/);
  if (!beginMatch || beginMatch.index === undefined) return false;
  const declSection = afterDecl.slice(0, beginMatch.index);
  return /\bPROCEDURE\b|\bFUNCTION\b/.test(declSection);
}

describe("Correction — Phase 1-B smoke test rewritten to remove the invalid nested PROCEDURE (20260712200000_phase1_b_identity_migration.sql)", () => {
  const FILE = "20260712200000_phase1_b_identity_migration.sql";
  const raw = readMigration(FILE);
  const SECTION_5_MARKER = "-- ── SECTION 5: SMOKE TEST";
  const sectionIdx = raw.indexOf(SECTION_5_MARKER);
  const smokeBlock = raw.slice(sectionIdx);
  const preSmoke = raw.slice(0, sectionIdx);
  // Comment-stripped view for keyword-absence checks — the block's own
  // explanatory NOTE legitimately *documents* the old PROCEDURE/ASSERT/
  // check_col(...) shape it replaced, so a raw substring search would
  // false-positive on that documentation. Only line comments are stripped
  // here (not the dollar-quoted DO body itself, which is exactly the
  // executable content these checks need to inspect).
  const smokeBlockCodeOnly = smokeBlock.replace(/--[^\n]*/g, "");

  const ORIGINAL_25_PAIRS: Array<[string, string]> = [
    ["capital_allowances", "created_by_member_id"],
    ["tax_payments", "created_by_member_id"],
    ["fiscal_periods", "created_by_member_id"],
    ["tax_losses", "created_by_member_id"],
    ["tax_computations", "cpa_modified_by_member_id"],
    ["adjusting_journal_entries", "created_by_member_id"],
    ["adjusting_journal_entries", "approved_by_member_id"],
    ["management_inputs", "created_by_member_id"],
    ["statement_sign_offs", "locked_by_member_id"],
    ["safisha_exceptions", "reviewer_member_id"],
    ["safisha_audit_log", "reviewer_member_id"],
    ["account_pl_mapping", "created_by_member_id"],
    ["variance_materiality", "updated_by_member_id"],
    ["variance_budgets", "submitted_by_member_id"],
    ["variance_budgets", "approved_by_member_id"],
    ["variance_runs", "triggered_by_member_id"],
    ["variance_alerts", "acknowledged_by_member_id"],
    ["board_packs", "generated_by_member_id"],
    ["efdms_z_reports", "imported_by_member_id"],
    ["efdms_reconciliation", "reconciled_by_member_id"],
    ["hesabu_validations", "validated_by_member_id"],
    ["xbrl_instance_documents", "generated_by_member_id"],
    ["efdms_records", "ingested_by_member_id"],
    ["findings", "created_by_member_id"],
    ["evidence_requests", "created_by_member_id"],
  ];

  function extractValuesPairs(): Array<[string, string]> {
    const valuesMatch = smokeBlock.match(/FROM \(VALUES([\s\S]*?)\) AS checks\(table_name, column_name\)/);
    expect(valuesMatch, "expected a FROM (VALUES ...) AS checks(table_name, column_name) clause").not.toBeNull();
    const rowRe = /\('([^']*)',\s*'([^']*)'\)/g;
    const pairs: Array<[string, string]> = [];
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(valuesMatch![1]))) pairs.push([m[1], m[2]]);
    return pairs;
  }

  it("1. contains no nested PROCEDURE (or FUNCTION) declaration anywhere in the smoke block's executable code", () => {
    expect(smokeBlockCodeOnly).not.toMatch(/\bPROCEDURE\b/);
    expect(smokeBlockCodeOnly).not.toMatch(/\bFUNCTION\s+\w+\s*\(/);
  });

  it("2. uses valid RECORD iteration over an inline VALUES relation, not a procedure call loop", () => {
    expect(smokeBlock).toMatch(/DECLARE\s*\n\s*v_check\s+RECORD;/);
    expect(smokeBlock).toMatch(/FOR\s+v_check\s+IN\s*\n\s*SELECT \*\s*\n\s*FROM \(VALUES/);
    expect(smokeBlock).toMatch(/\) AS checks\(table_name, column_name\)\s*\n\s*LOOP/);
    expect(smokeBlockCodeOnly).not.toMatch(/check_col\(/);
  });

  it("3. the VALUES relation contains exactly the same 25 table/column identities as the original check_col(...) calls", () => {
    const pairs = extractValuesPairs();
    expect(pairs).toEqual(ORIGINAL_25_PAIRS);
  });

  it("4. every identity occurs exactly once in the smoke-test input", () => {
    const pairs = extractValuesPairs();
    const keys = pairs.map(([t, c]) => `${t}::${c}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(25);
  });

  it("5. every checked column is added by this migration's own ALTER TABLE ADD COLUMN statements before the smoke block", () => {
    const pairs = extractValuesPairs();
    for (const [table, column] of pairs) {
      const addColRe = new RegExp(
        `ALTER TABLE public\\.${table}[\\s\\S]{0,200}?ADD COLUMN(?: IF NOT EXISTS)?\\s+${column}\\b`,
      );
      const addIdx = preSmoke.search(addColRe);
      expect(addIdx, `${table}.${column} must be added by an ADD COLUMN statement before the smoke block`).toBeGreaterThan(-1);
      expect(addIdx).toBeLessThan(sectionIdx);
    }
  });

  it("6. a missing column produces an explicit RAISE EXCEPTION (not a silent pass)", () => {
    expect(smokeBlock).toMatch(/RAISE EXCEPTION\s*\n\s*'Phase 1B smoke check failed: missing public\.%\.%',/);
    expect(smokeBlock).toMatch(/USING ERRCODE = '42703';/);
  });

  it("7. does not rely on ASSERT anywhere in its executable code", () => {
    expect(smokeBlockCodeOnly).not.toMatch(/\bASSERT\b/);
  });

  it("8. no top-level BEGIN;, COMMIT;, or ROLLBACK; was introduced by this correction", () => {
    expect(raw).not.toMatch(/^\s*BEGIN;/m);
    expect(raw).not.toMatch(/^\s*COMMIT;/m);
    expect(raw).not.toMatch(/^\s*ROLLBACK;/m);
  });

  it("9. all production SQL before the smoke-test section is unchanged — only the smoke-test block differs (content-hash pin)", () => {
    expect(sha256(preSmoke)).toBe(
      "e08a4a97075033b2c050e9c3f46a0d0c21959d41d4d375bba4bff82525c87bd4",
    );
  });

  it("still reports success via RAISE NOTICE naming all 25 columns, and closes the same $smoke$ tag it opened", () => {
    expect(smokeBlock).toMatch(/RAISE NOTICE 'Phase 1-B smoke test: all 25 _member_id columns confirmed present\.';/);
    expect(smokeBlock.match(/\$smoke\$/g)?.length).toBe(2);
  });
});

describe("Repository-wide guard — no PL/pgSQL DO block may declare a nested PROCEDURE/FUNCTION in its DECLARE section (Oracle PL/SQL syntax, invalid in PostgreSQL)", () => {
  const allFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

  it("self-test: the normalizer preserves DECLARE/BEGIN/PROCEDURE structure while blanking comments, strings, and identifiers, at every dollar-quote nesting level", () => {
    const sample = `
      DO $outer$
      DECLARE
        v BOOLEAN;
        "weird ident" TEXT; -- a comment mentioning PROCEDURE should not count
        PROCEDURE nested(p TEXT) AS $inner$
        BEGIN
          SELECT 'a string with BEGIN and DECLARE inside' INTO v;
        END;
        $inner$
      BEGIN
        NULL;
      END;
      $outer$;
    `;
    const normalized = normalizeSqlKeepingStructure(sample);
    expect(normalized).toContain("DECLARE");
    expect(normalized).toContain("PROCEDURE");
    expect(normalized).not.toMatch(/weird ident/);
    expect(normalized).not.toMatch(/a string with BEGIN and DECLARE inside/);
    const bodies = findDoBlockBodies(normalized);
    expect(bodies).toHaveLength(1);
    expect(doBlockDeclaresNestedSubprogram(bodies[0])).toBe(true);
  });

  it("self-test: a comment merely mentioning PROCEDURE/FUNCTION near a DO block is not flagged", () => {
    const sample = `
      -- this PROCEDURE-like comment and this FUNCTION-like word must not trigger anything
      DO $$
      DECLARE
        v INTEGER;
      BEGIN
        v := 1;
      END;
      $$;
    `;
    const normalized = normalizeSqlKeepingStructure(sample);
    const bodies = findDoBlockBodies(normalized);
    expect(bodies).toHaveLength(1);
    expect(doBlockDeclaresNestedSubprogram(bodies[0])).toBe(false);
  });

  it.each(allFiles)("%s: no DO block declares a nested PROCEDURE/FUNCTION in its DECLARE section", (file) => {
    const raw = readMigration(file);
    const normalized = normalizeSqlKeepingStructure(raw);
    const bodies = findDoBlockBodies(normalized);
    for (const body of bodies) {
      expect(
        doBlockDeclaresNestedSubprogram(body),
        `${file} contains a DO block with an illegal nested PROCEDURE/FUNCTION declaration in its DECLARE section`,
      ).toBe(false);
    }
  });
});
