// Deployment manifest of Edge Functions and migrations: what a deploy actually ships, not only index.ts.
//
//   node scripts/release/functionClosure.mjs <function> [<function> …] [--migrations <file> …]
//
// For each function: every file in the transitive closure of index.ts's RELATIVE imports (the files the bundler
// ships), each with its byte size and SHA-256; the remote specifiers the closure imports (resolved by the platform at
// deploy time, listed verbatim); and a closure digest = SHA-256 of the sorted "<sha256>  <path>" lines. For each
// migration: its full SHA-256 and size. Read-only; no network; the same tree always yields the same manifest.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FUNCTIONS = path.join(REPO, "supabase/functions");
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const rel = (p) => path.relative(REPO, p).split(path.sep).join("/");
// import … from "x"; export … from "x"; import "x"; import("x") — comments stripped first.
const SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*)(["'])([^"']+)\1/g;

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");
}

/** The closure of one entry file: relative files (with hashes) and remote specifiers. */
/** `root` is the tree the paths are relative to (the repository, or a downloaded deployment bundle). */
export function closureOf(entry, root = REPO) {
  const relTo = (p) => path.relative(root, p).split(path.sep).join("/");
  const files = new Map();
  const remote = new Set();
  const stack = [path.resolve(entry)];
  while (stack.length) {
    const file = stack.pop();
    if (files.has(file)) continue;
    if (!fs.existsSync(file)) throw new Error(`unresolved import: ${relTo(file)}`);
    const bytes = fs.readFileSync(file);
    files.set(file, { path: relTo(file), size: bytes.length, sha256: sha(bytes) });
    for (const m of stripComments(bytes.toString("utf8")).matchAll(SPEC)) {
      const spec = m[2];
      if (spec.startsWith("./") || spec.startsWith("../")) stack.push(path.resolve(path.dirname(file), spec));
      else remote.add(spec);
    }
  }
  const list = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  const digest = sha(list.map((f) => `${f.sha256}  ${f.path}`).join("\n") + "\n");
  return { files: list, remote: [...remote].sort(), closureSha256: digest };
}

export function functionManifest(name) {
  const entry = path.join(FUNCTIONS, name, "index.ts");
  if (!fs.existsSync(entry)) throw new Error(`no such function: ${name}`);
  return { function: name, entry: rel(entry), ...closureOf(entry) };
}

export function migrationManifest(file) {
  const p = path.join(REPO, "supabase/migrations", file);
  const bytes = fs.readFileSync(p);
  return { migration: file, size: bytes.length, sha256: sha(bytes) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const cut = args.indexOf("--migrations");
  const fns = cut < 0 ? args : args.slice(0, cut);
  const migs = cut < 0 ? [] : args.slice(cut + 1);
  console.log(JSON.stringify({ functions: fns.map(functionManifest), migrations: migs.map(migrationManifest) }, null, 2));
}
