// Controlled reproduction of the search_path / default-binding concern found by ipsasGrantsTransport.mjs: which function does the
// unqualified `DEFAULT gen_random_uuid()` in 20261207100000 / 20261208100000 bind to, under different session search_paths and with or
// without a function of the same name in `public`? Each variant runs the exact migration source in its own rolled-back transaction on a
// fresh session of the real predecessor chain, then reads the default's actual dependency (pg_depend), not its text.
// Disposable loopback database only. Prints a table; exits non-zero only if the harness itself fails.
import { applyChainBefore, migrationText, openDatabase } from "./lib/reportingKit.mjs";

const GRANTS = "20261208100000_ipsas_grants.sql";
const db = await openDatabase("ipsas_searchpath_binding");
try {
  const err = await applyChainBefore(db, GRANTS);
  if (err) throw new Error(err);
  const shadowAlreadyThere = (await db.admin.query("SELECT to_regprocedure('public.gen_random_uuid()') IS NOT NULL v")).rows[0].v;
  const catalogFn = (await db.admin.query("SELECT to_regprocedure('pg_catalog.gen_random_uuid()') IS NOT NULL v")).rows[0].v;
  console.log(`chain: pg_catalog.gen_random_uuid() exists=${catalogFn}; a public.gen_random_uuid() already exists=${shadowAlreadyThere}`);
  const VARIANTS = [
    ["default session  \"$user\", public", `"$user", public`, false],
    ["public, pg_catalog", "public, pg_catalog", false],
    ["pg_catalog, public", "pg_catalog, public", false],
    ["public only (pg_catalog implicit first)", "public", false],
    ["extensions, public", "extensions, public", false],
    ["public, pg_catalog + a public.gen_random_uuid() present", "public, pg_catalog", true],
    ["default session + a public.gen_random_uuid() present", `"$user", public`, true],
    ["pg_catalog, public + a public.gen_random_uuid() present", "pg_catalog, public", true],
  ];
  const rows = [];
  for (const [label, path, shadow] of VARIANTS) {
    const c = await db.pool.connect();
    try {
      await c.query("BEGIN");
      if (path.includes("extensions")) await c.query("CREATE SCHEMA IF NOT EXISTS extensions");
      if (shadow && !shadowAlreadyThere) await c.query("CREATE FUNCTION public.gen_random_uuid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-0000-0000-000000000000'::uuid $$");
      await c.query(`SET LOCAL search_path TO ${path}`);
      await c.query(migrationText(GRANTS));
      const dep = (await c.query(`SELECT c.relname, n.nspname AS fn_schema, p.proname
        FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid JOIN pg_depend dp ON dp.classid = 'pg_attrdef'::regclass AND dp.objid = d.oid AND dp.refclassid = 'pg_proc'::regclass
        JOIN pg_proc p ON p.oid = dp.refobjid JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE c.relname IN ('ipsas_grant_revisions','ipsas_grant_confirmations') AND p.proname = 'gen_random_uuid' ORDER BY c.relname`)).rows;
      rows.push({ variant: label, binds_to: [...new Set(dep.map((r) => `${r.fn_schema}.${r.proname}`))].join(", ") || "(no dependency found)", tables: dep.length });
    } catch (e) { rows.push({ variant: label, binds_to: `ERROR ${String(e.message).split("\n")[0]}`, tables: 0 }); }
    finally { try { await c.query("ROLLBACK"); } catch { /* */ } c.release(); }
  }
  console.table(rows);
  const leaves = (await db.admin.query("SELECT to_regclass('public.ipsas_grant_revisions') IS NOT NULL v")).rows[0].v;
  console.log(`each variant rolled back; grants objects left behind: ${leaves}`);
} finally { await db.close(); process.exit(0); }
