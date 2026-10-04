/**
 * The guarded native-migrator entries for 20261004100000 / 20261005100000 (scripts/release/guardedEntry.mjs). Their
 * behaviour through the real drizzle-orm migrate() — single run, retry, re-application, staggered and simultaneous runs,
 * payload and postcondition failure — is proven by scripts/db-proof/migratorRelease.mjs; this pins the exact texts and the
 * release-journal check.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { RELEASE_2026_10, checkGuardedEntry, renderGuardedEntry } from "../../../scripts/release/guardedEntry.mjs";
import { TEMPLATES, checkGuardedReleaseEntry } from "../../../scripts/ci/releaseJournal.mjs";

const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const sha256 = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
const srcBytes = (name: string) => (fs.existsSync(path.join(ROOT, "supabase/migrations", name)) ? fs.readFileSync(path.join(ROOT, "supabase/migrations", name)) : null);

describe("guarded release entries", () => {
  for (const e of RELEASE_2026_10.entries) {
    const candidate = read(`release/candidates/${e.tag}.sql`);
    const source = read(`supabase/migrations/${e.source}`);

    it(`${e.tag}: the approved source is unchanged (${e.bytes} bytes, ${e.digest.slice(0, 8)}…)`, () => {
      expect(Buffer.byteLength(source)).toBe(e.bytes);
      expect(sha256(Buffer.from(source))).toBe(e.digest);
    });

    it(`${e.tag}: the candidate is exactly the guarded rendering and embeds the source byte for byte once`, () => {
      expect(candidate).toBe(renderGuardedEntry({ source: e.source, sourceText: source, head: RELEASE_2026_10.head, verifyText: read(`scripts/db-preflight/${e.verify}`) }));
      expect(candidate.split(source)).toHaveLength(2);
      expect(checkGuardedEntry(candidate, { source: e.source, head: RELEASE_2026_10.head, repoRoot: ROOT, verify: e.verify })).toEqual([]);
    });

    it(`${e.tag}: a second application is refused, never a no-op; postconditions and the ledger record follow the source`, () => {
      const [guard, rest] = candidate.split(source);
      expect(guard).toContain("PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose_release_ledger', 0));");
      expect(guard).toContain(`RAISE EXCEPTION 'RELEASE_ALREADY_APPLIED: ${e.source} is already recorded; nothing was changed' USING ERRCODE = '55000';`);
      expect(guard).toContain("REVOKE ALL ON public._release_migration_ledger FROM PUBLIC, anon, authenticated, service_role;");
      expect(guard).not.toMatch(/\bRETURN\b/);
      expect(rest.indexOf("v.ok IS NOT TRUE")).toBeLessThan(rest.indexOf("INSERT INTO public._release_migration_ledger"));
      expect(rest).toContain(`VALUES ('${e.source}', '${e.digest}')`);
      expect(candidate).not.toContain("_pr34_migration_bodies");
    });

    it(`${e.tag}: the release-journal check accepts it exactly and rejects any change, including the noop wrapper`, () => {
      const entry = { kind: "release_guarded", source: e.source, bytes: e.bytes, digest: e.digest, head: RELEASE_2026_10.head, verify: e.verify, sha256: sha256(candidate) };
      expect(checkGuardedReleaseEntry(e.tag, entry, candidate, srcBytes).problems).toEqual([]);
      expect(checkGuardedReleaseEntry(e.tag, entry, candidate.replace("55000", "55001"), srcBytes).problems.length).toBeGreaterThan(0);
      const noop = TEMPLATES.verbatim_noop_main({ name: e.source, digest: e.digest, head: RELEASE_2026_10.head });
      expect(checkGuardedReleaseEntry(e.tag, entry, noop, srcBytes).problems.length).toBeGreaterThan(0);
      expect(checkGuardedReleaseEntry(e.tag, { ...entry, bytes: e.bytes + 1 }, candidate, srcBytes).problems.length).toBeGreaterThan(0);
    });
  }

  it("the proof runs in CI through the real migrator", () => {
    expect(read(".github/workflows/ci.yml")).toContain("run: node scripts/db-proof/migratorRelease.mjs");
  });
});
