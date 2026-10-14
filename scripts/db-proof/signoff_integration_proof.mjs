#!/usr/bin/env node
// ============================================================================
// FULL-CHAIN INTEGRATION PROOF — legacy statement_sign_offs authorization (WS-A)
//
// Per the release directive (§3): on disposable PostgreSQL 17, replay the ACTUAL
// authoritative migration chain from zero, then apply the EXACT candidate
// migration, and exercise the sign-off authorization with the REAL policies,
// triggers and capability/entitlement functions (not stubs — the focused fixture
// proof supplements this, it does not replace it). Simulated PostgREST callers
// via SET LOCAL ROLE + request.jwt.claim.* (as PostgREST does).
//
// Loopback-only; refuses the production project ref; synthetic fixtures only.
//   DB_PROOF_CONN=postgres://postgres:postgres@127.0.0.1:5432/db node scripts/db-proof/signoff_integration_proof.mjs
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const CANDIDATE = path.join(REPO, "docs/fin-integrity/candidate-migration/20261103100000_signoff_authorization_hardening.sql");
const require = createRequire(import.meta.url);
const { Client, Pool } = require("pg");

const CONN = process.env.DB_PROOF_CONN;
if (!CONN) { console.error("Set DB_PROOF_CONN=postgres://…@127.0.0.1:5432/db (loopback)"); process.exit(2); }
if (CONN.includes(PRODUCTION_REF)) { console.error("REFUSED: production project ref"); process.exit(2); }
{ const u = new URL(CONN); if (!["localhost","127.0.0.1","::1","[::1]"].includes(u.hostname)) { console.error(`REFUSED: ${u.hostname} not loopback`); process.exit(2); } }

const uuid = () => globalThis.crypto.randomUUID();
const hex64 = (s) => { let h=""; for(let i=0;h.length<64;i++) h+=Buffer.from(`${s}:${i}`).toString("hex"); return h.slice(0,64); };
const U = { owner: uuid(), partner: uuid(), partner2: uuid(), preparer: uuid(), viewer: uuid(), ownerB: uuid(), preparerB: uuid() };
let COMPANY_A, COMPANY_B, UPLOAD_A, UPLOAD_B, MEMBER = {};

let admin, pool;
const results = [];
const rec = (n, ok, d="") => { results.push({n,ok}); console.log(`  ${ok?"PASS":"FAIL"}  ${n}${ok||!d?"":`  — ${d}`}`); };

async function replayAll() {
  const shim = fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8");
  await admin.query(shim);
  const dir = path.join(REPO, "supabase/migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let n = 0;
  for (const f of files) {
    let text = fs.readFileSync(path.join(dir, f), "utf8");
    if (f === PG_CRON_FILE) { const lines = text.split("\n"); text = lines.slice(0, lines.findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n"); }
    try { await admin.query(text); n++; } catch (e) { throw new Error(`migration ${f} failed: ${String(e.message).split("\n")[0]}`); }
  }
  // the EXACT candidate migration, applied on top of the full chain
  await admin.query(fs.readFileSync(CANDIDATE, "utf8"));
  // PostgREST's `authenticated` role reaches the Data API through schema USAGE + per-table grants (the migrations grant the
  // table verbs; Supabase grants schema USAGE at the platform layer, which the proof shim does not — run.mjs never needs it
  // because it calls SECURITY DEFINER RPCs, not direct table writes). Grant it so writes reach RLS/triggers rather than a
  // schema-permission error. This does NOT weaken the sign-off controls (those are RLS policies + triggers, not grants).
  await admin.query("GRANT USAGE ON SCHEMA public, auth TO authenticated, anon, service_role");
  // The RLS policies read reference tables (firm_members, …) as the CALLER; the role needs base SELECT (Supabase grants
  // this at the platform layer). RLS still enforces row visibility, so this does NOT weaken any sign-off control — it only
  // lets a legitimate write's WITH CHECK subquery run instead of hitting a bare table-permission error.
  await admin.query("GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated");
  await admin.query("GRANT SELECT ON public.firm_members, public.companies, public.statement_sign_offs, public.hesabu_validations, public.trial_balance_uploads TO authenticated");
  const diag = (await admin.query("SELECT has_table_privilege('authenticated','public.firm_members','SELECT') fm, has_schema_privilege('authenticated','public','USAGE') pub")).rows[0];
  console.log(`  [diag] authenticated: firm_members SELECT=${diag.fm}, public USAGE=${diag.pub}`);
  return { applied: n, total: files.length };
}

async function seed() {
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id, email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  // Company A = a paid workspace holding STATEMENT_CERTIFICATION (Practice plan), exactly as a real account records it.
  const prod = (await admin.query("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).rows[0].id;
  const bc = (await admin.query("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [U.owner, prod])).rows[0].id;
  await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1,id,'ACTIVE','ADMIN_GRANT', now()-interval '1 day', 4 FROM public.commercial_plans WHERE product_id=$2 AND code='PRACTICE'", [bc, prod]);
  const bcB = (await admin.query("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [U.ownerB, prod])).rows[0].id;
  await admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1,id,'ACTIVE','ADMIN_GRANT', now()-interval '1 day', 4 FROM public.commercial_plans WHERE product_id=$2 AND code='PRACTICE'", [bcB, prod]);
  COMPANY_A = (await admin.query("INSERT INTO public.companies (user_id, name) VALUES ($1,'Company A') RETURNING id", [U.owner])).rows[0].id;
  COMPANY_B = (await admin.query("INSERT INTO public.companies (user_id, name) VALUES ($1,'Company B') RETURNING id", [U.ownerB])).rows[0].id;
  for (const [k, role] of [["partner","partner"],["partner2","partner"],["preparer","preparer"],["viewer","viewer"]])
    await admin.query("INSERT INTO public.firm_members (company_id, user_id, role, accepted_at) VALUES ($1,$2,$3, now())", [COMPANY_A, U[k], role]);
  await admin.query("INSERT INTO public.firm_members (company_id, user_id, role, accepted_at) VALUES ($1,$2,'preparer', now())", [COMPANY_B, U.preparerB]);
  const rows = (await admin.query("SELECT user_id, id FROM public.firm_members WHERE accepted_at IS NOT NULL")).rows;
  MEMBER = Object.fromEntries(rows.map((r) => [r.user_id, r.id]));
  // Trial balances + a passing validation for each (so the real HESABU gate can admit a legitimate sign-off).
  UPLOAD_A = (await admin.query("INSERT INTO public.trial_balance_uploads (user_id, company_id, period_year, file_name, file_path, file_size, status) VALUES ($1,$2,2026,'a.csv','p/a.csv',100,'complete') RETURNING id", [U.owner, COMPANY_A])).rows[0].id;
  UPLOAD_B = (await admin.query("INSERT INTO public.trial_balance_uploads (user_id, company_id, period_year, file_name, file_path, file_size, status) VALUES ($1,$2,2026,'b.csv','p/b.csv',100,'complete') RETURNING id", [U.ownerB, COMPANY_B])).rows[0].id;
}
// hesabu_validations is append-only (IRON DOME); the HESABU gate reads the LATEST run by validated_at.
// So we never delete — we APPEND with a strictly-increasing validated_at so the newest row is the effective state.
let vseq = 0;
async function setValidation(upload, company, spec) {
  const at = (n) => `now() + interval '${n} seconds'`;
  if (spec === "pass") { await admin.query(`INSERT INTO public.hesabu_validations (upload_id, company_id, period_year, status, validated_by, validated_at) VALUES ($1,$2,2026,'all_pass',$3, ${at(++vseq)})`, [upload, company, U.owner]); }
  if (spec === "stale") { await admin.query(`INSERT INTO public.hesabu_validations (upload_id, company_id, period_year, status, validated_by, validated_at) VALUES ($1,$2,2026,'all_pass',$3, ${at(++vseq)}),($1,$2,2026,'some_fail',$3, ${at(++vseq)})`, [upload, company, U.owner]); }
  // 'none' => append nothing (the table starts empty).
}

async function asUser(uid, fn) {
  const c = await pool.connect();
  try { await c.query("BEGIN"); await c.query("SET LOCAL ROLE authenticated");
    await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [uid]);
    const out = await fn(c); await c.query("COMMIT"); return out;
  } catch (e) { try { await c.query("ROLLBACK"); } catch {} throw e; } finally { c.release(); }
}
async function refused(name, uid, fn) {
  let ref=false,d=""; try { await asUser(uid, fn); } catch(e){ ref=true; d=String(e.message).split("\n")[0]; }
  // A schema/table *permission* error is an infra misconfiguration, NOT a valid authorization refusal — fail it so a
  // genuine RLS/trigger refusal is never masked by one.
  const infra = /permission denied for (schema|table|relation)/i.test(d);
  rec(name, ref && !infra, ref ? (infra ? `INVALID refusal (infra): ${d}` : "") : "write SUCCEEDED (defect not closed)");
}
async function allowed(name, uid, fn) { let ok=true,d=""; try { await asUser(uid, fn); } catch(e){ ok=false; d=`${e.message} | WHERE=${e.where||""} | TABLE=${e.table||""}`.replace(/\n/g," "); } rec(name, ok, d); }
const ins = (c, co, yr, up, cols, vals) => c.query(`INSERT INTO public.statement_sign_offs (company_id, period_year, upload_id, ${cols}) VALUES ('${co}',${yr},'${up}',${vals})`);

async function main() {
  admin = new Client({ connectionString: CONN }); await admin.connect();
  pool = new Pool({ connectionString: CONN, max: 6 });
  const ver = (await admin.query("show server_version")).rows[0].server_version;
  await admin.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA public;");
  console.log(`\n== PostgreSQL ${ver} — full-chain replay + candidate`);
  const { applied, total } = await replayAll();
  rec(`REPLAY · entire migration chain (${applied}/${total}) + candidate applied on PostgreSQL 17`, applied === total && applied > 100);
  await seed();
  const fmPrep = MEMBER[U.preparer], fmPart = MEMBER[U.partner], fmPart2 = MEMBER[U.partner2];

  console.log("\n== real-policy integration scenarios (secure = refused unless noted)");
  await setValidation(UPLOAD_A, COMPANY_A, "none");
  // A — unauthorized signing: prepare_close actor INSERTs a locked+approved row, no validation, no tier
  await refused("A · INSERT locked+approved bypasses HESABU gate & approver tier (real RLS+trigger)", U.preparer,
    (c)=>ins(c,COMPANY_A,2026,UPLOAD_A,"preparer_signed_at,approver_id,approver_signed_at,approver_firm_member_id,status,locked_at", `NULL,'${U.partner}',now(),'${fmPart}','locked',now()`));
  // A' — draft INSERT then signed UPDATE (the production "nuance"): UPDATE never re-invoked the old gate
  await refused("A' · draft INSERT then signed UPDATE with no passing validation", U.preparer, async (c)=>{
    await ins(c,COMPANY_A,2027,UPLOAD_A,"preparer_firm_member_id,status", `'${fmPrep}','draft'`);
    await c.query(`UPDATE public.statement_sign_offs SET preparer_id='${U.preparer}', preparer_signed_at=now() WHERE company_id='${COMPANY_A}' AND period_year=2027`);
  });
  // D — stale/failing latest validation
  await setValidation(UPLOAD_A, COMPANY_A, "stale");
  await refused("D · sign accepted against a stale pass / newer failing validation", U.preparer,
    (c)=>ins(c,COMPANY_A,2028,UPLOAD_A,"preparer_id,preparer_signed_at,preparer_firm_member_id", `'${U.preparer}',now(),'${fmPrep}'`));
  // B — identity substitution (one approve_certification actor signs as others)
  await setValidation(UPLOAD_A, COMPANY_A, "pass");
  await refused("B · signer identity not bound to auth.uid() (identity substitution)", U.partner,
    (c)=>ins(c,COMPANY_A,2029,UPLOAD_A,"preparer_id,preparer_signed_at,reviewer_id,reviewer_signed_at,approver_id,approver_signed_at,preparer_firm_member_id", `'${U.preparer}',now(),'${U.viewer}',now(),'${U.partner}',now(),'${fmPrep}'`));
  // E — status jumps straight to locked
  await refused("E · status jumps to 'locked' without the tier sequence", U.partner,
    (c)=>ins(c,COMPANY_A,2030,UPLOAD_A,"status,locked_at,statements_hash", `'locked',now(),'${hex64("x")}'`));
  // TENANT — company-B actor cannot write a company-A sign-off (real RLS)
  await refused("TENANT · company-B actor cannot INSERT a company-A sign-off", U.preparerB,
    (c)=>ins(c,COMPANY_A,2031,UPLOAD_A,"preparer_firm_member_id,status", `'${fmPrep}','draft'`));
  // GRANTS — excessive privileges removed by the candidate
  { const t = (await admin.query("SELECT has_table_privilege('authenticated','public.statement_sign_offs',$1) v",['TRUNCATE'])).rows[0].v;
    const d = (await admin.query("SELECT has_table_privilege('authenticated','public.statement_sign_offs',$1) v",['DELETE'])).rows[0].v;
    rec("GRANTS · authenticated no longer holds TRUNCATE/DELETE (excessive grants revoked)", t===false && d===false); }

  // LEGITIMATE AUTHORIZED JOURNEY — preparer signs, partner reviews then approves+locks; records intact.
  await setValidation(UPLOAD_A, COMPANY_A, "pass");
  await allowed("JOURNEY · preparer sign-off (self id + latest pass) succeeds", U.preparer,
    (c)=>ins(c,COMPANY_A,2040,UPLOAD_A,"preparer_id,preparer_signed_at,preparer_firm_member_id,status", `'${U.preparer}',now(),'${fmPrep}','preparer_signed'`));
  // Segregation of duties: reviewer and approver must be DISTINCT people, each signing AS THEMSELVES (the repair binds
  // every signature to auth.uid()). So a legitimate close is three separate writes by three different members.
  await allowed("JOURNEY · reviewer (partner2, distinct) signs", U.partner2, (c)=>
    c.query(`UPDATE public.statement_sign_offs SET reviewer_id='${U.partner2}', reviewer_firm_member_id='${fmPart2}', reviewer_signed_at=now(), status='reviewer_signed' WHERE company_id='${COMPANY_A}' AND period_year=2040`));
  await allowed("JOURNEY · approver (partner, distinct) signs & locks", U.partner, (c)=>
    c.query(`UPDATE public.statement_sign_offs SET approver_id='${U.partner}', approver_firm_member_id='${fmPart}', approver_signed_at=now(), statements_hash='${hex64("final")}', locked_at=now(), status='locked' WHERE company_id='${COMPANY_A}' AND period_year=2040`));
  { const r = (await admin.query("SELECT locked_at IS NOT NULL locked, status FROM public.statement_sign_offs WHERE company_id=$1 AND period_year=2040",[COMPANY_A])).rows[0];
    rec("JOURNEY · the authorized sign-off is persisted and locked (record intact)", r && r.locked===true && r.status==='locked'); }
  // the locked record cannot then be mutated (input-change after approval)
  await refused("INPUT-CHANGE · the locked, approved record cannot be mutated post-lock", U.partner,
    (c)=>c.query(`UPDATE public.statement_sign_offs SET approver_note='tamper' WHERE company_id='${COMPANY_A}' AND period_year=2040`));

  // STALE-APPROVAL race: preparer signs on a passing run; inputs then change (new failing run); the NEXT signer (reviewer,
  // distinct) is refused — a stale approval can never remain valid.
  await setValidation(UPLOAD_A, COMPANY_A, "pass");
  await allowed("STALE-RACE · preparer signs on a passing validation", U.preparer,
    (c)=>ins(c,COMPANY_A,2041,UPLOAD_A,"preparer_id,preparer_signed_at,preparer_firm_member_id,status", `'${U.preparer}',now(),'${fmPrep}','preparer_signed'`));
  await setValidation(UPLOAD_A, COMPANY_A, "stale");   // inputs changed after the preparer signed
  await refused("STALE-RACE · reviewer step refused once inputs changed (no stale approval remains valid)", U.partner2, (c)=>
    c.query(`UPDATE public.statement_sign_offs SET reviewer_id='${U.partner2}', reviewer_firm_member_id='${fmPart2}', reviewer_signed_at=now(), status='reviewer_signed' WHERE company_id='${COMPANY_A}' AND period_year=2041`));

  // CONCURRENCY — two independent connections sign the same (company,period); controlled synchronization; no duplicate.
  await setValidation(UPLOAD_A, COMPANY_A, "pass");
  { const c1 = await pool.connect(), c2 = await pool.connect();
    try {
      for (const c of [c1,c2]) { await c.query("BEGIN"); await c.query("SET LOCAL ROLE authenticated"); await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)",[U.preparer]); }
      await c1.query(`INSERT INTO public.statement_sign_offs (company_id,period_year,upload_id,preparer_id,preparer_signed_at,preparer_firm_member_id,status) VALUES ('${COMPANY_A}',2042,'${UPLOAD_A}','${U.preparer}',now(),'${fmPrep}','preparer_signed')`);
      const p2 = c2.query(`INSERT INTO public.statement_sign_offs (company_id,period_year,upload_id,preparer_id,preparer_signed_at,preparer_firm_member_id,status) VALUES ('${COMPANY_A}',2042,'${UPLOAD_A}','${U.preparer}',now(),'${fmPrep}','preparer_signed')`); // blocks on the unique index
      await c1.query("COMMIT");              // first writer wins
      let loser=false; try { await p2; await c2.query("COMMIT"); } catch { loser=true; await c2.query("ROLLBACK"); }
      rec("CONCURRENCY · two independent connections, same (company,period): exactly one commits, the other is refused (no duplicate)", loser);
    } finally { c1.release(); c2.release(); } }
  // IDEMPOTENT-REPLAY contract: the legacy table has no idempotency key — a repeated request is a DUPLICATE and must be
  // refused (not silently reused). Distinct from a safe idempotent replay (which the fs_* publication path provides).
  await refused("REPLAY · a repeated identical sign-off is refused as a duplicate (not a silent idempotent reuse)", U.preparer,
    (c)=>ins(c,COMPANY_A,2042,UPLOAD_A,"preparer_id,preparer_signed_at,preparer_firm_member_id,status", `'${U.preparer}',now(),'${fmPrep}','preparer_signed'`));

  await pool.end(); await admin.end();
  const failed = results.filter(r=>!r.ok);
  console.log(`\n${results.length-failed.length}/${results.length} assertions as expected.`);
  process.exit(failed.length ? 1 : 0);
}
main().catch(async (e) => { console.error("PROOF ERROR:", e.message); try { await pool?.end(); } catch {} try { await admin?.end(); } catch {} process.exit(2); });
