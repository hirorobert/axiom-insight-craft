// The deployed-bundle verifier (scripts/release/verifyDeployedClosure.mjs) recognises the required TB/FS closures,
// known older closures and anything else — from a downloaded tree, read-only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classify, deployedClosure, KNOWN_CLOSURES } from "../../../scripts/release/verifyDeployedClosure.mjs";

const ROOT = path.join(__dirname, "../../..");
const FILES = ["supabase/functions/trial-balance-storage-cleanup/index.ts", "supabase/functions/_shared/storageCleanup.ts"];
const LAYOUT_FILES = [
  "supabase/functions/trial-balance-layout/index.ts",
  "supabase/functions/_shared/auth.ts",
  "supabase/functions/_shared/currencyRegistry.ts",
  "supabase/functions/_shared/hash.ts",
  "supabase/functions/_shared/layoutConfirmationRead.ts",
  "supabase/functions/_shared/layoutProfile.ts",
  "supabase/functions/_shared/namedUserAccess.ts",
  "supabase/functions/_shared/paidAction.ts",
  "supabase/functions/_shared/printedReportMetadata.ts",
  "supabase/functions/_shared/processingActor.ts",
  "supabase/functions/_shared/tbIngestion.ts",
  "supabase/functions/_shared/tbInvestigation.ts",
  "supabase/functions/_shared/tbSource.ts",
  "supabase/functions/_shared/trialBalanceLayout.ts",
  "supabase/functions/_shared/uploadLifecycle.ts",
  "supabase/functions/_shared/uploadPolicy.ts",
];
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
  it("PR #176: the repository's current process-trial-balance and seal-reporting-pack closures ARE the required ones; the hosted 2026-10-18 closures are known older (redeploy)", () => {
    for (const fn of ["process-trial-balance", "seal-reporting-pack"] as const) {
      const digest = deployedClosure(fn, ROOT);
      expect(digest, fn).toBe(KNOWN_CLOSURES[fn].required.sha256);
      expect(classify(fn, digest).verdict, fn).toBe("REQUIRED");
      expect(classify(fn, KNOWN_CLOSURES[fn].known[0].sha256).verdict, fn).toBe("KNOWN_OLDER");
    }
  });
  it("the generation-7 process and layout closures are recomputed from the committed source and both classify as REQUIRED", () => {
    for (const fn of ["process-trial-balance", "trial-balance-layout"] as const) {
      const digest = deployedClosure(fn, ROOT);
      expect(digest, fn).toBe(KNOWN_CLOSURES[fn].required.sha256);
      expect(classify(fn, digest).verdict, fn).toBe("REQUIRED");
    }
  });
  it("a complete layout bundle with one changed byte is UNKNOWN, never accepted by a substring match", () => {
    const files = Object.fromEntries(LAYOUT_FILES.map((f) => {
      const body = fs.readFileSync(path.join(ROOT, f));
      return [f, Buffer.concat([body, f.endsWith("index.ts") ? Buffer.from(" ") : Buffer.alloc(0)])];
    }));
    const d = tree(files);
    expect(classify("trial-balance-layout", deployedClosure("trial-balance-layout", d)).verdict).toBe("UNKNOWN");
  });
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

describe("which compile-financial-report bundle is deployed", () => {
  const CFR_FILES = [
    "supabase/functions/compile-financial-report/index.ts",
    "supabase/functions/compile-financial-report/handler.ts",
    "supabase/functions/_shared/statementCompiler.generated.mjs",
    "supabase/functions/_shared/statementCompiler.manifest.mjs",
  ];
  const copy = (alter?: string) => tree(Object.fromEntries(CFR_FILES.map((f) => {
    const b = fs.readFileSync(path.join(ROOT, f));
    return [f, f === alter ? Buffer.concat([b, Buffer.from(" ")]) : b];
  })));
  it("registers the approved full closure, distinct from the compiler bundle digest", () => {
    expect(KNOWN_CLOSURES["compile-financial-report"].required.sha256).toBe("745c8170099329911db55ee2ee20f5a989c0ae2a10003be0860c8cb679e4db59");
    expect(classify("compile-financial-report", "49fc0852e33ce71604f4c1430916144910a700ab33873a3ef8e8ad85adbf4789").verdict).toBe("UNKNOWN");
  });
  it("a downloaded bundle of exactly the approved files is REQUIRED", () => {
    expect(classify("compile-financial-report", deployedClosure("compile-financial-report", copy())).verdict).toBe("REQUIRED");
  });
  it.each(CFR_FILES)("one changed byte in %s is UNKNOWN", (f) => {
    expect(classify("compile-financial-report", deployedClosure("compile-financial-report", copy(f))).verdict).toBe("UNKNOWN");
  });
});
