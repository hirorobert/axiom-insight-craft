/**
 * QuickBooks realmID protection r1 (Intuit case 00232331; docs/release/qbo-realm-protection-r1/README.md), Phases A and B: three migrations,
 * authored and authorized, NOT applied (the hosted journal stays at 113). These tests pin their approved submission identity, prove the guard
 * reports them PENDING (never mirrored by normalised parity, never accepted without a reviewed release entry), and hold the static properties
 * the release record promises: Lovable-migrator size, one atomic DO block each, no transaction control, append-only guards and RLS untouched,
 * every new or replaced writer service-role only, and no realm in anything a member can execute. The Phase C cutover (three more migrations, IRREVERSIBLE
 * for the plaintext, separately approved) is registered the same way and held to its own properties: the gate in every part, the redaction only in
 * the last part, the append-only evidence and terminal rows untouched.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script without type declarations
import { checkMigrationAuthority } from "../../../scripts/ci/assertMigrationAuthority.mjs";
// @ts-expect-error — plain ESM script without type declarations
import { RELEASE_JOURNAL, SUBMISSION_FORMS, submittedForm } from "../../../scripts/ci/releaseJournal.mjs";

type Result = { ok: boolean; errors: string[]; pending: string[]; mirrored: { tag: string; source: string }[] };
const ROOT = path.join(__dirname, "../../..");
const NAMES = ["20261230100000_qbo_realm_protection_schema.sql", "20261230200000_qbo_realm_protection_connect.sql", "20261230300000_qbo_realm_protection_evidence.sql"];
const CUTOVER = ["20261231100000_qbo_realm_protection_cutover_schema.sql", "20261231200000_qbo_realm_protection_cutover_functions.sql", "20261231300000_qbo_realm_protection_cutover_redaction.sql"];
const ALL = [...NAMES, ...CUTOVER];
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const src = (n: string) => fs.readFileSync(path.join(ROOT, "supabase/migrations", n));
const code = (n: string) => src(n).toString("utf8").replace(/^\s*--[^\n]*$/gm, "");

describe("realmID protection migrations: authorized, pending, not applied", () => {
  it("register exactly the committed bytes as their two submission forms; nothing of them is a reviewed release entry", () => {
    for (const n of ALL) {
      const s = src(n);
      expect(s[s.length - 1], n).toBe(0x0a);
      expect(s.includes("\r\n"), n).toBe(false);
      expect(SUBMISSION_FORMS[n], n).toEqual({ identical: { bytes: s.length, sha256: sha(s) }, finalLfRemoved: { bytes: s.length - 1, sha256: sha(s.subarray(0, s.length - 1)) } });
      expect(submittedForm(n, s, s)).toBe("identical");
      expect(submittedForm(n, s, s.subarray(0, s.length - 1))).toBe("final_lf_removed");
      expect(submittedForm(n, s, Buffer.concat([s, Buffer.from("\n")]))).toBeNull();
    }
    expect(Object.keys(RELEASE_JOURNAL).filter((k) => /realm/.test(k))).toEqual([]);   // no applied mirror, no receipt: nothing is fabricated
  });

  it("the repository reports exactly these six as pending, in order, with no error", () => {
    const r = checkMigrationAuthority(ROOT) as Result;
    expect(r.errors).toEqual([]);
    expect(r.pending).toEqual(ALL);
    expect(r.mirrored.some((m) => ALL.includes(m.source))).toBe(false);
  }, 120_000);

  it("a Lovable mirror of one WITHOUT a reviewed release entry is refused (rule 9)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qbo-realm-migration-"));
    try {
      for (const d of ["supabase/migrations", "drizzle/migrations", "drizzle/migrations/meta"]) {
        fs.mkdirSync(path.join(dir, d), { recursive: true });
        for (const f of fs.readdirSync(path.join(ROOT, d))) { const p = path.join(ROOT, d, f); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(dir, d, f)); }
      }
      const jp = path.join(dir, "drizzle/migrations/meta/_journal.json");
      const j = JSON.parse(fs.readFileSync(jp, "utf8")) as { entries: { idx: number; when: number; tag: string }[] };
      const idx = j.entries.length, tag = `${String(idx).padStart(4, "0")}_qbo_realm_protection_schema`;
      fs.writeFileSync(path.join(dir, "drizzle/migrations", `${tag}.sql`), src(NAMES[0]));
      fs.writeFileSync(path.join(dir, "drizzle/migrations/meta", `${String(idx).padStart(4, "0")}_snapshot.json`), "{}");
      j.entries.push({ ...j.entries[idx - 1], idx, when: j.entries[idx - 1].when + 1000, tag });
      fs.writeFileSync(jp, JSON.stringify(j));
      const r = checkMigrationAuthority(dir) as Result;
      expect(r.errors.join("\n")).toMatch(/mirrors 20261230100000_qbo_realm_protection_schema\.sql, which is accepted only through a reviewed RELEASE_JOURNAL entry/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 240_000);
});

describe("realmID protection migrations: static properties", () => {
  it("each fits the Lovable migrator (under 18 KB) and is ONE DO block with preflight and postcondition, no transaction control", () => {
    for (const n of NAMES) {
      const s = src(n), c = code(n);
      expect(s.length, n).toBeLessThan(18_000);
      expect(c.trim(), n).toMatch(/^DO \$(\w+)\$[\s\S]*\nEND\n\$\1\$;$/);
      expect(c, n).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
      expect(c, n).toMatch(/PREFLIGHT_REFUSED/); expect(c, n).toMatch(/POSTCONDITION/); expect(c, n).toMatch(/RETURN;\s+-- replay|THEN RETURN; END IF;\s+-- replay/);
    }
  });
  it("append-only evidence keeps its guards; no RLS policy, table grant or truncate guard is touched; nothing is deleted", () => {
    for (const n of NAMES) {
      const c = code(n);
      expect(c, n).not.toMatch(/tbu_append_only_guard|qbo_evidence_no_truncate|DROP TRIGGER|DISABLE TRIGGER|ROW LEVEL SECURITY|CREATE POLICY|DROP POLICY|ALTER POLICY/i);
      expect(c, n).not.toMatch(/\bDELETE\s+FROM\b|\bTRUNCATE\b|DROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT)/i);
      expect(c, n).not.toMatch(/GRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\s+ON\s+(TABLE\s+)?public\./i);
      expect(c, n).not.toMatch(/UPDATE public\.qbo_(pull_intents|pulls)\b/);
    }
  });
  it("every new or re-created writer is service-role only; members execute only the status read, which carries no realm", () => {
    const all = NAMES.map(code).join("\n");
    const granted = [...all.matchAll(/GRANT EXECUTE ON FUNCTION ([^\s]+) TO (\w+)/g)].map((m) => [m[1], m[2]]);
    expect(granted).toEqual([["public.qbo_connection_status(uuid)", "authenticated"]]);
    expect(all.match(/EXECUTE 'GRANT EXECUTE ON FUNCTION ' \|\| \w+ \|\| ' TO service_role'/g)?.length).toBe(3);
    const status = /CREATE FUNCTION public\.qbo_connection_status[\s\S]*?\$f\$;/.exec(code(NAMES[1]))?.[0] ?? "";
    expect(status).toMatch(/RETURNS TABLE \(id uuid, environment text, status text, refresh_expires_at timestamptz, created_at timestamptz\)/);
    expect(status).not.toMatch(/realm/);
  });
  it("Phase A and B never set the plaintext realm to NULL and never relax its constraints (that is the separately approved cutover)", () => {
    for (const n of NAMES) expect(code(n), n).not.toMatch(/realm_id\s*=\s*NULL|ALTER COLUMN realm_id|DROP NOT NULL/i);
  });
});

describe("the cutover (Phase C): IRREVERSIBLE for the plaintext, held to its own properties", () => {
  it("each part fits the migrator, is ONE DO block, says it is irreversible, and re-checks the 100 % gate before anything changes", () => {
    for (const n of CUTOVER) {
      const s = src(n), c = code(n), raw = s.toString("utf8");
      expect(s.length, n).toBeLessThan(18_000);
      expect(c.trim(), n).toMatch(/^DO \$(\w+)\$[\s\S]*\nEND\n\$\1\$;$/);
      expect(c, n).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
      expect(raw, n).toMatch(/IRREVERSIBLE FOR THE PLAINTEXT/);
      const gate = c.indexOf("QBO_REALM_CUTOVER_REFUSED");
      expect(gate, n).toBeGreaterThan(0);
      // nothing is altered, created, dropped or updated before the gate
      expect(c.slice(0, gate), n).not.toMatch(/\b(ALTER TABLE|CREATE OR REPLACE|DROP|UPDATE public|DELETE FROM)\b/);
    }
  });
  it("only the last part removes a plaintext; it never touches append-only evidence, a terminal connection, RLS or a table grant", () => {
    const [schema, functions, redaction] = CUTOVER.map(code);
    for (const c of [schema, functions]) expect(c).not.toMatch(/SET realm_id = NULL|DELETE FROM/);
    expect(redaction).toMatch(/UPDATE public\.qbo_connections SET realm_id = NULL WHERE status <> 'disconnected' AND realm_id IS NOT NULL;/);
    expect(redaction).toMatch(/UPDATE public\.qbo_disconnect_operations SET realm_id = NULL WHERE realm_id IS NOT NULL;/);
    expect([...redaction.matchAll(/DELETE FROM (\S+)/g)].map((m) => m[1])).toEqual(["public.qbo_oauth_states"]);
    for (const c of [schema, functions, redaction]) {
      expect(c).not.toMatch(/tbu_append_only_guard|qbo_evidence_no_truncate|DROP TRIGGER|DISABLE TRIGGER|ROW LEVEL SECURITY|POLICY|\bTRUNCATE\b/i);
      expect(c).not.toMatch(/UPDATE public\.qbo_(pull_intents|pulls)\b|GRANT\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\s+ON/i);
    }
  });
  it("the guards allow exactly one new transition: a verified row's realm_id to NULL", () => {
    const schema = code(CUTOVER[0]);
    expect(schema.match(/NOT \(NEW\.realm_id IS NULL AND OLD\.realm_index IS NOT NULL AND OLD\.realm_verified_at IS NOT NULL\)/g)).toHaveLength(2);
    expect(schema).toMatch(/IF OLD\.status = 'disconnected' THEN\s+RAISE EXCEPTION 'QBO_CONNECTION_TERMINAL/);   // terminal rows still cannot change
  });
  it("after the cutover every realm rule reads the index and no function writes a plaintext", () => {
    const f = code(CUTOVER[1]);
    expect(f).toMatch(/hashtextextended\('qbo-connect:'\|\|p_environment\|\|':'\|\|p_realm_index,0\)/);
    expect(f).toMatch(/x\.realm_index=c\.realm_index/);
    expect(f).toMatch(/realm_index=p_realm_index AND environment=p_environment AND outcome='pending'/);
    // the only "c.realm_id" left: the anchor the live fiscal text is checked against and replaced, and the postcondition that it is gone
    expect(f.split("c.realm_id").length - 1).toBe(f.split("OR c.realm_id<>p_realm_id OR c.environment<>p_environment").length - 1 + f.split("position('c.realm_id' IN").length - 1);
    expect(f).toMatch(/position\('c\.realm_id' IN pg_get_functiondef\(to_regprocedure\(c_fiscal\)\)\) > 0/);
    expect(f).not.toMatch(/realm_id = p_realm_id|realm_id=p_realm_id AND/);
    expect(f.match(/QBO_REALM_PROTECTION_REQUIRED/g)).toHaveLength(2);
  });
});
