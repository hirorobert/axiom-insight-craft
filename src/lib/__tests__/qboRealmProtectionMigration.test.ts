/**
 * QuickBooks realmID protection r1 (Intuit case 00232331; docs/release/qbo-realm-protection-r1/README.md), Phases A and B: three migrations,
 * registered before application and APPLIED on 2026-11-18 as hosted 114-116 (mirrors 0113-0115): two byte for byte, the third as a reviewed
 * whitespace variant (Lovable's migrator added one leading space to line 60). These tests pin their submission identity and the three reviewed
 * release entries, prove the variant validator accepts exactly that one indentation change and nothing else, and hold the static properties
 * the release record promises: Lovable-migrator size, one atomic DO block each, no transaction control, append-only guards and RLS untouched,
 * every new or replaced writer service-role only, and no realm in anything a member can execute.
 *
 * Their token-key reseal (20261230400000) was applied on 2026-11-19 as hosted 117 (mirror 0116) in NEITHER registered form: besides the final
 * LF, line 67 of qbo_disconnect_operations_guard() was transcribed with OLD for NEW, a semantic deviation that weakened the guard. It is
 * registered through the reviewed kind release_transcription_variant_repaired, and the forward-only 20261230410000 restores the reviewed body;
 * it was applied byte for byte on 2026-11-19 as hosted 118 (mirror 0117, release_verbatim). The tests below pin that entry and prove its validator accepts exactly that one substitution, with the repair present.
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
    expect(Object.keys(RELEASE_JOURNAL).filter((k) => /realm/.test(k))).toEqual([...TAGS, RESEAL_TAG, "0118_qbo_realm_index_rotation", "0119_qbo_realm_protection_cutover_schema", "0120_qbo_realm_protection_cutover_functions", "0121_qbo_realm_rotation_post_redaction"]);   // + 2026-11-20: the index-key rotation (hosted 119)
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

const RESEAL = "20261230400000_qbo_realm_key_reseal.sql", RESEAL_TAG = "0116_qbo_realm_key_reseal";
const REPAIR = "20261230410000_qbo_reseal_operations_guard_repair.sql", REPAIR_TAG = "0117_qbo_reseal_operations_guard_repair";
const REVIEWED_BODY = "ab3855f445f5d82b68f29dba324745752853a472ee065befdc207b15162099a0";
const VARIANT_BODY = "d087625f8ffa333d1d90fb407099abc0461418b0425a9486a63e57d70a6ccd18";
const LINE_67_SOURCE = "    IF (OLD.realm_envelope IS NOT NULL AND NEW.realm_envelope IS DISTINCT FROM OLD.realm_envelope)";
const LINE_67_HOSTED = "    IF (OLD.realm_envelope IS NOT NULL AND OLD.realm_envelope IS DISTINCT FROM OLD.realm_envelope)";
/** The dollar-quoted body of qbo_disconnect_operations_guard() in a text: exactly what PostgreSQL stores as prosrc. */
const guardBody = (t: string) => /CREATE OR REPLACE FUNCTION public\.qbo_disconnect_operations_guard\(\)[\s\S]*?\bAS (\$[A-Za-z_]*\$)([\s\S]*?)\1/.exec(t)?.[2] ?? "";

describe("the token-key reseal: applied as hosted 117 with one transcribed line (2026-11-19), repaired by 20261230410000 (applied as hosted 118)", () => {
  it("the mirror is the source with its final LF removed and line 67 transcribed OLD for NEW, nothing else; the repair carries the reviewed body", () => {
    const s = src(RESEAL), m = mirror(RESEAL_TAG);
    expect([s.length, sha(s)]).toEqual([16076, "ee921a7b9043aa382c0da0cb3f7bbf8daa2e43e8ca3039593916010845d6c775"]);
    expect([m.length, sha(m)]).toEqual([16075, "d7938affaa0a63a930e82a534ca20e428e1245adfa3001439fbb04bace1110c0"]);
    expect(submittedForm(RESEAL, s, m)).toBeNull();   // neither registered form
    const a = s.toString("utf8").split("\n"), b = `${m.toString("utf8")}\n`.split("\n");
    expect(m[m.length - 1]).not.toBe(0x0a);
    expect(b.length).toBe(a.length);
    expect(a.map((x, i) => (x === b[i] ? null : i + 1)).filter((x) => x !== null)).toEqual([67]);
    expect([a[66], b[66]]).toEqual([LINE_67_SOURCE, LINE_67_HOSTED]);
    expect(sha(Buffer.from(guardBody(s.toString("utf8")), "utf8"))).toBe(REVIEWED_BODY);
    expect(sha(Buffer.from(guardBody(m.toString("utf8")), "utf8"))).toBe(VARIANT_BODY);
    const r = src(REPAIR);
    expect(sha(Buffer.from(guardBody(r.toString("utf8")), "utf8"))).toBe(REVIEWED_BODY);
    expect(r.toString("utf8")).toContain(REVIEWED_BODY); expect(r.toString("utf8")).toContain(VARIANT_BODY);
    expect(J[RESEAL_TAG]).toEqual({ kind: "release_transcription_variant_repaired", source: RESEAL, bytes: 16076,
      digest: "ee921a7b9043aa382c0da0cb3f7bbf8daa2e43e8ca3039593916010845d6c775", submittedBytes: 16075, finalLfRemoved: true,
      sha256: "d7938affaa0a63a930e82a534ca20e428e1245adfa3001439fbb04bace1110c0", function: "public.qbo_disconnect_operations_guard",
      substitutions: [{ line: 67, from: LINE_67_SOURCE, to: LINE_67_HOSTED }], reviewedBodyDigest: REVIEWED_BODY, variantBodyDigest: VARIANT_BODY, repairedBy: REPAIR });
  });

  it("the repair's two submission forms are its committed bytes; it is mirrored byte for byte as 0117 and nothing of the reseal is pending", () => {
    const s = src(REPAIR);
    expect(s[s.length - 1]).toBe(0x0a); expect(s.includes("\r\n")).toBe(false);
    expect(SUBMISSION_FORMS[REPAIR]).toEqual({ identical: { bytes: 6185, sha256: "6e7af318be84e3d58500d642a24e0a36d2a080c3fddf7f2aac7f4a19b37d9d69" },
      finalLfRemoved: { bytes: 6184, sha256: "55a0ccf244193dcc0d792805fe070ed84ce1392157f06aaf8350792d4d22015a" } });
    expect(SUBMISSION_FORMS[REPAIR]).toEqual({ identical: { bytes: s.length, sha256: sha(s) }, finalLfRemoved: { bytes: s.length - 1, sha256: sha(s.subarray(0, s.length - 1)) } });
    expect(submittedForm(REPAIR, s, s)).toBe("identical");
    expect(submittedForm(REPAIR, s, s.subarray(0, s.length - 1))).toBe("final_lf_removed");
    const r = checkMigrationAuthority(ROOT) as Result & { mirrored: { tag: string; source: string; how: string }[] };
    expect(r.errors).toEqual([]);
    expect(r.pending).toEqual(["20261231300000_qbo_realm_protection_cutover_redaction.sql"]); // 2026-11-22: Phase C v2 parts 1-3 applied as hosted 120-122 (mirrors 0119-0121, release_verbatim); only part 4 (the redaction) is pending. Before that: Phase C v2 (supersedes PR #282): the four cutover parts, authored, not applied; // 2026-11-20: the realm index-key rotation (20261230500000) applied byte for byte as hosted 119 (mirror 0118, release_verbatim); nothing is pending. 2026-11-20: the realm index-key rotation (20261230500000), authored, not applied
    expect(r.mirrored.filter((x) => x.source === REPAIR)).toEqual([{ tag: REPAIR_TAG, source: REPAIR, how: "release_verbatim" }]);
    const rm = mirror(REPAIR_TAG); expect([rm.length, sha(rm)]).toEqual([s.length, sha(s)]);   // hosted 118 = the committed file, final LF kept
    expect(J[REPAIR_TAG]).toEqual({ kind: "release_verbatim", source: REPAIR, bytes: 6185, digest: sha(s), sha256: sha(s) });
    // The realm index-key rotation (20261230500000): hosted 119 = the committed file byte for byte, final LF kept (mirror 0118).
    const ROT = "20261230500000_qbo_realm_index_rotation.sql", ROT_TAG = "0118_qbo_realm_index_rotation", rs = src(ROT), rot = mirror(ROT_TAG);
    expect([rs.length, sha(rs)]).toEqual([18452, "9d44bf0c73989b4bf5487ed3c864f66190c962e969fadf657cbe09eb3a6d20bf"]); expect([rot.length, sha(rot)]).toEqual([rs.length, sha(rs)]);
    expect(r.mirrored.filter((x) => x.source === ROT)).toEqual([{ tag: ROT_TAG, source: ROT, how: "release_verbatim" }]);
    expect(J[ROT_TAG]).toEqual({ kind: "release_verbatim", source: ROT, bytes: 18452, digest: sha(rs), sha256: sha(rs) });
    // Phase C v2 parts 1-3: hosted 120-122 = the committed files byte for byte, final LF kept (mirrors 0119-0121, 2026-11-22). Part 4 stays pending.
    for (const [name, tag, bytes, digest] of [
      ["20261231100000_qbo_realm_protection_cutover_schema.sql", "0119_qbo_realm_protection_cutover_schema", 16936, "599c851f209d0e5a4bbf782320139823a371750b89898afb6488dd5af6108966"],
      ["20261231200000_qbo_realm_protection_cutover_functions.sql", "0120_qbo_realm_protection_cutover_functions", 20450, "48295fcd5fae4ef3d368494a427d44f13ccd64157ce80f036732ca49e6fcf020"],
      ["20261231250000_qbo_realm_rotation_post_redaction.sql", "0121_qbo_realm_rotation_post_redaction", 15045, "ae14667cb7163c23d7123cd76d2f06e3b22e19ccd6624a64d144ec023ce40b89"],
    ] as const) {
      const cs = src(name), cm = mirror(tag);
      expect([cs.length, sha(cs)]).toEqual([bytes, digest]); expect([cm.length, sha(cm)]).toEqual([bytes, digest]);
      expect(r.mirrored.filter((x) => x.source === name)).toEqual([{ tag, source: name, how: "release_verbatim" }]);
      expect(J[tag]).toEqual({ kind: "release_verbatim", source: name, bytes, digest, sha256: digest });
    }
    expect(r.pending).toEqual(["20261231300000_qbo_realm_protection_cutover_redaction.sql"]);   // the redaction: not applied, its own explicit go
    expect(r.mirrored.filter((x) => x.source === RESEAL)).toEqual([{ tag: RESEAL_TAG, source: RESEAL, how: "release_transcription_variant_repaired" }]);
    expect(checkReleaseEntry(RESEAL_TAG, mirror(RESEAL_TAG).toString("utf8"), srcBytes).problems).toEqual([]);
  }, 120_000);

  describe("the transcription-variant entry accepts exactly the reviewed substitution, with the repair present, and nothing else", () => {
    const text = () => mirror(RESEAL_TAG).toString("utf8");
    const lines = () => text().split("\n");
    const problems = (t: string, patch: Record<string, unknown> = {}, bytes: (n: string) => Buffer | null = srcBytes) => {
      let out: string[] = [];
      withEntry(RESEAL_TAG, { sha256: sha(Buffer.from(t, "utf8")), submittedBytes: Buffer.byteLength(t), ...patch }, () => { out = checkReleaseEntry(RESEAL_TAG, t, bytes).problems; });
      return out.join("\n");
    };
    it("the source itself under this tag is refused, in either registered form: the reviewed line is not transcribed", () => {
      const s = src(RESEAL).toString("utf8");
      expect(problems(s)).toMatch(/final LF of .* was not removed/);
      expect(problems(s)).toMatch(/body of public.qbo_disconnect_operations_guard in the mirror is not the reviewed variant body digest/);
      expect(problems(s.slice(0, -1))).toMatch(/reviewed line 67 of the mirror is not the reviewed transcribed text/);
      expect(problems(s.slice(0, -1))).toMatch(/body of public\.qbo_disconnect_operations_guard in the mirror is not the reviewed variant body digest/);
    });
    it("a different change on the reviewed line is refused", () => {
      const l = lines(); l[66] = l[66].replace("IS DISTINCT FROM", "IS NOT DISTINCT FROM");
      expect(problems(l.join("\n"))).toMatch(/reviewed line 67 of the mirror is not the reviewed transcribed text/);
      const m = lines(); m[66] = ` ${m[66]}`;
      expect(problems(m.join("\n"))).toMatch(/reviewed line 67 of the mirror is not the reviewed transcribed text/);
    });
    it("a listed line whose source text is not exactly `from`, or a substitution that changes nothing or repeats a line, is refused", () => {
      expect(problems(text(), { substitutions: [{ line: 67, from: LINE_67_SOURCE.trim(), to: LINE_67_HOSTED }] })).toMatch(/reviewed line 67 of .* is not the reviewed source text/);
      expect(problems(text(), { substitutions: [{ line: 67, from: LINE_67_SOURCE, to: LINE_67_HOSTED.trim() }] })).toMatch(/reviewed line 67 of the mirror is not the reviewed transcribed text/);
      expect(problems(text(), { substitutions: [{ line: 67, from: LINE_67_HOSTED, to: LINE_67_HOSTED }] })).toMatch(/must name one distinct line and two different texts/);
      expect(problems(text(), { substitutions: [{ line: 67, from: LINE_67_SOURCE, to: LINE_67_HOSTED }, { line: 67, from: LINE_67_SOURCE, to: LINE_67_HOSTED }] })).toMatch(/must name one distinct line/);
    });
    it("any other changed line, even whitespace-only, is refused; so is a listed line outside the transcribed function's body", () => {
      const l = lines(); l[10] = ` ${l[10]}`;
      expect(problems(l.join("\n"))).toMatch(/line 11 differs from .* and is not a reviewed substitution/);
      const a = src(RESEAL).toString("utf8").split("\n");
      expect(problems(l.join("\n"), { substitutions: [{ line: 67, from: LINE_67_SOURCE, to: LINE_67_HOSTED }, { line: 11, from: a[10], to: ` ${a[10]}` }] }))
        .toMatch(/reviewed line 11 is outside the body of public\.qbo_disconnect_operations_guard/);
    });
    it("an added or removed line, or a final LF left in place, is refused", () => {
      expect(problems(`${text()}\n-- appended`)).toMatch(/lines/);
      const l = lines(); l.splice(5, 1);
      expect(problems(l.join("\n"))).toMatch(/lines/);
      expect(problems(`${text()}\n`)).toMatch(/final LF of .* was not removed/);
      expect(problems(text(), { finalLfRemoved: undefined })).toMatch(/must state whether its final LF was removed/);
    });
    it("an entry without listed substitutions, a wrong source digest or bytes, or a mirror other than pinned is refused", () => {
      expect(problems(text(), { substitutions: [] })).toMatch(/must list its reviewed line substitutions/);
      expect(problems(text(), { substitutions: [] })).toMatch(/line 67 differs from .* and is not a reviewed substitution/);
      expect(problems(text(), { digest: "0".repeat(64) })).toMatch(/pinned digest does not match/);
      expect(problems(text(), { bytes: 16075 })).toMatch(/pinned byte count 16075 does not match/);
      let out: string[] = [];
      withEntry(RESEAL_TAG, {}, () => { out = checkReleaseEntry(RESEAL_TAG, `${text()} `, srcBytes).problems; });
      expect(out.join("\n")).toMatch(/differs from its reviewed content/);
      expect(out.join("\n")).toMatch(/has 16076 bytes, expected 16075/);
    });
    it("wrong, equal or missing body digests, or no named function, are refused", () => {
      expect(problems(text(), { reviewedBodyDigest: "0".repeat(64) })).toMatch(/body of .* in .* is not the reviewed body digest/);
      expect(problems(text(), { variantBodyDigest: "0".repeat(64) })).toMatch(/in the mirror is not the reviewed variant body digest/);
      expect(problems(text(), { variantBodyDigest: REVIEWED_BODY })).toMatch(/must pin two different body digests/);
      expect(problems(text(), { function: undefined })).toMatch(/must name the function it transcribed/);
      expect(problems(text(), { function: "public.qbo_begin_disconnect" })).toMatch(/does not define public\.qbo_begin_disconnect exactly once/);
    });
    it("a repairing migration that does not exist, sorts first, or does not carry the reviewed body and both digests is refused", () => {
      expect(problems(text(), { repairedBy: "20261230420000_not_in_this_repository.sql" })).toMatch(/repairing migration 20261230420000_not_in_this_repository\.sql does not exist in this repository/);
      expect(problems(text(), { repairedBy: undefined })).toMatch(/does not exist in this repository/);
      const before = problems(text(), { repairedBy: NAMES[2] });
      expect(before).toMatch(/must sort after/); expect(before).toMatch(/does not install the reviewed body/); expect(before).toMatch(/does not name the reviewed body digest/);
      const fix = src(REPAIR).toString("utf8");
      const withRepair = (t: string) => (n: string) => (n === REPAIR ? Buffer.from(t, "utf8") : srcBytes(n));
      expect(problems(text(), {}, withRepair(fix.replace(LINE_67_SOURCE, LINE_67_HOSTED)))).toMatch(/does not install the reviewed body of public\.qbo_disconnect_operations_guard/);
      expect(problems(text(), {}, withRepair(fix.split(VARIANT_BODY).join("0".repeat(64))))).toMatch(/does not name the variant body digest/);
      expect(problems(text(), {}, withRepair(fix.split(REVIEWED_BODY).join("0".repeat(64))))).toMatch(/does not name the reviewed body digest/);
      expect(problems(text(), {}, withRepair(fix))).toBe("");
    });
    it("the same mirror is never accepted as a whitespace variant, nor without a reviewed entry", () => {
      const ws = { kind: "release_whitespace_variant", source: RESEAL, bytes: 16076, digest: "ee921a7b9043aa382c0da0cb3f7bbf8daa2e43e8ca3039593916010845d6c775", submittedBytes: 16075,
        variantLines: [67], sha256: "d7938affaa0a63a930e82a534ca20e428e1245adfa3001439fbb04bace1110c0" };
      let out: string[] = [];
      const saved = J[RESEAL_TAG]; J[RESEAL_TAG] = ws;
      try { out = checkReleaseEntry(RESEAL_TAG, text(), srcBytes).problems; } finally { J[RESEAL_TAG] = saved; }
      expect(out.join("\n")).toMatch(/lines|differs in more than its leading indentation/);
      delete J[RESEAL_TAG];
      try { out = checkReleaseEntry(RESEAL_TAG, text(), srcBytes).problems; } finally { J[RESEAL_TAG] = saved; }
      expect(out.join("\n")).toMatch(/has not been reviewed/);
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
