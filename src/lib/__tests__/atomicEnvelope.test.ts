/**
 * The atomic migration envelope parser fails closed on a PostgreSQL-aware lexer (security correction M-1): a migration
 * that claims the envelope is accepted only as exactly one valid envelope whose every executable statement — and every
 * PL/pgSQL body inside it, recursively — is visible to the static guards, with no dynamic SQL anywhere.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AtomicEnvelopeError, isAtomicEnvelope, lexSql, parseAtomicEnvelope, unwrapAtomicEnvelope } from "../../../scripts/ci/atomicEnvelope.mjs";
import { checkMigrationAuthority } from "../../../scripts/ci/assertMigrationAuthority.mjs";

const ROOT = path.join(__dirname, "../../..");
const MIGRATIONS = path.join(ROOT, "supabase/migrations");

let n = 0;
const seg = (sql: string, tag = `aa${String.fromCharCode(97 + (n++ % 26))}`) => `  EXECUTE $mx${tag}$\n${sql}\n$mx${tag}$;`;
const envelope = (...segments: string[]) => `DO $cfoclose_x$\nBEGIN\n${segments.join("\n\n")}\nEND\n$cfoclose_x$;\n`;
const inDo = (plpgsql: string) => envelope(seg(`DO $d$\nBEGIN\n${plpgsql}\nEND\n$d$`, "aaa"));
const inFn = (plpgsql: string) => envelope(seg(`CREATE OR REPLACE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $fn$\nBEGIN\n${plpgsql}\nEND;\n$fn$`, "aaa"));
const refused = (sql: string, why: RegExp) => {
  let err: unknown = null;
  try { parseAtomicEnvelope(sql); } catch (e) { err = e; }
  expect(err, `accepted:\n${sql}`).toBeInstanceOf(AtomicEnvelopeError);
  expect(String((err as Error).message)).toMatch(why);
  expect(() => unwrapAtomicEnvelope(sql)).toThrow(AtomicEnvelopeError);
};
const accepted = (sql: string) => expect(parseAtomicEnvelope(sql).statements.length).toBeGreaterThan(0);

// Every malicious fixture of this file, reused below against the migration-authority guard.
const MALICIOUS: Array<[string, string, RegExp]> = [
  ["1 EXECUTE(...)", inDo("EXECUTE('GRANT ALL ON public.t TO anon');"), /dynamic SQL/],
  ["2 EXECUTE/**/'...'", inDo("EXECUTE/**/'GRANT ALL ON public.t TO anon';"), /dynamic SQL/],
  ["3 EXECUTE /* nested /* comment */ */ (...)", inDo("EXECUTE /* a /* nested */ comment */ ('GRANT ALL ON public.t TO anon');"), /dynamic SQL/],
  ["4 PERFORM '--'; EXECUTE '...'", inDo("PERFORM '--'; EXECUTE 'GRANT ALL ON public.t TO anon';"), /dynamic SQL/],
  ["5 E'--' then EXECUTE", inDo("PERFORM E'--\\' still in the string'; EXECUTE 'GRANT ALL ON public.t TO anon';"), /dynamic SQL/],
  ["6 escaped quotes and comment markers in a string", inDo("PERFORM 'it''s -- not /* a comment'; EXECUTE 'GRANT ALL ON public.t TO anon';"), /dynamic SQL/],
  ["7 dollar-quoted hidden GRANT", inDo("EXECUTE $q$GRANT ALL ON public.t TO anon$q$;"), /dynamic SQL/],
  ["7b dollar tag with digits and underscores", inDo("EXECUTE $q_1$GRANT ALL ON public.t TO anon$q_1$;"), /dynamic SQL/],
  ["8a concatenation", inDo("EXECUTE 'GRANT ALL ON public.' || 't' || ' TO anon';"), /dynamic SQL/],
  ["8b format()", inDo("EXECUTE format('GRANT ALL ON %I TO anon', 't');"), /dynamic SQL/],
  ["9 variable", inDo("DECLARE v text := 'GRANT ALL ON public.t TO anon'; BEGIN EXECUTE v; END;"), /dynamic SQL/],
  ["9b RETURN QUERY EXECUTE in a function body", inFn("RETURN QUERY EXECUTE 'SELECT 1';"), /dynamic SQL/],
  ["10a mixed case", inDo("eXeCuTe 'GRANT ALL ON public.t TO anon';"), /dynamic SQL/],
  ["10b newlines and tabs", inDo("EXECUTE\n\t\n  'GRANT ALL ON public.t TO anon';"), /dynamic SQL/],
  ["11 nested block comments hiding nothing", inDo("/* outer /* inner */ still comment */ EXECUTE 'GRANT ALL ON public.t TO anon';"), /dynamic SQL/],
  ["11b nested dollar quotes", envelope(seg("DO $a$ BEGIN PERFORM $b$ x $b$; EXECUTE $c$GRANT ALL ON public.t TO anon$c$; END $a$", "aaa")), /dynamic SQL/],
  // Executable bodies in string literals would hide their code from inspection: only dollar-quoted bodies are allowed.
  ["14a DO '...'", envelope(seg("DO 'BEGIN EXECUTE ''GRANT ALL ON public.t TO anon''; END'", "aaa")), /DO body in a string literal/],
  ["14b DO E'...'", envelope(seg("DO E'BEGIN EXECUTE \\'GRANT ALL ON public.t TO anon\\'; END'", "aaa")), /DO body in a string literal/],
  ["14c DO LANGUAGE plpgsql '...'", envelope(seg("DO LANGUAGE plpgsql 'BEGIN NULL; END'", "aaa")), /DO body in a string literal/],
  ["14d do /* c */ e'...' (case, comment)", envelope(seg("do /* hidden */ e'BEGIN NULL; END'", "aaa")), /DO body in a string literal/],
  ["14e DO '...' nested inside a dollar-quoted body", inDo("PERFORM 1; DO 'BEGIN NULL; END';"), /DO body in a string literal/],
  ["15a CREATE FUNCTION ... AS '...' LANGUAGE plpgsql", envelope(seg("CREATE FUNCTION public.f() RETURNS void AS 'BEGIN EXECUTE ''GRANT ALL ON public.t TO anon''; END' LANGUAGE plpgsql", "aaa")), /function \/ procedure body in a string literal/],
  ["15b CREATE OR REPLACE FUNCTION ... AS E'...'", envelope(seg("CREATE OR REPLACE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS E'BEGIN NULL; END'", "aaa")), /function \/ procedure body in a string literal/],
  ["15c create function, mixed case, comments and newlines", envelope(seg("create\n  /* x */ Function public.f()\n\tReturns void language sql as\n  'SELECT 1'", "aaa")), /function \/ procedure body in a string literal/],
  ["16a CREATE PROCEDURE ... AS '...'", envelope(seg("CREATE PROCEDURE public.p() LANGUAGE plpgsql AS 'BEGIN NULL; END'", "aaa")), /function \/ procedure body in a string literal/],
  ["16b CREATE OR REPLACE PROCEDURE ... AS E'...'", envelope(seg("CREATE OR REPLACE PROCEDURE public.p() AS E'BEGIN NULL; END' LANGUAGE plpgsql", "aaa")), /function \/ procedure body in a string literal/],
  ["16c procedure inside a DO body", inDo("CREATE PROCEDURE public.p() AS 'BEGIN NULL; END' LANGUAGE plpgsql;"), /function \/ procedure body in a string literal/],
  ["12a raw GRANT before", `GRANT ALL ON public.t TO anon;\n${envelope(seg("SELECT 1", "aaa"))}`, /before the envelope/],
  ["12b raw REVOKE after", `${envelope(seg("SELECT 1", "aaa"))}REVOKE ALL ON public.t FROM service_role;\n`, /after the envelope/],
  ["12c trailing GRANT after a comment", `${envelope(seg("SELECT 1", "aaa"))}-- done\nGRANT EXECUTE ON FUNCTION public.can_user_act_on_workspace(uuid, uuid, text) TO authenticated;`, /after the envelope/],
  ["12d EXECUTE directly in the DO body", `DO $cfoclose_x$\nBEGIN\n${seg("SELECT 1", "aaa")}\n  EXECUTE 'GRANT ALL ON public.t TO anon';\nEND\n$cfoclose_x$;`, /unrecognised executable content/],
  ["12e raw statement between segments", `DO $cfoclose_x$\nBEGIN\n${seg("SELECT 1", "aaa")}\nGRANT ALL ON public.t TO anon;\n${seg("SELECT 2", "aab")}\nEND\n$cfoclose_x$;`, /unrecognised executable content/],
  ["12f two statements in one segment", envelope(seg("CREATE TABLE public.t (id int); GRANT ALL ON public.t TO anon", "aaa")), /more than one statement/],
  ["13a second envelope", `${envelope(seg("SELECT 1", "aaa"))}${envelope(seg("SELECT 2", "aab"))}`, /after the envelope/],
  ["13b nested envelope", envelope(seg(`DO $cfoclose_y$\nBEGIN\nEND\n$cfoclose_y$`, "aaa")), /nested envelope/],
  ["13c another segment's tag inside a segment", envelope(seg("SELECT $mxaab$ x $mxaab$", "aaa")), /nested envelope or segment tag/],
  ["13d reused tag", `DO $cfoclose_x$\nBEGIN\n${seg("SELECT 1", "aaa")}\n${seg("SELECT 2", "aaa")}\nEND\n$cfoclose_x$;`, /reused/],
  ["13e malformed segment tag", `DO $cfoclose_x$\nBEGIN\n  EXECUTE $mx1$\nSELECT 1\n$mx1$;\nEND\n$cfoclose_x$;`, /unrecognised executable content/],
  ["13f unterminated segment", `DO $cfoclose_x$\nBEGIN\n  EXECUTE $mxaaa$\nSELECT 1\nEND\n$cfoclose_x$;`, /unterminated dollar quote/],
  ["13g mismatched closing tag", `DO $cfoclose_x$\nBEGIN\n${seg("SELECT 1", "aaa")}\nEND\n$cfoclose_y$;`, /unterminated dollar quote/],
  ["13h missing BEGIN", `DO $cfoclose_x$\n${seg("SELECT 1", "aaa")}\nEND\n$cfoclose_x$;`, /does not start with BEGIN/],
  ["13i missing semicolon after the envelope", `DO $cfoclose_x$\nBEGIN\n${seg("SELECT 1", "aaa")}\nEND\n$cfoclose_x$`, /not terminated/],
  ["13j zero statements", "DO $cfoclose_x$\nBEGIN\nEND\n$cfoclose_x$;", /zero statements/],
  ["13k empty segment", envelope(seg("-- only a comment", "aaa")), /empty/],
  ["13l marker without a valid envelope", "-- $cfoclose_x$\nGRANT ALL ON public.t TO anon;", /before the envelope/],
  ["13m unterminated block comment", `/* never closed\n${envelope(seg("SELECT 1", "aaa"))}`, /unterminated block comment/],
];

describe("the lexer tokenises PostgreSQL exactly", () => {
  it("strings, escapes, identifiers, dollar quotes, comments and parameters", () => {
    const kinds = (s: string) => lexSql(s).filter((t: { type: string }) => t.type !== "ws").map((t: { type: string; text: string }) => `${t.type}:${t.text}`);
    expect(kinds("SELECT 'a''--b', E'c\\'--d', \"x\"\"y\", $$ -- $$, $t$ /* $t$, $1 -- tail")).toEqual([
      "word:SELECT", "string:'a''--b'", "punct:,", "string:E'c\\'--d'", "punct:,", 'qident:"x""y"', "punct:,", "dollar:$$ -- $$", "punct:,", "dollar:$t$ /* $t$", "punct:,", "param:$1", "comment:-- tail",
    ]);
    expect(kinds("/* a /* b */ c */ x")).toEqual(["comment:/* a /* b */ c */", "word:x"]);
    expect(kinds("a$b EXECUTED")).toEqual(["word:a$b", "word:EXECUTED"]);
    expect(() => lexSql("'open")).toThrow(/unterminated string/);
    expect(() => lexSql("$q$ open")).toThrow(/unterminated dollar quote/);
    expect(() => lexSql("/* /* */")).toThrow(/unterminated block comment/);
  });
});

describe("dynamic SQL and anything outside the envelope are refused (adversarial fixtures)", () => {
  it.each(MALICIOUS)("%s", (_name, sql, why) => refused(sql, why));
});

describe("no false positives", () => {
  it("EXECUTE in data strings, identifiers and comments, and the static EXECUTE forms, are accepted", () => {
    accepted(envelope(seg("COMMENT ON TABLE public.t IS 'we EXECUTE nothing here; EXECUTE ''x'' -- not code'", "aaa")));
    accepted(envelope(seg("CREATE TABLE public.t (executed_at timestamptz, \"EXECUTE\" text) -- EXECUTE 'x' in a comment", "aaa")));
    accepted(inDo("/* EXECUTE 'GRANT' in a comment */ RAISE NOTICE 'EXECUTE %', E'it\\'s /* fine */'; -- EXECUTE"));
    accepted(envelope(seg("CREATE TRIGGER trg BEFORE UPDATE ON public.t FOR EACH ROW EXECUTE FUNCTION public.f()", "aaa")));
    accepted(envelope(seg("CREATE TRIGGER trg BEFORE UPDATE ON public.t FOR EACH ROW EXECUTE PROCEDURE public.f()", "aaa")));
    accepted(envelope(seg("GRANT EXECUTE ON FUNCTION public.f() TO service_role", "aaa")));
    accepted(envelope(seg("REVOKE EXECUTE ON FUNCTION public.f() FROM PUBLIC", "aaa")));
    accepted(envelope(seg("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role", "aaa")));
    accepted(`-- header\n/* block /* nested */ comment */\n${envelope(seg("SELECT 1", "aaa"))}-- trailing comment\n`);
    // Dollar-quoted bodies, ON CONFLICT DO, and strings that merely follow AS outside a function definition.
    accepted(envelope(seg("CREATE OR REPLACE FUNCTION public.f() RETURNS text LANGUAGE sql AS $fn$ SELECT 'AS ''x''' $fn$", "aaa")));
    accepted(envelope(seg("DO LANGUAGE plpgsql $d$ BEGIN NULL; END $d$", "aaa")));
    accepted(envelope(seg("INSERT INTO public.t (id) VALUES (1) ON CONFLICT DO NOTHING", "aaa")));
    accepted(envelope(seg("COMMENT ON FUNCTION public.f() IS 'defined AS ''sql'' elsewhere'", "aaa")));
  });
});

describe("the six pending migrations", () => {
  it("each parses as one valid envelope with its exact statement count; every body is inspected; statements are unchanged", () => {
    const want: Record<string, number> = { "20260925100000": 146, "20260925110000": 108, "20260925120000": 56, "20260925130000": 65, "20260925140000": 186, "20260925150000": 6, "20260926160000": 12 };
    const got: Record<string, number> = {};
    for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql"))) {
      const sql = fs.readFileSync(path.join(MIGRATIONS, f), "utf8");
      if (!isAtomicEnvelope(sql)) continue;
      const { statements, label } = parseAtomicEnvelope(sql);
      got[f.slice(0, 14)] = statements.length;
      // Independent extraction of the segments (text between each opening tag line and its closing tag line).
      const direct = [...sql.replace(/\r\n/g, "\n").matchAll(new RegExp(`\\n {2}EXECUTE (\\$m${label}[a-z]{3}\\$)\\n([\\s\\S]*?)\\n\\1;`, "g"))].map((m) => m[2]);
      expect(statements).toEqual(direct);
      expect(unwrapAtomicEnvelope(sql)).not.toMatch(/\$cfoclose_/);
    }
    expect(got).toEqual(want);
  });
});

describe("the migration-authority guard refuses every malicious fixture", () => {
  it("each fixture added as a migration is reported as an invalid envelope; the untouched repository is clean", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "envelope-guard-"));
    try {
      fs.cpSync(path.join(ROOT, "supabase/migrations"), path.join(dir, "supabase/migrations"), { recursive: true });
      fs.cpSync(path.join(ROOT, "drizzle"), path.join(dir, "drizzle"), { recursive: true });
      expect((checkMigrationAuthority(dir) as { errors: string[] }).errors).toEqual([]);
      const fixture = path.join(dir, "supabase/migrations/20260930000000_fixture.sql");
      const missed: string[] = [];
      for (const [name, sql] of MALICIOUS) {
        fs.writeFileSync(fixture, sql);
        const errors = (checkMigrationAuthority(dir) as { errors: string[] }).errors.join("\n");
        if (!/20260930000000_fixture\.sql: atomic envelope refused/.test(errors)) missed.push(name);
      }
      expect(missed).toEqual([]);
      // Appended to a REAL atomic migration, too.
      fs.rmSync(fixture);
      const real = path.join(dir, "supabase/migrations/20260925140000_workspace_capability_authorization.sql");
      fs.appendFileSync(real, "GRANT ALL ON public.workspace_member_capabilities TO anon;\n");
      expect((checkMigrationAuthority(dir) as { errors: string[] }).errors.join("\n")).toMatch(/20260925140000_workspace_capability_authorization\.sql: atomic envelope refused: executable text after the envelope/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);   // one full-repository guard run per fixture
});
