/**
 * Storage-policy sequential-replay guard.
 *
 * Migration 20260624120000 creates four named RLS policies on
 * storage.objects. Migration 20260625043303 re-declares the same four
 * policy names with byte-identical definitions, without first dropping
 * them — a clean sequential replay from an empty database (as opposed to
 * Lovable's own applied-migration-identity tracking, which never re-runs
 * an already-recorded migration) hits `policy "..." already exists`
 * (SQLSTATE 42710) on the first of the four CREATE POLICY statements in
 * the later file. This test proves the later migration now drops each of
 * the four exact names, from the exact relation, before recreating it —
 * and that nothing broader than that was introduced as the fix.
 *
 * This test reads the real migration files directly from
 * supabase/migrations/ — no copied fixture.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.join(__dirname, "../../../");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase/migrations");

function escapeForRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const CREATOR_MIGRATION = "20260624120000_c4e7f821-3b9d-4a15-8e62-d09f37a5bc18.sql";
const REPLAY_MIGRATION = "20260625043303_3878e8ce-9e30-426d-b2d5-9f6bf2d0b530.sql";

const POLICY_NAMES = [
  "Users can upload their own trial balance files",
  "Users can read their own trial balance files",
  "Users can update their own trial balance files",
  "Users can delete their own trial balance files",
] as const;

const TARGET_RELATION = "storage.objects";

function stripComments(sql: string): string {
  return sql.replace(/--.*$/gm, "");
}

function extractPolicyBody(sql: string, name: string): string {
  const re = new RegExp(
    `CREATE POLICY "${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}"[\\s\\S]*?\\);`,
  );
  const match = sql.match(re);
  if (!match) throw new Error(`Policy body for "${name}" not found`);
  return match[0];
}

const creatorText = fs.readFileSync(path.join(MIGRATIONS_DIR, CREATOR_MIGRATION), "utf-8");
const replayText = fs.readFileSync(path.join(MIGRATIONS_DIR, REPLAY_MIGRATION), "utf-8");
const creatorCode = stripComments(creatorText);
const replayCode = stripComments(replayText);

describe("storage-policy replay guard — migration 20260624120000 (creator)", () => {
  it("creates exactly the four named policies on storage.objects, no more, no fewer", () => {
    for (const name of POLICY_NAMES) {
      const matches = creatorCode.match(new RegExp(`CREATE POLICY "${name}"`, "g")) ?? [];
      expect(matches.length, `expected exactly 1 CREATE POLICY "${name}" in the creator migration`).toBe(1);
    }
    const allCreates = creatorCode.match(/CREATE POLICY "[^"]+"/g) ?? [];
    expect(allCreates.length).toBe(4);
  });

  it("every one of the four policies targets storage.objects", () => {
    for (const name of POLICY_NAMES) {
      const body = extractPolicyBody(creatorCode, name);
      expect(body).toMatch(new RegExp(`ON\\s+${TARGET_RELATION.replace(".", "\\.")}`));
    }
  });
});

describe("storage-policy replay guard — migration 20260625043303 (corrected replay)", () => {
  it("drops each of the four exact policy names from the exact relation before recreating it", () => {
    for (const name of POLICY_NAMES) {
      const dropIndex = replayCode.indexOf(`DROP POLICY IF EXISTS "${name}" ON ${TARGET_RELATION}`);
      const createIndex = replayCode.indexOf(`CREATE POLICY "${name}"`);
      expect(dropIndex, `expected a relation-qualified DROP POLICY IF EXISTS for "${name}" ON ${TARGET_RELATION}`).toBeGreaterThan(-1);
      expect(createIndex, `expected a CREATE POLICY for "${name}"`).toBeGreaterThan(-1);
      expect(dropIndex, `the drop for "${name}" must precede its own recreate`).toBeLessThan(createIndex);
    }
  });

  it("all four new drops appear before ALL FOUR replacement creates (not just their own paired create)", () => {
    const lastDropIndex = Math.max(
      ...POLICY_NAMES.map((name) => replayCode.indexOf(`DROP POLICY IF EXISTS "${name}" ON ${TARGET_RELATION}`)),
    );
    const firstCreateIndex = Math.min(...POLICY_NAMES.map((name) => replayCode.indexOf(`CREATE POLICY "${name}"`)));
    expect(lastDropIndex).toBeLessThan(firstCreateIndex);
  });

  it("for each exact policy name, only the first executable migration to create it is unguarded — every later creator drops-then-creates within its own file, checked by strict per-file statement order, not a whole-file substring", () => {
    // Stable repository-content invariant: depends only on the SQL text of
    // the migration files themselves, never on git HEAD, staged state, or
    // whether this exact commit is dirty/committed/amended. Lexical
    // filename order matches this repository's own apply order (every
    // migration filename is a sortable timestamp prefix).
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

    for (const name of POLICY_NAMES) {
      const escapedName = escapeForRegex(name);
      const createRe = new RegExp(`CREATE POLICY "${escapedName}"`);
      const creators = files.filter((f) => {
        const text = stripComments(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf-8"));
        return createRe.test(text);
      });

      expect(
        creators,
        `"${name}" must be created by exactly the original creator followed by the corrected replay migration, in that order`,
      ).toEqual([CREATOR_MIGRATION, REPLAY_MIGRATION]);

      // The first creator (migration 10) is the legitimate original
      // creation — it needs no preceding drop of its own.
      // Every creator strictly after the first must contain, within its
      // OWN file's text, a relation-qualified DROP POLICY IF EXISTS for
      // this exact name at a index strictly BEFORE its own CREATE POLICY
      // statement for this exact name. This is a per-file, index-based
      // comparison — a drop appearing in a different file, or after the
      // create in the same file, does not satisfy it.
      for (let i = 1; i < creators.length; i++) {
        const laterFile = creators[i];
        const laterText = stripComments(fs.readFileSync(path.join(MIGRATIONS_DIR, laterFile), "utf-8"));
        const dropIndex = laterText.indexOf(`DROP POLICY IF EXISTS "${name}" ON ${TARGET_RELATION}`);
        const createIndex = laterText.search(createRe);
        expect(dropIndex, `${laterFile} re-creates "${name}" but has no relation-qualified DROP POLICY IF EXISTS for it in its own text`).toBeGreaterThan(-1);
        expect(createIndex, `${laterFile} was expected to contain CREATE POLICY "${name}"`).toBeGreaterThan(-1);
        expect(dropIndex, `${laterFile}'s drop for "${name}" must precede its own recreate — a drop appearing anywhere else in the file, or after the create, does not count`).toBeLessThan(createIndex);
      }
    }
  });

  it("the replay migration's four final policy definitions are byte-identical (command, role, USING/WITH CHECK) to the creator's own definitions", () => {
    for (const name of POLICY_NAMES) {
      const creatorBody = extractPolicyBody(creatorCode, name).trim();
      const replayBody = extractPolicyBody(replayCode, name).trim();
      expect(replayBody).toBe(creatorBody);
    }
  });

  it("no broad DROP POLICY, dynamic SQL, exception handling, or transaction control was introduced", () => {
    expect(replayCode).not.toMatch(/DROP POLICY IF EXISTS ALL/i);
    expect(replayCode).not.toMatch(/EXECUTE\s+(format|'|")/i);
    expect(replayCode).not.toMatch(/DO\s+\$\$/i);
    expect(replayCode).not.toMatch(/EXCEPTION/i);
    expect(replayCode).not.toMatch(/\bBEGIN\b/);
    expect(replayCode).not.toMatch(/\bCOMMIT\b/);
    expect(replayCode).not.toMatch(/\bROLLBACK\b/);
    // Exactly 6 DROP POLICY statements total: the 2 pre-existing legacy
    // drops plus the 4 new ones — never more, never a wildcard form.
    const dropCount = (replayCode.match(/DROP POLICY IF EXISTS "/g) ?? []).length;
    expect(dropCount).toBe(6);
  });

  it("the two pre-existing legacy DROP POLICY statements are untouched", () => {
    expect(replayCode).toMatch(/DROP POLICY IF EXISTS "Allow public upload to trial-balance-files" ON storage\.objects;/);
    expect(replayCode).toMatch(/DROP POLICY IF EXISTS "Allow public read from trial-balance-files"\s+ON storage\.objects;/);
  });
});
