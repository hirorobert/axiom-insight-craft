/**
 * PR #266 (commercial accuracy and refunds) carries ONE migration, 20261229100000_checkout_terms_acceptance.sql, which is authored
 * and NOT applied: the hosted journal stays at 112 (the consolidated release, 2026-11-15) until the commercial migration is separately
 * authorized and applied. These tests pin its approved submission identity and prove the guard tells an AUTHORIZED PENDING migration
 * (registered forms, exact bytes, reported pending, never mirrored by normalised parity) apart from an UNKNOWN or UNREGISTERED one.
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
const NAME = "20261229100000_checkout_terms_acceptance.sql";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const src = () => fs.readFileSync(path.join(ROOT, "supabase/migrations", NAME));

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
const addMirror = (dir: string, tag: string, body: Buffer) => {
  const jp = path.join(dir, "drizzle/migrations/meta/_journal.json");
  const j = JSON.parse(fs.readFileSync(jp, "utf8")) as { entries: { idx: number; when: number }[] };
  const idx = j.entries.length;
  fs.writeFileSync(path.join(dir, "drizzle/migrations", `${tag}.sql`), body);
  fs.writeFileSync(path.join(dir, "drizzle/migrations/meta", `${String(idx).padStart(4, "0")}_snapshot.json`), "{}");
  j.entries.push({ ...j.entries[idx - 1], idx, when: j.entries[idx - 1].when + 1000, tag } as never);
  fs.writeFileSync(jp, JSON.stringify(j));
};

describe("checkout terms acceptance migration (PR #266): authorized, pending, not applied", () => {
  it("registers exactly the committed bytes as its two submission forms (LF blob; no wrapper), and nothing of it is a reviewed release entry", () => {
    const s = src();
    expect(s[s.length - 1]).toBe(0x0a);
    expect(s.includes("\r\n")).toBe(false);
    expect(SUBMISSION_FORMS[NAME]).toEqual({
      identical: { bytes: s.length, sha256: sha(s) },
      finalLfRemoved: { bytes: s.length - 1, sha256: sha(s.subarray(0, s.length - 1)) },
    });
    expect(SUBMISSION_FORMS[NAME].identical).toEqual({ bytes: 11995, sha256: "f541d4d18bac1c4103e57e3e2dc5c36b47ba411793f8555cacfdbb96e693b027" });
    expect(submittedForm(NAME, s, s)).toBe("identical");
    expect(submittedForm(NAME, s, s.subarray(0, s.length - 1))).toBe("final_lf_removed");
    expect(submittedForm(NAME, s, Buffer.concat([s, Buffer.from("\n")]))).toBeNull();
    expect(Object.keys(RELEASE_JOURNAL).filter((k) => /checkout_terms/.test(k))).toEqual([]); // no applied mirror, no receipt — nothing is fabricated
  });

  it("the repository reports it as the ONLY pending migration: the hosted journal (112) is complete and unchanged, no error", () => {
    const r = checkMigrationAuthority(ROOT) as Result;
    expect(r.errors).toEqual([]);
    expect(r.pending).toEqual([NAME]);
    expect(r.mirrored.some((m) => m.source === NAME)).toBe(false);
  }, 120_000);

  it("a Lovable mirror of the registered migration WITHOUT a reviewed release entry is refused (rule 9), byte for byte or final-LF-removed", () => {
    const s = src();
    for (const [tag, body] of [["0112_checkout_terms_acceptance", s], ["0112_checkout_terms_acceptance", s.subarray(0, s.length - 1)]] as const) {
      const r = run((d) => addMirror(d, tag, body));
      expect(r.errors.join("\n")).toMatch(/0112_checkout_terms_acceptance mirrors 20261229100000_checkout_terms_acceptance\.sql, which is accepted only through a reviewed RELEASE_JOURNAL entry/);
    }
  }, 240_000);

  it("an unknown source is pending but UNREGISTERED: it has no submission forms, and the pinned digest refuses any byte change to the authorized one", () => {
    const s = src();
    const altered = Buffer.concat([s, Buffer.from("-- altered\n")]);
    expect(SUBMISSION_FORMS["20261230100000_unregistered_commercial_change.sql"]).toBeUndefined();
    expect(submittedForm("20261230100000_unregistered_commercial_change.sql", altered, altered)).toBeNull();
    expect(submittedForm(NAME, altered, altered)).toBeNull(); // the registered digest does not match altered source bytes
    const r = run((d) => fs.writeFileSync(path.join(d, "supabase/migrations/20261230100000_unregistered_commercial_change.sql"), altered));
    expect(r.errors).toEqual([]);
    expect(r.pending).toEqual([NAME, "20261230100000_unregistered_commercial_change.sql"]);
    expect(Object.keys(SUBMISSION_FORMS)).toContain(NAME);
    expect(Object.keys(SUBMISSION_FORMS)).not.toContain("20261230100000_unregistered_commercial_change.sql");
  }, 120_000);
});
