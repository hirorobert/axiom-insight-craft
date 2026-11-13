// Establishes WHICH reviewed version of an Edge Function is deployed, from its downloaded bundle — read-only.
//
//   supabase functions download trial-balance-storage-cleanup --project-ref <ref>      (writes supabase/functions/… into a
//                                                                                        scratch directory; read-only)
//   node scripts/release/verifyDeployedClosure.mjs trial-balance-layout <scratch directory>
//   node scripts/release/verifyDeployedClosure.mjs process-trial-balance <scratch directory>
//
// The downloaded tree is treated as data: its files are hashed, never executed. The closure digest is computed exactly as
// scripts/release/functionClosure.mjs computes it (SHA-256 of the sorted "<sha256>  <path>" lines over the transitive
// relative imports of index.ts) and compared with the reviewed closures below. Exit 0 = the deployed bundle IS the
// required closure (reuse it); exit 1 = it is a known older closure or unknown (redeploy the required closure).
import fs from "node:fs";
import path from "node:path";
import { closureOf } from "./functionClosure.mjs";

/** Reviewed closures: the one the current release requires, and the ones known to have been deployed before. */
export const KNOWN_CLOSURES = Object.freeze({
  // Trial Balance workflow: generation 7 (finding decisions, evaluation manifest) supersedes the PR #176 closure, which
  // remains the newest KNOWN closure (it needs no 20261118100000). Neither is evidence of hosted deployment.
  // PR #176 (FS first slice): the mapping read is paged (DEFECT-PTB-MAPPINGS-API-ROW-CAP-001). The closure deployed hosted on
  // 2026-10-18 (tb-release-r1, EVIDENCE.md) read at most 1,000 mappings and must be redeployed.
  "process-trial-balance": Object.freeze({
    required: { sha256: "f0fef38ca79f6329647c22168c68bd2f130672a892c61d645e7c355ac0747ab0", source: "SheetJS 0.20.3 vendored in the closure (_shared/vendor/sheetjs-0.20.3/xlsx.mjs; vendor/sheetjs/PROVENANCE.md; CVE-2023-30533 prototype pollution, CVE-2024-22363 ReDoS; sheetjsPrototypePollution.test.ts) on the tb-ingest-3.3.0 reader; no remote spreadsheet import; no migration" },
    known: [{ sha256: "6ed1e1df3d98197e6da8435b29daf528a61638f80f485d1da12b73080457e802", source: "PR #271 first revision be4df8f-dd10bde (never deployed): SheetJS 0.20.3 imported at run time from cdn.sheetjs.com, an externally hosted dependency the owner did not accept" },
      { sha256: "63fe4142c457da286a37c3efee35f91d00468323d0679b88e7c1381c3ccc3133", source: "PR #267 reader tb-ingest-3.3.0 (S2-I01 FORMULA_WITHOUT_VALUE, S2-I02 refusals) on SheetJS 0.18.5 from esm.sh: a crafted workbook pollutes Object.prototype" },
      { sha256: "120f3899c291cec18571bc4f8c806e00f62c3f963ad8327b96c476e13f616fa8", source: "main through d20a36b (number-cell noise rule on the QuickBooks Desktop export reading): certifies a workbook whose uncalculated formulas vanish, and Debit/Credit movements beside opening and closing balances" },
      { sha256: "06425fa89ec9ac6abe5a5b5ba4de04493e6ad655e60e8d3e9b06942398f76755", source: "main with the QuickBooks Desktop export reading (PR #235), before the number-cell noise rule" },
      { sha256: "d0e8eb018c50e870d561c1bd45b21472ab0d29fd57c199cee852bd6f9dee19db", source: "main with classification-r1 (specific names win over general words in classification suggestions; docs/release/classification-r1/RECORD.md), before the QuickBooks Desktop export reading fix" },
      { sha256: "89dfebd2bfc96c73cf766468881db73eb1290f37cd34164880fba64d6cd934e3", source: "main through 5b2f087b (generation 7, before classification-r1): wrong suggestions for cost of sales, accumulated depreciation, bank loan, interest income with a qualifier" },
      { sha256: "e2553c3b559a9bead72f5afd022d568419c0a6ea1b542ea25a6ade1a7b975bd8", source: "main daa23e4 (PR #176 merged; generation 6): PR #176: account_mappings read page by page by KEYSET on the immutable id (_shared/pagedSelect.ts selectAllRowsByKey; Codex review blocker 2)" },
      { sha256: "67cbf27b09e68fbfb70c8d1562a5fdd7063f284bf7cdda9280a81edbf25607fd", source: "main through 942764f (deployed hosted 2026-10-18, tb-release-r1): one unpaged select, at most 1,000 mappings applied" },
      { sha256: "85670e5ae5bd01a737ca7a30f90f9b779784d272ad4422c5d94f36e2f7ba8a6e", source: "PR #176 bbb9ad2-018f1f4 (never deployed): OFFSET-window pages, unsafe against a concurrent unrelated mapping change" }],
  }),
  "trial-balance-layout": Object.freeze({
    required: { sha256: "8052b2240449024b509ab17b4440b7296c59f7003b93f60bb1c4b5caf8fac614", source: "SheetJS 0.20.3 vendored in the closure (_shared/vendor/sheetjs-0.20.3/xlsx.mjs; CVE-2023-30533, CVE-2024-22363) on the tb-ingest-3.3.0 reader and the generation 7 layout/investigation closure (20261118100000); no remote spreadsheet import" },
    // The prior hosted layout digest is only abbreviated in historical evidence; without a full digest it remains UNKNOWN,
    // which correctly requires a fresh closure verification rather than accepting a partial identity.
    known: [{ sha256: "1d4ff3750437cbccdbed8f15efe4e714a90e92b02f023c432ad40ed8deb3a2ca", source: "PR #271 first revision be4df8f-dd10bde (never deployed): SheetJS 0.20.3 imported at run time from cdn.sheetjs.com, an externally hosted dependency the owner did not accept" }, { sha256: "a73c7da56de0e9d51ceaf4c58e69683aaa61e0298939773ffef1308469ddf092", source: "PR #267 reader tb-ingest-3.3.0 (S2-I01/S2-I02 refusals) on SheetJS 0.18.5 from esm.sh, before the SheetJS upgrade" }, { sha256: "e3a7516b7f38df6775bdd94ec643b830d71c704acec1fdd563fad02e98d2a44c", source: "main through d20a36b: number-cell noise rule on the QuickBooks Desktop export reading and the generation 7 layout/investigation closure, before the S2-I01/S2-I02 reader refusals" }, { sha256: "a441d63d905999f4771498893c25febbaf4948a3cb18e8cac415dc153c11e35c", source: "main with the QuickBooks Desktop export reading (PR #235), before the number-cell noise rule" }, { sha256: "aec4b9287af4bcd2dfd761eb151434e7b1ff0050b05f4d1a9dac6ae89e603dab", source: "main before the QuickBooks Desktop export reading fix: generation 7 layout/investigation closure (20261118100000)" }],
  }),
  // 20261124100000 / 20261125100000 (publication integrity gate, FINAL authority): verify/retrieve disclose `superseded` (a later
  // FINAL of the lineage, or another lineage's authority; the pages read the authority relation from readiness/versions); the
  // seal-stage refusals superseded_final_version and authority_unresolved answer 409. The PR #176 closure (deployed hosted 2026-10-21) is the
  // newest KNOWN older closure: it still issues/verifies/retrieves, but reads no supersession and answers 500 on that refusal.
  "seal-reporting-pack": Object.freeze({
    required: { sha256: "cdc5416f6a3ebd3925e36feaa9deb1c1dd00b4a2122091caf693b60324f44da6", source: "combined candidate (20261124100000-20261126100000, PR #192 + PR #191): issue, verify and retrieve, with the superseded disclosure" },
    known: [{ sha256: "6c62bdcdec99ea4d4dbfc555f67f0b9cfc1c6a0b7c8e5000c08b45573b21706c", source: "PR #192 before the combined candidate (never deployed): the same module text with the gate numbered 20261123100000" },
      { sha256: "dd4f0855705566a92b4cddcf3b045760dff40d6cc01d29a950a90ae295ec3e0d", source: "PR #176 since abc11a0 (deployed hosted 2026-10-21, fs-first-slice): issue, verify and retrieve; no superseded disclosure" },
      { sha256: "095a9ed92169c997d1d869ee5cb91697dfddade5963fe71be62f5daa6ba533b8", source: "main (deployed hosted 2026-10-18, tb-release-r1): issue and verify only - retrieve answers unavailable" }],
  }),
  // 20261123100000 (server compilation): the FULL function closure. Not the embedded compiler bundle digest (49fc0852…), which
  // the migration pins separately; a matching compiler digest alone never proves this closure is deployed.
  "compile-financial-report": Object.freeze({
    required: { sha256: "8419ff178ea7469ffb8ca373a71e65c1a69ce28f770bbd2ff8ae2704d82bfc9f", source: "consolidated release (compiler 85a0f362…, rule pack 2.5.0 = 2.4.0 + subtotal-casting 1.1.0; S2-A01/S2-A02 transfers and post-closing, ledger evidence schema 1.1.0, restated-comparative and one-period casting): needs 20261222100000, 20261222200000 AND 20261228100000 applied first; the intermediate 2.4.0-only bundle (closure ed84408e…) is never deployed" },
    known: [{ sha256: "745c8170099329911db55ee2ee20f5a989c0ae2a10003be0860c8cb679e4db59", source: "merged 27f48f7 (PR #191 + PR #192 combined candidate): server compilation with the compiler 49fc0852…; still accepted by the database after 20261222200000, but presents transfers between cash accounts as cash flows and has no post-closing finding" }],
  }),
  // PR #266: the Terms version check (termsVersion.ts), p_terms_version to acquire_checkout_attempt and terms_version in Polar's
  // checkout metadata (providers/polar.ts, shared by both functions). Neither function was pinned before; main 9a919c0's closures
  // are recorded as the known predecessors (whether they are what production runs is NOT verified from this repository).
  "commercial-create-checkout": Object.freeze({
    required: { sha256: "22a26cf189463a6bc0ffdf3e0b568a8c47f96111be8e623dfb7ce9d66fe008d1", source: "PR #266: refuses a checkout without the current Terms version before any write; records the server's version on the intent and in Polar metadata; needs 20261229100000 applied first" },
    known: [{ sha256: "961818245916e93cbe7810ecbd4acc58eceb0f91ec96d8890c051ac5fbdbec42", source: "main 9a919c0 (consolidated release): no Terms version; 14-argument acquire_checkout_attempt call (still valid after 20261229100000)" }],
  }),
  "commercial-payment-status": Object.freeze({
    required: { sha256: "9f9c8cf770739cd8d485f474394cae149bbf5bc15e8bbfa1eea150091c3614ce", source: "PR #266: shares providers/polar.ts (terms_version metadata); no behavioural change of its own" },
    known: [{ sha256: "0cb83e259c7516c02f5ca86abb2f7f033a66dde73f24d93485e59d27fdea3941", source: "main 9a919c0 (consolidated release)" }],
  }),
  "trial-balance-storage-cleanup": Object.freeze({
    required: { sha256: "04ebf148992f85b0b224215bfacb36bcd6a1342f822346c0e018594bfc410b7f", source: "main since 80384d1 (PR #76): knows source_shared" },
    known: [{ sha256: "e47b381850dc13a4101613a799233313b3400df4308a6f28f91650b23ca0d7df", source: "main before 80384d1 (PR #32 upload lifecycle): source_shared unknown — answers 500 and deletes nothing" }],
  }),
});

/** The closure digest of `fn` inside a downloaded tree rooted at `dir` (paths made relative to that root). */
export function deployedClosure(fn, dir) {
  const entry = path.join(dir, "supabase/functions", fn, "index.ts");
  if (!fs.existsSync(entry)) throw new Error(`no ${fn}/index.ts under ${dir}/supabase/functions`);
  const c = closureOf(entry, dir);
  return c.closureSha256;
}

export function classify(fn, digest) {
  const k = KNOWN_CLOSURES[fn];
  if (!k) return { verdict: "UNKNOWN_FUNCTION" };
  if (digest === k.required.sha256) return { verdict: "REQUIRED", detail: k.required.source };
  const old = k.known.find((x) => x.sha256 === digest);
  return old ? { verdict: "KNOWN_OLDER", detail: old.source } : { verdict: "UNKNOWN" };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"))) {
  const [fn, dir] = process.argv.slice(2);
  if (!fn || !dir) { console.error("usage: verifyDeployedClosure.mjs <function> <downloaded directory>"); process.exit(2); }
  const digest = deployedClosure(fn, path.resolve(dir));
  const r = classify(fn, digest);
  console.log(`${fn}: deployed closure ${digest} — ${r.verdict}${r.detail ? ` (${r.detail})` : ""}`);
  console.log(r.verdict === "REQUIRED" ? "REUSE: the deployed bundle is the required closure; no redeploy." : "REDEPLOY: the deployed bundle is not the required closure.");
  process.exit(r.verdict === "REQUIRED" ? 0 : 1);
}
