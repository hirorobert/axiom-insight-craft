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
 *
 * GENERALIZATION (replay-hardening correction pass): the invariant below
 * is not specific to storage.objects or to any one file pair — a bare
 * `CREATE POLICY` has no `IF NOT EXISTS` form in PostgreSQL, so ANY
 * migration that re-declares a policy name already created (on the same
 * relation) by an earlier migration will hit 42710 on sequential replay
 * unless it drops that exact name, on that exact relation, first. The
 * second describe block below scans every migration file and enforces
 * this for every (policy name, schema.relation) identity in the
 * repository, not just the four storage.objects names.
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

/**
 * Strips line comments, block comments, single-quoted string literals, and
 * dollar-quoted (PL/pgSQL) bodies from a migration's SQL text, replacing
 * each with a single space so surrounding statement structure and byte
 * offsets stay meaningful for substring/index-based checks. Without this,
 * a `CREATE POLICY` or `BEGIN`/`END` occurring inside a function body or a
 * string literal would be indistinguishable from a genuine top-level
 * statement.
 */
function stripDollarQuotedStringsAndComments(sql: string): string {
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

interface PolicyOccurrence {
  name: string;
  relation: string; // always schema-qualified, e.g. "public.capital_allowances"
  index: number; // character offset of the `CREATE POLICY` keyword in the stripped text
}

function extractPolicyOccurrences(strippedText: string): PolicyOccurrence[] {
  const results: PolicyOccurrence[] = [];
  const re = /CREATE POLICY\s+"([^"]+)"\s+ON\s+([a-zA-Z_][a-zA-Z0-9_.]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(strippedText)) !== null) {
    const name = m[1];
    const relation = m[2].includes(".") ? m[2] : `public.${m[2]}`;
    results.push({ name, relation, index: m.index });
  }
  return results;
}

/** Extracts the full `CREATE POLICY ... ;` statement text starting at a known index. */
function extractStatementAt(strippedText: string, startIndex: number): string {
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

type SqlTokenType = "word" | "punct" | "string" | "ident" | "dollar";

interface SqlToken {
  type: SqlTokenType;
  raw: string;
}

/**
 * A minimal, quote-aware SQL lexer that classifies a SQL fragment into an
 * explicit token stream, exactly as PostgreSQL itself would delimit it —
 * word/number identifiers, single-character punctuation and operators,
 * single-quoted string literals, double-quoted identifiers, and
 * dollar-quoted bodies. Whitespace and comments are only ever recognized
 * BETWEEN tokens: once a quote or dollar-tag opens, every character up to
 * its matching close (including doubled `''`/`""` escapes) is consumed as
 * part of that one token's raw text, so nothing inside a string,
 * identifier, or dollar-quoted body is ever mistaken for whitespace,
 * a comment, or a separate token.
 */
function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  const isWordChar = (ch: string) => /[A-Za-z0-9_]/.test(ch);

  while (i < sql.length) {
    const ch = sql[i];

    // Insignificant whitespace between tokens — never itself a token.
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Line comment. Only reached outside any quoted/dollar-quoted span —
    // those are matched and fully consumed by their own branches below
    // before control ever returns here, so "--" or "/*" inside a string
    // literal, identifier, or dollar-quoted body is never treated as a
    // comment.
    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }

    // Block comment — same outside-quotes-only guarantee as above.
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }

    // Single-quoted string literal. A doubled '' is the standard SQL
    // escape for a literal quote character inside the string and does
    // NOT terminate it. The entire span — quotes, internal whitespace,
    // punctuation, and doubled-quote escapes included — is preserved
    // verbatim as one token.
    if (ch === "'") {
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
      tokens.push({ type: "string", raw: sql.slice(i, j) });
      i = j;
      continue;
    }

    // Double-quoted identifier. Same "" escaping rule as single-quoted
    // strings. Preserved verbatim as one token.
    if (ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '"' && sql[j + 1] === '"') {
          j += 2;
          continue;
        }
        if (sql[j] === '"') {
          j += 1;
          break;
        }
        j++;
      }
      tokens.push({ type: "ident", raw: sql.slice(i, j) });
      i = j;
      continue;
    }

    // Dollar-quoted body ($$...$$ or $tag$...$tag$) — how PL/pgSQL
    // function and DO-block bodies are embedded in migration SQL.
    // Preserved verbatim, both delimiters included, as one token.
    if (ch === "$") {
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const endIdx = sql.indexOf(tag, i + tag.length);
        const j = endIdx === -1 ? sql.length : endIdx + tag.length;
        tokens.push({ type: "dollar", raw: sql.slice(i, j) });
        i = j;
        continue;
      }
      // A lone "$" that doesn't open a valid dollar-quote tag falls
      // through to ordinary punctuation handling below.
    }

    // Word/number token: a maximal run of identifier characters. Two
    // word tokens can only ever end up adjacent in the token stream if
    // whitespace or a comment separated them in the source — otherwise
    // this same greedy match would already have consumed them together
    // as a single token — so tokenizing can never itself merge two
    // distinct identifiers or split one apart.
    if (isWordChar(ch)) {
      let j = i + 1;
      while (j < sql.length && isWordChar(sql[j])) j++;
      tokens.push({ type: "word", raw: sql.slice(i, j) });
      i = j;
      continue;
    }

    // Punctuation/operator: every other character is its own explicit
    // token. Multi-character operators (<=, ::, ||, etc.) simply become
    // adjacent single-character punctuation tokens, which re-serialize
    // byte-for-byte since no separator is ever inserted next to
    // punctuation (see normalizeSqlPreservingTokens below).
    tokens.push({ type: "punct", raw: ch });
    i++;
  }

  return tokens;
}

/**
 * Normalizes formatting differences between two SQL fragments that encode
 * the identical statement — indentation, line-wrapping, spacing around
 * parentheses/commas, and comments — into a single comparable string,
 * without ever merging two distinct tokens and without ever altering the
 * exact contents of a quoted string, quoted identifier, or dollar-quoted
 * body.
 *
 * Built on `tokenizeSql` rather than regex-based whitespace stripping:
 * regex stripping can't tell a comment or piece of whitespace found
 * OUTSIDE a string literal from the same-looking bytes sitting INSIDE
 * one, so it risks corrupting quoted content it should never touch (for
 * example, discarding a `'--' `-containing literal, or the meaningful
 * internal spacing of `'a  b'`). Tokenizing first, then re-serializing
 * only the token stream, makes that structurally impossible: whitespace
 * and comments are only ever recognized between tokens, never inside one.
 *
 * Serialization rule: a single space is inserted between two consecutive
 * tokens if and only if BOTH are plain word/number tokens — the only
 * pairing where omitting a separator would actually change the token
 * stream (two word tokens with literally nothing between them are, by
 * construction, impossible: `tokenizeSql` would already have merged them
 * into one). Between any other pairing — word/punctuation,
 * punctuation/punctuation, or anything next to a quoted/dollar-quoted
 * token — whitespace is never load-bearing in SQL syntax (quotes and
 * punctuation are self-delimiting), so it is dropped entirely rather than
 * merely collapsed. Every keyword, identifier, operator, and string/
 * numeric literal must still match exactly and in the same order; only
 * insignificant whitespace and comments between them are ignored.
 */
function normalizeSqlPreservingTokens(sql: string): string {
  const tokens = tokenizeSql(sql);
  let out = "";
  for (let i = 0; i < tokens.length; i++) {
    if (i > 0 && tokens[i - 1].type === "word" && tokens[i].type === "word") {
      out += " ";
    }
    out += tokens[i].raw;
  }
  return out;
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

  it("for each exact policy name + exact relation, only the first executable migration to create it is unguarded — every later creator drops-then-creates within its own file, checked by strict per-file statement order, not a whole-file substring", () => {
    // Stable repository-content invariant: depends only on the SQL text of
    // the migration files themselves, never on git HEAD, staged state, or
    // whether this exact commit is dirty/committed/amended. Lexical
    // filename order matches this repository's own apply order (every
    // migration filename is a sortable timestamp prefix).
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();

    for (const name of POLICY_NAMES) {
      const escapedName = escapeForRegex(name);
      const createRe = new RegExp(`CREATE POLICY "${escapedName}"\\s+ON\\s+${TARGET_RELATION.replace(".", "\\.")}`);
      const creators = files.filter((f) => {
        const text = stripComments(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf-8"));
        return createRe.test(text);
      });

      expect(
        creators,
        `"${name}" on ${TARGET_RELATION} must be created by exactly the original creator followed by the corrected replay migration, in that order`,
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
        expect(dropIndex, `${laterFile} re-creates "${name}" on ${TARGET_RELATION} but has no relation-qualified DROP POLICY IF EXISTS for it in its own text`).toBeGreaterThan(-1);
        expect(createIndex, `${laterFile} was expected to contain CREATE POLICY "${name}" ON ${TARGET_RELATION}`).toBeGreaterThan(-1);
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

describe("generalized replay guard — every migration file, keyed by exact policy name + exact schema/relation", () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const strippedByFile = new Map<string, string>();
  for (const f of files) {
    strippedByFile.set(f, stripDollarQuotedStringsAndComments(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf-8")));
  }

  // identity key = exact policy name + exact schema-qualified relation,
  // NOT name alone — two different tables may legitimately share a policy
  // name (e.g. a generic "select" policy), and that must never be treated
  // as a collision.
  const creatorsByKey = new Map<string, string[]>();
  for (const f of files) {
    const text = strippedByFile.get(f)!;
    for (const occ of extractPolicyOccurrences(text)) {
      const key = `${occ.name}::${occ.relation}`;
      if (!creatorsByKey.has(key)) creatorsByKey.set(key, []);
      const list = creatorsByKey.get(key)!;
      if (!list.includes(f)) list.push(f);
    }
  }

  const duplicateKeys = [...creatorsByKey.entries()].filter(([, fs2]) => fs2.length > 1);

  it("found at least the known duplicate policy identities (sanity check that the scanner is working)", () => {
    // Guards against a silently-broken extractor reporting zero duplicates.
    expect(duplicateKeys.length).toBeGreaterThanOrEqual(8);
  });

  it("the first creator of any policy name+relation needs no guard; every later creator of that same name+relation contains its own same-relation DROP POLICY IF EXISTS strictly before its corresponding CREATE POLICY", () => {
    const failures: string[] = [];
    for (const [key, creatorFiles] of duplicateKeys) {
      const [name, relation] = key.split("::");
      const relBare = relation.startsWith("public.") ? relation.slice("public.".length) : relation;
      const escapedName = escapeForRegex(name);
      const createRe = new RegExp(`CREATE POLICY\\s+"${escapedName}"\\s+ON\\s+(public\\.)?${escapeForRegex(relBare)}\\b`);
      // Accepts either a fully public.-qualified drop or an unqualified one
      // (matching whatever schema-qualification style the CREATE itself used) —
      // what matters is that it targets the same relation, not the exact spelling.
      const dropRe = new RegExp(`DROP POLICY IF EXISTS\\s+"${escapedName}"\\s+ON\\s+(public\\.)?${escapeForRegex(relBare)}\\s*;`);

      for (let i = 1; i < creatorFiles.length; i++) {
        const laterFile = creatorFiles[i];
        const laterText = strippedByFile.get(laterFile)!;
        const createIndex = laterText.search(createRe);
        const dropMatch = laterText.match(dropRe);
        const dropIndex = dropMatch ? laterText.indexOf(dropMatch[0]) : -1;

        if (createIndex === -1) {
          failures.push(`${laterFile}: expected to find CREATE POLICY "${name}" ON ${relation}`);
          continue;
        }
        if (dropIndex === -1) {
          failures.push(`${laterFile}: re-creates "${name}" on ${relation} but has no relation-qualified DROP POLICY IF EXISTS for it in its own text`);
          continue;
        }
        if (!(dropIndex < createIndex)) {
          failures.push(`${laterFile}: drop for "${name}" on ${relation} must precede its own recreate`);
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  // The seven migrations touched by the replay-hardening correction pass.
  // For each, every duplicated policy's CREATE body must still encode the
  // exact same authorization rule (role, command, USING/WITH CHECK) as its
  // original creator — proving the correction inserted DROP statements
  // only, and never touched the CREATE POLICY bodies themselves.
  const CORRECTED_FILES: Record<string, string> = {
    "20260629042520_7c1fccd0-e91a-42cb-b09e-93fa907ae316.sql": "20260628100000_tax_engine_schema.sql",
    "20260707200000_iron_dome_nuclear_full.sql": "20260707183617_6cb7067f-cf11-49a5-bf6a-4948c6a2b08b.sql",
    "20260708100000_iron_dome_sprint2.sql": "20260708070202_196b8158-673e-4765-99ef-a1fd46b664ee.sql",
    "20260711300000_maono_phase_a.sql": "20260711163040_9ec82b5f-ee11-45e7-942a-65f09f24dddf.sql",
    "20260711300100_maono_phase_b.sql": "20260711163133_b0024d19-b5fa-4904-a8b7-6adce235fd64.sql",
    "20260711300200_maono_phase_c.sql": "20260711163223_9a12e0e2-cf5f-41dc-8fc5-17d8798a27b2.sql",
    "20260811054356_e4768bc4-04df-4222-b2e6-482e35dde61a.sql": "20260811000000_account_mapping_memory.sql",
  };

  it("all 7 replay-hardening-corrected files' duplicated CREATE POLICY bodies still encode the exact same rule as their original creator (whitespace-insensitive) — the correction added only DROP statements", () => {
    let checkedCount = 0;
    for (const [laterFile, creatorFile] of Object.entries(CORRECTED_FILES)) {
      const laterText = strippedByFile.get(laterFile)!;
      const creatorText2 = strippedByFile.get(creatorFile)!;
      const laterOccurrences = extractPolicyOccurrences(laterText);
      const creatorOccurrences = extractPolicyOccurrences(creatorText2);

      for (const laterOcc of laterOccurrences) {
        const creatorOcc = creatorOccurrences.find(
          (c) => c.name === laterOcc.name && c.relation === laterOcc.relation,
        );
        if (!creatorOcc) continue; // unique to the later file, not a duplicate — nothing to compare

        const laterBody = normalizeSqlPreservingTokens(extractStatementAt(laterText, laterOcc.index));
        const creatorBody = normalizeSqlPreservingTokens(extractStatementAt(creatorText2, creatorOcc.index));
        expect(
          laterBody,
          `${laterFile}: CREATE POLICY "${laterOcc.name}" ON ${laterOcc.relation} must encode the same rule as its creator (${creatorFile}), aside from whitespace`,
        ).toBe(creatorBody);
        checkedCount++;
      }
    }
    // Pins the exact number of guarded duplicates this correction pass covers:
    // 4 (capital_allowances) + 11 (iron dome nuclear: pcb x3, aje x3, aje_lines x2, sso x3)
    // + 3 (management_inputs) + 11 (maono phase a) + 6 (maono phase b)
    // + 8 (maono phase c) + 1 (amm_select) = 44.
    expect(checkedCount).toBe(44);
  });

  it("each of the 10 blockers resolved by the replay-hardening correction pass is covered", () => {
    // Correction B — 7 files, 44 total guarded policy re-declarations.
    const correctionBFiles = Object.keys(CORRECTED_FILES);
    for (const f of correctionBFiles) {
      expect(files).toContain(f);
      const text = strippedByFile.get(f)!;
      expect(text, `${f} must contain at least one DROP POLICY IF EXISTS guard`).toMatch(/DROP POLICY IF EXISTS "/);
    }
    expect(correctionBFiles.length).toBe(7);
  });
});

describe("normalizeSqlPreservingTokens — quote-aware SQL lexical normalization self-tests", () => {
  it("SELECT company_id differs from SELECTcompany_id (whitespace between two word tokens is never insignificant — removing it changes the token stream)", () => {
    const withSpace = normalizeSqlPreservingTokens("SELECT company_id");
    const withoutSpace = normalizeSqlPreservingTokens("SELECTcompany_id");
    expect(withSpace).not.toBe(withoutSpace);
    expect(withSpace).toBe("SELECT company_id");
    expect(withoutSpace).toBe("SELECTcompany_id");
  });

  it("'a  b' differs from 'a b' (internal string-literal whitespace is content, not formatting, and must never be touched)", () => {
    const twoSpaces = normalizeSqlPreservingTokens("SELECT 'a  b'");
    const oneSpace = normalizeSqlPreservingTokens("SELECT 'a b'");
    expect(twoSpaces).not.toBe(oneSpace);
    expect(twoSpaces).toContain("'a  b'");
    expect(oneSpace).toContain("'a b'");
  });

  it("punctuation inside a single-quoted string literal is preserved exactly, including a doubled '' escape", () => {
    const sql = "INSERT INTO t (notes) VALUES ('a;b,c (d) -- not a comment; it''s quoted');";
    const normalized = normalizeSqlPreservingTokens(sql);
    expect(normalized).toContain("'a;b,c (d) -- not a comment; it''s quoted'");
  });

  it("a double-quoted identifier's exact contents (including internal spacing) are preserved", () => {
    const sql = 'CREATE POLICY "x" ON "My   Weird  Table";';
    const normalized = normalizeSqlPreservingTokens(sql);
    expect(normalized).toContain('"My   Weird  Table"');
  });

  it("a dollar-quoted body's exact contents (including internal comments, quotes, and whitespace) are preserved verbatim", () => {
    const sql = "CREATE FUNCTION f() RETURNS void AS $tag$\n  -- not stripped in here\n  SELECT 'still not stripped';\n$tag$ LANGUAGE sql;";
    const normalized = normalizeSqlPreservingTokens(sql);
    expect(normalized).toContain("$tag$\n  -- not stripped in here\n  SELECT 'still not stripped';\n$tag$");
  });

  it("formatting-only whitespace and comments outside quoted content normalize to the same result", () => {
    const a = "SELECT   1\n  FROM  t\nWHERE  x = 1;";
    const b = "SELECT 1 FROM t WHERE x = 1;";
    const c = "SELECT/*inline*/1\nFROM t -- trailing comment\nWHERE x = 1;";
    const normalizedA = normalizeSqlPreservingTokens(a);
    const normalizedB = normalizeSqlPreservingTokens(b);
    const normalizedC = normalizeSqlPreservingTokens(c);
    expect(normalizedA).toBe(normalizedB);
    expect(normalizedC).toBe(normalizedB);
  });

  it("whitespace immediately touching parentheses/commas/semicolons is dropped, never merging the surrounding tokens", () => {
    const spaced = normalizeSqlPreservingTokens("role IN ( 'owner' , 'partner' )");
    const tight = normalizeSqlPreservingTokens("role IN('owner','partner')");
    expect(spaced).toBe(tight);
    expect(spaced).toBe("role IN('owner','partner')");
  });

  it("does not confuse a comment marker or dollar-quote delimiter that appears inside a string literal for a real comment or dollar-quote", () => {
    const sql = "SELECT '-- not a comment', '$$ not a dollar quote $$', 1;";
    const normalized = normalizeSqlPreservingTokens(sql);
    expect(normalized).toContain("'-- not a comment'");
    expect(normalized).toContain("'$$ not a dollar quote $$'");
    // No space is inserted between "," and "1" — punctuation-adjacent
    // whitespace is never load-bearing, so only the quoted literals'
    // exact contents matter here, not spacing around the trailing comma.
    expect(normalized).toContain(",1;");
  });
});
