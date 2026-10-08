// Establishes WHICH reviewed version of an Edge Function is deployed, from its downloaded bundle — read-only.
//
//   supabase functions download trial-balance-storage-cleanup --project-ref <ref>      (writes supabase/functions/… into a
//                                                                                        scratch directory; read-only)
//   node scripts/release/verifyDeployedClosure.mjs trial-balance-storage-cleanup <scratch directory>
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
