import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RELEASE_JOURNAL, checkReleaseEntry } from "../../../scripts/ci/releaseJournal.mjs";
import {
  HOSTED_ENTRY_97_VARIANT,
  checkHostedEntry97Variant,
  checkTransportMirror,
  renderApply,
  renderHostedEntry97Variant,
} from "../../../scripts/release/ipsasStatementReviewStagedTransport.mjs";

const ROOT = process.cwd();
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const mirror = (tag: string) => fs.readFileSync(path.join(ROOT, "drizzle/migrations", `${tag}.sql`));
const srcBytes = (name: string) => {
  const p = path.join(ROOT, "supabase/migrations", name);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
};

// The hosted journal hashes reported by the installing agent after the owner-directed install of 2026-10-31 (hosted ids 93–97).
// Hosted id 92 (the preparation bootstrap) was recorded by the same agent but its hash was not part of that report.
const HOSTED_JOURNAL: readonly (readonly [string, string])[] = [
  ["0092_ipsas_1_preparation_staged_apply", "108c034845c17fa9915f1328d7840c2cd7cf6338d4bd169b0a1df1254369b1a0"],
  ["0093_ipsas_grants_staged_transport", "4d84ab9d3356aaa7c090359070c665fe39e518143739ad7e8de8c562d179bacf"],
  ["0094_ipsas_2_grants_staged_apply", "00a3279500b3417bde407be27e97d2b25b1c98bbc09fa6ce996d2e97d537995d"],
  ["0095_ipsas_statement_review_staged_transport", "0f436114cb2e2fc0a2669a5293b689718f87932c0ea3f1af98028c5e535a8b32"],
  ["0096_ipsas_3_statement_review_staged_apply", "023484a1f9ad9ce298b03ec3f15d76c8df2dec2a9b8675749ef334ab3f8e7c17"],
];
const TAGS = ["0091_ipsas_staged_transport", ...HOSTED_JOURNAL.map(([t]) => t)];

describe("IPSAS hosted install record (hosted ids 92–97, 2026-10-31)", () => {
  it("registers exactly the six IPSAS entries, each as a reviewed ipsas_staged_transport", () => {
    expect(Object.keys(RELEASE_JOURNAL).filter((k) => /ipsas/i.test(k))).toEqual(TAGS);
    for (const tag of TAGS) expect(RELEASE_JOURNAL[tag]).toMatchObject({ kind: "ipsas_staged_transport" });
  });

  it("each committed Drizzle mirror hashes to the hosted journal hash that was recorded for it", () => {
    for (const [tag, hosted] of HOSTED_JOURNAL) expect(sha(mirror(tag)), tag).toBe(hosted);
  });

  it("every registered entry validates through the canonical release check against the repository's sources", () => {
    for (const tag of TAGS) {
      const r = checkReleaseEntry(tag, mirror(tag).toString("utf8"), srcBytes);
      expect(r.problems, tag).toEqual([]);
    }
  });

  it("hosted id 97 is the reviewed wrapper plus exactly one space on exactly one line (and is not accepted by the strict check)", () => {
    const reviewed = renderApply(0);
    const variant = renderHostedEntry97Variant();
    expect(Buffer.byteLength(variant)).toBe(Buffer.byteLength(reviewed) + 1);
    const a = reviewed.split("\n"), b = variant.split("\n");
    expect(b).toHaveLength(a.length);
    const differing = a.map((l, i) => (l === b[i] ? -1 : i)).filter((i) => i >= 0);
    expect(differing).toHaveLength(1);
    expect(b[differing[0]]).toBe(` ${a[differing[0]]}`);
    expect(a[differing[0]]).toBe(HOSTED_ENTRY_97_VARIANT.insertedSpaceBeforeLine);
    expect(sha(variant)).toBe(HOSTED_ENTRY_97_VARIANT.sha256);
    expect(sha(`${variant}\n`)).toBe(HOSTED_ENTRY_97_VARIANT.journalSha256);
    // The strict, reviewed check still refuses it: registering the variant is a recorded fact, not an acceptance.
    expect(checkTransportMirror(HOSTED_ENTRY_97_VARIANT.tag, variant).problems.length).toBeGreaterThan(0);
    expect(checkHostedEntry97Variant(HOSTED_ENTRY_97_VARIANT.tag, variant).problems).toEqual([]);
    expect(checkHostedEntry97Variant(HOSTED_ENTRY_97_VARIANT.tag, `${variant}  `).problems.length).toBeGreaterThan(0);
    expect(checkHostedEntry97Variant(HOSTED_ENTRY_97_VARIANT.tag, reviewed).problems.length).toBeGreaterThan(0);
  });

  it("the entry 97 registration is flagged as awaiting the reviewer's decision, and only that entry carries the variant", () => {
    expect(RELEASE_JOURNAL["0096_ipsas_3_statement_review_staged_apply"]).toMatchObject({ variant: "hosted_entry_97", decision: "PENDING_REVIEWER" });
    expect(HOSTED_ENTRY_97_VARIANT.decision).toBe("PENDING_REVIEWER");
    for (const tag of TAGS.filter((t) => t !== HOSTED_ENTRY_97_VARIANT.tag)) expect(RELEASE_JOURNAL[tag]).not.toHaveProperty("variant");
  });

  it("the record document states the open decision and what is not installed", () => {
    const doc = fs.readFileSync(path.join(ROOT, "docs/release/ipsas-accrual-chain-r1/HOSTED_RECORD.md"), "utf8");
    expect(doc).toContain("PENDING_REVIEWER");
    expect(doc).toContain("20261211100000_source_access_authority_repairs.sql");
    expect(doc).toContain("023484a1f9ad9ce298b03ec3f15d76c8df2dec2a9b8675749ef334ab3f8e7c17");
  });
});
