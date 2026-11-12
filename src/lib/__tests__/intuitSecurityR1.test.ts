/**
 * intuit-security-r1 (docs/release/intuit-security-r1/RECORD.md): static guards for the Intuit security-requirement changes.
 * The behaviour is proven elsewhere: scripts/db-proof/apiCacheHeaders.mjs (a real PostgREST), scripts/e2e/sourceDownloadJourney.mjs and
 * localStackJourney.mjs (the local Supabase stack in CI), scripts/db-proof/qboRealmProtectionCandidate.mjs (the inert realm candidate).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openRealm, realmIndex, sealRealm, REALM_INDEX_SHAPE } from "../../../release/candidates/qbo-realm-protection-r0/realmProtection";
import { QBO_CONNECTOR_ENABLED } from "../workspace/qboConnectorClient";

const ROOT = path.resolve(__dirname, "../../..");
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");
const MIGRATION = "supabase/migrations/20261215100000_api_cache_control_headers.sql";
const NO_CACHE_FUNCTIONS = ["qbo-connect-start", "qbo-disconnect", "qbo-finish-connection", "qbo-oauth-callback", "qbo-pull-trial-balance",
  "trial-balance-draft", "trial-balance-source-download", "trial-balance-source-signer"];
/** Functions that still send no-store only (not QuickBooks and not serving workspace data to a browser): listed in the record, changed deliberately. */
const STILL_NO_STORE_ONLY = ["supabase/functions/_shared/serviceEnquiryHandler.ts", "supabase/functions/issue-enquiry-challenge/index.ts",
  "supabase/functions/trial-balance-source-sweeper/index.ts", "supabase/functions/trial-balance-storage-cleanup/index.ts"];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p, out); else if (/\.(ts|mjs|sql)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("Edge Function Cache-Control (Intuit: no-cache and no-store, never private)", () => {
  it("the QuickBooks functions and the trial-balance file/draft functions send exactly no-cache, no-store", () => {
    for (const fn of NO_CACHE_FUNCTIONS) {
      const src = read(`supabase/functions/${fn}/index.ts`);
      expect(src, fn).toMatch(/"Cache-Control": ("no-cache, no-store"|NO_CACHE)/);
      expect(src, fn).not.toMatch(/"Cache-Control": "no-store"/);
    }
    expect(read("supabase/functions/_shared/sourceDownload.ts")).toContain('export const NO_CACHE = "no-cache, no-store";');
  });
  it("no function anywhere sends private, public or max-age caching; the no-store-only set is exactly the listed one", () => {
    const files = walk("supabase/functions").filter((f) => f.endsWith(".ts"));
    const values = files.flatMap((f) => [...read(f).matchAll(/"Cache-Control":\s*"([^"]*)"/g)].map((m) => [f, m[1]] as const));
    expect(values.filter(([, v]) => /private|public|max-age/i.test(v))).toEqual([]);
    expect(values.filter(([, v]) => v === "no-store").map(([f]) => f).sort()).toEqual(STILL_NO_STORE_ONLY);
  });
  it("the OAuth callback keeps its Referrer-Policy and Location; every function keeps its CORS and content type", () => {
    const cb = read("supabase/functions/qbo-oauth-callback/index.ts");
    expect(cb).toContain('const noStore = { "Cache-Control": "no-cache, no-store", "Referrer-Policy": "no-referrer" };');
    expect(cb).toContain("headers: { ...noStore, Location: result.location }");
    for (const fn of NO_CACHE_FUNCTIONS.filter((f) => f !== "qbo-oauth-callback")) expect(read(`supabase/functions/${fn}/index.ts`), fn).toMatch(/\.\.\.corsHeaders, "Content-Type": "application\/json", "Cache-Control"/);
  });
  it("customer QuickBooks access stays off", () => expect(QBO_CONNECTOR_ENABLED).toBe(false));
});

describe("the PostgREST pre-request hook migration", () => {
  const sql = read(MIGRATION);
  const body = sql.slice(sql.indexOf("CREATE FUNCTION public.api_cache_control_pre_request()"), sql.indexOf("$mapi_cache_headersaab$;"));
  it("sets exactly Cache-Control: no-cache, no-store, appending to (never discarding) any earlier response.headers", () => {
    expect(body.match(/\[\{"Cache-Control": "no-cache, no-store"\}\]/g)?.length).toBe(2);
    expect(body).toContain("OPERATOR(pg_catalog.||)");
  });
  it("reads and writes no table, is SECURITY INVOKER with no SET clause, and touches only response.headers", () => {
    const code = body.replace(/--[^\n]*/g, "");
    expect(code).not.toMatch(/\b(FROM|JOIN|INSERT|UPDATE|DELETE|TRUNCATE|EXECUTE)\b/i);
    expect(code).toMatch(/SECURITY INVOKER/);
    expect(code).not.toMatch(/\n\s*SET\s/i);
    expect([...code.matchAll(/set_config\('([^']+)'/g)].map((m) => m[1])).toEqual(["response.headers", "response.headers"]);
  });
  it("refuses when ANY pre-request hook is already configured, and wires only authenticator", () => {
    const code = sql.replace(/^--[^\n]*$/gm, "");
    expect(sql).toContain("WHERE c LIKE 'pgrst.db\\_pre\\_request=%'");
    expect(sql).toContain("API_PRE_REQUEST_HOOK_ALREADY_CONFIGURED");
    expect(code.match(/ALTER ROLE/g)).toEqual(["ALTER ROLE"]);
    expect(sql).toContain("ALTER ROLE authenticator SET pgrst.db_pre_request = 'public.api_cache_control_pre_request';");
    expect(code).not.toMatch(/\b(POLICY|ROW LEVEL SECURITY|ALTER TABLE|CREATE TABLE|DROP)\b/);
    expect(code.match(/\bGRANT\b/g)).toEqual(["GRANT"]);
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.api_cache_control_pre_request() TO anon, authenticated, service_role");
  });
  it("no other migration or function sets response.headers or a pre-request hook (an RPC that did would replace the header: measured)", () => {
    const setters = [...walk("supabase/migrations"), ...walk("supabase/functions")].filter((f) => f !== MIGRATION && /['"]response\.headers['"]|db_pre_request/.test(read(f).replace(/--[^\n]*/g, "")));
    expect(setters).toEqual([]);
  });
});

describe("the realmID protection candidate stays inert (awaiting Intuit clarification)", () => {
  it("is not a migration, is imported by no function or page, and says it awaits clarification", () => {
    expect(fs.readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => /realm/i.test(f))).toEqual([]);
    const importers = [...walk("supabase/functions"), ...walk("src")].filter((f) => !f.includes("__tests__") && read(f).includes("qbo-realm-protection-r0"));
    expect(importers).toEqual([]);
    for (const f of ["DESIGN.md", "phase-a-additive.sql", "realmProtection.ts"]) expect(read(`release/candidates/qbo-realm-protection-r0/${f}`), f).toMatch(/awaiting Intuit('s written)? clarification/i);
  });
  const key = (id: string, fill: number) => ({ id, bytes: new Uint8Array(32).fill(fill) });
  it("an envelope opens to its realm only for its own workspace and environment; the index is keyed, deterministic and shaped", async () => {
    const env = await sealRealm("9130350000000001", "sandbox", "company-a", key("k1", 1));
    expect(env).toMatch(/^v1\.k1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(env).not.toContain("9130350000000001");
    await expect(openRealm(env, "sandbox", "company-a", [key("k1", 1)])).resolves.toBe("9130350000000001");
    await expect(openRealm(env, "sandbox", "company-b", [key("k1", 1)])).rejects.toThrow();
    await expect(openRealm(env, "production", "company-a", [key("k1", 1)])).rejects.toThrow();
    await expect(openRealm(env, "sandbox", "company-a", [key("k1", 2)])).rejects.toThrow();
    const i1 = await realmIndex("9130350000000001", "sandbox", key("idx1", 3));
    expect(i1).toMatch(REALM_INDEX_SHAPE);
    expect(await realmIndex("9130350000000001", "sandbox", key("idx1", 3))).toBe(i1);
    expect(await realmIndex("9130350000000001", "production", key("idx1", 3))).not.toBe(i1);
    expect(await realmIndex("9130350000000001", "sandbox", key("idx1", 4))).not.toBe(i1);
    await expect(sealRealm("12a", "sandbox", "company-a", key("k1", 1))).rejects.toThrow();
  });
});
