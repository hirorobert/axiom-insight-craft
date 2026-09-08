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
 * "generalized replay guard" describe block below scans every migration
 * file and enforces this for every (policy name, schema.relation)
 * identity in the repository.
 *
 * QUOTED/UNQUOTED CORRECTION: an earlier version of the generalized
 * scanner matched `CREATE POLICY "([^"]+)"` — it required the policy name
 * to be double-quoted. PostgreSQL policy names do not require quoting
 * (only identifiers with spaces, mixed case that must be preserved, or
 * reserved words do), so any migration writing `CREATE POLICY foo ON
 * bar` with no quotes at all was invisible to that scanner. This was not
 * theoretical: `20260711200000_safisha_core.sql` declares nine SAFISHA
 * policies entirely unquoted, duplicating an earlier migration
 * (20260711162832) with no guard — a real `supabase db push` against a
 * live database hit `policy "safisha_recon_select" on
 * "safisha_reconciliations" already exists` (SQLSTATE 42710) at exactly
 * this point. The scanner below is built on the same quote-aware token
 * stream as `normalizeSqlPreservingTokens`, recognizes quoted and
 * unquoted identifiers in either position (name or relation, schema or
 * table) with correct PostgreSQL folding semantics, and is exercised by
 * self-tests proving both forms.
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

type SqlTokenType = "word" | "punct" | "string" | "ident" | "dollar";

interface SqlToken {
  type: SqlTokenType;
  raw: string;
  /** Character offset of this token's first character in the source string passed to tokenizeSql. */
  start: number;
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
 * a comment, or a separate token. Every token records its own start
 * offset in the source, so callers can recover exact source spans (e.g.
 * "from this CREATE keyword to the matching top-level semicolon")
 * without re-scanning raw characters and risking a false match inside a
 * string or comment.
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
      tokens.push({ type: "string", raw: sql.slice(i, j), start: i });
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
      tokens.push({ type: "ident", raw: sql.slice(i, j), start: i });
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
        tokens.push({ type: "dollar", raw: sql.slice(i, j), start: i });
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
      tokens.push({ type: "word", raw: sql.slice(i, j), start: i });
      i = j;
      continue;
    }

    // Punctuation/operator: every other character is its own explicit
    // token. Multi-character operators (<=, ::, ||, etc.) simply become
    // adjacent single-character punctuation tokens, which re-serialize
    // byte-for-byte since no separator is ever inserted next to
    // punctuation (see normalizeSqlPreservingTokens below).
    tokens.push({ type: "punct", raw: ch, start: i });
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

/**
 * Resolves a single SQL identifier token to its PostgreSQL catalog name,
 * applying real folding semantics:
 *   - a double-quoted identifier keeps its exact contents (with `""`
 *     un-escaped to `"`), case included — quoted "Foo" and unquoted foo
 *     are genuinely different catalog names;
 *   - an unquoted identifier is case-folded to lowercase — unquoted Foo
 *     and unquoted foo, or unquoted foo and quoted "foo", name the same
 *     object.
 * Returns null for any token that isn't a valid identifier position.
 */
function resolveSqlIdentifier(token: SqlToken | undefined): { value: string; quoted: boolean } | null {
  if (!token) return null;
  if (token.type === "ident") {
    return { value: token.raw.slice(1, -1).replace(/""/g, '"'), quoted: true };
  }
  if (token.type === "word") {
    return { value: token.raw.toLowerCase(), quoted: false };
  }
  return null;
}

function isKeywordToken(token: SqlToken | undefined, keyword: string): boolean {
  return !!token && token.type === "word" && token.raw.toUpperCase() === keyword;
}

type PolicyStatementKind = "CREATE" | "DROP";

interface PolicyStatementOccurrence {
  kind: PolicyStatementKind;
  /** Normalized identity: quoted names keep exact case, unquoted names are lowercased. */
  name: string;
  nameQuoted: boolean;
  /** Normalized "schema.relation" — an unqualified relation is assigned schema "public". */
  relation: string;
  /** Character offset of the CREATE/DROP keyword in the source text passed to the scanner. */
  index: number;
}

/**
 * Structurally scans SQL text for `CREATE POLICY` and
 * `DROP POLICY IF EXISTS` statements, recognizing every PostgreSQL
 * identifier form for both the policy name and the relation — quoted,
 * unquoted, schema-qualified, unqualified, or any mix of those — with
 * correct PostgreSQL folding semantics (see `resolveSqlIdentifier`).
 *
 * Built directly on the `tokenizeSql` token stream rather than a regex:
 * a regex that requires literal `"..."` around the name (the defect this
 * scanner replaces) silently skips every unquoted `CREATE POLICY name ON
 * table` statement — exactly the form nine real SAFISHA policies in
 * 20260711200000_safisha_core.sql use. Operating on tokens instead means
 * comments, string literals, and dollar-quoted bodies can never produce
 * a false match (they were never tokenized as CREATE/POLICY/ON/IF/EXISTS
 * keywords or identifiers to begin with), and both quoting styles are
 * recognized identically because both resolve through the same
 * `resolveSqlIdentifier` step.
 */
function scanPolicyStatements(sql: string): PolicyStatementOccurrence[] {
  const tokens = tokenizeSql(sql);
  const results: PolicyStatementOccurrence[] = [];

  function readRelation(tokens: SqlToken[], firstIndex: number): { relation: string; nextIndex: number } | null {
    const rel1 = resolveSqlIdentifier(tokens[firstIndex]);
    if (!rel1) return null;
    if (tokens[firstIndex + 1]?.type === "punct" && tokens[firstIndex + 1].raw === ".") {
      const rel2 = resolveSqlIdentifier(tokens[firstIndex + 2]);
      if (rel2) {
        return { relation: `${rel1.value}.${rel2.value}`, nextIndex: firstIndex + 3 };
      }
    }
    return { relation: `public.${rel1.value}`, nextIndex: firstIndex + 1 };
  }

  for (let i = 0; i < tokens.length; i++) {
    if (isKeywordToken(tokens[i], "CREATE") && isKeywordToken(tokens[i + 1], "POLICY")) {
      const nameInfo = resolveSqlIdentifier(tokens[i + 2]);
      if (nameInfo && isKeywordToken(tokens[i + 3], "ON")) {
        const rel = readRelation(tokens, i + 4);
        if (rel) {
          results.push({
            kind: "CREATE",
            name: nameInfo.value,
            nameQuoted: nameInfo.quoted,
            relation: rel.relation,
            index: tokens[i].start,
          });
        }
      }
    }

    if (
      isKeywordToken(tokens[i], "DROP") &&
      isKeywordToken(tokens[i + 1], "POLICY") &&
      isKeywordToken(tokens[i + 2], "IF") &&
      isKeywordToken(tokens[i + 3], "EXISTS")
    ) {
      const nameInfo = resolveSqlIdentifier(tokens[i + 4]);
      if (nameInfo && isKeywordToken(tokens[i + 5], "ON")) {
        const rel = readRelation(tokens, i + 6);
        if (rel) {
          results.push({
            kind: "DROP",
            name: nameInfo.value,
            nameQuoted: nameInfo.quoted,
            relation: rel.relation,
            index: tokens[i].start,
          });
        }
      }
    }
  }

  return results;
}

/**
 * Extracts the full statement text starting at a known token's source
 * offset, ending at the matching top-level (paren-depth-0) semicolon.
 * Token-based rather than a raw-character scan: a raw scan for `;` at
 * depth 0 can be fooled by a semicolon sitting inside a string literal or
 * comment, which `tokenizeSql` has already excluded from being anything
 * but part of one string/comment token.
 */
function extractStatementAt(sql: string, index: number): string {
  const tokens = tokenizeSql(sql);
  const startTokenIndex = tokens.findIndex((t) => t.start === index);
  if (startTokenIndex === -1) throw new Error(`No token starts at offset ${index}`);
  let depth = 0;
  for (let i = startTokenIndex; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "punct" && t.raw === "(") depth++;
    else if (t.type === "punct" && t.raw === ")") depth--;
    else if (t.type === "punct" && t.raw === ";" && depth === 0) {
      return sql.slice(index, t.start + 1);
    }
  }
  const last = tokens[tokens.length - 1];
  return sql.slice(index, last ? last.start + last.raw.length : index);
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

  it("the replay migration's four final policy definitions encode the exact same rule (command, role, USING/WITH CHECK) as the creator's own definitions", () => {
    // Compared via normalizeSqlPreservingTokens rather than raw string
    // equality: these two source files are committed with different line
    // endings (20260624120000 is LF-only; 20260625043303 is CRLF
    // throughout) — a pre-existing disparity that a raw .toBe() only
    // happened to miss locally because core.autocrlf normalizes both to
    // CRLF on a Windows checkout. GitHub Actions' Ubuntu runner checks
    // blobs out as committed, with no such conversion, which is what
    // actually failed CI. The token-preserving normalizer already treats
    // any whitespace/line-ending gap as insignificant outside quoted
    // content, so it correctly reports these as the same rule — proven
    // identical below using the real committed byte content, not a
    // reformatted copy.
    for (const name of POLICY_NAMES) {
      const creatorBody = extractPolicyBody(creatorCode, name).trim();
      const replayBody = extractPolicyBody(replayCode, name).trim();
      expect(normalizeSqlPreservingTokens(replayBody)).toBe(normalizeSqlPreservingTokens(creatorBody));
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

describe("generalized replay guard — every migration file, keyed by exact normalized policy name + exact schema/relation (quoted and unquoted identifiers both recognized)", () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  const rawByFile = new Map<string, string>();
  const occurrencesByFile = new Map<string, PolicyStatementOccurrence[]>();
  for (const f of files) {
    const raw = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf-8");
    rawByFile.set(f, raw);
    occurrencesByFile.set(f, scanPolicyStatements(raw));
  }

  interface GlobalEvent {
    kind: PolicyStatementKind;
    file: string;
    fileOrder: number;
    index: number;
  }

  // identity key = exact normalized policy name + exact normalized
  // schema-qualified relation, NOT name alone — two different tables may
  // legitimately share a policy name, and that must never be treated as
  // a collision.
  const eventsByKey = new Map<string, GlobalEvent[]>();
  files.forEach((f, fileOrder) => {
    for (const occ of occurrencesByFile.get(f)!) {
      const key = `${occ.name}::${occ.relation}`;
      if (!eventsByKey.has(key)) eventsByKey.set(key, []);
      // Events for one file are already emitted in ascending token order
      // by scanPolicyStatements, and files themselves are iterated here
      // in filename/apply order, so each key's accumulated event list is
      // already in true global apply order — no separate sort needed.
      eventsByKey.get(key)!.push({ kind: occ.kind, file: f, fileOrder, index: occ.index });
    }
  });

  const createEventsByKey = new Map<string, GlobalEvent[]>();
  for (const [key, events] of eventsByKey) {
    createEventsByKey.set(
      key,
      events.filter((e) => e.kind === "CREATE"),
    );
  }
  const duplicateKeys = [...createEventsByKey.entries()].filter(([, creates]) => creates.length > 1);

  /** True if event `e` falls strictly after `after` and strictly before `before`, in true file-then-position apply order. */
  function isStrictlyBetween(e: GlobalEvent, after: GlobalEvent, before: GlobalEvent): boolean {
    const afterOk = e.fileOrder > after.fileOrder || (e.fileOrder === after.fileOrder && e.index > after.index);
    const beforeOk = e.fileOrder < before.fileOrder || (e.fileOrder === before.fileOrder && e.index < before.index);
    return afterOk && beforeOk;
  }

  it("finds exactly 91 duplicate policy-name/relation identities across the repository", () => {
    expect(duplicateKeys.length).toBe(91);
  });

  it("finds exactly 253 total CREATE POLICY occurrences among those 91 duplicate identities", () => {
    let total = 0;
    for (const [, creates] of duplicateKeys) total += creates.length;
    expect(total).toBe(253);
  });

  it("finds exactly 162 later-creator occurrences — every CREATE POLICY occurrence beyond each identity's first", () => {
    let total = 0;
    for (const [, creates] of duplicateKeys) total += creates.length - 1;
    expect(total).toBe(162);
  });

  it("every later CREATE POLICY occurrence has its own dedicated DROP POLICY IF EXISTS strictly between it and the immediately preceding CREATE for the same identity — validated occurrence by occurrence, so a single DROP can never incorrectly satisfy more than one later CREATE, even multiple occurrences inside one file", () => {
    const failures: string[] = [];
    let guardedCount = 0;
    for (const [key, creates] of duplicateKeys) {
      const drops = eventsByKey.get(key)!.filter((e) => e.kind === "DROP");
      for (let i = 1; i < creates.length; i++) {
        const prevCreate = creates[i - 1];
        const thisCreate = creates[i];
        const guard = drops.find((d) => isStrictlyBetween(d, prevCreate, thisCreate));
        if (guard) {
          guardedCount++;
        } else {
          failures.push(
            `${key}: CREATE POLICY occurrence #${i + 1} in ${thisCreate.file} has no dedicated DROP POLICY IF EXISTS strictly between it and the previous CREATE in ${prevCreate.file}`,
          );
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
    expect(guardedCount).toBe(162);
  });

  it("zero unguarded later-creator occurrences remain after this correction", () => {
    let unguarded = 0;
    for (const [key, creates] of duplicateKeys) {
      const drops = eventsByKey.get(key)!.filter((e) => e.kind === "DROP");
      for (let i = 1; i < creates.length; i++) {
        const guard = drops.find((d) => isStrictlyBetween(d, creates[i - 1], creates[i]));
        if (!guard) unguarded++;
      }
    }
    expect(unguarded).toBe(0);
  });

  // The migrations touched by the original replay-hardening correction
  // pass (Correction B). For each, every duplicated policy's CREATE body
  // must still encode the exact same authorization rule (role, command,
  // USING/WITH CHECK) as its original creator — proving the correction
  // inserted DROP statements only, and never touched the CREATE POLICY
  // bodies themselves.
  const CORRECTED_FILES: Record<string, string> = {
    "20260629042520_7c1fccd0-e91a-42cb-b09e-93fa907ae316.sql": "20260628100000_tax_engine_schema.sql",
    "20260707200000_iron_dome_nuclear_full.sql": "20260707183617_6cb7067f-cf11-49a5-bf6a-4948c6a2b08b.sql",
    "20260708100000_iron_dome_sprint2.sql": "20260708070202_196b8158-673e-4765-99ef-a1fd46b664ee.sql",
    "20260711300000_maono_phase_a.sql": "20260711163040_9ec82b5f-ee11-45e7-942a-65f09f24dddf.sql",
    "20260711300100_maono_phase_b.sql": "20260711163133_b0024d19-b5fa-4904-a8b7-6adce235fd64.sql",
    "20260711300200_maono_phase_c.sql": "20260711163223_9a12e0e2-cf5f-41dc-8fc5-17d8798a27b2.sql",
    "20260811054356_e4768bc4-04df-4222-b2e6-482e35dde61a.sql": "20260811000000_account_mapping_memory.sql",
  };

  it("all 7 Correction-B files' duplicated CREATE POLICY bodies still encode the exact same rule as their original creator (whitespace-insensitive) — the correction added only DROP statements", () => {
    let checkedCount = 0;
    for (const [laterFile, creatorFile] of Object.entries(CORRECTED_FILES)) {
      const laterRaw = rawByFile.get(laterFile)!;
      const creatorRaw = rawByFile.get(creatorFile)!;
      const laterOccurrences = occurrencesByFile.get(laterFile)!.filter((o) => o.kind === "CREATE");
      const creatorOccurrences = occurrencesByFile.get(creatorFile)!.filter((o) => o.kind === "CREATE");

      for (const laterOcc of laterOccurrences) {
        const creatorOcc = creatorOccurrences.find(
          (c) => c.name === laterOcc.name && c.relation === laterOcc.relation,
        );
        if (!creatorOcc) continue; // unique to the later file, not a duplicate — nothing to compare

        const laterBody = normalizeSqlPreservingTokens(extractStatementAt(laterRaw, laterOcc.index));
        const creatorBody = normalizeSqlPreservingTokens(extractStatementAt(creatorRaw, creatorOcc.index));
        expect(
          laterBody,
          `${laterFile}: CREATE POLICY ${laterOcc.name} ON ${laterOcc.relation} must encode the same rule as its creator (${creatorFile}), aside from whitespace`,
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

  it("the nine SAFISHA policy bodies in 20260711200000_safisha_core.sql remain token-identical to their original definitions in 20260711162832 — this correction added only DROP POLICY statements, all nine unquoted names included", () => {
    const SAFISHA_LATER = "20260711200000_safisha_core.sql";
    const SAFISHA_CREATOR = "20260711162832_180fac0d-7745-4e36-9902-e35e98cfac33.sql";
    const SAFISHA_NAMES = [
      "safisha_recon_select",
      "safisha_recon_insert",
      "safisha_recon_update",
      "safisha_txn_select",
      "safisha_txn_insert",
      "safisha_exc_select",
      "safisha_exc_insert",
      "safisha_audit_select",
      "safisha_mapping_all",
    ];

    const laterRaw = rawByFile.get(SAFISHA_LATER)!;
    const creatorRaw = rawByFile.get(SAFISHA_CREATOR)!;
    const laterOccs = occurrencesByFile.get(SAFISHA_LATER)!.filter((o) => o.kind === "CREATE");
    const creatorOccs = occurrencesByFile.get(SAFISHA_CREATOR)!.filter((o) => o.kind === "CREATE");

    let checked = 0;
    for (const name of SAFISHA_NAMES) {
      const laterOcc = laterOccs.find((o) => o.name === name);
      const creatorOcc = creatorOccs.find((o) => o.name === name);
      expect(laterOcc, `expected an unquoted CREATE POLICY ${name} in ${SAFISHA_LATER}`).toBeDefined();
      expect(creatorOcc, `expected an unquoted CREATE POLICY ${name} in ${SAFISHA_CREATOR}`).toBeDefined();

      const laterBody = normalizeSqlPreservingTokens(extractStatementAt(laterRaw, laterOcc!.index));
      const creatorBody = normalizeSqlPreservingTokens(extractStatementAt(creatorRaw, creatorOcc!.index));
      expect(laterBody, `${name}: must encode the same rule as its original creator`).toBe(creatorBody);
      checked++;
    }
    expect(checked).toBe(9);
  });

  it("each of the 10 blockers resolved by the original replay-hardening correction pass is covered", () => {
    // Correction B — 7 files, 44 total guarded policy re-declarations.
    const correctionBFiles = Object.keys(CORRECTED_FILES);
    for (const f of correctionBFiles) {
      expect(files).toContain(f);
      const drops = occurrencesByFile.get(f)!.filter((o) => o.kind === "DROP");
      expect(drops.length, `${f} must contain at least one DROP POLICY IF EXISTS guard`).toBeGreaterThan(0);
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

  it("a CRLF-terminated statement normalizes identically to the same statement with LF line endings — the exact class of difference that broke this file's original creator/replay comparison on a Linux checkout that does not convert line endings", () => {
    const lf = 'CREATE POLICY "x" ON t FOR SELECT\n  USING (\n    a = 1\n  );';
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(crlf).not.toBe(lf); // sanity: the two inputs really do differ
    expect(normalizeSqlPreservingTokens(crlf)).toBe(normalizeSqlPreservingTokens(lf));
  });
});

describe("scanPolicyStatements — quoted/unquoted identifier recognition self-tests", () => {
  it("recognizes an entirely unquoted CREATE POLICY statement — the exact form the previous quote-mandatory regex silently missed for all nine SAFISHA policies", () => {
    const sql = "CREATE POLICY safisha_recon_select ON safisha_reconciliations FOR SELECT USING (client_id = auth.uid());";
    const occs = scanPolicyStatements(sql);
    expect(occs).toHaveLength(1);
    expect(occs[0].kind).toBe("CREATE");
    expect(occs[0].name).toBe("safisha_recon_select");
    expect(occs[0].nameQuoted).toBe(false);
    expect(occs[0].relation).toBe("public.safisha_reconciliations");
  });

  it("quoted \"foo\" and unquoted foo are the SAME identity (PostgreSQL folds an unquoted name to lowercase, matching an all-lowercase quoted name)", () => {
    const quoted = scanPolicyStatements('CREATE POLICY "foo" ON t FOR SELECT USING (true);')[0];
    const unquoted = scanPolicyStatements("CREATE POLICY foo ON t FOR SELECT USING (true);")[0];
    expect(quoted.name).toBe(unquoted.name);
    expect(quoted.relation).toBe(unquoted.relation);
  });

  it('quoted "Foo" remains DISTINCT from unquoted foo (quoting preserves case; folding only applies to the unquoted form)', () => {
    const quotedMixedCase = scanPolicyStatements('CREATE POLICY "Foo" ON t FOR SELECT USING (true);')[0];
    const unquoted = scanPolicyStatements("CREATE POLICY foo ON t FOR SELECT USING (true);")[0];
    expect(quotedMixedCase.name).toBe("Foo");
    expect(unquoted.name).toBe("foo");
    expect(quotedMixedCase.name).not.toBe(unquoted.name);
  });

  it("handles a quoted schema-qualified relation, an unquoted schema-qualified relation, and a mix of the two", () => {
    const bothQuoted = scanPolicyStatements('CREATE POLICY p ON "public"."t" FOR SELECT USING (true);')[0];
    const bothUnquoted = scanPolicyStatements("CREATE POLICY p ON public.t FOR SELECT USING (true);")[0];
    const mixed = scanPolicyStatements('CREATE POLICY p ON public."t" FOR SELECT USING (true);')[0];
    expect(bothQuoted.relation).toBe("public.t");
    expect(bothUnquoted.relation).toBe("public.t");
    expect(mixed.relation).toBe("public.t");
  });

  it("normalizes an unqualified relation to public.<relation>", () => {
    const occ = scanPolicyStatements("CREATE POLICY p ON bare_table FOR SELECT USING (true);")[0];
    expect(occ.relation).toBe("public.bare_table");
  });

  it("recognizes DROP POLICY IF EXISTS in both quoted and unquoted form", () => {
    const quotedDrop = scanPolicyStatements('DROP POLICY IF EXISTS "foo" ON public.t;')[0];
    const unquotedDrop = scanPolicyStatements("DROP POLICY IF EXISTS foo ON public.t;")[0];
    expect(quotedDrop.kind).toBe("DROP");
    expect(unquotedDrop.kind).toBe("DROP");
    expect(quotedDrop.name).toBe(unquotedDrop.name);
    expect(quotedDrop.relation).toBe(unquotedDrop.relation);
  });

  it("never matches CREATE POLICY text sitting inside a line comment, a block comment, or a string literal", () => {
    const sql = [
      "-- CREATE POLICY fake_from_comment ON faketable FOR SELECT USING (true);",
      "/* CREATE POLICY fake_from_block ON faketable FOR SELECT USING (true); */",
      "SELECT 'CREATE POLICY fake_from_string ON faketable FOR SELECT USING (true);';",
      "CREATE POLICY real_one ON realtable FOR SELECT USING (true);",
    ].join("\n");
    const occs = scanPolicyStatements(sql);
    expect(occs).toHaveLength(1);
    expect(occs[0].name).toBe("real_one");
    expect(occs[0].relation).toBe("public.realtable");
  });

  it("never matches CREATE POLICY text sitting inside a dollar-quoted body", () => {
    const sql = [
      "CREATE FUNCTION f() RETURNS void AS $$",
      "BEGIN",
      "  -- not a real statement: CREATE POLICY fake_from_dollar ON faketable FOR SELECT USING (true);",
      "  RAISE NOTICE 'noop';",
      "END;",
      "$$ LANGUAGE plpgsql;",
      "CREATE POLICY real_one ON realtable FOR SELECT USING (true);",
    ].join("\n");
    const occs = scanPolicyStatements(sql);
    expect(occs).toHaveLength(1);
    expect(occs[0].name).toBe("real_one");
  });

  it("handles a multiline CREATE POLICY statement identically to the same statement written on one line", () => {
    const oneLine = "CREATE POLICY p ON t FOR SELECT USING (a = 1);";
    const multiline = "CREATE POLICY p\n  ON t\n  FOR SELECT\n  USING (\n    a = 1\n  );";
    const occOne = scanPolicyStatements(oneLine)[0];
    const occMulti = scanPolicyStatements(multiline)[0];
    expect(occOne.name).toBe(occMulti.name);
    expect(occOne.relation).toBe(occMulti.relation);
  });
});
