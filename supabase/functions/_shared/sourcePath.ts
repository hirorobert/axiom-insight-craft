// Source-path shape rule (PR #32 N-05/N-06). The database's tbu_path_well_formed (20260923170000) is the authority;
// this is its exact mirror for the Edge Functions' own defence-in-depth checks. Both are held to the same corpus:
// src/lib/workspace/__fixtures__/sourcePathCorpus.json (unit test + scripts/db-proof/uploadLifecycle.mjs).
//
// Well formed: non-empty; no empty, "." or ".." segment (so no leading or trailing "/", no "//", no traversal);
// no backslash; no control character. ".." INSIDE a name (TB..final.csv) is an ordinary name.
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export function isWellFormedSourcePath(p: unknown): boolean {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.includes("\\") || CONTROL.test(p)) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}
