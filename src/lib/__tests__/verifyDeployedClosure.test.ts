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
  // SheetJS 0.20.3, vendored and shipped with the function (vendor/sheetjs/PROVENANCE.md).
  "supabase/functions/_shared/vendor/sheetjs-0.20.3/xlsx.mjs",
];
const tree =(contents: Record<string, Buffer>) => {
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
    expect(KNOWN_CLOSURES["compile-financial-report"].required.sha256).toBe("8419ff178ea7469ffb8ca373a71e65c1a69ce28f770bbd2ff8ae2704d82bfc9f");
    expect(classify("compile-financial-report", "49fc0852e33ce71604f4c1430916144910a700ab33873a3ef8e8ad85adbf4789").verdict).toBe("UNKNOWN");
  });
  it("a downloaded bundle of exactly the approved files is REQUIRED", () => {
    expect(classify("compile-financial-report", deployedClosure("compile-financial-report", copy())).verdict).toBe("REQUIRED");
  });
  it.each(CFR_FILES)("one changed byte in %s is UNKNOWN", (f) => {
    expect(classify("compile-financial-report", deployedClosure("compile-financial-report", copy(f))).verdict).toBe("UNKNOWN");
  });
});

describe("the two commercial functions that carry the Terms version (PR #266)", () => {
  it("are pinned to the current tree's closures, with main 9a919c0 as the known predecessor", () => {
    expect(KNOWN_CLOSURES["commercial-create-checkout"].required.sha256).toBe("c579825ca48870ac3d59433ad224d1169aae818ef69f61df02cbd82445c3a0e9");
    expect(KNOWN_CLOSURES["commercial-payment-status"].required.sha256).toBe("9f9c8cf770739cd8d485f474394cae149bbf5bc15e8bbfa1eea150091c3614ce");
    expect(classify("commercial-create-checkout", "961818245916e93cbe7810ecbd4acc58eceb0f91ec96d8890c051ac5fbdbec42").verdict).toBe("KNOWN_OLDER");
    expect(classify("commercial-create-checkout", deployedClosure("commercial-create-checkout", ROOT)).verdict).toBe("REQUIRED");
    expect(classify("commercial-payment-status", deployedClosure("commercial-payment-status", ROOT)).verdict).toBe("REQUIRED");
  });
});
