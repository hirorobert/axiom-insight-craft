/**
 * Database-inertness proof for the financial-statements workspace change.
 *
 * This change must not add or alter any database schema, Edge Function or
 * write path, and the workspace code must be unable to mutate a database even
 * if its gates were flipped. The SQL persistence candidate is preserved on a
 * separate branch and is deliberately absent here.
 *
 * Static and non-executing: it reads the real sources.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { FINANCIAL_STATEMENT_PERSISTENCE_ENABLED } from "./persistenceGate";
import { FINANCIAL_STATEMENTS_WORKSPACE_ENABLED } from "./workspaceGate";

const ROOT = path.join(__dirname, "../../../");
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const workspaceSources = [
  ...walk(path.join(ROOT, "src/lib/financialStatementsWorkspace")),
  ...walk(path.join(ROOT, "src/components/financialStatements")),
  ...walk(path.join(ROOT, "dev-harness")),
  path.join(ROOT, "src/hooks/useFinancialStatementsWorkspace.ts"),
];

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const gitOut = (args: string): string | null => {
  try {
    return execSync(`git ${args}`, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};
const hasMain = gitOut("rev-parse --verify --quiet origin/main") !== null;

describe("database inertness — schema and functions", () => {
  it("adds no migration and defines no financial-statement persistence object anywhere under supabase/", () => {
    const files = [...fs.readdirSync(path.join(ROOT, "supabase/migrations")), ...fs.readdirSync(path.join(ROOT, "supabase/functions"))];
    expect(files.filter((f) => /financial_statement_(reports|evaluations|reviewer_decisions)|financial-statement-workspace/.test(f))).toEqual([]);
  });

  it.skipIf(!hasMain)("changes nothing under supabase/ relative to origin/main (no migration, no Edge Function, no config change)", () => {
    const changed = (gitOut("diff --name-status origin/main...HEAD -- supabase") ?? "").trim();
    expect(changed).toBe("");
  });

  it.skipIf(!hasMain)("changes no automation-deploy surface other than the RLS-regression hardening in ci.yml", () => {
    const changed = (gitOut("diff --name-only origin/main...HEAD -- .github package.json supabase/config.toml .lovable scripts") ?? "").trim().split(/\r?\n/).filter(Boolean).sort();
    // Every file the branch touches in these locations must be part of the reviewed RLS-regression safety hardening.
    const allowed = new Set([".github/workflows/ci.yml", "scripts/ci/stagingGuard.mjs", "scripts/rls_regression.mjs"]);
    expect(changed.filter((f) => !allowed.has(f))).toEqual([]);
  });
});

describe("database inertness — the workspace code cannot mutate a database", () => {
  it("both gates are off in source", () => {
    expect(FINANCIAL_STATEMENT_PERSISTENCE_ENABLED).toBe(false);
    expect(FINANCIAL_STATEMENTS_WORKSPACE_ENABLED).toBe(false);
  });

  it("no workspace source performs a write, RPC, function invocation, storage access, raw network call or deploy command", () => {
    const forbidden: readonly [RegExp, string][] = [
      [/\.(insert|update|upsert|delete)\s*\(/, "table write"],
      [/\.rpc\s*\(/, "rpc call"],
      [/functions\.invoke|\.functions\b/, "edge function invocation"],
      [/\.storage\b/, "storage access"],
      [/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket/, "raw network call"],
      [/service_role|SERVICE_ROLE|SERVICE-ROLE/i, "service-role reference"],
      [/supabase\s+(db|functions|link|migration)|psql\b|db push/i, "database/deploy command"],
    ];
    const offenders: string[] = [];
    for (const f of workspaceSources) {
      const src = stripComments(fs.readFileSync(f, "utf8"));
      for (const [re, what] of forbidden) if (re.test(src)) offenders.push(`${rel(f)}: ${what}`);
    }
    expect(offenders).toEqual([]);
  });

  it("the only Supabase access in workspace code is one read-only select of account_mappings, in the hook", () => {
    const users = workspaceSources.filter((f) => /integrations\/supabase|supabase\.from|createClient/.test(stripComments(fs.readFileSync(f, "utf8")))).map(rel);
    expect(users).toEqual(["src/hooks/useFinancialStatementsWorkspace.ts"]);
    const hook = stripComments(fs.readFileSync(path.join(ROOT, "src/hooks/useFinancialStatementsWorkspace.ts"), "utf8"));
    const calls = [...hook.matchAll(/supabase\s*\.from\(([^)]*)\)([\s\S]{0,400}?)(?=;)/g)];
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe('"account_mappings"');
    expect(calls[0][2]).toMatch(/^\s*\.select\(/);
  });

  it("the remote persistence repository is instantiated by no production module and reads/writes fail closed", () => {
    const users = workspaceSources.filter((f) => /new RemoteFinancialStatementReportRepository/.test(stripComments(fs.readFileSync(f, "utf8")))).map(rel);
    expect(users).toEqual([]);
    const contract = fs.readFileSync(path.join(ROOT, "src/lib/financialStatementsWorkspace/persistenceContract.ts"), "utf8");
    for (const method of ["getLatestByCompanyPeriod", "getByReportId", "getEvaluationRun", "saveReport", "saveEvaluationRun", "appendDecision"]) {
      const body = contract.slice(contract.indexOf(`async ${method}(`));
      expect(body.slice(0, 400), method).toMatch(/assertEnabled\(\)|this\.write\(/);
    }
  });
});
