#!/usr/bin/env node
// Customer-visible legacy product-name sweep.
//
// SAFISHA, HESABU, MAONO and KINGA are internal engine names. They may stay in code identifiers, file and folder
// names, database object names, Edge Function slugs, comments and developer console output. They may never reach
// a customer: JSX text, user-facing string and template literals (copy, toasts, errors, PDF/spreadsheet content,
// export metadata, Edge Function response messages) are scanned with the TypeScript parser (so comments, identifiers,
// import paths and type-only literals are never counted).
//
//   node scripts/ci/legacyNameSweep.mjs          -> prints findings, exit 1 if any
//
// Product spellings (SAFISHA / Safisha, ...) match anywhere as a word. Lower-case words match when they stand alone,
// so technical identifiers such as "safisha-ingest" or "hesabu_validations" are not product names, but "run safisha" is.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const LEGACY_NAME = /\b(SAFISHA|HESABU|MAONO|KINGA|Safisha|Hesabu|Maono|Kinga)\b|(^|[\s"(])(safisha|hesabu|maono|kinga)([\s.,:;!?)"]|$)/;

const JSX_SLUG = /\b(safisha|hesabu|maono|kinga)[-_]/i;

// Literals that must keep their exact value because they are identities, not display text. Each entry is reviewed:
// the value is never rendered to a customer.
export const PERSISTED_IDENTIFIER_ALLOWLIST = [
  // Legacy workspace sub-routes kept ONLY so old bookmarks keep working: each renders nothing and immediately
  // redirects to the neutral stage route (prepare / statements / tax). The words never appear on screen.
  { file: "src/App.tsx", value: "safisha" },
  { file: "src/App.tsx", value: "hesabu" },
  { file: "src/App.tsx", value: "kinga" },
];

const SCAN_DIRS = ["src", "supabase/functions"];
const skipFile = (rel) =>
  /\.test\.(ts|tsx)$/.test(rel) || rel.includes("__tests__") || rel.includes("__fixtures__")
  || rel === "src/integrations/supabase/types.ts" || rel.endsWith(".d.ts");

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out); }
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

function isConsoleCall(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isCallExpression(n)) {
      const t = n.expression.getText();
      if (/^console\.(log|info|warn|error|debug)$/.test(t)) return true;
    }
    if (ts.isBlock(n) || ts.isSourceFile(n)) return false;
  }
  return false;
}

function skipNode(node) {
  const p = node.parent;
  if (!p) return false;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true;
  if (ts.isLiteralTypeNode(p)) return true; // type-only
  if (ts.isCallExpression(p) && /^(require|import)$/.test(p.expression.getText())) return true;
  return isConsoleCall(node);
}

export function scanFile(abs) {
  const rel = path.relative(ROOT, abs).split(path.sep).join("/");
  const text = fs.readFileSync(abs, "utf8");
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, abs.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const findings = [];
  const report = (node, value) => {
    if (!LEGACY_NAME.test(value)) return;
    if (PERSISTED_IDENTIFIER_ALLOWLIST.some((a) => a.file === rel && a.value === value)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    findings.push({ file: rel, line: line + 1, text: value.trim().slice(0, 140) });
  };
  const visit = (node) => {
    // JSX text is always on screen, so even a technical slug ("run maono-risk") is customer-visible there.
    if (ts.isJsxText(node) && JSX_SLUG.test(node.getText(sf))) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      findings.push({ file: rel, line: line + 1, text: node.getText(sf).trim().slice(0, 140) });
    } else if (ts.isJsxText(node)) report(node, node.getText(sf));
    else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !skipNode(node)) report(node, node.text);
    else if (ts.isTemplateExpression(node) && !skipNode(node)) {
      report(node, [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" "));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

export function sweep() {
  const files = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d), []))
    .filter((abs) => !skipFile(path.relative(ROOT, abs).split(path.sep).join("/")));
  return files.flatMap(scanFile);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = sweep();
  for (const f of findings) console.log(`${f.file}:${f.line}  ${f.text}`);
  console.log(findings.length === 0 ? "LEGACY_NAME_SWEEP: CLEAN" : `LEGACY_NAME_SWEEP: ${findings.length} customer-visible occurrence(s)`);
  process.exitCode = findings.length === 0 ? 0 : 1;
}
