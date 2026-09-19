// Offline proof of the hosted-staging acceptance harness. No network, no Supabase project.
//
// A hosted staging project may not exist yet, so what can be proven here is the HARNESS: that it
// refuses to run without an explicit staging target, that it can never touch production, that it
// never counts a skipped or manual check as passed, and — with an in-memory model of GoTrue +
// PostgREST + RLS — that it FAILS (with the right check named) for every way the real stack could be
// mis-exposed. This is not hosted acceptance and is never reported as such.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
// @ts-expect-error — plain ESM script without types
import { INTERNAL_FUNCTIONS, jwtClaims, runAcceptance } from "../../../scripts/hosted-staging/acceptance.mjs";
import { PRODUCTION_PROJECT_REF } from "../../../scripts/ci/stagingGuard.mjs";

const ROOT = path.join(__dirname, "../../../");
const STAGING_REF = "abcdefghijklmnopqrst"; // synthetic, well-formed, not any real project
const URL_ = `https://${STAGING_REF}.supabase.co`;
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: Record<string, unknown>) => `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u(claims)}.sig`;
const ANON = jwt({ role: "anon", ref: STAGING_REF });
const SERVICE = jwt({ role: "service_role", ref: STAGING_REF });
const ZERO = "00000000-0000-0000-0000-000000000000";

interface Faults {
  exposeInternal?: boolean;
  anonOpen?: boolean;
  tableWritable?: boolean;
  outsiderReads?: boolean;
  defaultEnabled?: boolean;
  writeWhileDisabled?: boolean;
  outsiderWrites?: boolean;
  outsiderLists?: boolean;
  wrongRole?: boolean;
  noSignIn?: boolean;
}

/** A tiny in-memory GoTrue + PostgREST + RLS, with optional faults. */
function world(f: Faults = {}) {
  const users = new Map<string, { id: string; email: string; password: string }>();
  const members = new Map<string, Set<string>>(); // company -> user ids
  const enabled = new Set<string>();
  const evidence: { id: string; company: string }[] = [];
  const log: string[] = [];
  const res = (status: number, body: unknown = null) => ({ status, json: async () => body });
  const who = (auth: string | null) => {
    const t = auth?.replace(/^Bearer /, "") ?? "";
    const c = jwtClaims(t) as { role?: string; sub?: string } | null;
    return { role: c?.role ?? "anon", sub: c?.sub ?? null, isService: t === SERVICE };
  };
  const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const u = new URL(url);
    const p = u.pathname;
    const body = init.body ? JSON.parse(init.body) : {};
    const me = who(init.headers.authorization);
    log.push(`${init.method} ${p}`);
    if (p === "/auth/v1/admin/users" && init.method === "POST") {
      if (!me.isService) return res(403);
      const id = crypto.randomUUID();
      users.set(id, { id, email: body.email, password: body.password });
      return res(200, { id });
    }
    if (p.startsWith("/auth/v1/admin/users/") && init.method === "DELETE") return res(200, {});
    if (p === "/auth/v1/token") {
      if (f.noSignIn) return res(400, { error: "invalid" });
      const user = [...users.values()].find((x) => x.email === body.email && x.password === body.password);
      if (!user) return res(400, { error: "invalid" });
      return res(200, { access_token: jwt({ role: f.wrongRole ? "anon" : "authenticated", aud: "authenticated", sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600, iss: `${URL_}/auth/v1` }) });
    }
    if (p === "/rest/v1/companies" && init.method === "POST") {
      if (me.role !== "authenticated") return res(401);
      const id = crypto.randomUUID();
      members.set(id, new Set([me.sub!]));
      return res(201, [{ id }]);
    }
    if (p.startsWith("/rest/v1/rpc/")) {
      const fn = p.slice("/rest/v1/rpc/".length);
      if (INTERNAL_FUNCTIONS.some(([n]: [string]) => n === fn)) {
        if (fn === "fs_set_company_rollout" && me.isService) {
          body.p_enabled ? enabled.add(body.p_company_id) : enabled.delete(body.p_company_id);
          return res(200, null);
        }
        return f.exposeInternal ? res(200, null) : res(404, { code: "PGRST202" });
      }
      if (me.role === "anon" && !me.isService) return f.anonOpen ? res(200, null) : res(401, { message: "permission denied" });
      const company = body.p_company_id as string;
      const member = !!company && members.get(company)?.has(me.sub ?? "");
      if (fn === "financial_statements_workspace_access") {
        if (!member) return res(200, { enabled: false, reason: "NOT_A_MEMBER" });
        const on = f.defaultEnabled || enabled.has(company);
        return res(200, { enabled: on, reason: on ? "ENABLED" : "NOT_ALLOWLISTED" });
      }
      if (fn === "fs_list_saved_versions") return member || f.outsiderLists ? res(200, []) : res(403, { code: "42501", message: "FORBIDDEN" });
      if (fn === "fs_ingest_evidence_batch") {
        if (!member && !f.outsiderWrites) return res(403, { code: "42501", message: "FORBIDDEN" });
        if (!(f.defaultEnabled || enabled.has(company)) && !f.writeWhileDisabled) return res(403, { code: "PT403", message: "FEATURE_DISABLED" });
        evidence.push({ id: body.p_evidence_batch_id, company });
        return res(200, { evidence_batch_id: body.p_evidence_batch_id });
      }
      return res(404);
    }
    if (p.startsWith("/rest/v1/")) {
      const table = p.slice("/rest/v1/".length);
      if (init.method === "GET" && table === "financial_evidence_batches") {
        const id = u.searchParams.get("evidence_batch_id")?.replace("eq.", "");
        const rows = evidence.filter((e) => e.id === id && (members.get(e.company)?.has(me.sub ?? "") || f.outsiderReads));
        return res(200, rows);
      }
      return f.tableWritable ? res(200, [{ x: 1 }]) : res(403, { code: "42501" });
    }
    return res(404);
  };
  return { fetchImpl, log, evidence };
}

const env = { STAGING_SUPABASE_URL: URL_, STAGING_SUPABASE_ANON_KEY: ANON, STAGING_SUPABASE_SERVICE_ROLE_KEY: SERVICE, STAGING_SUPABASE_PROJECT_REF: STAGING_REF };
const go = (f: Faults = {}) => runAcceptance({ env, fetchImpl: world(f).fetchImpl });
const statusOf = (r: { results: { id: string; status: string }[] }, id: string) => r.results.find((x) => x.id === id)?.status;

describe("hosted-staging acceptance harness — a correctly configured stack", () => {
  it("passes every automated check and leaves the realtime check MANUAL_PENDING — never a bare PASS", async () => {
    const r = await go();
    expect(r.results.filter((x: { status: string }) => x.status === "FAIL"), JSON.stringify(r.results)).toEqual([]);
    expect(r.overall).toBe("AUTOMATED_PASS_MANUAL_REALTIME_PENDING");
    expect(statusOf(r, "REALTIME_PUBLICATION_EXCLUDES_HISTORY_TABLES")).toBe("MANUAL_PENDING");
    for (const id of ["GOTRUE_ADMIN_CREATE_USERS", "GOTRUE_PASSWORD_SIGN_IN", "JWT_ROLE_CLAIMS", "POSTGREST_INTERNALS_NOT_EXPOSED", "POSTGREST_ANON_DENIED", "POSTGREST_HISTORY_TABLES_NOT_WRITABLE", "FEATURE_DEFAULT_DENIED", "WRITE_REFUSED_WHILE_DISABLED", "SERVICE_ROLE_ENABLES_COMPANY", "AUTHENTICATED_WRITE_ROUNDTRIP", "OUTSIDER_WRITE_REFUSED", "RLS_MEMBER_READS_OWN_ROWS", "RLS_OUTSIDER_SEES_NOTHING", "RLS_OUTSIDER_CANNOT_LIST_VERSIONS"]) {
      expect(statusOf(r, id), id).toBe("PASS");
    }
  });

  it("deactivates the rollout it enabled and removes its users; it says the append-only rows remain", async () => {
    const r = await go();
    expect(r.cleanup).toContain("rollout deactivated");
    expect(r.cleanup.filter((c: string) => c === "user removed")).toHaveLength(2);
  });

  it("never puts a password, token or key into its log", async () => {
    const lines: string[] = [];
    await runAcceptance({ env, fetchImpl: world().fetchImpl, log: (l: string) => lines.push(l) });
    const all = lines.join("\n");
    expect(all).not.toContain(ANON);
    expect(all).not.toContain(SERVICE);
    expect(all).not.toMatch(/eyJ[\w-]{10,}|Bearer /);
  });
});

describe("hosted-staging acceptance harness — every mis-exposure is caught and named", () => {
  it.each([
    ["an internal function callable by authenticated", { exposeInternal: true }, "POSTGREST_INTERNALS_NOT_EXPOSED"],
    ["the persistence RPCs open to anon", { anonOpen: true }, "POSTGREST_ANON_DENIED"],
    ["a history table writable through REST", { tableWritable: true }, "POSTGREST_HISTORY_TABLES_NOT_WRITABLE"],
    ["an outsider reading a member's rows (RLS broken)", { outsiderReads: true }, "RLS_OUTSIDER_SEES_NOTHING"],
    ["the feature on by default", { defaultEnabled: true }, "FEATURE_DEFAULT_DENIED"],
    ["a write accepted while the company is not allowlisted", { writeWhileDisabled: true }, "WRITE_REFUSED_WHILE_DISABLED"],
    ["a non-member allowed to write", { outsiderWrites: true }, "OUTSIDER_WRITE_REFUSED"],
    ["a non-member allowed to list versions", { outsiderLists: true }, "RLS_OUTSIDER_CANNOT_LIST_VERSIONS"],
    ["a session whose JWT does not carry the authenticated role", { wrongRole: true }, "JWT_ROLE_CLAIMS"],
  ] as const)("%s → %s fails and the overall result is FAILED", async (_n, faults, check) => {
    const r = await go(faults as Faults);
    expect(statusOf(r, check), check).toBe("FAIL");
    expect(r.overall).toBe("FAILED");
  });

  it("a stack where sign-in does not work fails at GoTrue and runs nothing further", async () => {
    const w = world({ noSignIn: true });
    const r = await runAcceptance({ env, fetchImpl: w.fetchImpl });
    expect(statusOf(r, "GOTRUE_PASSWORD_SIGN_IN")).toBe("FAIL");
    expect(r.overall).toBe("FAILED");
    expect(w.log.some((l) => l.startsWith("POST /rest/v1/"))).toBe(false);
  });
});

describe("hosted-staging acceptance CLI — refuses before any request", () => {
  const cli = (e: Record<string, string>) => spawnSync(process.execPath, ["scripts/hosted-staging/acceptance.mjs"], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", ...e }, encoding: "utf8", timeout: 20000 });

  it("without a staging project it reports BLOCKED_MISSING_STAGING_PROJECT (exit 2) and runs nothing", () => {
    const r = cli({});
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("HOSTED_STAGING_RESULT=BLOCKED_MISSING_STAGING_PROJECT");
    expect(r.stdout).not.toMatch(/✓|created/);
  });

  it("ignores generic SUPABASE_* credentials entirely", () => {
    const r = cli({ SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: "prod-secret-value" });
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).not.toContain("prod-secret-value");
  });

  it("refuses the production project even when it is configured as the staging one", () => {
    const secret = "sentinel-service-role";
    const r = cli({ STAGING_SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co`, STAGING_SUPABASE_ANON_KEY: "sentinel-anon", STAGING_SUPABASE_SERVICE_ROLE_KEY: secret, STAGING_SUPABASE_PROJECT_REF: STAGING_REF });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("HOSTED_STAGING_RESULT=REFUSED_TARGET_IS_PRODUCTION");
    expect(r.stdout + r.stderr).not.toContain(secret);
    expect(r.stdout + r.stderr).not.toContain("sentinel-anon");
  });

  it("refuses a target that is not the expected staging project", () => {
    const r = cli({ STAGING_SUPABASE_URL: `https://zzzzzzzzzzzzzzzzzzzz.supabase.co`, STAGING_SUPABASE_ANON_KEY: "a", STAGING_SUPABASE_SERVICE_ROLE_KEY: "b", STAGING_SUPABASE_PROJECT_REF: STAGING_REF });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("REFUSED_TARGET_MISMATCH");
  });
});

describe("hosted-staging acceptance — static contract", () => {
  const script = fs.readFileSync(path.join(ROOT, "scripts/hosted-staging/acceptance.mjs"), "utf8").replace(/\r\n/g, "\n");

  it("runs the guard before any request and reads only STAGING_* variables", () => {
    expect(script).toMatch(/from '\.\.\/ci\/stagingGuard\.mjs'/);
    expect(script.indexOf("assertStagingTargetFromEnv()")).toBeGreaterThan(-1);
    expect(script.lastIndexOf("assertStagingTargetFromEnv()")).toBeLessThan(script.lastIndexOf("await runAcceptance("));
    expect(script).not.toMatch(/process\.env\.SUPABASE_|process\.env\[['"]SUPABASE_/);
    expect(script).not.toContain(PRODUCTION_PROJECT_REF);
    expect(script).not.toMatch(/console\.(log|error)\([^)]*(password|serviceKey|anonKey|token)/i);
  });

  it("never reports a bare PASS, and reserves the realtime check as manual", () => {
    expect(script).not.toMatch(/HOSTED_STAGING_RESULT=PASS\b/);
    expect(script).toContain("AUTOMATED_PASS_MANUAL_REALTIME_PENDING");
    expect(script).toContain("MANUAL_PENDING");
  });

  it("the argument names it sends to internal functions match the real SQL signatures (so a refusal is for the right reason)", () => {
    const sql = ["20260919100000_financial_statements_rollout_control.sql", "20260919110000_financial_statements_persistence.sql"].map((f) => fs.readFileSync(path.join(ROOT, "supabase/migrations", f), "utf8").replace(/\r\n/g, "\n")).join("\n");
    for (const [fn, args] of INTERNAL_FUNCTIONS as [string, Record<string, unknown>][]) {
      const m = sql.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(([\\s\\S]*?)\\)\\s*\\n\\s*RETURNS`));
      expect(m, fn).not.toBeNull();
      const declared = [...m![1].matchAll(/\b(p_\w+)\s+[A-Z]/g)].map((x) => x[1]).sort();
      expect(Object.keys(args).sort(), fn).toEqual(declared);
    }
    void ZERO;
  });
});
