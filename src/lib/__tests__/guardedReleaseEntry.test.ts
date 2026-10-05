/**
 * OBSOLETE (2026-10-05): handoff r5 is void (see release/candidates/OBSOLETE.md); this keeps the parked texts exact.
 * The guarded release entries for 20261004100000 / 20261005100000 and their read-only inspection
 * (scripts/release/guardedEntry.mjs). Their behaviour under Lovable's stated hosted-executor contract — one invocation, one
 * transaction with its journal row; 0027 committed and 0028 failed; recovery; concurrency; lost responses — is proven by
 * scripts/db-proof/hostedExecutorRelease.mjs; repository compatibility with drizzle-orm migrate() by
 * scripts/db-proof/migratorRelease.mjs. This pins the exact texts and the release-journal check.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { RELEASE_2026_10, checkGuardedEntry, renderRelease } from "../../../scripts/release/guardedEntry.mjs";
import { TEMPLATES, checkGuardedReleaseEntry } from "../../../scripts/ci/releaseJournal.mjs";

const ROOT = path.resolve(__dirname, "../../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const sha256 = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
const srcBytes = (name: string) => (fs.existsSync(path.join(ROOT, "supabase/migrations", name)) ? fs.readFileSync(path.join(ROOT, "supabase/migrations", name)) : null);
const INSPECTION = "release/candidates/inspect_release_2026_10.sql";

describe("guarded release entries", () => {
  it("every committed release file is exactly its rendering", () => {
    for (const [rel, text] of Object.entries(renderRelease(ROOT))) expect(read(rel), rel).toBe(text);
  });

  for (const e of RELEASE_2026_10.entries) {
    const candidate = read(`release/candidates/${e.tag}.sql`);
    const source = read(`supabase/migrations/${e.source}`);

    it(`${e.tag}: the approved source is unchanged (${e.bytes} bytes, ${e.digest.slice(0, 8)}…)`, () => {
      expect(Buffer.byteLength(source)).toBe(e.bytes);
      expect(sha256(Buffer.from(source))).toBe(e.digest);
    });

    it(`${e.tag}: embeds the source byte for byte once; its journal hash differs from the source hash`, () => {
      expect(candidate.split(source)).toHaveLength(2);
      expect(sha256(Buffer.from(candidate))).not.toBe(e.digest);
      expect(checkGuardedEntry(candidate, { source: e.source, head: RELEASE_2026_10.head, repoRoot: ROOT, verify: e.verify, requires: e.requires })).toEqual([]);
    });

    it(`${e.tag}: a second application is refused, never a no-op; postconditions and the ledger record follow the source`, () => {
      const [guard, rest] = candidate.split(source);
      expect(guard).toContain("PERFORM pg_advisory_xact_lock(hashtextextended('cfoclose_release_ledger', 0));");
      expect(guard).toContain("source        text        PRIMARY KEY,");
      expect(guard).toContain(`RAISE EXCEPTION 'RELEASE_ALREADY_APPLIED: ${e.source} is already recorded; nothing was changed' USING ERRCODE = '55000';`);
      expect(guard).toContain("REVOKE ALL ON public._release_migration_ledger FROM PUBLIC, anon, authenticated, service_role;");
      expect(guard).not.toMatch(/\bRETURN\b/);
      expect(rest.indexOf("v.ok IS NOT TRUE")).toBeLessThan(rest.indexOf("INSERT INTO public._release_migration_ledger"));
      expect(rest).toContain(`VALUES ('${e.source}', '${e.digest}')`);
      expect(candidate).not.toContain("_pr34_migration_bodies");
    });

    it(`${e.tag}: the release-journal check accepts it exactly and rejects any change, a missing or wrong pin, and the noop wrapper`, () => {
      const entry = { kind: "release_guarded", source: e.source, bytes: e.bytes, digest: e.digest, head: RELEASE_2026_10.head, verify: e.verify, requires: e.requires, sha256: sha256(Buffer.from(candidate)) };
      expect(checkGuardedReleaseEntry(e.tag, entry, candidate, srcBytes).problems).toEqual([]);
      expect(checkGuardedReleaseEntry(e.tag, entry, candidate.replace("55000", "55001"), srcBytes).problems.length).toBeGreaterThan(0);
      expect(checkGuardedReleaseEntry(e.tag, { ...entry, sha256: undefined }, candidate, srcBytes).problems.length).toBeGreaterThan(0);
      expect(checkGuardedReleaseEntry(e.tag, { ...entry, sha256: "0".repeat(64) }, candidate, srcBytes).problems.length).toBeGreaterThan(0);
      expect(checkGuardedReleaseEntry(e.tag, { ...entry, requires: [] }, candidate, srcBytes).problems.length).toBe(e.requires.length ? 1 : 0);
      const noop = TEMPLATES.verbatim_noop_main({ name: e.source, digest: e.digest, head: RELEASE_2026_10.head });
      expect(checkGuardedReleaseEntry(e.tag, entry, noop, srcBytes).problems.length).toBeGreaterThan(0);
      expect(checkGuardedReleaseEntry(e.tag, { ...entry, bytes: e.bytes + 1 }, candidate, srcBytes).problems.length).toBeGreaterThan(0);
    });
  }

  it("0028 refuses unless 0027 is recorded with its exact digest; 0027 has no prerequisite", () => {
    const [e27, e28] = RELEASE_2026_10.entries;
    expect(e28.requires).toEqual([{ source: e27.source, digest: e27.digest }]);
    const g28 = read(`release/candidates/${e28.tag}.sql`).split(read(`supabase/migrations/${e28.source}`))[0];
    expect(g28).toContain(`IF NOT EXISTS (SELECT 1 FROM public._release_migration_ledger WHERE source = '${e27.source}' AND source_sha256 = '${e27.digest}') THEN`);
    expect(g28.indexOf("RELEASE_ALREADY_APPLIED")).toBeLessThan(g28.indexOf("RELEASE_PREREQUISITE_MISSING"));
    expect(read(`release/candidates/${e27.tag}.sql`)).not.toContain("RELEASE_PREREQUISITE_MISSING");
  });

  it("the inspection checks the exact ledger digests, the guarded-entry journal hashes, the bare source hashes and anchors on 0026", () => {
    const text = read(INSPECTION);
    const hosted0026 = sha256(Buffer.from(read(`drizzle/migrations/${RELEASE_2026_10.after}.sql`)));
    expect(hosted0026).toBe("704beb2d1c2cc3a1276633055cbf3fc049d26049db4ce60565130a4d550cf0f8");
    expect(text).toContain(hosted0026);
    for (const e of RELEASE_2026_10.entries) {
      expect(text).toContain(e.digest);
      expect(text).toContain(sha256(Buffer.from(read(`release/candidates/${e.tag}.sql`))));
      expect(text).toContain(e.probe);
    }
    expect(text).toContain("Run inside BEGIN READ ONLY");
    expect(text).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|REVOKE|TRUNCATE)\b/im);
  });

  it("r5 is OBSOLETE: its proofs are retired from CI and every r5 artifact says so (parked, never applied as it stands)", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).not.toMatch(/run: \S+ scripts\/db-proof\/(migratorRelease|hostedExecutorRelease)\.mjs/);
    for (const f of ["scripts/db-proof/hostedExecutorRelease.mjs", "scripts/db-proof/migratorRelease.mjs", "scripts/release/guardedEntry.mjs"]) {
      expect(read(f), f).toContain("OBSOLETE (2026-10-05)");
    }
    expect(read("release/candidates/OBSOLETE.md")).toMatch(/^# OBSOLETE/);
    // Hosted 0027 is the applied digest fix, not r5's entry.
    const journal = JSON.parse(read("drizzle/migrations/meta/_journal.json")) as { entries: { idx: number; tag: string }[] };
    expect(journal.entries.find((e) => e.idx === 27)?.tag).toBe("0027_account_review_digest_schema_qualification");
  });
});
