// inertBase — the exact comparison base for the database-inertness guard
// (src/lib/financialStatementsWorkspace/databaseInert.test.ts). Fail-closed: there is no "skip".
//
// Where the base comes from:
//   · pull_request CI  → GitHub's authoritative github.event.pull_request.base.sha   (DB_INERT_BASE_SHA, REQUIRED)
//   · push CI          → github.event.before, the branch tip the push replaced        (DB_INERT_BASE_SHA, REQUIRED)
//   · local / manual   → origin/main, ONLY when no CI base is supplied for the event
// Whatever the source, the base must be a full 40-hex commit present in this repository and an ANCESTOR of HEAD. A
// malformed, missing, unrelated, descendant or stale base (a branch not reconciled with its base) is rejected with a
// controlled diagnostic — the guard then fails; it never passes open.
//
// Review is EXACT-FILE: a changed path is accepted only if it is byte-for-byte one of the registered paths. No pattern,
// prefix, glob or normalisation is applied, so whitespace, "./", "..", case or separator variants never match.

const SHA = /^[0-9a-f]{40}$/;
const EVENTS_REQUIRING_A_BASE = new Set(["pull_request", "push"]);

/**
 * @param {{ env: Record<string, string | undefined>, git: (args: string) => string | null }} input
 *   git(args) runs `git <args>` and returns stdout, or null when the command fails.
 * @returns {{ ok: true, sha: string, source: string } | { ok: false, diagnostic: string }}
 */
export function resolveComparisonBase({ env, git }) {
  const supplied = env.DB_INERT_BASE_SHA ?? "";
  const event = env.DB_INERT_BASE_SOURCE ?? "";
  let sha;
  let source;
  if (supplied !== "") {
    if (!SHA.test(supplied)) return { ok: false, diagnostic: `DB_INERT_BASE: the supplied base "${supplied}" is not a full 40-hex commit SHA` };
    sha = supplied;
    source = event ? `${event} base ${supplied}` : `supplied base ${supplied}`;
  } else if (EVENTS_REQUIRING_A_BASE.has(event)) {
    return { ok: false, diagnostic: `DB_INERT_BASE: the ${event} event supplied no base SHA; the comparison cannot run against an assumed branch` };
  } else {
    const main = (git("rev-parse --verify --quiet origin/main") ?? "").trim();
    if (!SHA.test(main)) return { ok: false, diagnostic: "DB_INERT_BASE: no base SHA was supplied and origin/main is not available — fetch origin/main or supply DB_INERT_BASE_SHA" };
    sha = main;
    source = `origin/main ${main}`;
  }
  // `cat-file -t` (no ^{commit} suffix: the caret is an escape character in Windows cmd.exe).
  if ((git(`cat-file -t ${sha}`) ?? "").trim() !== "commit") {
    return { ok: false, diagnostic: `DB_INERT_BASE: base ${sha} is not present in this repository (shallow checkout? fetch the base commit)` };
  }
  if (git(`merge-base --is-ancestor ${sha} HEAD`) === null) {
    return { ok: false, diagnostic: `DB_INERT_BASE: base ${sha} is not an ancestor of HEAD — a stale or wrong base (reconcile the branch with its base)` };
  }
  return { ok: true, sha, source };
}

/**
 * Exact-file review of `git diff --name-status` output.
 * @param {string} nameStatus raw output (tab-separated status and path per line)
 * @param {{ added: ReadonlySet<string>, modified: ReadonlySet<string> }} reviewed
 * @returns {string[]} one message per unreviewed change; empty = every change is a reviewed exact file
 */
export function unreviewedChanges(nameStatus, { added, modified }) {
  const out = [];
  for (const line of nameStatus.split("\n")) {
    if (line === "") continue;
    const fields = line.split("\t");
    const [status, file] = fields;
    if (fields.length !== 2 || (status !== "A" && status !== "M")) { out.push(`unsupported change: ${JSON.stringify(line)}`); continue; }
    if (!(status === "A" ? added : modified).has(file)) out.push(`${JSON.stringify(file)} is not a reviewed ${status === "A" ? "addition" : "modification"}`);
  }
  return out;
}

/**
 * Exact-file review of `git diff --name-only` output.
 * @param {string} names raw output (one path per line)
 * @param {ReadonlySet<string>} allowed
 * @returns {string[]} the paths that are not exactly one of `allowed`
 */
export function unreviewedPaths(names, allowed) {
  return names.split("\n").filter((l) => l !== "" && !allowed.has(l));
}
