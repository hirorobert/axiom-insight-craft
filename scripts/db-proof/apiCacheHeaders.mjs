#!/usr/bin/env node
// Proof for 20261215100000_api_cache_control_headers.sql against a REAL PostgREST in front of a REAL PostgreSQL.
//
//   POSTGREST_BIN=/path/postgrest[,/path/other-version/postgrest] DB_PROOF_MODULES_DIR=<dir with embedded-postgres + pg> \
//     node scripts/db-proof/apiCacheHeaders.mjs [evidence.json]
//
// One throwaway PostgreSQL (embedded, or an EMPTY loopback database with DB_PROOF_MODE=external) receives the whole current
// chain up to the migration. Each PostgREST binary is started on loopback against it with NO pre-request in its own
// configuration, so the hook can only come from the migration's in-database setting (the mechanism Supabase uses).
// Harness-only fixtures (never in the migration): the Supabase API role `authenticator`, Supabase's own auth.uid()
// definition (which reads the claims PostgREST sets), and one proof table and two proof functions.
//
// Asserted: no Cache-Control before the migration; the refusal when another hook is already configured (nothing changed);
// the header on successful reads (GET/HEAD, anon/authenticated/service_role), RPCs (GET and POST) and inserts; table and
// function privileges, RLS flags, policies, memberships and the other role settings unchanged by the migration; the rollback
// (RESET + reload) removes the header and requests keep working. RECORDED, not asserted either way: which error responses
// carry the header - that is the measured answer this proof exists to give.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { openDatabase, applyChainBefore, makeWorld, migrationText, reporter, REPO } from "./lib/reportingKit.mjs";

const MIGRATION = "20261215100000_api_cache_control_headers.sql";
const EXPECTED = "no-cache, no-store";
const BINS = (process.env.POSTGREST_BIN ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (BINS.length === 0) { console.error("POSTGREST_BIN is required (one or more PostgREST executables, comma-separated)"); process.exit(2); }
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : null;
const SECRET = crypto.randomBytes(32).toString("hex");
const AUTH_PASSWORD = crypto.randomBytes(18).toString("base64url");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims, secret = SECRET) => {
  const head = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}`;
  return `${head}.${crypto.createHmac("sha256", secret).update(head).digest("base64url")}`;
};
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); s.on("error", reject); });

// PostgREST on Windows needs libpq: the embedded PostgreSQL package ships it.
function binEnvPath() {
  const dir = process.env.DB_PROOF_MODULES_DIR;
  if (process.platform !== "win32" || !dir) return process.env.PATH;
  return [path.join(path.resolve(dir), "node_modules/@embedded-postgres/windows-x64/native/bin"), process.env.PATH].join(path.delimiter);
}

async function startPostgrest(bin, dbUrl) {
  const port = await freePort(), adminPort = await freePort();
  const env = { ...process.env, PATH: binEnvPath(), PGRST_DB_URI: dbUrl, PGRST_DB_SCHEMAS: "public", PGRST_DB_ANON_ROLE: "anon", PGRST_JWT_SECRET: SECRET,
    PGRST_SERVER_HOST: "127.0.0.1", PGRST_SERVER_PORT: String(port), PGRST_ADMIN_SERVER_PORT: String(adminPort), PGRST_DB_CONFIG: "true", PGRST_DB_CHANNEL_ENABLED: "true", PGRST_LOG_LEVEL: "error" };
  delete env.PGRST_DB_PRE_REQUEST;
  const child = spawn(bin, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
  for (let i = 0; i < 240; i++) {
    try { const r = await fetch(`http://127.0.0.1:${adminPort}/ready`); if (r.status === 200) break; } catch { /* not up yet */ }
    if (child.exitCode !== null) throw new Error(`PostgREST exited: ${log.slice(-800)}`);
    await sleep(250);
    if (i === 239) throw new Error(`PostgREST not ready: ${log.slice(-800)}`);
  }
  const version = await new Promise((resolve) => { const v = spawn(bin, ["--version"], { env: { ...process.env, PATH: binEnvPath() } }); let o = ""; v.stdout.on("data", (d) => { o += d; }); v.on("close", () => resolve(o.trim())); });
  return { base: `http://127.0.0.1:${port}`, version, stop: async () => { child.kill(); await sleep(300); } };
}

async function main() {
  const r = reporter();
  const evidence = { migration: MIGRATION, runs: [] };
  const db = await openDatabase("api_cache_headers");
  let crashed = false;
  try {
    const failed = await applyChainBefore(db, MIGRATION);
    if (failed) throw new Error(`chain: ${failed}`);
    const w = await makeWorld(db);
    // Harness fixtures (Supabase provides these; the bare-PostgreSQL shim does not).
    await db.admin.query(`CREATE ROLE authenticator LOGIN NOINHERIT PASSWORD '${AUTH_PASSWORD}';
      GRANT anon, authenticated, service_role TO authenticator;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
      CREATE TABLE public.proof_cache_rows (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, owner uuid NOT NULL);
      ALTER TABLE public.proof_cache_rows ENABLE ROW LEVEL SECURITY;
      CREATE POLICY proof_own ON public.proof_cache_rows FOR ALL TO authenticated USING (owner = auth.uid()) WITH CHECK (owner = auth.uid());
      REVOKE ALL ON public.proof_cache_rows FROM anon; GRANT SELECT, INSERT ON public.proof_cache_rows TO authenticated;
      CREATE FUNCTION public.proof_raise() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PROOF_RAISED'; END $$;
      CREATE FUNCTION public.proof_sets_own_header() RETURNS int LANGUAGE plpgsql AS $$ BEGIN PERFORM set_config('response.headers', '[{"X-Proof": "1"}]', true); RETURN 1; END $$;
      CREATE FUNCTION public.proof_echo(n int) RETURNS int LANGUAGE sql STABLE AS $$ SELECT n $$;
      GRANT EXECUTE ON FUNCTION public.proof_raise(), public.proof_sets_own_header(), public.proof_echo(int) TO anon, authenticated;`);
    const dbUrl = `postgres://authenticator:${AUTH_PASSWORD}@${db.admin.host === "localhost" ? "127.0.0.1" : db.admin.host}:${db.admin.port}/${db.admin.database}`;
    const ownerJwt = jwt({ sub: w.U.owner, role: "authenticated", aud: "authenticated" });
    const otherJwt = jwt({ sub: w.U.ownerB, role: "authenticated", aud: "authenticated" });
    const serviceJwt = jwt({ role: "service_role" });
    const anonJwt = jwt({ role: "anon" });

    const call = async (base, label, method, pathAndQuery, { token, body, headers = {} } = {}) => {
      const res = await fetch(`${base}${pathAndQuery}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      const text = method === "HEAD" ? "" : await res.text();
      return { label, method, path: pathAndQuery.split("?")[0], status: res.status, cacheControl: res.headers.get("cache-control"), sqlstate: (() => { try { return JSON.parse(text).code ?? null; } catch { return null; } })() };
    };
    const SUCCESS = (base) => [
      () => call(base, "anon RPC GET (no token)", "GET", "/rpc/proof_echo?n=3"),
      () => call(base, "anon-key JWT RPC POST", "POST", "/rpc/proof_echo", { token: anonJwt, body: { n: 3 } }),
      () => call(base, "authenticated GET own company", "GET", `/companies?select=id&id=eq.${w.A}`, { token: ownerJwt }),
      () => call(base, "authenticated HEAD", "HEAD", "/companies?select=id", { token: ownerJwt }),
      () => call(base, "service_role GET", "GET", "/companies?select=id&limit=1", { token: serviceJwt }),
      () => call(base, "RPC POST (stable)", "POST", "/rpc/proof_echo", { token: ownerJwt, body: { n: 7 } }),
      () => call(base, "RPC GET (stable)", "GET", "/rpc/proof_echo?n=7", { token: ownerJwt }),
      () => call(base, "RPC POST real application function", "POST", "/rpc/qbo_pending_disconnect", { token: ownerJwt, body: { p_company: w.A } }),
      () => call(base, "INSERT own row (RLS passes)", "POST", "/proof_cache_rows", { token: ownerJwt, body: { owner: w.U.owner }, headers: { Prefer: "return=representation" } }),
    ];
    const ERRORS = (base) => [
      () => call(base, "anon: no table privilege on an application table", "GET", "/companies?select=id"),
      () => call(base, "RLS WITH CHECK violation on INSERT", "POST", "/proof_cache_rows", { token: ownerJwt, body: { owner: w.U.ownerB } }),
      () => call(base, "anon: no table privilege (token-material table)", "GET", "/qbo_disconnect_operations?select=connection_id"),
      () => call(base, "authenticated: no table privilege", "GET", "/qbo_disconnect_operations?select=connection_id", { token: ownerJwt }),
      () => call(base, "authenticated: no function privilege (service-only writer)", "POST", "/rpc/qbo_begin_disconnect", { token: otherJwt, body: { p_connection: w.A, p_actor: w.U.ownerB, p_request: w.B } }),
      () => call(base, "bad input: invalid uuid in filter", "GET", "/companies?select=id&id=eq.not-a-uuid", { token: ownerJwt }),
      () => call(base, "RPC raises an exception", "POST", "/rpc/proof_raise", { token: ownerJwt, body: {} }),
      () => call(base, "single object requested, zero rows", "GET", `/companies?select=id&id=eq.${w.B}`, { token: ownerJwt, headers: { Accept: "application/vnd.pgrst.object+json" } }),
      () => call(base, "JWT with a wrong signature", "GET", "/companies?select=id", { token: jwt({ sub: w.U.owner, role: "authenticated" }, "x".repeat(64)) }),
      () => call(base, "expired JWT", "GET", "/companies?select=id", { token: jwt({ sub: w.U.owner, role: "authenticated", exp: Math.floor(Date.now() / 1000) - 600 }) }),
      () => call(base, "unknown table (schema cache)", "GET", "/no_such_table"),
      () => call(base, "unknown RPC (schema cache)", "POST", "/rpc/no_such_function", { token: ownerJwt, body: {} }),
      () => call(base, "query parse error (unknown operator)", "GET", "/companies?id=zz.1", { token: ownerJwt }),
      () => call(base, "method not allowed on RPC", "PUT", "/rpc/proof_echo", { token: ownerJwt, body: { n: 1 } }),
    ];
    const runAll = async (list) => { const out = []; for (const f of list) out.push(await f()); return out; };

    // Snapshot of every authorization-relevant catalog fact, taken before and after (the new function itself is excluded).
    const snapshot = async () => (await db.admin.query(`SELECT jsonb_build_object(
        'rels', (SELECT jsonb_agg(jsonb_build_array(c.oid::regclass::text, c.relacl::text, c.relrowsecurity, c.relforcerowsecurity, c.relowner::regrole::text) ORDER BY c.oid::regclass::text) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')),
        'policies', (SELECT jsonb_agg(jsonb_build_array(schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check) ORDER BY schemaname, tablename, policyname) FROM pg_policies),
        'procs', (SELECT jsonb_agg(jsonb_build_array(p.oid::regprocedure::text, p.proacl::text, p.prosecdef, p.proowner::regrole::text) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.oid::regprocedure::text <> 'api_cache_control_pre_request()'),
        'members', (SELECT jsonb_agg(jsonb_build_array(roleid::regrole::text, member::regrole::text, admin_option) ORDER BY 1,2) FROM pg_auth_members),
        'roles', (SELECT jsonb_agg(jsonb_build_array(rolname, rolsuper, rolinherit, rolcreaterole, rolbypassrls, rolcanlogin) ORDER BY rolname) FROM pg_roles),
        'settings', (SELECT jsonb_agg(jsonb_build_array(setdatabase, setrole::regrole::text, c) ORDER BY 1,2,3) FROM pg_db_role_setting, unnest(setconfig) c WHERE c NOT LIKE 'pgrst.db\\_pre\\_request=%')
      ) s`)).rows[0].s;
    const hookSetting = async () => (await db.admin.query(`SELECT string_agg(c, ',') s FROM pg_db_role_setting, unnest(setconfig) c WHERE c LIKE 'pgrst.db\\_pre\\_request=%'`)).rows[0].s;
    const sql = migrationText(MIGRATION);

    const first = await startPostgrest(BINS[0], dbUrl);
    r.group(`Before the migration (${first.version})`);
    const before = await runAll(SUCCESS(first.base));
    evidence.before = { postgrest: first.version, responses: before };
    await r.check("no API response carries Cache-Control before the migration (the measured gap)", async () => before.every((x) => x.cacheControl === null) || before);

    r.group("Compatibility: an existing pre-request hook is refused, never replaced");
    await db.admin.query("ALTER ROLE authenticator SET pgrst.db_pre_request = 'public.some_existing_hook'");
    const pre = await snapshot();
    await r.refused("the migration refuses while another hook is configured", "P0001", () => db.admin.query(sql), "API_PRE_REQUEST_HOOK_ALREADY_CONFIGURED");
    await r.check("after the refusal the existing hook, the catalog and the function are exactly as they were", async () => {
      const fn = (await db.one("SELECT to_regprocedure('public.api_cache_control_pre_request()') f")).f;
      return (await hookSetting()) === "pgrst.db_pre_request=public.some_existing_hook" && fn === null && JSON.stringify(await snapshot()) === JSON.stringify(pre) || { hook: await hookSetting(), fn };
    });
    await db.admin.query("ALTER ROLE authenticator RESET pgrst.db_pre_request");

    r.group("Apply the migration exactly as authored");
    const beforeApply = await snapshot();
    await db.admin.query(sql);
    await r.check("the hook setting is on authenticator only, naming the new function", async () => (await hookSetting()) === "pgrst.db_pre_request=public.api_cache_control_pre_request" || await hookSetting());
    await r.check("privileges, RLS flags, policies, owners, memberships, role attributes and other role settings are unchanged", async () => JSON.stringify(await snapshot()) === JSON.stringify(beforeApply));
    await r.check("the new function: SECURITY INVOKER, no SET clause, EXECUTE only for anon/authenticated/service_role (+ owner)", async () => {
      const f = await db.one("SELECT prosecdef, proconfig, proacl::text acl, provolatile FROM pg_proc WHERE oid = 'public.api_cache_control_pre_request()'::regprocedure");
      return f.prosecdef === false && f.proconfig === null && /anon=X/.test(f.acl) && /authenticated=X/.test(f.acl) && /service_role=X/.test(f.acl) && !/(^|[{,])=X/.test(f.acl) || f;
    });
    await r.refused("an accidental replay refuses", "P0001", () => db.admin.query(sql), "API_PRE_REQUEST_HOOK_ALREADY_CONFIGURED");
    await first.stop();

    for (const bin of BINS) {
      const pg = await startPostgrest(bin, dbUrl);
      r.group(`After the migration (${pg.version})`);
      const ok = await runAll(SUCCESS(pg.base));
      const errs = await runAll(ERRORS(pg.base));
      const own = await call(pg.base, "RPC that sets its own response.headers", "POST", "/rpc/proof_sets_own_header", { token: ownerJwt, body: {} });
      for (const x of ok) await r.check(`${x.label}: ${x.status} with Cache-Control: ${EXPECTED}`, async () => (x.status >= 200 && x.status < 300 && x.cacheControl === EXPECTED) || x);
      console.log("  RECORDED (error responses; header presence is measured, not assumed):");
      for (const x of errs) console.log(`    ${String(x.status).padEnd(4)} ${String(x.sqlstate ?? "-").padEnd(9)} Cache-Control=${x.cacheControl ?? "ABSENT"}  ${x.label}`);
      console.log(`    ${own.status} ${String(own.sqlstate ?? "-").padEnd(9)} Cache-Control=${own.cacheControl ?? "ABSENT"}  ${own.label}`);
      await r.check("every recorded error response is an error (4xx), i.e. the matrix measures what it says", async () => errs.every((x) => x.status >= 400 && x.status < 500) || errs.filter((x) => x.status < 400 || x.status >= 500));
      evidence.runs.push({ postgrest: pg.version, success: ok, errors: errs, rpcSettingOwnHeaders: own });
      await pg.stop();
    }

    r.group("Rollback: RESET the setting and reload");
    await db.admin.query("ALTER ROLE authenticator RESET pgrst.db_pre_request; NOTIFY pgrst, 'reload config';");
    const rb = await startPostgrest(BINS[0], dbUrl);
    const after = await runAll(SUCCESS(rb.base));
    await r.check("after rollback requests succeed and carry no Cache-Control (behaviour before the migration)", async () => after.every((x) => x.status < 300 && x.cacheControl === null) || after);
    evidence.rollback = { postgrest: rb.version, responses: after };
    await rb.stop();
  } catch (e) {
    crashed = true;
    console.error("CRASH", e?.stack ?? e);
  } finally {
    await db.close();
  }
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(evidence, null, 2) + "\n");
  const ok = r.finish("API cache headers (real PostgREST)", crashed);
  process.exit(ok ? 0 : 1);
}

void REPO;
await main();
