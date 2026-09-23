/**
 * Static workflow contract + guard behaviour for the write-capable RLS
 * regression suite. That suite creates users, companies and rows in whichever
 * Supabase project it targets, so it must be impossible for pull_request, push
 * or an ordinary branch run to reach it, and impossible to point it at
 * production. Everything here is static or offline: no test contacts Supabase.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { PRODUCTION_PROJECT_REF, StagingGuardError, assertStagingTarget, parseProjectRef } from "../../../scripts/ci/stagingGuard.mjs";

const ROOT = path.join(__dirname, "../../../");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
const workflow = read(".github/workflows/ci.yml");

function jobBlock(name: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start, `job ${name}`).toBeGreaterThan(-1);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}
const jobNames = () => [...workflow.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]).filter((n) => !["pull_request", "push", "workflow_dispatch"].includes(n));
const stepText = (block: string, stepName: string) => {
  const parts = block.split(/\n {6}- name: /);
  return parts.find((p) => p.startsWith(stepName)) ?? "";
};

const rls = jobBlock("rls-regression");
const STAGING_REF = "abcdefghijklmnopqrst"; // synthetic, well-formed, deliberately not any real project

describe("RLS regression workflow contract", () => {
  it("is reachable only through workflow_dispatch: it cannot run on pull_request, push, or any other event", () => {
    const ifLine = rls.match(/^ {4}if: (.*)$/m)?.[1] ?? "";
    expect(ifLine).toBe("${{ github.event_name == 'workflow_dispatch' }}");
    expect(ifLine).not.toMatch(/pull_request|push|schedule|always|failure|success/);
    const runsOn = (event: string) => ifLine === `\${{ github.event_name == '${event}' }}`;
    for (const event of ["pull_request", "push", "pull_request_target", "schedule", "repository_dispatch", "release"]) expect(runsOn(event), event).toBe(false);
    expect(runsOn("workflow_dispatch")).toBe(true);
    // The manual trigger exists, and the dangerous privileged trigger does not.
    expect(workflow).toMatch(/^on:\n(?:.*\n)*? {2}workflow_dispatch:/m);
    expect(workflow).not.toMatch(/pull_request_target/);
  });

  it("requires the protected `staging` environment", () => {
    expect(rls).toMatch(/^ {4}environment: staging$/m);
  });

  it("uses staging-specific secret names only, and no other job or step touches any secret", () => {
    const names = [...workflow.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n, n).toMatch(/^STAGING_SUPABASE_(URL|ANON_KEY|SERVICE_ROLE_KEY)$/);
    expect(workflow).not.toMatch(/secrets\.SUPABASE_|secrets\.(DATABASE|POSTGRES|SERVICE)/);
    for (const name of jobNames().filter((n) => n !== "rls-regression")) expect(jobBlock(name), name).not.toMatch(/secrets\.|environment:|vars\./);
    // Secrets are scoped to steps, never job-level, so install scripts cannot read them.
    const beforeSteps = rls.slice(0, rls.indexOf("    steps:"));
    expect(beforeSteps).not.toMatch(/secrets\./);
  });

  it("runs the fail-closed guard before dependency installation and before the suite, with no bypass", () => {
    const guardAt = rls.indexOf("node scripts/ci/stagingGuard.mjs");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(rls.indexOf("bun install"));
    expect(guardAt).toBeLessThan(rls.indexOf("bun run test:rls"));
    expect(rls).not.toMatch(/continue-on-error|\|\|\s*true|if:\s*(always|failure)/);
    const guardStep = stepText(rls, "Verify the target");
    expect(guardStep).toMatch(/STAGING_SUPABASE_PROJECT_REF: \$\{\{ vars\.STAGING_SUPABASE_PROJECT_REF \}\}/);
    expect(rls).not.toMatch(/PROJECT_REF: [a-z0-9]{20}\b/); // the expected ref is never hard-coded here; nothing is invented
  });

  it("never logs a secret: no shell tracing, env dumps, echoes of variables, or debug logging", () => {
    expect(rls).not.toMatch(/set\s+-[a-z]*x|printenv|\benv\s*\||\bset\s*\||echo\s+[^\n]*(\$\{?STAGING|secrets\.)|ACTIONS_STEP_DEBUG|ACTIONS_RUNNER_DEBUG|cat\s+[^\n]*\.env/);
    const runs = [...rls.matchAll(/^\s+run: (.*)$/gm)].map((m) => m[1]);
    expect(runs).toEqual(["node scripts/ci/stagingGuard.mjs", "bun install --frozen-lockfile", "bun run test:rls", "node scripts/upload_lifecycle_staging.mjs", "node scripts/sweeper_readiness.mjs"]);
  });

  it("does not deploy, push or apply anything to a database", () => {
    expect(workflow).not.toMatch(/supabase\s+(db\s+push|db\s+reset|migration\s+up|functions\s+deploy|link|login)|lovable\s+(publish|deploy)/i);
    expect(workflow).not.toMatch(/SUPABASE_ACCESS_TOKEN|SUPABASE_DB_PASSWORD|DATABASE_URL|POSTGRES_URL/);
  });

  it("keeps every non-mutating check running on pull requests and pushes, with no secrets", () => {
    for (const name of ["migration-audit", "conflict-marker-check", "lint-build-and-typecheck", "golden-tests", "db-contract-tests"]) {
      const block = jobBlock(name);
      expect(block, name).not.toMatch(/^ {4}if:/m);
      expect(block, name).not.toMatch(/secrets\.|environment:/);
    }
    expect(workflow).toMatch(/^on:\n {2}pull_request:\n {4}branches: \[main\]\n {2}push:\n {4}branches: \[main\]/m);
    // The disposable-DB job may only talk to its own throwaway service container.
    expect(jobBlock("db-contract-tests")).toMatch(/PGHOST: localhost/);
  });

  it("the test:rls entry point exists only as the guarded script and nothing else invokes the suite", () => {
    expect(JSON.parse(read("package.json")).scripts["test:rls"]).toBe("node scripts/rls_regression.mjs");
    const invokers = [".github/workflows/ci.yml"].filter((f) => /rls_regression|test:rls/.test(read(f)));
    expect(invokers).toEqual([".github/workflows/ci.yml"]);
  });
});

describe("Upload lifecycle staging proof (PR #32) — same guard, refuses before any client exists", () => {
  const script = read("scripts/upload_lifecycle_staging.mjs");

  it("imports the guard, runs it before createClient is ever called, and reads only STAGING_* variables", () => {
    expect(script).toMatch(/from '\.\/ci\/stagingGuard\.mjs'/);
    expect(script.indexOf("assertStagingTargetFromEnv()")).toBeGreaterThan(-1);
    expect(script.indexOf("assertStagingTargetFromEnv()")).toBeLessThan(script.indexOf("createClient("));
    expect(script).not.toMatch(/process\.env\.SUPABASE_|process\.env\[['"]SUPABASE_/);
    expect(script).toMatch(/process\.env\.STAGING_SUPABASE_URL/);
  });

  it("exits 1 without touching the network when pointed at the production project, and never prints a secret", () => {
    const secret = "sentinel-service-role-secret-value";
    const r = spawnSync(process.execPath, ["scripts/upload_lifecycle_staging.mjs"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 20000,
      env: {
        PATH: process.env.PATH ?? "",
        STAGING_SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
        STAGING_SUPABASE_ANON_KEY: "sentinel-anon-key",
        STAGING_SUPABASE_SERVICE_ROLE_KEY: secret,
        STAGING_SUPABASE_PROJECT_REF: STAGING_REF,
      },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("TARGET_IS_PRODUCTION");
    expect(r.stdout + r.stderr).not.toContain(secret);
    expect(r.stdout).not.toMatch(/PASS|Fixtures/);
  });
});

describe("Sweeper readiness (PR #32) — staging by default, same guard, refuses before any client exists", () => {
  const script = read("scripts/sweeper_readiness.mjs");

  it("runs the guard before createClient in staging mode; the owner mode is explicit (--owner) and never the default", () => {
    expect(script).toMatch(/from '\.\/ci\/stagingGuard\.mjs'/);
    expect(script.indexOf("assertStagingTargetFromEnv()")).toBeGreaterThan(-1);
    expect(script.indexOf("assertStagingTargetFromEnv()")).toBeLessThan(script.indexOf("createClient("));
    expect(script).not.toMatch(/process\.env\.SUPABASE_|process\.env\[['"]SUPABASE_/);
    expect(script).toMatch(/process\.argv\.includes\('--owner'\)/);
  });

  it("exits 1 without touching the network when pointed at the production project, and never prints a secret", () => {
    const secret = "sentinel-service-role-secret-value";
    const r = spawnSync(process.execPath, ["scripts/sweeper_readiness.mjs"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 20000,
      env: {
        PATH: process.env.PATH ?? "",
        STAGING_SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
        STAGING_SUPABASE_ANON_KEY: "sentinel-anon-key",
        STAGING_SUPABASE_SERVICE_ROLE_KEY: secret,
        STAGING_SUPABASE_PROJECT_REF: STAGING_REF,
      },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("TARGET_IS_PRODUCTION");
    expect(r.stdout + r.stderr).not.toContain(secret);
    expect(r.stdout).not.toMatch(/SWEEPER_READINESS: READY/);
  });
});

describe("RLS regression script — refuses before any client exists", () => {
  const script = read("scripts/rls_regression.mjs");

  it("imports the guard, runs it before createClient is ever called, and reads only STAGING_* variables", () => {
    expect(script).toMatch(/from '\.\/ci\/stagingGuard\.mjs'/);
    expect(script.indexOf("assertStagingTargetFromEnv()")).toBeGreaterThan(-1);
    expect(script.indexOf("assertStagingTargetFromEnv()")).toBeLessThan(script.indexOf("createClient(SUPABASE_URL"));
    expect(script).not.toMatch(/process\.env\.SUPABASE_|process\.env\[['"]SUPABASE_/);
    expect(script).toMatch(/process\.env\.STAGING_SUPABASE_URL/);
  });

  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, ["scripts/rls_regression.mjs"], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 20000 });

  it("exits 1 without touching the network when pointed at the production project, and never prints a secret", () => {
    const secret = "sentinel-service-role-secret-value";
    const r = run({
      STAGING_SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
      STAGING_SUPABASE_ANON_KEY: "sentinel-anon-key",
      STAGING_SUPABASE_SERVICE_ROLE_KEY: secret,
      STAGING_SUPABASE_PROJECT_REF: STAGING_REF,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("TARGET_IS_PRODUCTION");
    expect(r.stdout + r.stderr).not.toContain(secret);
    expect(r.stdout + r.stderr).not.toContain("sentinel-anon-key");
    expect(r.stdout).not.toMatch(/created owner|✓/);
  });

  it("ignores generic SUPABASE_* production credentials entirely: with only those set it refuses (exit 1)", () => {
    const r = run({ SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co`, SUPABASE_ANON_KEY: "x", SUPABASE_SERVICE_ROLE_KEY: "prod-secret-value" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("URL_MISSING");
    expect(r.stdout + r.stderr).not.toContain("prod-secret-value");
  });

  it("fails closed when no expected staging project reference is configured (the job stays disabled)", () => {
    const r = run({ STAGING_SUPABASE_URL: `https://${STAGING_REF}.supabase.co`, STAGING_SUPABASE_ANON_KEY: "x", STAGING_SUPABASE_SERVICE_ROLE_KEY: "y" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("EXPECTED_REF_MISSING");
    expect(r.stderr).toContain("disabled until an explicit staging project reference is provided");
  });

  it("the guard CLI used by the workflow behaves the same and exits non-zero on production", () => {
    const r = spawnSync(process.execPath, ["scripts/ci/stagingGuard.mjs"], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", STAGING_SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co`, STAGING_SUPABASE_PROJECT_REF: PRODUCTION_PROJECT_REF }, encoding: "utf8", timeout: 20000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/EXPECTED_REF_IS_PRODUCTION/);
  });
});

describe("staging guard", () => {
  const cfg = (over: Record<string, unknown> = {}) => ({ url: `https://${STAGING_REF}.supabase.co`, expectedRef: STAGING_REF, anonKey: "opaque", serviceRoleKey: "opaque", ...over });
  const code = (over: Record<string, unknown>): string => {
    try {
      assertStagingTarget(cfg(over));
    } catch (e) {
      return e instanceof StagingGuardError ? e.code : "OTHER";
    }
    return "PASSED";
  };
  const jwt = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

  it("its production reference is exactly the project_id in supabase/config.toml (drift is detected)", () => {
    expect(read("supabase/config.toml")).toMatch(new RegExp(`^project_id = "${PRODUCTION_PROJECT_REF}"$`, "m"));
    expect(PRODUCTION_PROJECT_REF).toBe("bvyivmmfjejbmqoydezk");
  });

  it("accepts only the explicitly expected staging project", () => {
    expect(code({})).toBe("PASSED");
    expect(parseProjectRef(`https://${STAGING_REF}.supabase.co`)).toBe(STAGING_REF);
  });

  it("rejects the production project as the target, as the expected value, and in any spelling", () => {
    expect(code({ url: `https://${PRODUCTION_PROJECT_REF}.supabase.co` })).toBe("TARGET_IS_PRODUCTION");
    expect(code({ url: `https://${PRODUCTION_PROJECT_REF.toUpperCase()}.SUPABASE.CO/` })).toBe("TARGET_IS_PRODUCTION");
    expect(code({ url: `https://${PRODUCTION_PROJECT_REF}.supabase.co`, expectedRef: PRODUCTION_PROJECT_REF })).toBe("EXPECTED_REF_IS_PRODUCTION");
    expect(code({ expectedRef: PRODUCTION_PROJECT_REF })).toBe("EXPECTED_REF_IS_PRODUCTION");
  });

  it("requires an explicit expected staging reference: none, blank or malformed all refuse", () => {
    expect(code({ expectedRef: undefined })).toBe("EXPECTED_REF_MISSING");
    expect(code({ expectedRef: "" })).toBe("EXPECTED_REF_MISSING");
    expect(code({ expectedRef: "   " })).toBe("EXPECTED_REF_MISSING");
    expect(code({ expectedRef: "short" })).toBe("EXPECTED_REF_MALFORMED");
    expect(code({ expectedRef: "ABCDEFGHIJKLMNOPQRST" })).toBe("EXPECTED_REF_MALFORMED");
  });

  it("refuses any target that is not the expected staging project", () => {
    expect(code({ url: "https://zzzzzzzzzzzzzzzzzzzz.supabase.co" })).toBe("TARGET_MISMATCH");
  });

  it("rejects empty or malformed URLs and project references", () => {
    expect(code({ url: undefined })).toBe("URL_MISSING");
    expect(code({ url: "" })).toBe("URL_MISSING");
    expect(code({ url: "not a url" })).toBe("URL_MALFORMED");
    expect(code({ url: `http://${STAGING_REF}.supabase.co` })).toBe("URL_MALFORMED");
    expect(code({ url: `https://user:pw@${STAGING_REF}.supabase.co` })).toBe("URL_MALFORMED");
    expect(code({ url: `https://${STAGING_REF}.supabase.co:8443` })).toBe("URL_MALFORMED");
    expect(code({ url: `https://${STAGING_REF}.supabase.co/rest/v1` })).toBe("URL_MALFORMED");
    expect(code({ url: `https://${STAGING_REF}.supabase.co.evil.example` })).toBe("PROJECT_REF_MALFORMED");
    expect(code({ url: `https://evil.example/${STAGING_REF}.supabase.co` })).toBe("URL_MALFORMED");
    expect(code({ url: "https://short.supabase.co" })).toBe("PROJECT_REF_MALFORMED");
    expect(code({ url: "https://localhost" })).toBe("PROJECT_REF_MALFORMED");
    expect(code({ url: `https://${STAGING_REF}.supabase.com` })).toBe("PROJECT_REF_MALFORMED");
  });

  it("cross-checks legacy JWT keys: a key for another project, or with the wrong role, is refused", () => {
    expect(code({ serviceRoleKey: jwt({ ref: PRODUCTION_PROJECT_REF, role: "service_role" }) })).toBe("KEY_PROJECT_MISMATCH");
    expect(code({ anonKey: jwt({ ref: "zzzzzzzzzzzzzzzzzzzz", role: "anon" }) })).toBe("KEY_PROJECT_MISMATCH");
    expect(code({ serviceRoleKey: jwt({ ref: STAGING_REF, role: "anon" }) })).toBe("KEY_ROLE_MISMATCH");
    expect(code({ anonKey: jwt({ ref: STAGING_REF, role: "anon" }), serviceRoleKey: jwt({ ref: STAGING_REF, role: "service_role" }) })).toBe("PASSED");
  });

  it("failure messages never contain the configured URL, keys or project reference", () => {
    const url = `https://${PRODUCTION_PROJECT_REF}.supabase.co`;
    const serviceRoleKey = "very-secret-service-role";
    for (const over of [{ url, serviceRoleKey }, { expectedRef: PRODUCTION_PROJECT_REF, serviceRoleKey }, { url: "https://zzzzzzzzzzzzzzzzzzzz.supabase.co", serviceRoleKey }]) {
      try {
        assertStagingTarget(cfg(over));
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).not.toContain(serviceRoleKey);
        expect(msg).not.toContain("zzzzzzzzzzzzzzzzzzzz");
        expect(msg).not.toContain(STAGING_REF);
        expect(msg).not.toContain("supabase.co");
      }
    }
  });
});
