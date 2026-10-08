// The deployed-bundle verifier (scripts/release/verifyDeployedClosure.mjs) recognises the required storage-cleanup
// closure, the known older one (before PR #76) and anything else — from a downloaded tree, read-only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classify, deployedClosure, KNOWN_CLOSURES } from "../../../scripts/release/verifyDeployedClosure.mjs";

const ROOT = path.join(__dirname, "../../..");
const FILES = ["supabase/functions/trial-balance-storage-cleanup/index.ts", "supabase/functions/_shared/storageCleanup.ts"];
const tree = (contents: Record<string, Buffer>) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "deployed-"));
  for (const [f, b] of Object.entries(contents)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), b); }
  return d;
};
// The sources as they were before PR #76 (80384d1): exactly its three added lines removed (checked against git when written;
// derived here so a shallow checkout needs no history).
const PR76_ADDED = [
  "  // I1-B: the discarded year's record is purged, but its file is kept because the other year of the same file uses it.\n",
  '  | "source_shared"\n',
  '  source_shared: { status: 200, outcome: "source_shared" },\n',
];
const before76 = (f: string) => {
  let t = fs.readFileSync(path.join(ROOT, f), "utf8");
  if (f.endsWith("storageCleanup.ts")) for (const l of PR76_ADDED) { expect(t.split(l).length - 1).toBe(1); t = t.replace(l, ""); }
  return Buffer.from(t, "utf8");
};

describe("which storage-cleanup bundle is deployed", () => {
  it("a bundle with the current sources IS the required closure (reuse)", () => {
    const d = tree(Object.fromEntries(FILES.map((f) => [f, fs.readFileSync(path.join(ROOT, f))])));
    expect(classify("trial-balance-storage-cleanup", deployedClosure("trial-balance-storage-cleanup", d)).verdict).toBe("REQUIRED");
  });
  it("a bundle from before PR #76 is the known older closure (redeploy)", () => {
    const d = tree(Object.fromEntries(FILES.map((f) => [f, before76(f)])));
    const digest = deployedClosure("trial-balance-storage-cleanup", d);
    expect(digest).toBe(KNOWN_CLOSURES["trial-balance-storage-cleanup"].known[0].sha256);
    expect(classify("trial-balance-storage-cleanup", digest).verdict).toBe("KNOWN_OLDER");
  });
  it("any other bundle (one byte changed) is unknown (redeploy)", () => {
    const d = tree(Object.fromEntries(FILES.map((f) => [f, Buffer.concat([fs.readFileSync(path.join(ROOT, f)), Buffer.from(f.endsWith("index.ts") ? " " : "")])])));
    expect(classify("trial-balance-storage-cleanup", deployedClosure("trial-balance-storage-cleanup", d)).verdict).toBe("UNKNOWN");
  });
});
