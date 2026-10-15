#!/usr/bin/env node
// ============================================================================
// FULL-CHAIN PROOF — platform-owner access administration & entity allowances
//
// On disposable PostgreSQL 17: replay the ACTUAL authoritative migration chain
// from zero (which now includes 20261104100000_platform_owner_access_and_entity_allowance),
// then exercise the directive's §16 tests against the REAL functions/triggers/RLS
// — no stubs. Simulated PostgREST callers via SET LOCAL ROLE + request.jwt.claim.*.
//
// Loopback-only; refuses the production project ref; synthetic data only.
//   DB_PROOF_CONN=postgres://postgres:postgres@127.0.0.1:5432/db node scripts/db-proof/owner_access_proof.mjs
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const require = createRequire(import.meta.url);
const { Client, Pool } = require("pg");

const CONN = process.env.DB_PROOF_CONN;
if (!CONN) { console.error("Set DB_PROOF_CONN=postgres://…@127.0.0.1:5432/db (loopback)"); process.exit(2); }
if (CONN.includes(PRODUCTION_REF)) { console.error("REFUSED: production project ref"); process.exit(2); }
{ const u = new URL(CONN); if (!["localhost","127.0.0.1","::1","[::1]"].includes(u.hostname)) { console.error(`REFUSED: ${u.hostname} not loopback`); process.exit(2); } }

const uuid = () => globalThis.crypto.randomUUID();
const U = { owner: uuid(), ordinary: uuid(), recipient: uuid(), practice: uuid(), solo: uuid(), tenantB: uuid() };
let PRODUCT, COMPANY_B;
let admin, pool;
const results = [];
const rec = (n, ok, d="") => { results.push({n,ok}); console.log(`  ${ok?"PASS":"FAIL"}  ${n}${ok||!d?"":`  — ${d}`}`); };

async function replayAll() {
  const shim = fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8");
  await admin.query(shim);
  const dir = path.join(REPO, "supabase/migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    let text = fs.readFileSync(path.join(dir, f), "utf8");
    if (f === PG_CRON_FILE) { const lines = text.split("\n"); text = lines.slice(0, lines.findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n"); }
    try { await admin.query(text); } catch (e) { throw new Error(`migration ${f} failed: ${String(e.message).split("\n")[0]}`); }
  }
  await admin.query("GRANT USAGE ON SCHEMA public, auth TO authenticated, anon, service_role");
  await admin.query("GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated");
  return files.length;
}

async function giveLicence(user, planCode) {
  const bc = (await admin.query(
    "INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) ON CONFLICT (owner_user_id) DO UPDATE SET product_id=EXCLUDED.product_id RETURNING id",
    [user, PRODUCT])).rows[0].id;
  await admin.query(
    "INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start) SELECT $1,id,'ACTIVE','ADMIN_GRANT', now()-interval '1 day' FROM public.commercial_plans WHERE product_id=$2 AND code=$3",
    [bc, PRODUCT, planCode]);
  return bc;
}

async function seed() {
  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id, email, email_confirmed_at) VALUES ($1,$2, now())", [id, `${k}@example.test`]);
  PRODUCT = (await admin.query("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).rows[0].id;
  await giveLicence(U.practice, "PRACTICE");            // capacity 5
  await giveLicence(U.solo, "SOLO");                    // capacity 1
  await giveLicence(U.tenantB, "SOLO");                 // a real plan (there is no free tier → an account with no plan cannot create even its first entity)
  for (let i = 0; i < 4; i++) await admin.query("INSERT INTO public.companies (user_id, name) VALUES ($1,$2)", [U.practice, `P${i}`]);  // 4 of 5 used
  COMPANY_B = (await admin.query("INSERT INTO public.companies (user_id, name) VALUES ($1,'Tenant B Co') RETURNING id", [U.tenantB])).rows[0].id;
}

async function asUser(uid, fn) {
  const c = await pool.connect();
  try { await c.query("BEGIN"); await c.query("SET LOCAL ROLE authenticated");
    await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [uid]);
    const out = await fn(c); await c.query("COMMIT"); return out;
  } catch (e) { try { await c.query("ROLLBACK"); } catch {} throw e; } finally { c.release(); }
}
async function refused(name, uid, fn, codeRe) {
  let ref=false,d=""; try { await asUser(uid, fn); } catch(e){ ref=true; d=String(e.message).split("\n")[0]; }
  const infra = /permission denied for (schema|table|relation)/i.test(d);
  const codeOk = !codeRe || codeRe.test(d);
  rec(name, ref && !infra && codeOk, ref ? (infra ? `INVALID refusal (infra): ${d}` : (codeOk ? "" : `wrong error: ${d}`)) : "action SUCCEEDED (control not enforced)");
}
async function allowed(name, uid, fn) { let ok=true,d=""; try { await asUser(uid, fn); } catch(e){ ok=false; d=String(e.message).split("\n")[0]; } rec(name, ok, d); }
const mintNonce = (user, nonce) => admin.query("SELECT public.record_privileged_reauth($1,$2,300)", [user, nonce]);
const resolve = async (owner, cap) => (await admin.query("SELECT public._resolve_entitlement_for_owner($1,$2) r", [owner, cap])).rows[0].r;
const entityCap = async (acct) => (await admin.query("SELECT public._entity_capacity_for_account($1) r", [acct])).rows[0].r;

async function main() {
  admin = new Client({ connectionString: CONN }); await admin.connect();
  pool = new Pool({ connectionString: CONN, max: 6 });
  const total = await replayAll();
  rec(`REPLAY · entire migration chain (${total} files incl. platform-owner migration) applied on PostgreSQL 17`, true);
  await seed();

  // ── Bootstrap the first platform owner (service-role / db-owner; names a verified UID). ──
  await admin.query("SELECT public.bootstrap_first_platform_owner($1,'initial platform owner')", [U.owner]);
  const po = (await admin.query("SELECT public.is_platform_owner($1) v", [U.owner])).rows[0].v;
  rec("OWNER · the exact bootstrapped user is a platform owner", po === true);

  // 1 · Owner receives intended privileges WITHOUT paying.
  const certs = await resolve(U.owner, "STATEMENT_CERTIFICATION");
  const insight = await resolve(U.owner, "CLOSE_INSIGHTS");
  rec("OWNER · complimentary access to released capabilities (STATEMENT_CERTIFICATION, CLOSE_INSIGHTS) → ENTITLED",
    certs.status === "ENTITLED" && certs.source === "PLATFORM_OWNER_COMPLIMENTARY" && insight.status === "ENTITLED");
  const ocap = await entityCap(U.owner);
  rec("OWNER · unlimited active entities, EXPLICIT (unlimited=true, determined=true, no number)",
    ocap.unlimited === true && ocap.determined === true && ocap.capacity === null && ocap.source === "PLATFORM_OWNER_COMPLIMENTARY");
  const ownerPay = (await admin.query(
    "SELECT count(*)::int n FROM public.commercial_licences cl JOIN public.billing_customers bc ON bc.id=cl.billing_customer_id WHERE bc.owner_user_id=$1", [U.owner])).rows[0].n;
  rec("OWNER · complimentary access fabricates NO payment/subscription/revenue (zero licences for the owner)", ownerPay === 0);

  // 1b · Owner does NOT get withheld modules; withheld gate intact.
  const withheld = await resolve(U.owner, "TAX_COMPUTATION");
  rec("OWNER · withheld modules are NOT granted by complimentary access (unknown/not-entitled, gate intact)",
    withheld.status !== "ENTITLED");

  // 1c · Customer entity enforcement/pricing is UNCHANGED by this task (no owner, no override → identical to before).
  const soloBase = await entityCap(U.solo);
  const soloCert = await resolve(U.solo, "STATEMENT_CERTIFICATION");
  rec("CUSTOMER-UNCHANGED · a normal customer still resolves on its own plan (Solo capacity 1, NOT unlimited, via ACTIVE_LICENCE) — no change to customer limits/pricing/blocking",
    soloBase.capacity === 1 && soloBase.unlimited === false && soloBase.source === "ACTIVE_LICENCE" && soloCert.source === "ACTIVE_LICENCE");

  // 2 · Ordinary account cannot obtain owner privileges (self-escalation refused, before any reauth).
  await mintNonce(U.ordinary, "NORD");
  await refused("ESCALATION · an ordinary account cannot grant itself platform-owner", U.ordinary,
    (c)=>c.query("SELECT public.grant_platform_owner($1,'x','NORD')", [U.ordinary]), /NOT_A_PLATFORM_OWNER/);

  // 6a · Privileged grant WITHOUT recent reauthentication is refused (owner is a platform owner but has no nonce).
  await refused("REAUTH · a privileged grant without recent reauthentication is refused", U.owner,
    (c)=>c.query("SELECT public.owner_grant_complimentary_access($1,'CLOSE_INSIGHTS','comp',NULL,'BADNONCE')", [U.recipient]), /REAUTH_REQUIRED/);

  // 5 · Scoped delegation then revocation (reauth consumed each time).
  await mintNonce(U.owner, "N1");
  let overrideId;
  await allowed("DELEGATE · platform owner grants a recipient complimentary CLOSE_INSIGHTS (with reauth)", U.owner, async (c)=>{
    overrideId = (await c.query("SELECT (public.owner_grant_complimentary_access($1,'CLOSE_INSIGHTS','comp access',NULL,'N1'))->>'override_id' id", [U.recipient])).rows[0].id;
  });
  const recGrant = await resolve(U.recipient, "CLOSE_INSIGHTS");
  rec("DELEGATE · the recipient is now ENTITLED via admin override (no payment)", recGrant.status === "ENTITLED" && recGrant.source === "ADMIN_OVERRIDE");
  const recPay = (await admin.query("SELECT count(*)::int n FROM public.commercial_licences cl JOIN public.billing_customers bc ON bc.id=cl.billing_customer_id WHERE bc.owner_user_id=$1", [U.recipient])).rows[0].n;
  rec("DELEGATE · the complimentary grant created NO licence/payment for the recipient", recPay === 0);
  await mintNonce(U.owner, "N2");
  await allowed("REVOKE · platform owner revokes the grant (with reauth)", U.owner,
    (c)=>c.query("SELECT public.revoke_access_grant($1,'revoke','N2')", [overrideId]));
  const recAfter = await resolve(U.recipient, "CLOSE_INSIGHTS");
  rec("REVOKE · revocation is effective server-side immediately (recipient no longer entitled; no refresh)", recAfter.status === "NOT_ENTITLED");

  // 4 · Cross-tenant isolation — the owner's complimentary access does NOT leak to another account, and the owner has no
  //     workspace capability in a tenant they are not a member of.
  // MULTI_ENTITY_REPORTING is released but NOT in the SOLO plan — the platform owner gets it (complimentary), tenant B (SOLO) does not.
  const ownerMER = await resolve(U.owner, "MULTI_ENTITY_REPORTING");
  const bLeak = await resolve(U.tenantB, "MULTI_ENTITY_REPORTING");
  rec("CROSS-TENANT · owner gets a released capability complimentary while tenant B (SOLO) does NOT — no leak across accounts",
    ownerMER.status === "ENTITLED" && ownerMER.source === "PLATFORM_OWNER_COMPLIMENTARY" && bLeak.status === "NOT_ENTITLED");
  const bCap = (await admin.query("SELECT public.has_workspace_capability($1,$2,'prepare_close') v", [COMPANY_B, U.owner])).rows[0].v;
  rec("OWNER · platform-owner status grants NO workspace capability without membership (cannot bypass financial controls)", bCap === false);

  // 7 · Entity limit — at a limit of 5 (4 used), two simultaneous requests for the final slot → exactly one new entity.
  { const c1 = await pool.connect(), c2 = await pool.connect();
    try {
      await c1.query("BEGIN"); await c2.query("BEGIN");
      await c1.query("INSERT INTO public.companies (user_id, name) VALUES ($1,'E5a')", [U.practice]);   // acquires the per-account advisory lock
      const p2 = c2.query("INSERT INTO public.companies (user_id, name) VALUES ($1,'E5b')", [U.practice]); // blocks on that lock
      await c1.query("COMMIT");                                                                           // reaches 5
      let loser=false; try { await p2; await c2.query("COMMIT"); } catch { loser=true; await c2.query("ROLLBACK"); }
      const used = (await admin.query("SELECT count(*)::int n FROM public.companies WHERE user_id=$1 AND COALESCE(is_active,true)", [U.practice])).rows[0].n;
      rec("CONCURRENCY · two simultaneous requests for the final slot (limit 5) → exactly one new active entity", loser && used === 5);
    } finally { c1.release(); c2.release(); } }

  // 9 · UI usage agrees with server enforcement.
  const uiP = await asUser(U.practice, async (c)=> (await c.query("SELECT public.get_my_entity_capacity() r")).rows[0].r);
  rec("UI-AGREES · get_my_entity_capacity (Practice) reports 5 of 5, not unlimited", uiP.capacity === 5 && uiP.used === 5 && uiP.unlimited === false);
  const uiO = await asUser(U.owner, async (c)=> (await c.query("SELECT public.get_my_entity_capacity() r")).rows[0].r);
  rec("UI-AGREES · get_my_entity_capacity (owner) reports unlimited", uiO.unlimited === true && uiO.determined === true);

  // 8 · Unlimited allowance lets the owner create entities past any numeric cap.
  for (let i = 0; i < 3; i++) await admin.query("INSERT INTO public.companies (user_id, name) VALUES ($1,$2)", [U.owner, `OWN${i}`]);
  const ownCount = (await admin.query("SELECT count(*)::int n FROM public.companies WHERE user_id=$1 AND COALESCE(is_active,true)", [U.owner])).rows[0].n;
  rec("UNLIMITED · the owner can create entities past any numeric cap (3 created, none refused)", ownCount === 3);

  // 8b · Retry cannot create a duplicate entity (idempotency index), even for an unlimited owner.
  { const reqId = uuid();
    await admin.query("INSERT INTO public.companies (user_id, name, creation_request_id) VALUES ($1,'RETRY',$2)", [U.owner, reqId]);
    let dup=false; try { await admin.query("INSERT INTO public.companies (user_id, name, creation_request_id) VALUES ($1,'RETRY2',$2)", [U.owner, reqId]); } catch { dup=true; }
    rec("RETRY · the same creation_request_id cannot create a duplicate entity (idempotency index)", dup); }

  // 10 · Expired grant does not count.
  { const bc = (await admin.query("SELECT id FROM public.billing_customers WHERE owner_user_id=$1", [U.solo])).rows[0].id;
    await admin.query("INSERT INTO public.entitlement_overrides (billing_customer_id, feature_code, capacity_value, granted_by, reason, effective_start, effective_end) VALUES ($1,'ENTITY_CAPACITY',50,$2,'expired boost', now()-interval '10 days', now()-interval '1 day')", [bc, U.owner]);
    const soloCap = await entityCap(U.solo);
    rec("EXPIRED · an expired entity-capacity override is ignored (Solo stays at 1, not 50)", soloCap.capacity === 1 && soloCap.unlimited === false); }

  // 11 · Archive frees capacity; restore past the limit is refused (history preserved — rows are not deleted).
  { const archId = (await admin.query("SELECT id FROM public.companies WHERE user_id=$1 AND COALESCE(is_active,true) ORDER BY created_at LIMIT 1", [U.practice])).rows[0].id;
    await admin.query("UPDATE public.companies SET is_active=false WHERE id=$1", [archId]);          // now 4 active
    await admin.query("INSERT INTO public.companies (user_id, name) VALUES ($1,'E5c')", [U.practice]); // back to 5
    let restoreRef=false; try { await admin.query("UPDATE public.companies SET is_active=true WHERE id=$1", [archId]); } catch { restoreRef=true; } // would be 6th
    const stillThere = (await admin.query("SELECT count(*)::int n FROM public.companies WHERE id=$1", [archId])).rows[0].n;
    rec("ARCHIVE/RESTORE · archive frees a slot; restoring past the limit is refused AND the archived row is preserved", restoreRef && stillThere === 1); }

  // 12 · Grant/revoke history is recorded (append-only ledger with full provenance).
  const hist = (await admin.query("SELECT count(*)::int n FROM public.access_grant_events WHERE recipient_user_id IN ($1,$2)", [U.owner, U.recipient])).rows[0].n;
  let ledgerImmutable=false; try { await admin.query("UPDATE public.access_grant_events SET reason='x' WHERE recipient_user_id=$1", [U.recipient]); } catch { ledgerImmutable=true; }
  rec("HISTORY · every grant/revoke is recorded in an append-only ledger (events present AND immutable)", hist >= 3 && ledgerImmutable);

  // 7b · Last-active-owner protection.
  await mintNonce(U.owner, "N3");
  await refused("LAST-OWNER · the last active platform owner cannot be removed", U.owner,
    (c)=>c.query("SELECT public.revoke_platform_owner($1,'drop','N3')", [U.owner]), /LAST_PLATFORM_OWNER/);

  // ── Review verifications (directive): reauthentication properties + no escalation via general endpoints ──
  // Single-use: a fresh nonce works once, then cannot be reused.
  await mintNonce(U.owner, "NREUSE");
  await allowed("REAUTH · a fresh nonce is accepted exactly once", U.owner,
    (c)=>c.query("SELECT public.owner_grant_complimentary_access($1,'REPORTING_PACK_EXPORT','once',NULL,'NREUSE')", [U.recipient]));
  await refused("REAUTH · the same nonce cannot be reused (single-use)", U.owner,
    (c)=>c.query("SELECT public.owner_grant_complimentary_access($1,'CLOSE_ASSURANCE','reuse',NULL,'NREUSE')", [U.recipient]), /REAUTH_REQUIRED/);
  // Expiry: a past-expiry nonce is refused.
  await admin.query("INSERT INTO public.privileged_reauth (user_id, nonce, expires_at) VALUES ($1,'NEXPIRED', now()-interval '1 minute')", [U.owner]);
  await refused("REAUTH · an expired nonce is refused", U.owner,
    (c)=>c.query("SELECT public.owner_grant_complimentary_access($1,'CLOSE_ASSURANCE','expired',NULL,'NEXPIRED')", [U.recipient]), /REAUTH_REQUIRED/);
  // Bound to the authenticated user: a nonce minted for another user cannot be used by the owner.
  await mintNonce(U.ordinary, "NBOUND");
  await refused("REAUTH · a nonce minted for another user cannot be used (bound to auth.uid(), not forgeable/transferable)", U.owner,
    (c)=>c.query("SELECT public.owner_grant_complimentary_access($1,'CLOSE_ASSURANCE','crossuser',NULL,'NBOUND')", [U.recipient]), /REAUTH_REQUIRED/);

  // A COMMERCIAL admin (authority='commercial', the "ordinary administrator") cannot grant platform-owner authority.
  await admin.query("INSERT INTO public.commercial_admins (user_id, granted_by, active, authority) VALUES ($1,$1,true,'commercial') ON CONFLICT (user_id) DO UPDATE SET active=true, authority='commercial'", [U.ordinary]);
  await mintNonce(U.ordinary, "NCA");
  await refused("ESCALATION · a commercial admin (NOT a platform owner) cannot grant platform-owner authority", U.ordinary,
    (c)=>c.query("SELECT public.grant_platform_owner($1,'escalate','NCA')", [U.ordinary]), /NOT_A_PLATFORM_OWNER/);
  // No general endpoint writes commercial_admins: authenticated has no UPDATE grant, so a direct escalation is refused.
  { let direct=false,d=""; try { await asUser(U.ordinary, (c)=>c.query("UPDATE public.commercial_admins SET authority='platform_owner' WHERE user_id=$1",[U.ordinary])); } catch(e){ direct=true; d=String(e.message).split("\n")[0]; }
    rec("ESCALATION · authenticated cannot directly write commercial_admins.authority (no UPDATE grant → permission denied)", direct && /permission denied/i.test(d)); }

  await pool.end(); await admin.end();
  const failed = results.filter(r=>!r.ok);
  console.log(`\n${results.length-failed.length}/${results.length} assertions as expected.`);
  process.exit(failed.length ? 1 : 0);
}
main().catch(async (e) => { console.error("PROOF ERROR:", e.message); try { await pool?.end(); } catch {} try { await admin?.end(); } catch {} process.exit(2); });
