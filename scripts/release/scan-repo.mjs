#!/usr/bin/env node
// Repository release scans. Each exits non-zero on a finding and NEVER prints a secret value: only path, line and kind.
//
//   node scripts/release/scan-repo.mjs nul        literal NUL bytes in tracked text files
//   node scripts/release/scan-repo.mjs secrets    credentials in files changed relative to the base
//   node scripts/release/scan-repo.mjs paths      every changed path is inside the areas this release is authorised to touch
//   node scripts/release/scan-repo.mjs payments   no executable payment-provider file changed
//   node scripts/release/scan-repo.mjs bundle     the production build (dist/) carries no operator surface, harness or workbook reader
//
// The pure functions are exported so tests can prove each scan detects what it claims to.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|icns|bmp|tiff?|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|xlsx|xls|docx|pptx|mp[34]|mov|wasm|lockb|bin|dat|sqlite|svg)$/i;

/** Files (from `files`) whose bytes contain a literal NUL and that are not known binary types. */
export function findNulFiles(root, files) {
  const out = [];
  for (const f of files) {
    if (BINARY_EXT.test(f)) continue;
    let buf;
    try {
      buf = fs.readFileSync(path.join(root, f));
    } catch {
      continue;
    }
    if (buf.includes(0)) out.push(f);
  }
  return out;
}

// Names and shapes only; a finding reports WHERE, never WHAT.
const SECRET_PATTERNS = [
  { kind: "jwt", re: /eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/g, check: (m) => !isPublicAnonJwt(m) },
  { kind: "supabase-secret-key", re: /\bsb_secret_[A-Za-z0-9_-]{10,}/g },
  { kind: "stripe-live-key", re: /\bsk_live_[A-Za-z0-9]{10,}/g },
  { kind: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "private-key-block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
  { kind: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { kind: "service-role-assignment", re: /SERVICE_ROLE_KEY['"]?\s*[:=]\s*['"][A-Za-z0-9._-]{24,}['"]/g },
  { kind: "postgres-url-with-password", re: /postgres(?:ql)?:\/\/[^\s:@/]+:[^\s@/]{3,}@(?!localhost|127\.0\.0\.1|\$\{)[^\s/'"]+/g },
];

/** A JWT whose payload role is `anon` is the public browser key that is already deployed; any other role is a secret. */
function isPublicAnonJwt(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return payload.role === "anon";
  } catch {
    return false;
  }
}

/** [{ path, line, kind }] — never the value. `files` is [{ path, text }]. */
export function findSecrets(files) {
  const out = [];
  for (const f of files) {
    if (BINARY_EXT.test(f.path)) continue;
    const lines = f.text.split("\n");
    lines.forEach((text, i) => {
      for (const p of SECRET_PATTERNS) {
        p.re.lastIndex = 0;
        for (let m = p.re.exec(text); m; m = p.re.exec(text)) {
          if (!p.check || p.check(m[0])) out.push({ path: f.path, line: i + 1, kind: p.kind });
        }
      }
    });
  }
  return out;
}

/** The areas this release is authorised to change. Anything else is a violation. */
export const AUTHORIZED = {
  prefixes: [
    "src/lib/financialStatementsWorkspace/",
    "src/lib/financialEvidence/",
    "src/lib/financialGeneration/",
    "src/lib/canonicalStatement/",
    "src/components/financialStatements/",
    "docs/release/",
    "scripts/db-proof/",
    "scripts/hosted-staging/",
    "scripts/release/",
    "dev-harness/",
  ],
  exact: [
    "src/hooks/useFinancialStatementsWorkspace.ts",
    "supabase/migrations/20260919100000_financial_statements_rollout_control.sql",
    "supabase/migrations/20260919110000_financial_statements_persistence.sql",
    // migration-tail pins that must follow the two new migrations
    "src/lib/__tests__/billingTriggerRepairMigration.test.ts",
    "src/lib/__tests__/migrationReplayCompatibilityGuard.test.ts",
    "src/lib/commercial/payments/__tests__/omega3CheckoutIntervalAuthority.test.ts",
    // CI: the disposable-database proof job and the staging guard's tests
    ".github/workflows/ci.yml",
    // the audited zip reader behind the secure XLSX intake (exactly one dependency; asserted separately)
    "package.json",
    "package-lock.json",
    "CLAUDE.md",
  ],
};

export function authorizeChangedPaths(changed, allowed = AUTHORIZED) {
  return changed.filter((f) => !allowed.exact.includes(f) && !allowed.prefixes.some((p) => f.startsWith(p)));
}

const PAYMENT_PATH = /(^|\/)(payments?|flutterwave|checkout)(\/|[-_.])|flutterwave/i;
/** Changed executable payment-surface files (tests are not executable surface). */
export function paymentSurfaceChanges(changed) {
  return changed.filter((f) => (PAYMENT_PATH.test(f) || /^supabase\/functions\/[^/]*(payment|checkout|flutterwave)[^/]*\//i.test(f)) && !/\.test\.[cm]?[tj]sx?$/.test(f) && !/(^|\/)__tests__\//.test(f) && !f.startsWith("docs/"));
}

/**
 * The production bundle must not contain the operator surface, the harness, the local-identity label, the workbook reader
 * (the workspace is tree-shaken while its ship gate is off), or any use of the production project other than the one
 * pre-existing Supabase client URL constant.
 */
export const BUNDLE_FORBIDDEN = ["service_role", "fs_set_company_rollout", "fs_set_kill_switch", "fs_commit_revision", "dev-harness", "NON-PRODUCTION HARNESS", "LOCAL_SIMULATED_IDENTITY", "Internal preview", "fflate", "inspectWorkbook", "STAGING_SUPABASE"];
export function scanBundle(files, productionRef = "bvyivmmfjejbmqoydezk") {
  const out = [];
  for (const f of files) {
    for (const token of BUNDLE_FORBIDDEN) if (f.text.includes(token)) out.push({ path: f.path, kind: `forbidden token ${token}` });
    let i = f.text.indexOf(productionRef);
    while (i !== -1) {
      const around = f.text.slice(Math.max(0, i - 12), i + productionRef.length + 12);
      if (!/https:\/\/bvyivmmfjejbmqoydezk\.supabase\.co/.test(around)) out.push({ path: f.path, kind: "production project reference outside the client URL constant" });
      i = f.text.indexOf(productionRef, i + 1);
    }
  }
  return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────
function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).replace(/\n$/, "");
const lines = (t) => t.split("\n").filter(Boolean);

function main(mode) {
  const root = repoRoot();
  const base = process.env.RELEASE_BASE_REF ?? "origin/main";
  const changed = lines(git(root, "diff", "--name-only", "--no-renames", base, "HEAD"));
  if (mode === "nul") {
    // A pre-existing NUL in a file this branch did not add NUL bytes to is a BASELINE finding (reported exactly, not a regression).
    const found = findNulFiles(root, lines(git(root, "ls-files")));
    const baseCount = (f) => {
      try {
        return execFileSync("git", ["show", `${base}:${f}`], { cwd: root, maxBuffer: 256 * 1024 * 1024 }).reduce((n, byte) => n + (byte === 0 ? 1 : 0), 0);
      } catch {
        return 0;
      }
    };
    const headCount = (f) => fs.readFileSync(path.join(root, f)).reduce((n, byte) => n + (byte === 0 ? 1 : 0), 0);
    const regressions = found.filter((f) => headCount(f) > baseCount(f));
    const baseline = found.filter((f) => !regressions.includes(f));
    console.log(`NUL scan: ${regressions.length} file(s) with NEW literal NUL bytes; ${baseline.length} baseline file(s) identical to ${base} in NUL count${baseline.length ? `: ${baseline.map((f) => `${f} (${headCount(f)} == ${baseCount(f)})`).join(", ")}` : ""}${regressions.length ? `
NEW: ${regressions.join(", ")}` : ""}`);
    process.exit(regressions.length === 0 ? 0 : 1);
  }
  if (mode === "secrets") {
    const files = changed.filter((f) => fs.existsSync(path.join(root, f))).map((f) => ({ path: f, text: fs.readFileSync(path.join(root, f), "utf8") }));
    const found = findSecrets(files);
    console.log(found.length === 0 ? `secret scan: ${files.length} changed file(s) checked, no credential found (values are never printed)` : `secret scan: ${found.length} finding(s) (values withheld):\n${found.map((f) => ` - ${f.path}:${f.line} [${f.kind}]`).join("\n")}`);
    process.exit(found.length === 0 ? 0 : 1);
  }
  if (mode === "paths") {
    const bad = authorizeChangedPaths(changed);
    console.log(bad.length === 0 ? `changed-path authorization: all ${changed.length} changed path(s) are within the authorised areas` : `changed-path authorization: ${bad.length} path(s) outside the authorised areas:\n${bad.map((f) => ` - ${f}`).join("\n")}`);
    process.exit(bad.length === 0 ? 0 : 1);
  }
  if (mode === "payments") {
    const hit = paymentSurfaceChanges(changed);
    console.log(hit.length === 0 ? "payment surface: no executable payment-provider file changed" : `payment surface: ${hit.length} executable payment-related file(s) changed:\n${hit.map((f) => ` - ${f}`).join("\n")}`);
    process.exit(hit.length === 0 ? 0 : 1);
  }
  if (mode === "bundle") {
    const dist = path.join(root, "dist");
    const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);
    const files = walk(dist).filter((f) => /\.(js|css|html|json|map|txt)$/.test(f)).map((f) => ({ path: path.relative(root, f).split(path.sep).join("/"), text: fs.readFileSync(f, "utf8") }));
    if (files.length === 0) {
      console.error("bundle scan: dist/ is empty; run the production build first");
      process.exit(1);
    }
    const found = scanBundle(files);
    console.log(found.length === 0 ? `bundle scan: ${files.length} built file(s) checked; no operator surface, harness, local-identity label or workbook reader, and the production project appears only as the pre-existing client URL constant` : `bundle scan: ${found.length} finding(s): ${found.map((f) => `${f.path} [${f.kind}]`).join("; ")}`);
    process.exit(found.length === 0 ? 0 : 1);
  }
  console.error("usage: scan-repo.mjs nul|secrets|paths|payments|bundle");
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2]);
