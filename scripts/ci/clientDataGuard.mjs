// clientDataGuard.mjs — keeps client records out of the repository.
//
// Test data must be independently invented. This guard fails when a tracked text file
//   1. contains a token whose salted SHA-256 is on the denylist (identifiers and amounts that must never
//      appear here; only hashes are stored, so the guard itself names nothing), or
//   2. labels its own content as taken from a client's books (for example a fixture header that calls its
//      balances genuine), which is how such data has been labelled before.
//
// Applied migrations and their byte-for-byte mirrors are outside the scan: they are SHA-256 pinned and never
// edited (appliedMigrationsImmutable.test.ts); any correction there is a new forward migration.
//
// Usage: node scripts/ci/clientDataGuard.mjs            (scans `git ls-files`; exit 1 on any hit)
// Adding a denylist entry: hash `${salt}${token}` with the normalisation below and append it to
// clientDataDenylist.json — never commit the token itself.
//
// Origin: ported from draft PR #171 (fix/synthetic-test-data-current-tree) on 2026-11-11 with a denylist limited to
// the client-derived trial balance removed in the same change. #171's broader replacement of other client-derived
// fixtures has not landed; the files it covers are listed in KNOWN_UNRESOLVED so they stay visible instead of
// being excluded. That list may only shrink: the test fails if an entry no longer hits or a new file hits.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "../..");
export const DENYLIST = JSON.parse(fs.readFileSync(path.join(HERE, "clientDataDenylist.json"), "utf8"));

/** Paths the scan does not read: immutable applied migrations and their mirrors, lockfiles, binaries. */
export const EXCLUDED = [
  /^supabase\/migrations(_historical)?\//,
  /^drizzle\//,
  /^release\/(wrappers|wrappers_historical|candidates)\//,
  /(^|\/)(bun|deno)\.lock$/,
  /\.(png|jpe?g|gif|ico|webp|pdf|xlsx?|docx?|zip|gz|woff2?|ttf|otf|eot|mp4|mov)$/i,
];

/**
 * Tracked files that still hit and are owned by a named open remediation. Never add a file here to make the guard pass:
 * replace its content with invented data instead. Each entry names where its replacement lives.
 */
export const KNOWN_UNRESOLVED = Object.freeze({
  "src/lib/accounting/arushaFy2025Balances.fixture.ts": "client-derived public-sector fixture; replacement prepared in draft PR #171",
  "src/lib/accounting/arushaFy2026Balances.fixture.ts": "client-derived public-sector fixture; replacement prepared in draft PR #171",
});

const SELF_LABELLED_REAL = [
  /\bREAL\s+(debit|credit|balances?|figures)\b/,
  /\breal\s+(client|customer)(['’]s)?\s+(data|figures|balances|records|trial balance)\b/i,
  /\bextracted\s+from\s+[\w' ]{0,40}audited\s+accounts\b/i,
];

/** Canonical form of an amount token: no separators, absolute value, two decimals. Small or round values are ignored. */
export function normaliseAmount(raw) {
  const clean = raw.replace(/[,_]/g, "");
  if (!/^\d+(\.\d+)?$/.test(clean)) return null;
  const [int, frac = ""] = clean.split(".");
  const intPart = int.replace(/^0+(?=\d)/, "");
  if (intPart.length < 7) return null; // below 1,000,000
  if (frac.length > 2 && /[1-9]/.test(frac.slice(2))) return null; // not a two-decimal amount
  const cents = (frac + "00").slice(0, 2);
  if (cents === "00" && /0000$/.test(intPart)) return null; // multiples of 10,000 are too generic to judge
  return `${intPart}.${cents}`;
}

/** A scanner over one denylist ({ salt, words, amounts }: salted SHA-256 hex digests). */
export function makeScanner(denylist) {
  const hash = (token) => createHash("sha256").update(denylist.salt + token).digest("hex");
  const words = new Set(denylist.words);
  const amounts = new Set(denylist.amounts);
  /** Every denylist or self-labelling hit in one text (positions only, never content). */
  return function scan(text) {
    const hits = [];
    for (const re of SELF_LABELLED_REAL) if (re.test(text)) hits.push({ kind: "self-labelled-real", rule: re.source });
    for (const m of text.toLowerCase().matchAll(/[a-z]{4,}|\d{6,}/g)) {
      if (words.has(hash(m[0]))) hits.push({ kind: "denylisted-token", at: m.index });
    }
    for (const m of text.matchAll(/\d{1,3}(?:[,_]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)) {
      const n = normaliseAmount(m[0]);
      if (n && amounts.has(hash(n))) hits.push({ kind: "denylisted-amount", at: m.index });
    }
    return hits;
  };
}

/** The repository's scanner (the committed denylist). */
export const scanText = makeScanner(DENYLIST);

export function trackedTextFiles(root = ROOT) {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter((p) => p && !EXCLUDED.some((re) => re.test(p)));
}

/** Scans repository-relative paths; returns [{ file, hits }] for files with any hit (positions only, never content). */
export function scanFiles(files, root = ROOT, scan = scanText) {
  const findings = [];
  for (const file of files) {
    const abs = path.join(root, file);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) continue; // binary
    const hits = scan(buf.toString("utf8"));
    if (hits.length) findings.push({ file, hits });
  }
  return findings;
}

/** Findings outside KNOWN_UNRESOLVED (these fail), and KNOWN_UNRESOLVED entries that no longer hit (these fail too: shrink the list). */
export function evaluate(findings, known = KNOWN_UNRESOLVED) {
  const hitFiles = new Set(findings.map((f) => f.file));
  return {
    unexpected: findings.filter((f) => !Object.hasOwn(known, f.file)),
    stale: Object.keys(known).filter((file) => !hitFiles.has(file)),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { unexpected, stale } = evaluate(scanFiles(trackedTextFiles()));
  for (const f of unexpected) {
    console.error(`client-data guard: ${f.file}: ${f.hits.map((h) => (h.at === undefined ? h.kind : `${h.kind}@${h.at}`)).join(", ")}`);
  }
  for (const file of stale) console.error(`client-data guard: ${file} no longer hits; remove it from KNOWN_UNRESOLVED.`);
  if (unexpected.length || stale.length) {
    console.error(`client-data guard: FAILED — ${unexpected.length} file(s) with hits, ${stale.length} stale exception(s). Replace the content with independently invented data.`);
    process.exit(1);
  }
  console.log(`client-data guard: no unexpected hit (${Object.keys(KNOWN_UNRESOLVED).length} tracked exception(s) owned by named remediations).`);
}
