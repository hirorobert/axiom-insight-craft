/**
 * QuickBooks realmID protection r1 (Intuit case 00232331; docs/release/qbo-realm-protection-r1/README.md), Phases A and B: three migrations,
 * registered before application and APPLIED on 2026-11-18 as hosted 114-116 (mirrors 0113-0115): two byte for byte, the third as a reviewed
 * whitespace variant (Lovable's migrator added one leading space to line 60). These tests pin their submission identity and the three reviewed
 * release entries, prove the variant validator accepts exactly that one indentation change and nothing else, and hold the static properties
 * the release record promises: Lovable-migrator size, one atomic DO block each, no transaction control, append-only guards and RLS untouched,
 * every new or replaced writer service-role only, and no realm in anything a member can execute.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script without type declarations
import { checkMigrationAuthority } from "../../../scripts/ci/assertMigrationAuthority.mjs";
// @ts-expect-error — plain ESM script without type declarations
import { RELEASE_JOURNAL, SUBMISSION_FORMS, checkReleaseEntry, submittedForm } from "../../../scripts/ci/releaseJournal.mjs";

type Result = { ok: boolean; errors: string[]; pending: string[]; mirrored: { tag: string; source: string }[] };
const ROOT = path.join(__dirname, "../../..");
const NAMES = ["20261230100000_qbo_realm_protection_schema.sql", "20261230200000_qbo_realm_protection_connect.sql", "20261230300000_qbo_realm_protection_evidence.sql"];
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const src = (n: string) => fs.readFileSync(path.join(ROOT, "supabase/migrations", n));
const code = (n: string) => src(n).toString("utf8").replace(/^\s*--[^\n]*$/gm, "");

const TAGS = ["0113_qbo_realm_protection_schema", "0114_qbo_realm_protection_connect", "0115_qbo_realm_protection_evidence"];
const mirror = (t: string) => fs.readFileSync(path.join(ROOT, "drizzle/migrations", `${t}.sql`));
const srcBytes = (n: string) => (fs.existsSync(path.join(ROOT, "supabase/migrations", n)) ? src(n) : null);
const J = RELEASE_JOURNAL as Record<string, Record<string, unknown>>;
const withEntry = (tag: string, patch: Record<string, unknown>, fn: () => void) => {
  const saved = J[tag]; J[tag] = { ...saved, ...patch };
  try { fn(); } finally { J[tag] = saved; }
};

describe("realmID protection migrations: registered, then applied as hosted 114-116 (2026-11-18)", () => {
  it("their two submission forms are the committed bytes; the release entries pin exactly what was applied", () => {
    for (const n of NAMES) {
      const s = src(n);
      expect(s[s.length - 1], n).toBe(0x0a);
      expect(s.includes("\r\n"), n).toBe(false);
      expect(SUBMISSION_FORMS[n], n).toEqual({ identical: { bytes: s.length, sha256: sha(s) }, finalLfRemoved: { bytes: s.length - 1, sha256: sha(s.subarray(0, s.length - 1)) } });
      expect(submittedForm(n, s, s)).toBe("identical");
      expect(submittedForm(n, s, s.subarray(0, s.length - 1))).toBe("final_lf_removed");
      expect(submittedForm(n, s, Buffer.concat([s, Buffer.from("\n")]))).toBeNull();
    }
    expect(Object.keys(RELEASE_JOURNAL).filter((k) => /realm/.test(k))).toEqual(TAGS);
    // Hosted 114 and 115: the committed files byte for byte (journal hashes read in the hosted SQL editor).
    expect(sha(mirror(TAGS[0]))).toBe(sha(src(NAMES[0]))); expect(sha(mirror(TAGS[0]))).toBe("7b310469b5b5919786295f7709f8d9532e604abf2acaea7689df642037885598");
    expect(sha(mirror(TAGS[1]))).toBe(sha(src(NAMES[1]))); expect(sha(mirror(TAGS[1]))).toBe("578a4bafc9e38fe793c1c8f88628ac613300a5e13b7d648c4d209d18213e1f82");
    // Hosted 116: the source with ONE extra leading space on line 60, nothing else.
    const a = src(NAMES[2]).toString("utf8").split("\n"), b = mirror(TAGS[2]).toString("utf8").split("\n");
    expect(sha(mirror(TAGS[2]))).toBe("b58065bb05c99b33c11bf6aa1888360d104185f7600b400130c9fb0b0e78dfea");
    expect(b.length).toBe(a.length);
    expect(a.map((x, i) => (x === b[i] ? null : i + 1)).filter((x) => x !== null)).toEqual([60]);
    expect(b[59]).toBe(" " + a[59]);
    expect(a[59].trimStart().startsWith("refresh_lease_until=NULL,refresh_lease_id=NULL,disconnected_at=clock_timestamp() WHERE id=c.id;")).toBe(true);
  });

  it("the repository reports none of them pending: each is mirrored through its reviewed entry, in order, with no error", () => {
    const r = checkMigrationAuthority(ROOT) as Result & { mirrored: { tag: string; source: string; how: string }[] };
    expect(r.errors).toEqual([]);
    expect(r.pending.filter((n) => NAMES.includes(n))).toEqual([]);
    expect(r.mirrored.filter((m) => NAMES.includes(m.source))).toEqual([
      { tag: TAGS[0], source: NAMES[0], how: "release_verbatim" },
      { tag: TAGS[1], source: NAMES[1], how: "release_verbatim" },
      { tag: TAGS[2], source: NAMES[2], how: "release_whitespace_variant" },
    ]);
  }, 120_000);

  it("each applied mirror validates against its entry", () => {
    for (const t of TAGS) expect(checkReleaseEntry(t, mirror(t).toString("utf8"), srcBytes).problems, t).toEqual([]);
  });

  describe("the whitespace-variant entry accepts exactly the reviewed indentation change and nothing else", () => {
    const text = () => mirror(TAGS[2]).toString("utf8");
    const lines = () => text().split("\n");
    const problems = (t: string, patch: Record<string, unknown> = {}) => {
      let out: string[] = [];
      withEntry(TAGS[2], { sha256: sha(Buffer.from(t, "utf8")), submittedBytes: Buffer.byteLength(t), ...patch }, () => { out = checkReleaseEntry(TAGS[2], t, srcBytes).problems; });
      return out.join("\n");
    };
    it("the source itself under this tag (no variant) is refused: the reviewed line does not differ", () => {
      expect(problems(src(NAMES[2]).toString("utf8"))).toMatch(/reviewed line 60 does not differ/);
    });
    it("a non-whitespace change on the reviewed line is refused", () => {
      const l = lines(); l[59] = l[59].replace("WHERE id=c.id", "WHERE id<>c.id");
      expect(problems(l.join("\n"))).toMatch(/line 60 differs in more than its leading indentation/);
    });
    it("trailing whitespace or a tab inside the statement on the reviewed line is refused", () => {
      const l = lines(); l[59] = l[59] + " ";
      expect(problems(l.join("\n"))).toMatch(/line 60 differs in more than its leading indentation/);
      const m = lines(); m[59] = m[59].replace("=NULL,", "= NULL,");
      expect(problems(m.join("\n"))).toMatch(/line 60 differs in more than its leading indentation/);
    });
    it("any other changed line, even whitespace-only, is refused", () => {
      const l = lines(); l[10] = " " + l[10];
      expect(problems(l.join("\n"))).toMatch(/line 11 differs from .* and is not a reviewed variant line/);
    });
    it("an added or removed line is refused", () => {
      expect(problems(text() + "-- appended\n")).toMatch(/lines/);
      const l = lines(); l.splice(5, 1);
      expect(problems(l.join("\n"))).toMatch(/lines/);
    });
    it("an entry without reviewed lines, a wrong source digest, or bytes other than pinned are refused", () => {
      expect(problems(text(), { variantLines: [] })).toMatch(/must list its reviewed lines/);
      expect(problems(text(), { digest: "0".repeat(64) })).toMatch(/pinned digest does not match/);
      let out: string[] = [];
      withEntry(TAGS[2], {}, () => { out = checkReleaseEntry(TAGS[2], text() + " ", srcBytes).problems; });
      expect(out.join("\n")).toMatch(/differs from its reviewed content|has 16319 bytes/);
    });
  });
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
