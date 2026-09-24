/**
 * browserAcceptance.test.ts — the offline guarantees of the staging browser-acceptance suite
 * (scripts/browser_acceptance.mjs): production is detected in any request, the bundle check fails closed, the
 * suite refuses a production target before any client or browser exists, and it never prints a secret.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { classifyRequests } from "../../../scripts/browser-acceptance/checks.mjs";
import { verifyBundle } from "../../../scripts/browser-acceptance/stagingFrontend.mjs";

const STAGING = "hplriydtdelehepgttul";
const PROD = "bvyivmmfjejbmqoydezk";
const ROOT = path.join(__dirname, "../../../");

describe("classifyRequests", () => {
  it("any production reference anywhere in a URL is flagged", () => {
    const r = classifyRequests([`https://${PROD}.supabase.co/rest/v1/x`, `http://127.0.0.1:4173/?ref=${PROD}`, `https://${STAGING}.supabase.co/auth/v1/token`], STAGING);
    expect(r.production).toHaveLength(2);
    expect(r.staging).toHaveLength(1);
  });
  it("any other Supabase project (HTTP or realtime WebSocket) is flagged; staging and non-Supabase hosts are not", () => {
    const r = classifyRequests([`wss://abcdefghijklmnopqrst.supabase.co/realtime/v1`, `wss://${STAGING}.supabase.co/realtime/v1`, "https://fonts.gstatic.com/x.woff2"], STAGING);
    expect(r.otherSupabase).toEqual(["wss://abcdefghijklmnopqrst.supabase.co/realtime/v1"]);
  });
});

describe("verifyBundle", () => {
  it("passes only a bundle that names staging and never production", () => {
    expect(verifyBundle([`const u="https://${STAGING}.supabase.co"`], STAGING)).toEqual([]);
    expect(verifyBundle([`const u="https://${STAGING}.supabase.co"`, `x="${PROD}"`], STAGING)).toContain("PRODUCTION_REF_IN_BUNDLE");
    expect(verifyBundle(["nothing here"], STAGING)).toContain("STAGING_URL_NOT_IN_BUNDLE");
    expect(verifyBundle([`https://${PROD}.supabase.co`], PROD)).toContain("STAGING_REF_INVALID");
  });
});

describe("the suite itself", () => {
  const script = fs.readFileSync(path.join(ROOT, "scripts/browser_acceptance.mjs"), "utf8");
  it("runs the staging guard before any client, frontend build or browser exists, and reads only STAGING_* variables", () => {
    const guard = script.indexOf("assertStagingTargetFromEnv()");
    expect(guard).toBeGreaterThan(-1);
    for (const later of ["createClient(", "buildStagingFrontend(", "Browser.launch("]) expect(guard).toBeLessThan(script.indexOf(later));
    expect(script).not.toMatch(/process\.env\.SUPABASE_|process\.env\[['"]SUPABASE_/);
    expect(script).not.toMatch(/console\.(log|error)\([^)]*(password|SERVICE|ANON|access_token)/);
  });
  it("builds the frontend with no readable .env (empty envDir) and verifies the bundle before serving it", () => {
    const fe = fs.readFileSync(path.join(ROOT, "scripts/browser-acceptance/stagingFrontend.mjs"), "utf8");
    expect(fe).toMatch(/envDir: emptyEnvDir/);
    expect(fe).toMatch(/verifyBundle\(texts, ref\)/);
    expect(fe).toMatch(/ref === PRODUCTION_PROJECT_REF\) throw/);
  });
  it("fails closed on production requests, cleanup, screenshots and the tested commit", () => {
    expect(script).toMatch(/record\(`no request reached production/);
    expect(script).toMatch(/record\('cleanup left zero storage objects/);
    expect(script).toMatch(/record\(`screenshots captured/);
    expect(script).toMatch(/tested commit .* differs from PR/);
    expect(script).toMatch(/process\.exit\(ok \? 0 : 1\)/);
  });
  it("exits 1 before touching the network when pointed at production, and never prints a secret", () => {
    const secret = "sentinel-service-role-secret-value";
    const r = spawnSync(process.execPath, ["scripts/browser_acceptance.mjs"], {
      cwd: ROOT, encoding: "utf8", timeout: 20000,
      env: { PATH: process.env.PATH ?? "", STAGING_SUPABASE_URL: `https://${PROD}.supabase.co`, STAGING_SUPABASE_ANON_KEY: "sentinel-anon", STAGING_SUPABASE_SERVICE_ROLE_KEY: secret, STAGING_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst" },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("TARGET_IS_PRODUCTION");
    expect(r.stdout + r.stderr).not.toContain(secret);
    expect(r.stdout).not.toMatch(/PASS|Owner journey/);
  });
});
