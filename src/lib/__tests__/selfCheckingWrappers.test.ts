/**
 * The seven self-checking release wrappers (release/wrappers/, scripts/release/selfCheckingWrapper.mjs) are registered
 * submission forms of their source migrations: exactly render(source) or that text minus its single final LF — nothing
 * else, not even a wrapper that is internally consistent over different bytes. Their behaviour on real PostgreSQL
 * (refusal before any statement, atomic rollback, journal atomicity under drizzle-orm migrate()) is proven by
 * scripts/db-proof/selfCheckingWrappers.mjs.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RELEASE_JOURNAL, SUBMISSION_FORMS, checkReleaseEntry, submittedForm } from "../../../scripts/ci/releaseJournal.mjs";
import { checkMigrationAuthority } from "../../../scripts/ci/assertMigrationAuthority.mjs";
import { lexSql } from "../../../scripts/ci/atomicEnvelope.mjs";
import { RELEASE_BATCHES, REPORTING_SOURCE_COMMIT, REPORTING_WRAPPED_SOURCES, SOURCE_COMMIT, WRAPPED_SOURCES, enclosedPayload, render, wrapperFile } from "../../../scripts/release/selfCheckingWrapper.mjs";

// Every registered wrapper, both batches (the applied milestone, then the reporting release).
const ALL_WRAPPED = RELEASE_BATCHES.flatMap((b) => b.sources);

const ROOT = path.join(__dirname, "../../..");
const SRC = path.join(ROOT, "supabase/migrations");
const DZ = path.join(ROOT, "drizzle/migrations");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const src = (name: string) => fs.readFileSync(path.join(SRC, name));
const wrapper = (name: string) => fs.readFileSync(path.join(ROOT, wrapperFile(name)));
type Result = { ok: boolean; errors: string[]; pending: string[]; mirrored: Array<{ tag: string; source: string; how: string }> };

describe("self-checking wrappers: generated from the sources, registered exactly", () => {
  it("wraps exactly the seven pending milestone sources, at main 993774c, in release order", () => {
    expect(SOURCE_COMMIT).toBe("993774cd129a4bfd16946f6be1c339aaf93ac5d4");
    expect([...ALL_WRAPPED]).toEqual(Object.keys(SUBMISSION_FORMS).filter((k) => (SUBMISSION_FORMS as Record<string, { wrapper?: unknown }>)[k].wrapper));
    expect(fs.readdirSync(path.join(ROOT, "release/wrappers")).sort()).toEqual([...ALL_WRAPPED.map((s) => path.basename(wrapperFile(s))), "contract_probe.sql"].sort());
  });
  it("wraps exactly the five reporting sources, at the commit holding their final reviewed bytes, in release order", () => {
    expect(REPORTING_SOURCE_COMMIT).toBe("902a05763be23ef9b3ee762ae92401c0e32ddd84");
    expect([...REPORTING_WRAPPED_SOURCES]).toEqual(["20261018100000_fs_statement_composition.sql", "20261019100000_fs_notes_and_schedules.sql",
      "20261020100000_fs_comparatives.sql", "20261021100000_fs_signoff_binding.sql", "20261022100000_fs_reporting_closure.sql"]);
    for (const n of REPORTING_WRAPPED_SOURCES) expect(wrapper(n).toString("utf8")).toContain(`exactly as committed at ${REPORTING_SOURCE_COMMIT}:`);
    for (const n of WRAPPED_SOURCES) expect(wrapper(n).toString("utf8")).toContain(`exactly as committed at ${SOURCE_COMMIT}:`);
  });
  for (const name of ALL_WRAPPED) {
    it(`${name}: the file is render() of the source; it encloses those bytes; both forms are pinned (recomputed here)`, () => {
      const s = src(name), w = wrapper(name);
      expect(w.equals(Buffer.from(render(name, s), "utf8"))).toBe(true);
      expect(enclosedPayload(w.toString("utf8"))!.equals(s)).toBe(true);
      const f = (SUBMISSION_FORMS as Record<string, Record<string, { bytes: number; sha256: string }>>)[name];
      expect(f.identical).toEqual({ bytes: s.length, sha256: sha(s) }); // the enclosed source identity, unchanged
      expect(f.wrapper).toEqual({ bytes: w.length, sha256: sha(w) });
      expect(f.wrapperFinalLfRemoved).toEqual({ bytes: w.length - 1, sha256: sha(w.subarray(0, w.length - 1)) });
      // The pinned identity inside the wrapper is the source's own.
      expect(w.toString("utf8")).toContain(`c_bytes   CONSTANT integer := ${s.length};`);
      expect(w.toString("utf8")).toContain(`c_sha256  CONSTANT text    := '${sha(s)}';`);
      expect(w.includes(0x0d)).toBe(false);
      expect(w.toString("utf8")).not.toContain("--> statement-breakpoint"); // drizzle-orm splits only there
    });
    it(`${name}: ONE top-level statement; the check precedes the single EXECUTE of the payload; nothing else runs`, () => {
      const code = (t: string) => lexSql(t).filter((x: { type: string }) => x.type !== "ws" && x.type !== "comment");
      const top = code(wrapper(name).toString("utf8"));
      expect(top.map((x: { type: string; text: string }) => (x.type === "dollar" ? "$" : x.text.toUpperCase()))).toEqual(["DO", "$", ";"]);
      const body = code(top[1].body);
      const words = body.filter((x: { type: string }) => x.type === "word").map((x: { text: string }) => x.text.toUpperCase());
      expect(words.filter((x: string) => x === "EXECUTE")).toHaveLength(1);
      expect(words[words.indexOf("EXECUTE") + 1]).toBe("C_PAYLOAD");
      expect(words.indexOf("RAISE")).toBeGreaterThan(-1);
      expect(words.indexOf("RAISE")).toBeLessThan(words.indexOf("EXECUTE"));
      for (const w of ["INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "GRANT", "REVOKE", "COMMIT", "ROLLBACK", "PERFORM"]) expect(words, w).not.toContain(w);
      expect(body.filter((x: { type: string }) => x.type === "dollar")).toHaveLength(1); // the payload literal, nothing else quoted
    });
    it(`${name}: submittedForm accepts the two registered wrapper forms and nothing else; the source's own forms are unchanged`, () => {
      const s = src(name), w = wrapper(name), text = w.toString("utf8");
      expect(submittedForm(name, s, s)).toBe("identical");
      expect(submittedForm(name, s, s.subarray(0, s.length - 1))).toBe("final_lf_removed");
      expect(submittedForm(name, s, w)).toBe("wrapper");
      expect(submittedForm(name, s, w.subarray(0, w.length - 1))).toBe("wrapper_final_lf_removed");
      const other = WRAPPED_SOURCES[(WRAPPED_SOURCES.indexOf(name) + 1) % WRAPPED_SOURCES.length];
      const flipped = Buffer.from(s); flipped[Math.floor(s.length / 2)] ^= 0x01;
      const rejected: [string, Buffer][] = [
        ["two final bytes removed", w.subarray(0, w.length - 2)],
        ["an extra final LF", Buffer.concat([w, Buffer.from("\n")])],
        ["CRLF line endings", Buffer.from(text.replace(/\n/g, "\r\n"), "utf8")],
        ["a byte-order mark", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), w])],
        ["the header comment edited", Buffer.from(text.replace("do not edit", "do not change"), "utf8")],
        ["the expected SHA-256 edited", Buffer.from(text.replace(sha(s), "0".repeat(64)), "utf8")],
        ["one payload byte changed", (() => { const b = Buffer.from(w); b[enclosedPayloadOffset(text) + 10] ^= 0x01; return b; })()],
        // Internally consistent (it would pass its own check in PostgreSQL) — but over different bytes: refused.
        ["a self-consistent wrapper over altered source bytes", Buffer.from(render(name, flipped), "utf8")],
        ["another source's wrapper", wrapper(other)],
        ["empty text", Buffer.alloc(0)],
      ];
      for (const [label, bad] of rejected) expect(submittedForm(name, s, bad), label).toBeNull();
      // A changed source no longer matches its registration: not even its freshly rendered wrapper is accepted.
      const changed = Buffer.concat([s, Buffer.from("-- note\n")]);
      expect(submittedForm(name, changed, Buffer.from(render(name, changed), "utf8"))).toBeNull();
    });
  }
  it("the release procedure lists every wrapper with both registered forms, and executes through them", () => {
    const doc = fs.readFileSync(path.join(ROOT, "docs/release/MILESTONE_I1B_SIGNOFF_RELEASE.md"), "utf8");
    WRAPPED_SOURCES.forEach((name, i) => {
      const w = wrapper(name), l = w.subarray(0, w.length - 1);
      expect(doc, name).toContain(`| ${i + 1} | \`${wrapperFile(name)}\` | ${w.length} · \`${sha(w)}\` | ${l.length} · \`${sha(l)}\` |`);
    });
    expect(doc).toContain("release/wrappers/contract_probe.sql");
    expect(doc).toContain("SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC, id DESC LIMIT 3;");
  });
  it("render() refuses a payload it cannot enclose safely", () => {
    const n = WRAPPED_SOURCES[0];
    for (const bad of ["x\r\ny\n", "﻿SELECT 1;\n", "SELECT 1;\n--> statement-breakpoint\nSELECT 2;\n", "SELECT $cfoclose_x$;\n"]) {
      expect(() => render(n, Buffer.from(bad, "utf8")), JSON.stringify(bad)).toThrow();
    }
    expect(() => render("not-a-migration.sql", Buffer.from("SELECT 1;\n"))).toThrow();
  });
  it("the contract probe is one DO statement that only raises", () => {
    const t = fs.readFileSync(path.join(ROOT, "release/wrappers/contract_probe.sql"), "utf8");
    const code = (x: string) => lexSql(x).filter((k: { type: string }) => k.type !== "ws" && k.type !== "comment");
    const top = code(t);
    expect(top.map((x: { type: string; text: string }) => (x.type === "dollar" ? "$" : x.text.toUpperCase()))).toEqual(["DO", "$", ";"]);
    const words = code(top[1].body).filter((x: { type: string }) => x.type === "word").map((x: { text: string }) => x.text.toUpperCase());
    expect(words).toEqual(["BEGIN", "RAISE", "EXCEPTION", "USING", "ERRCODE", "END"]);
  });
});

function enclosedPayloadOffset(text: string): number {
  const m = /\$cfoclose_payload_[0-9a-f]{16}\$/.exec(text)!;
  return Buffer.byteLength(text.slice(0, m.index + m[0].length), "utf8");
}

describe("close-out: a hosted mirror of a wrapper is accepted only through a reviewed release_self_checking_wrapper entry", () => {
  const name = WRAPPED_SOURCES[0];
  const tag = "0033_release_wrapper_probe";
  const withMirror = (body: Buffer, fn: (dir: string) => void) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-mirror-"));
    let restore = () => {};
    try {
      fs.cpSync(SRC, path.join(dir, "supabase/migrations"), { recursive: true });
      fs.cpSync(path.join(ROOT, "drizzle"), path.join(dir, "drizzle"), { recursive: true });
      const jf = path.join(dir, "drizzle/migrations/meta/_journal.json");
      const j = JSON.parse(fs.readFileSync(jf, "utf8"));
      // The repository as it was before the hosted application (journal head 0032): the real mirrors 0033–0039 removed.
      for (const e of j.entries.filter((x: { idx: number }) => x.idx > 32)) {
        fs.rmSync(path.join(dir, `drizzle/migrations/${e.tag}.sql`));
        fs.rmSync(path.join(dir, `drizzle/migrations/meta/${String(e.idx).padStart(4, "0")}_snapshot.json`));
      }
      j.entries = j.entries.filter((x: { idx: number }) => x.idx <= 32);
      // ...and their reviewed entries hidden for the duration (restored below), as before the close-out.
      const hidden = Object.entries(RELEASE_JOURNAL).filter(([k, e]) => k !== tag && (e as { kind: string }).kind === "release_self_checking_wrapper");
      for (const [k] of hidden) delete (RELEASE_JOURNAL as Record<string, unknown>)[k];
      restore = () => { for (const [k, e] of hidden) (RELEASE_JOURNAL as Record<string, unknown>)[k] = e; };
      const idx = j.entries.length;
      j.entries.push({ ...j.entries[idx - 1], idx, tag });
      fs.writeFileSync(jf, JSON.stringify(j, null, 2));
      fs.writeFileSync(path.join(dir, `drizzle/migrations/${tag}.sql`), body);
      fs.copyFileSync(path.join(dir, `drizzle/migrations/meta/${String(idx - 1).padStart(4, "0")}_snapshot.json`), path.join(dir, `drizzle/migrations/meta/${String(idx).padStart(4, "0")}_snapshot.json`));
      fn(dir);
    } finally { restore(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
  const entryFor = (form: "wrapper" | "wrapper_final_lf_removed") => {
    const s = src(name), w = wrapper(name), m = form === "wrapper" ? w : w.subarray(0, w.length - 1);
    return { m, entry: { kind: "release_self_checking_wrapper", source: name, bytes: s.length, digest: sha(s), form, submittedBytes: m.length, sha256: sha(m) } };
  };
  const J = RELEASE_JOURNAL as Record<string, unknown>;

  for (const form of ["wrapper", "wrapper_final_lf_removed"] as const) {
    it(`a reviewed entry (${form}) accepts exactly that mirror: covered, no longer pending`, () => {
      const { m, entry } = entryFor(form);
      J[tag] = entry;
      try {
        expect(checkReleaseEntry(tag, m.toString("utf8"), (n: string) => (fs.existsSync(path.join(SRC, n)) ? src(n) : null)).problems).toEqual([]);
        withMirror(m, (dir) => {
          const r = checkMigrationAuthority(dir) as Result;
          expect(r.errors).toEqual([]);
          expect(r.mirrored).toContainEqual({ tag, source: name, how: "release_self_checking_wrapper" });
          expect(r.pending).not.toContain(name);
        });
      } finally { delete J[tag]; }
    }, 120_000);
  }
  it("the reviewed entry refuses any other mirror text: the other form, an edited wrapper, a self-consistent wrapper over other bytes", () => {
    const { entry } = entryFor("wrapper");
    J[tag] = entry;
    try {
      const s = src(name), w = wrapper(name);
      const flipped = Buffer.from(s); flipped[100] ^= 0x01;
      for (const bad of [w.subarray(0, w.length - 1), Buffer.from(w.toString("utf8").replace("do not edit", "do not change")), Buffer.from(render(name, flipped), "utf8"), s]) {
        expect(checkReleaseEntry(tag, bad.toString("utf8"), (n: string) => (fs.existsSync(path.join(SRC, n)) ? src(n) : null)).problems.length).toBeGreaterThan(0);
      }
    } finally { delete J[tag]; }
  });
  it("without a reviewed entry, a mirror of the exact wrapper is not accepted (and the source stays pending)", () => {
    withMirror(wrapper(name), (dir) => {
      const r = checkMigrationAuthority(dir) as Result;
      expect(r.ok).toBe(false);
      expect(r.errors.some((e) => e.includes(tag))).toBe(true);
      expect(r.mirrored.some((x) => x.tag === tag)).toBe(false);
    });
  }, 120_000);
  it("the repository: both batches applied (0033–0039, then 0040–0044), each through a reviewed entry pinning the exact registered wrapper form", () => {
    const entries = Object.entries(RELEASE_JOURNAL).filter(([, e]) => (e as { kind: string }).kind === "release_self_checking_wrapper");
    expect(entries.map(([, e]) => (e as { source: string }).source)).toEqual([...ALL_WRAPPED]);
    // The applied milestone was submitted byte for byte; the reporting release's 0043–0044 with exactly the final LF removed.
    const FINAL_LF_REMOVED = new Set(["0043_r1_w4_fs_signoff_binding", "0044_r1_w5_fs_reporting_closure"]);
    for (const [tag, e] of entries) {
      const x = e as { source: string; form: string; sha256: string; submittedBytes: number };
      const mirror = fs.readFileSync(path.join(DZ, `${tag}.sql`));
      const w = wrapper(x.source);
      expect(x.form, tag).toBe(FINAL_LF_REMOVED.has(tag) ? "wrapper_final_lf_removed" : "wrapper");
      expect(mirror.equals(FINAL_LF_REMOVED.has(tag) ? w.subarray(0, w.length - 1) : w), tag).toBe(true); // a registered form of release/wrappers/
      expect([mirror.length, sha(mirror)], tag).toEqual([x.submittedBytes, x.sha256]);
    }
    const r = checkMigrationAuthority(ROOT) as Result;
    expect(r.errors).toEqual([]);
    for (const s of ALL_WRAPPED) expect(r.pending, s).not.toContain(s);
  }, 120_000);
});
