#!/usr/bin/env node
/**
 * Supabase Migration Auditor
 *
 * Verifies migration file integrity:
 *   - All files match Supabase timestamp naming (`YYYYMMDDHHMMSS_*.sql`)
 *   - Chronological ordering is monotonic
 *   - No duplicate timestamps
 *   - No empty / zero-byte files
 *   - Required migrations (from `scripts/required_migrations.json`, if present)
 *     all exist; report missing and unexpected files.
 *
 * Usage:
 *   node scripts/audit_migrations.mjs              # human report
 *   node scripts/audit_migrations.mjs --json       # machine-readable
 *   node scripts/audit_migrations.mjs --strict     # exit 1 on any warning
 *
 * Exit codes:
 *   0 = clean (or warnings only, non-strict)
 *   1 = errors found (or any warnings in --strict)
 */

import { readdirSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");
const REQUIRED_MANIFEST = join(__dirname, "required_migrations.json");

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const strict = args.has("--strict");

const NAME_RE = /^(\d{14})_[A-Za-z0-9._-]+\.sql$/;

/** @type {{errors:string[], warnings:string[], info:string[]}} */
const report = { errors: [], warnings: [], info: [] };

if (!existsSync(MIGRATIONS_DIR)) {
  report.errors.push(`Migrations directory not found: ${MIGRATIONS_DIR}`);
  emit();
  process.exit(1);
}

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const seenTs = new Map(); // timestamp -> filename
const parsed = []; // { file, ts, size }

for (const file of files) {
  const m = file.match(NAME_RE);
  if (!m) {
    report.errors.push(`Malformed migration filename: ${file}`);
    continue;
  }
  const ts = m[1];
  const full = join(MIGRATIONS_DIR, file);
  const size = statSync(full).size;

  if (size === 0) {
    report.errors.push(`Empty migration (0 bytes): ${file}`);
  } else if (size < 32) {
    report.warnings.push(`Suspiciously small migration (${size}B): ${file}`);
  }

  if (seenTs.has(ts)) {
    report.errors.push(
      `Duplicate timestamp ${ts}: ${seenTs.get(ts)} vs ${file}`,
    );
  } else {
    seenTs.set(ts, file);
  }

  // Check for accidental NUL bytes / merge markers.
  try {
    const buf = readFileSync(full);
    if (buf.includes(0x00)) {
      report.errors.push(`Contains NUL byte (corrupted): ${file}`);
    }
    const text = buf.toString("utf8");
    if (/^<{7} |^={7}$|^>{7} /m.test(text)) {
      report.errors.push(`Contains unresolved merge conflict markers: ${file}`);
    }
  } catch (e) {
    report.errors.push(`Failed to read ${file}: ${e.message}`);
  }

  parsed.push({ file, ts, size });
}

// Chronological monotonicity (already sorted by name; verify parses ascend).
for (let i = 1; i < parsed.length; i++) {
  if (parsed[i].ts < parsed[i - 1].ts) {
    report.errors.push(
      `Out-of-order timestamp: ${parsed[i].file} follows ${parsed[i - 1].file}`,
    );
  }
}

// Required-manifest check.
let manifest = null;
if (existsSync(REQUIRED_MANIFEST)) {
  try {
    manifest = JSON.parse(readFileSync(REQUIRED_MANIFEST, "utf8"));
  } catch (e) {
    report.errors.push(
      `Failed to parse ${REQUIRED_MANIFEST}: ${e.message}`,
    );
  }
}

let missing = [];
let unexpected = [];
if (manifest && Array.isArray(manifest.required)) {
  const present = new Set(files);
  missing = manifest.required.filter((f) => !present.has(f));
  for (const f of missing) report.errors.push(`Missing required migration: ${f}`);

  if (manifest.strict_extras) {
    const required = new Set(manifest.required);
    unexpected = files.filter((f) => !required.has(f));
    for (const f of unexpected)
      report.warnings.push(`Unexpected migration (not in manifest): ${f}`);
  }
} else {
  report.info.push(
    `No manifest at scripts/required_migrations.json — skipping required-set check.`,
  );
}

report.info.push(`Scanned ${files.length} migration file(s).`);
if (parsed.length) {
  report.info.push(`First: ${parsed[0].file}`);
  report.info.push(`Last:  ${parsed[parsed.length - 1].file}`);
}

function emit() {
  if (asJson) {
    const out = {
      ok: report.errors.length === 0 && (!strict || report.warnings.length === 0),
      counts: {
        files: files.length,
        errors: report.errors.length,
        warnings: report.warnings.length,
        missing: missing.length,
        unexpected: unexpected.length,
      },
      missing,
      unexpected,
      errors: report.errors,
      warnings: report.warnings,
      info: report.info,
    };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log("== Supabase Migration Audit ==");
  console.log(`Directory: ${MIGRATIONS_DIR}`);
  console.log(`Files scanned: ${files.length}`);
  console.log(`Errors:   ${report.errors.length}`);
  console.log(`Warnings: ${report.warnings.length}`);
  console.log("");

  if (report.errors.length) {
    console.log("-- ERRORS --");
    for (const e of report.errors) console.log(`  ✗ ${e}`);
    console.log("");
  }
  if (report.warnings.length) {
    console.log("-- WARNINGS --");
    for (const w of report.warnings) console.log(`  ! ${w}`);
    console.log("");
  }
  if (report.info.length) {
    console.log("-- INFO --");
    for (const i of report.info) console.log(`  · ${i}`);
  }

  if (
    report.errors.length === 0 &&
    (!strict || report.warnings.length === 0)
  ) {
    console.log("\nVERDICT: CLEAN");
  } else {
    console.log("\nVERDICT: FAILED");
  }
}

emit();

const failed =
  report.errors.length > 0 || (strict && report.warnings.length > 0);
process.exit(failed ? 1 : 0);