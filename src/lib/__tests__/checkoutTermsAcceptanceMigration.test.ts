/**
 * PR #266 (commercial accuracy and refunds) carries ONE migration, 20261229100000_checkout_terms_acceptance.sql. It was applied on
 * 2026-11-17 by Lovable's native migrator as hosted journal id 113 in its pre-registered FINAL-LF-REMOVED form (11,994 B,
 * a8be47af…), mirrored as drizzle 0112_checkout_terms_acceptance and accepted through exactly one reviewed RELEASE_JOURNAL entry.
 * These tests pin that identity and prove the guard still refuses a mirror whose bytes differ from a registered form, and still
 * tells an UNKNOWN or UNREGISTERED source apart from the registered one.
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

type Result = { ok: boolean; errors: string[]; pending: string[]; mirrored: { tag: string; source: string; how?: string }[] };
const ROOT = path.join(__dirname, "../../..");
const NAME = "20261229100000_checkout_terms_acceptance.sql";
const TAG = "0112_checkout_terms_acceptance";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const src = () => fs.readFileSync(path.join(ROOT, "supabase/migrations", NAME));
const mirror = () => fs.readFileSync(path.join(ROOT, "drizzle/migrations", `${TAG}.sql`));

function copyRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkout-terms-migration-"));
  for (const d of ["supabase/migrations", "drizzle/migrations", "drizzle/migrations/meta"]) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, d))) {
      const p = path.join(ROOT, d, f);
      if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(dir, d, f));
    }
  }
  return dir;
}
const run = (mutate: (dir: string) => void): Result => {
  const dir = copyRepo();
  try { mutate(dir); return checkMigrationAuthority(dir) as Result; } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

describe("checkout terms acceptance migration (PR #266): applied as hosted 113 through one reviewed entry", () => {
  it("the source, its two registered forms, the mirror and the reviewed entry agree byte for byte", () => {
    const s = src();
    expect(s[s.length - 1]).toBe(0x0a);
    expect(s.includes("\r\n")).toBe(false);
    expect(SUBMISSION_FORMS[NAME]).toEqual({
      identical: { bytes: s.length, sha256: sha(s) },
      finalLfRemoved: { bytes: s.length - 1, sha256: sha(s.subarray(0, s.length - 1)) },
    });
    expect(SUBMISSION_FORMS[NAME].identical).toEqual({ bytes: 11995, sha256: "f541d4d18bac1c4103e57e3e2dc5c36b47ba411793f8555cacfdbb96e693b027" });
    const m = mirror();
    expect([m.length, sha(m)]).toEqual([11994, "a8be47afa5d8b28363b66ee1f932dff84e7038ac1f063549f4b10d2d7d203256"]); // = the hosted journal hash of id 113
    expect(submittedForm(NAME, s, m)).toBe("final_lf_removed");
    expect(Object.keys(RELEASE_JOURNAL).filter((k) => /checkout_terms/.test(k))).toEqual([TAG]);
    expect(RELEASE_JOURNAL[TAG]).toEqual({
      kind: "release_verbatim_final_lf_removed", source: NAME, bytes: 11995,
      digest: "f541d4d18bac1c4103e57e3e2dc5c36b47ba411793f8555cacfdbb96e693b027",
      submittedBytes: 11994, sha256: "a8be47afa5d8b28363b66ee1f932dff84e7038ac1f063549f4b10d2d7d203256",
    });
  });

  it("the repository is in parity with nothing pending: 0112 mirrors the source through its reviewed entry", () => {
    const r = checkMigrationAuthority(ROOT) as Result;
    expect(r.errors).toEqual([]);
    expect(r.pending).toEqual([]);
    expect(r.mirrored.find((x) => x.tag === TAG)).toMatchObject({ source: NAME, how: "release_verbatim_final_lf_removed" });
  }, 120_000);

  it("a mirror whose bytes differ from both registered forms is refused, even under the reviewed tag", () => {
    for (const body of [Buffer.concat([mirror(), Buffer.from("\n-- altered\n")]), mirror().subarray(0, mirror().length - 1)]) {
      const r = run((d) => fs.writeFileSync(path.join(d, "drizzle/migrations", `${TAG}.sql`), body));
      expect(r.errors.length).toBeGreaterThan(0);
    }
  }, 240_000);

  it("an unknown source is pending but UNREGISTERED: it has no submission forms, and the pinned digest refuses any byte change", () => {
    const s = src();
    const altered = Buffer.concat([s, Buffer.from("-- altered\n")]);
    expect(SUBMISSION_FORMS["20261230100000_unregistered_commercial_change.sql"]).toBeUndefined();
    expect(submittedForm("20261230100000_unregistered_commercial_change.sql", altered, altered)).toBeNull();
    expect(submittedForm(NAME, altered, altered)).toBeNull();
    const r = run((d) => fs.writeFileSync(path.join(d, "supabase/migrations/20261230100000_unregistered_commercial_change.sql"), altered));
    expect(r.errors).toEqual([]);
    expect(r.pending).toEqual(["20261230100000_unregistered_commercial_change.sql"]);
    expect(Object.keys(SUBMISSION_FORMS)).not.toContain("20261230100000_unregistered_commercial_change.sql");
  }, 120_000);
});
