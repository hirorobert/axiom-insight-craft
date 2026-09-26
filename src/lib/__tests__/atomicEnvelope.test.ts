/**
 * The atomic migration envelope parser fails closed (security correction M-1): a migration that claims the envelope
 * is accepted only as exactly one valid envelope whose every executable statement is visible to the static guards.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AtomicEnvelopeError, isAtomicEnvelope, parseAtomicEnvelope, unwrapAtomicEnvelope } from "../../../scripts/ci/atomicEnvelope.mjs";
import { checkMigrationAuthority } from "../../../scripts/ci/assertMigrationAuthority.mjs";

const ROOT = path.join(__dirname, "../../..");
const MIGRATIONS = path.join(ROOT, "supabase/migrations");

const seg = (tag: string, sql: string) => `  EXECUTE $mx${tag}$\n${sql}\n$mx${tag}$;`;
const envelope = (body: string, label = "x") => `DO $cfoclose_${label}$\nBEGIN\n${body}\nEND\n$cfoclose_${label}$;\n`;
const VALID = `-- header comment\n--\n${envelope([seg("aaa", "CREATE TABLE public.t (id int)"), seg("aab", "REVOKE ALL ON public.t FROM anon")].join("\n\n"))}-- trailing comment only\n`;
const refused = (sql: string, why: RegExp) => {
  let err: unknown = null;
  try { parseAtomicEnvelope(sql); } catch (e) { err = e; }
  expect(err, `accepted:\n${sql}`).toBeInstanceOf(AtomicEnvelopeError);
  expect(String((err as Error).message)).toMatch(why);
  expect(() => unwrapAtomicEnvelope(sql)).toThrow(AtomicEnvelopeError);
};

describe("a valid envelope unwraps to exactly its statements", () => {
  it("comments and whitespace outside are allowed; each segment becomes one statement", () => {
    expect(parseAtomicEnvelope(VALID).statements).toEqual(["CREATE TABLE public.t (id int)", "REVOKE ALL ON public.t FROM anon"]);
    expect(unwrapAtomicEnvelope(VALID)).toBe("CREATE TABLE public.t (id int);\n\nREVOKE ALL ON public.t FROM anon;\n");
    expect(unwrapAtomicEnvelope("CREATE TABLE a (id int);")).toBe("CREATE TABLE a (id int);");
  });
  it("the six pending migrations each parse as one valid envelope and every statement is recovered", () => {
    const want: Record<string, number> = { "20260925100000": 146, "20260925110000": 108, "20260925120000": 56, "20260925130000": 65, "20260925140000": 186, "20260925150000": 6 };
    const got: Record<string, number> = {};
    for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql"))) {
      const sql = fs.readFileSync(path.join(MIGRATIONS, f), "utf8");
      if (!isAtomicEnvelope(sql)) continue;
      const { statements } = parseAtomicEnvelope(sql);
      got[f.slice(0, 14)] = statements.length;
      const unwrapped = unwrapAtomicEnvelope(sql);
      expect(unwrapped).not.toMatch(/\$cfoclose_|EXECUTE \$m[a-z]+\$/);
      // Every segment body appears verbatim in the unwrapped text: nothing is dropped.
      for (const st of statements) expect(unwrapped).toContain(st);
    }
    expect(got).toEqual(want);
  });
});

describe("anything the parser cannot account for is refused (mutation tests)", () => {
  const body = [seg("aaa", "CREATE TABLE public.t (id int)"), seg("aab", "REVOKE ALL ON public.t FROM anon")].join("\n\n");
  it("executable text before the envelope (raw GRANT / DDL)", () => {
    refused(`GRANT ALL ON public.t TO anon;\n${envelope(body)}`, /before the envelope/);
    refused(`CREATE TABLE public.u (id int);\n${envelope(body)}`, /before the envelope/);
  });
  it("executable text after the envelope: an appended GRANT / REVOKE, a trailing statement, a second envelope", () => {
    refused(`${envelope(body)}GRANT EXECUTE ON FUNCTION public.can_user_act_on_workspace(uuid, uuid, text) TO authenticated;\n`, /after the envelope/);
    refused(`${envelope(body)}\nREVOKE ALL ON public.t FROM service_role;`, /after the envelope/);
    refused(`${envelope(body)}${envelope(body, "y")}`, /after the envelope/);
  });
  it("single-quoted (or any) dynamic EXECUTE — directly in the DO body or inside a segment", () => {
    refused(envelope(`${body}\n  EXECUTE 'GRANT ALL ON public.t TO anon';`), /unrecognised executable content/);
    refused(envelope(seg("aaa", "DO $d$ BEGIN EXECUTE 'GRANT ALL ON public.t TO anon'; END $d$")), /dynamic SQL/);
    refused(envelope(seg("aaa", "DO $d$ BEGIN EXECUTE format('GRANT ALL ON %I TO anon', 't'); END $d$")), /dynamic SQL/);
    refused(envelope(seg("aaa", "DO $d$ BEGIN EXECUTE $q$GRANT ALL ON public.t TO anon$q$; END $d$")), /dynamic SQL/);
    refused(envelope(seg("aaa", "DO $d$ DECLARE v text := 'x'; BEGIN EXECUTE v; END $d$")), /dynamic SQL/);
  });
  it("unrecognised content inside the DO body (a raw statement between segments)", () => {
    refused(envelope(`${seg("aaa", "CREATE TABLE public.t (id int)")}\nGRANT ALL ON public.t TO anon;\n${seg("aab", "SELECT 1")}`), /unrecognised executable content/);
  });
  it("nested, duplicated and malformed envelopes and tags", () => {
    refused(envelope(seg("aaa", envelope(seg("aab", "SELECT 1"), "inner"))), /nested envelope|another segment/);
    refused(envelope([seg("aaa", "SELECT 1"), seg("aaa", "SELECT 2")].join("\n\n")), /reused/);
    refused(envelope("  EXECUTE $mxaaa$\nSELECT 1\n$mxaab$;"), /not closed|never closed|unrecognised/);
    refused(envelope("  EXECUTE $mxaaa$\nSELECT 1\n$mxaaa$"), /not closed|never closed|unrecognised/);
    refused(envelope("  EXECUTE $myaaa$\nSELECT 1\n$myaaa$;"), /unrecognised executable content/);   // another label's tag
    refused(envelope("  EXECUTE $mx1$\nSELECT 1\n$mx1$;"), /unrecognised executable content/);      // digits in the tag
    refused(`DO $cfoclose_x$ BEGIN\n${body}\nEND\n$cfoclose_x$;`, /malformed envelope header|before the envelope/);
    refused(`DO $cfoclose_x$\nBEGIN\n${body}\nEND\n$cfoclose_y$;`, /unrecognised executable content|never closed/);
    refused(`DO $cfoclose_x$\nBEGIN\n${body}\n`, /never closed/);
  });
  it("zero statements, and an empty segment", () => {
    refused(envelope(""), /zero statements/);
    refused(envelope(seg("aaa", "-- only a comment")), /empty/);
  });
});

describe("the migration-authority guard fails closed on an invalid envelope", () => {
  it("a raw GRANT appended to a real atomic migration is reported, not skipped", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "envelope-guard-"));
    try {
      fs.cpSync(path.join(ROOT, "supabase/migrations"), path.join(dir, "supabase/migrations"), { recursive: true });
      fs.cpSync(path.join(ROOT, "drizzle"), path.join(dir, "drizzle"), { recursive: true });
      expect((checkMigrationAuthority(dir) as { errors: string[] }).errors).toEqual([]);
      const f = path.join(dir, "supabase/migrations/20260925140000_workspace_capability_authorization.sql");
      fs.appendFileSync(f, "GRANT ALL ON public.workspace_member_capabilities TO anon;\n");
      expect((checkMigrationAuthority(dir) as { errors: string[] }).errors.join("\n")).toMatch(/20260925140000_workspace_capability_authorization\.sql: atomic envelope refused: executable text after the envelope/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
