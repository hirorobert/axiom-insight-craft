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
    required: { sha256: "89dfebd2bfc96c73cf766468881db73eb1290f37cd34164880fba64d6cd934e3", source: "Trial Balance workflow: generation 7 with exhaustive finding/rule agreement and final-schema certification enforcement (20261118100000)" },
    known: [{ sha256: "e2553c3b559a9bead72f5afd022d568419c0a6ea1b542ea25a6ade1a7b975bd8", source: "main daa23e4 (PR #176 merged; generation 6): PR #176: account_mappings read page by page by KEYSET on the immutable id (_shared/pagedSelect.ts selectAllRowsByKey; Codex review blocker 2)" },
      { sha256: "67cbf27b09e68fbfb70c8d1562a5fdd7063f284bf7cdda9280a81edbf25607fd", source: "main through 942764f (deployed hosted 2026-10-18, tb-release-r1): one unpaged select, at most 1,000 mappings applied" },
      { sha256: "85670e5ae5bd01a737ca7a30f90f9b779784d272ad4422c5d94f36e2f7ba8a6e", source: "PR #176 bbb9ad2-018f1f4 (never deployed): OFFSET-window pages, unsafe against a concurrent unrelated mapping change" }],
  }),
  "trial-balance-layout": Object.freeze({
    required: { sha256: "aec4b9287af4bcd2dfd761eb151434e7b1ff0050b05f4d1a9dac6ae89e603dab", source: "Trial Balance workflow: generation 7 layout/investigation closure (20261118100000)" },
    // The prior hosted layout digest is only abbreviated in historical evidence; without a full digest it remains UNKNOWN,
    // which correctly requires a fresh closure verification rather than accepting a partial identity.
    known: [],
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
