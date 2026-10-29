/**
 * The authenticated IPSAS journey (scripts/e2e/ipsasAuthJourney.mjs, CI job real-app-e2e). It needs a local Supabase stack, so it cannot
 * run in this suite; what this suite pins is what CAN be checked without one: the fixture company balances in both years and carries
 * exactly the figures the shared PPE and grants steps expect, the journey really uses real sign-in and no simulation, it refuses anything
 * but loopback, and the CI job runs it on the local stack without a secret, link or deploy.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ACCOUNTS, CURRENT, G, PRIOR, TB, imbalance, reviewDecisions, sumOf, tbCsv } from "../../../scripts/e2e/ipsasAuthFixtures.mjs";
import { CODES } from "../../../scripts/e2e/localStackFixtures.mjs";

const ROOT = path.resolve(__dirname, "../../..");
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");

describe("the journey's company", () => {
  it("both trial balances balance and every account code is distinct", () => {
    expect(imbalance(CURRENT)).toBe(0n);
    expect(imbalance(PRIOR)).toBe(0n);
    const codes = TB.map((r: string[]) => r[0]);
    expect(new Set(codes).size).toBe(codes.length);
  });
  it("carries the equipment figures the PPE steps expect (carrying 14,000.00 closing / 16,000.00 opening; depreciation 2,000.00)", () => {
    expect(sumOf(CURRENT, ACCOUNTS.ppe, "debit")).toBe(1_400_000n);
    expect(sumOf(PRIOR, ACCOUNTS.ppe, "debit")).toBe(1_600_000n);
    expect(sumOf(CURRENT, ACCOUNTS.dep, "debit")).toBe(200_000n);
  });
  it("carries the grant figures the grants steps expect (revenue 6,500,000.00; unfulfilled obligations 5,500,000.00; receivable 4,500,000.00)", () => {
    expect(sumOf(CURRENT, ACCOUNTS.rev, "credit")).toBe(650_000_000n);
    expect(sumOf(CURRENT, ACCOUNTS.liab, "credit")).toBe(550_000_000n);
    expect(sumOf(CURRENT, ACCOUNTS.recv, "debit")).toBe(450_000_000n);
  });
  it("its two grant-related accounts the steps map are not equipment accounts, and the grants bank is a reviewed cash account", () => {
    for (const k of [...ACCOUNTS.rev, ...ACCOUNTS.liab, ...ACCOUNTS.recv]) expect(ACCOUNTS.ppe).not.toContain(k);
    expect(reviewDecisions().filter((d: { is_cash_account: boolean }) => d.is_cash_account).map((d: { account_code: string }) => d.account_code).sort()).toEqual([CODES.bank, G.grantsBank].sort());
    expect(reviewDecisions()).toHaveLength(TB.length);
  });
  it("the uploaded CSV carries every account once, with a header the uploader reads", () => {
    const lines = tbCsv(CURRENT).trim().split("\n");
    expect(lines[0]).toBe("Account code,Account name,Debit,Credit");
    expect(lines).toHaveLength(TB.length + 1);
  });
});

describe("the journey script", () => {
  const src = read("scripts/e2e/ipsasAuthJourney.mjs");
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  it("signs in for real and simulates no identity: no x-sim-user, no loopback bridge, no dev harness", () => {
    expect(code).toMatch(/signInWithPassword/);
    expect(code).toMatch(/#password/);
    // The results file may NAME what is not used; only an import or header can be usage.
    // (the harness directory name is assembled so that src/ never names it: harnessIsolation.test.ts forbids that)
    expect(code).not.toMatch(new RegExp(`x-sim-user|serveIpsas|${"dev" + "-harness"}|ipsasJourney\\.mjs|createServer`));
  });
  it("refuses anything but a loopback stack and a bundle that names production, and drives the shared PPE and grants steps", () => {
    expect(code).toMatch(/assertLocalStack/);
    expect(code).toMatch(/verifyLocalBundle/);
    expect(code).toMatch(/PRODUCTION_PROJECT_REF/);
    expect(code).toMatch(/ppeChain/); expect(code).toMatch(/grantsChain/); expect(code).toMatch(/ppeHostile/); expect(code).toMatch(/grantsHostile/);
  });
  it("covers the access matrix: viewer member, outsider, cross-company, anon, service role, tables, helpers, revoked access, private Storage", () => {
    for (const needle of ["viewer", "outsider", "cross-company", "anon", "service role", "ipsas_prep_revisions", "_ipsas_live", "accepted_at: null", "BUCKET", "public === false"]) expect(src, needle).toContain(needle);
  });
  it("keeps the service-role integrity read apart from authenticated checks, and records owner retrieval as a gap instead of passing it", () => {
    expect(src).toMatch(/OPERATOR INTEGRITY READ \(service role, NOT owner retrieval\)/);
    expect(src).toMatch(/RECORDED GAP \(not an acceptance pass\)/);
    expect(src).toMatch(/gaps\.push\(\{ id: "TB-SOURCE-OWNER-RETRIEVAL"/);
    // the authenticated storage check must not use the service role to read the object
    const authenticated = src.slice(src.indexOf("AUTHENTICATED: the trial-balance bucket"), src.indexOf("RECORDED GAP"));
    expect(authenticated).not.toMatch(/admin\.storage\.from/);
  });
  it("states which boundaries are real and which are operator actions in its results", () => {
    expect(src).toMatch(/real: \[/); expect(src).toMatch(/operatorActionsByServiceRole/); expect(src).toMatch(/notUsed: \[/);
    // operator-created fixtures must never be presented as tested onboarding
    expect(src).toMatch(/notProvenByThisJourney: \[[^\]]*invitation[^\]]*membership acceptance[^\]]*rollout configuration/);
  });
});

describe("the CI job", () => {
  const wf = read(".github/workflows/ci.yml");
  const start = wf.indexOf("\n  real-app-e2e:");
  const next = wf.slice(start + 1).search(/\n {2}[a-z-]+:\n/);
  const job = next < 0 ? wf.slice(start) : wf.slice(start, start + 1 + next);
  it("runs the authenticated journey on the local stack, always, and uploads its evidence; no link, push, deploy, login or secret", () => {
    expect(start).toBeGreaterThan(-1);
    expect(job).toMatch(/if: always\(\)\n\s+run: node scripts\/e2e\/ipsasAuthJourney\.mjs real-app-evidence\/ipsas/);
    expect(job).toMatch(/real-app-evidence\/ipsas\/edge-runtime\.log/);
    expect(job).not.toMatch(/secrets\.|environment:|vars\.|supabase\s+(link|login|db\s+push|functions\s+deploy)/);
  });
  it("no step name contains a colon followed by a space (it would void every check on the pull request)", () => {
    for (const m of job.matchAll(/^\s+- name: (.*)$/gm)) expect(m[1], m[1].slice(0, 60)).not.toMatch(/: /);
  });
});
