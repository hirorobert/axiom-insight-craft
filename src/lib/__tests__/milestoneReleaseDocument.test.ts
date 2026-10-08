// The milestone release procedure (docs/release/MILESTONE_I1B_SIGNOFF_RELEASE.md) states identities a person will
// compare against the hosted project. Every one of them is recomputed here from the repository, so the document cannot
// drift from the registered submission forms, the migration sources or the function closures it names.
import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SUBMISSION_FORMS } from "../../../scripts/ci/releaseJournal.mjs";
import { functionManifest } from "../../../scripts/release/functionClosure.mjs";

const ROOT = path.resolve(__dirname, "../../..");
const DOC = fs.readFileSync(path.join(ROOT, "docs/release/MILESTONE_I1B_SIGNOFF_RELEASE.md"), "utf8");
// The same list the release-order proof applies (scripts/db-proof/milestoneReleaseOrder.mjs runs on import, so it is
// pinned here and compared with the proof's source text instead).
const RELEASE_MIGRATIONS = [
  "20261011100000_two_period_shared_source.sql",
  "20261012100000_layout_assist_controls.sql",
  "20261013100000_close_review_timeline.sql",
  "20261014100000_close_review_findings.sql",
  "20261015100000_close_review_adjustments.sql",
  "20261016100000_fs_reporting_input.sql",
  "20261017100000_signoff_completion_requirements.sql",
];
const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

describe("the milestone release procedure states exactly the repository's identities", () => {
  it("lists the seven migrations in release order with both registered forms, recomputed from the sources", () => {
    const rows = [...DOC.matchAll(/^\| (\d) \| `(\d{14}_[a-z0-9_]+\.sql)` \| (\d+) · `([0-9a-f]{64})` \| (\d+) · `([0-9a-f]{64})` \|$/gm)];
    expect(rows.map((r) => r[2])).toEqual(RELEASE_MIGRATIONS);
    for (const [, n, name, bytes, canonical, lfBytes, lfSha] of rows) {
      const src = fs.readFileSync(path.join(ROOT, "supabase/migrations", name));
      expect(Number(n)).toBe(RELEASE_MIGRATIONS.indexOf(name) + 1);
      expect([Number(bytes), canonical]).toEqual([src.length, sha(src)]);
      expect([Number(lfBytes), lfSha]).toEqual([src.length - 1, sha(src.subarray(0, src.length - 1))]);
      expect(SUBMISSION_FORMS[name]).toMatchObject({ identical: { bytes: src.length, sha256: canonical }, finalLfRemoved: { bytes: src.length - 1, sha256: lfSha } });
    }
  });
  it("the seven are exactly the newest source migrations", () => {
    const proof = fs.readFileSync(path.join(ROOT, "scripts/db-proof/milestoneReleaseOrder.mjs"), "utf8");
    for (const m of RELEASE_MIGRATIONS) expect(proof, m).toContain(`"${m}",`);
    const all = fs.readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort();
    expect(all.slice(-RELEASE_MIGRATIONS.length)).toEqual(RELEASE_MIGRATIONS);
  });
  it("states the source closure digests of the two functions it names", () => {
    for (const fn of ["trial-balance-storage-cleanup", "layout-assist"]) {
      const m = functionManifest(fn);
      expect(DOC, fn).toContain(`\`${m.closureSha256}\``);
      for (const r of m.remote) expect(DOC, `${fn} ${r}`).toContain(r.replace(/^https:\/\//, ""));
    }
    const sc = functionManifest("trial-balance-storage-cleanup");
    for (const f of sc.files) expect(DOC).toContain(`${f.sha256.slice(0, 8)}…${f.sha256.slice(-4)}\` (${f.size} B`);
  });
  it("keeps every gate off and states exactly the recorded hosted state", () => {
    expect(DOC).toContain("**Status: APPLIED (hosted journal ids 34–40, mirrors 0033–0039, 2026-10-08) through the self-checking wrappers; functions\nNOT redeployed; frontend NOT published; every gate off.**");
    expect(DOC).toContain("I1B_SIGNOFF_CLOSEOUT_d25888e.md");
    expect(DOC).toContain("cross-workspace refusal not yet observed");
    expect(DOC).toContain("live processing message not yet observed");
    // (The financial-statements workspace gate is pinned off by workspaceGate.test.ts, which also restricts where its
    // name may appear, so it is not repeated here.)
    for (const gate of ["TWO_PERIOD_INTAKE_ENABLED", "LAYOUT_ASSIST_ENABLED"]) {
      const file = { TWO_PERIOD_INTAKE_ENABLED: "src/lib/workspace/twoPeriodIntake.ts", LAYOUT_ASSIST_ENABLED: "src/lib/workbench/intake/layoutAssistClient.ts" }[gate]!;
      expect(fs.readFileSync(path.join(ROOT, file), "utf8"), gate).toMatch(new RegExp(`^export const ${gate} = false;$`, "m"));
    }
  });
});
