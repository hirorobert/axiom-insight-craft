#!/usr/bin/env node
// Real-PostgreSQL proof of unlimited team members on Solo, Practice and Firm (20261110100000_unlimited_team_members.sql).
//
//   migration     applies over the full chain; a second application is refused before any change; every licence
//                 (with its recorded purchased seats), override, suspension, seat-price row and audit row is kept as recorded;
//                 prices, entity capacities and the Enterprise terms are unchanged; the proposed seat price is retired, not deleted
//   unlimited     each plan answers {unlimited: true}; a second member, and then members far beyond the former seat
//                 boundary, are invited, accepted and active; 12 concurrent invitations and 12 concurrent acceptances all
//                 succeed; nobody is ever counted "over allowance"
//   authority     an ordinary member cannot invite, cannot change their own title, cannot grant themselves a capability,
//                 and receives no review or approval capability; a cross-tenant invitation is refused; a non-member
//                 reads nothing; a revoked member loses access at once
//   preserved     invitation expiry and cancellation, billing suspension (append-only; lifted only by the account holder),
//                 loss of the plan (back to the holder only), active-entity limits, the Enterprise numeric allowance, and
//                 purchased-seat history (never raised on an unlimited plan)
//
//   DB_PROOF_MODULES_DIR=<dir whose node_modules has pg + embedded-postgres> node scripts/db-proof/unlimitedTeamMembers.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
// It reads no Supabase credential and refuses every non-loopback host and the production project reference.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const PG_CRON_FILE = "20260810044930_fcf7b034-7dc7-445d-a77d-99be66c3c4f4.sql";
const MIGRATION = "20261110100000_unlimited_team_members.sql";
const MODE = process.env.DB_PROOF_MODE ?? "embedded";
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const CONCURRENCY = 12;

const req = createRequire(MODULES_DIR ? path.join(path.resolve(MODULES_DIR), "noop.js") : import.meta.url);
const { Pool, Client } = req("pg");

const results = [];
let currentGroup = "";
const group = (n) => { currentGroup = n; console.log(`\n== ${n}`); };
function record(name, ok, detail = "") {
  results.push({ group: currentGroup, name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
}
async function check(name, fn) {
  try { const r = await fn(); record(name, r === true, r === true ? "" : `assertion returned ${JSON.stringify(r)?.slice(0, 900)}`); }
  catch (e) { record(name, false, `exception ${e.code ?? ""}: ${String(e?.message ?? e).split("\n")[0]}`); }
}

let pool, admin, embeddedServer = null, embeddedDir = null;
function assertLocal(u) {
  const url = new URL(u);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) throw new Error(`REFUSED: ${url.hostname} is not loopback`);
  if (u.includes(PRODUCTION_REF)) throw new Error("REFUSED: production project reference");
}
async function startDatabase() {
  if (MODE === "external") { assertLocal(process.env.DB_PROOF_CONN); return process.env.DB_PROOF_CONN; }
  const modDir = MODULES_DIR ? path.resolve(MODULES_DIR) : REPO;
  const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(modDir, "node_modules/embedded-postgres/dist/index.js")).href);
  embeddedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-unlimited-members-proof-"));
  const port = 54000 + Math.floor(Math.random() * 900);
  embeddedServer = new EmbeddedPostgres({ databaseDir: path.join(embeddedDir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await embeddedServer.initialise();
  await embeddedServer.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect(); await boot.query("CREATE DATABASE unlimited_members_proof"); await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/unlimited_members_proof`;
}
async function stopDatabase() {
  try { await pool?.end(); } catch { /* ignore */ }
  try { await admin?.end(); } catch { /* ignore */ }
  if (embeddedServer) { try { await embeddedServer.stop(); } catch { /* ignore */ } }
  if (embeddedDir) { try { fs.rmSync(embeddedDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ } }
}
const migrationFiles = () => fs.readdirSync(path.join(REPO, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
async function applyMigration(f) {
  let text = fs.readFileSync(path.join(REPO, "supabase/migrations", f), "utf8");
  if (f === PG_CRON_FILE) text = text.split("\n").slice(0, text.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
  try { await admin.query(text); } catch (e) { const err = new Error(`migration ${f} failed: ${String(e.message).split("\n")[0]}`); err.code = e.code; throw err; }
}
async function asCaller(caller, fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    if (caller.kind === "service") {
      await c.query("SET LOCAL ROLE service_role");
      await c.query("SELECT set_config('request.jwt.claim.role','service_role',true), set_config('request.jwt.claim.sub','',true)");
    } else {
      await c.query("SET LOCAL ROLE authenticated");
      await c.query("SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)", [caller.uid]);
    }
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    try { await c.query("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  } finally { c.release(); }
}
const user = (uid) => ({ kind: "user", uid });
const SERVICE = { kind: "service" };
const q = (caller, sql, params) => asCaller(caller, async (c) => (await c.query(sql, params)).rows);
const one = async (caller, sql, params) => (await q(caller, sql, params))[0];
const uuid = () => globalThis.crypto.randomUUID();
const count = async (sql, params = []) => Number((await admin.query(sql, params)).rows[0].n);
const codeOf = async (fn) => { try { await fn(); return "ok"; } catch (e) { return e.code ?? "error"; } };

async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url });
  await admin.connect();
  pool = new Pool({ connectionString: url, max: CONCURRENCY * 2 + 8 });
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  await admin.query(`GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  const files = migrationFiles();
  const cut = files.indexOf(MIGRATION);

  group("Migration chain");
  await check(`every migration before ${MIGRATION} applies`, async () => {
    if (cut < 0) return "migration not found";
    for (const f of files.slice(0, cut)) await applyMigration(f);
    return true;
  });

  // ── Fixtures created under the FORMER seat model (so the change is proven over existing customers) ──────────────
  const mkUser = async (label = "u") => { const id = uuid(); await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${label}-${id}@example.test`]); return id; };
  const U = { admin: await mkUser("admin"), outsider: await mkUser("outsider") };
  await admin.query("INSERT INTO public.commercial_admins (user_id) VALUES ($1)", [U.admin]);
  const product = (await admin.query("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).rows[0].id;
  const planId = async (code) => (await admin.query("SELECT id FROM public.commercial_plans WHERE product_id=$1 AND code=$2", [product, code])).rows[0].id;
  const account = async (planCode, seats = 0) => {
    const uid = await mkUser(`acct-${planCode ?? "none"}`);
    const bc = (await admin.query("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, product])).rows[0].id;
    let licence = null;
    if (planCode) {
      licence = (await admin.query(`INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats)
        VALUES ($1,$2,'ACTIVE','ADMIN_GRANT',now() - interval '1 day',$3) RETURNING id`, [bc, await planId(planCode), seats])).rows[0].id;
    }
    if (planCode === "ENTERPRISE") {
      // Enterprise capacities are agreed per contract (the plan carries none): record the agreed entity allowance.
      await admin.query(`INSERT INTO public.entitlement_overrides (billing_customer_id, feature_code, capacity_value, effective_start, granted_by, reason)
        VALUES ($1,'ENTITY_CAPACITY',5,now() - interval '1 day',$2,'agreed Enterprise entities')`, [bc, U.admin]);
    }
    const co = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,$2) RETURNING id", [uid, `Co ${uid.slice(0, 8)}`])).rows[0].id;
    return { uid, bc, co, licence };
  };
  const reserve = async (co, who, by, role = "preparer") => (await one(SERVICE, "SELECT public.reserve_workspace_invitation($1,$2,$3,$4,$5) r", [co, who, role, by, `${who}@example.test`])).r;
  const accept = async (who) => (await one(user(who), "SELECT public.accept_workspace_invitations() r")).r;
  const join = async (acct, role = "preparer") => { const p = await mkUser("member"); const r = await reserve(acct.co, p, acct.uid, role); const a = await accept(p); return { p, r, a }; };
  const cap = async (acct) => (await admin.query("SELECT public._seat_capacity_for_account($1) c", [acct.uid])).rows[0].c;
  const isActive = async (acct, p) => (await admin.query("SELECT public._account_named_user_access_active($1,$2) a", [acct.uid, p])).rows[0].a;
  const accepted = async (acct, p) => (await count("SELECT count(*) n FROM public.firm_members WHERE company_id=$1 AND user_id=$2 AND accepted_at IS NOT NULL", [acct.co, p])) === 1;
  const workspaceAccess = async (p, co) => (await one(user(p), "SELECT public.get_workspace_access($1) r", [co]))?.r ?? null;
  const seatState = async (acct) => (await one(user(acct.uid), "SELECT public.get_workspace_seat_capacity($1) r", [acct.co])).r;
  const roster = async (acct) => (await one(user(acct.uid), "SELECT public.get_named_user_roster() r")).r;

  const solo = await account("SOLO");
  const practice = await account("PRACTICE", 2);   // two seats purchased under the former model
  const practiceFull = { ...practice, members: [] };
  for (let i = 0; i < 2; i++) practiceFull.members.push((await join(practice)).p);
  const firm = await account("FIRM");
  const enterprise = await account("ENTERPRISE");
  await admin.query(`INSERT INTO public.entitlement_overrides (billing_customer_id, feature_code, capacity_value, effective_start, granted_by, reason)
    VALUES ($1,'NAMED_USER_SEATS',2,now() - interval '1 day',$2,'agreed Enterprise allowance')`, [enterprise.bc, U.admin]);
  // A person suspended under the former model (the Practice account dropped back to fewer seats before the change).
  const suspendedAcct = await account("PRACTICE", 1);
  const suspendedPerson = (await join(suspendedAcct)).p;
  await admin.query("UPDATE public.commercial_licences SET additional_seats = 0 WHERE id=$1", [suspendedAcct.licence]);
  await admin.query("SELECT public.reconcile_named_user_allowance($1)", [suspendedAcct.uid]);

  const before = {
    soloRefused: (await join(solo)).r.outcome,
    licences: (await admin.query("SELECT id, plan_id, status, additional_seats, effective_start, effective_end FROM public.commercial_licences ORDER BY id")).rows,
    overrides: (await admin.query("SELECT to_jsonb(e) j FROM public.entitlement_overrides e ORDER BY id")).rows,
    suspensions: (await admin.query("SELECT to_jsonb(s) j FROM public.named_user_billing_suspensions s ORDER BY id")).rows,
    audit: (await admin.query("SELECT to_jsonb(b) j FROM public.billing_audit_events b ORDER BY id")).rows,
    seatPrices: (await admin.query("SELECT id, plan_id, amount_minor, billing_interval, is_purchasable FROM public.commercial_additional_seat_prices ORDER BY id")).rows,
    offers: (await admin.query("SELECT id, plan_id, amount_minor, currency_code, billing_interval, is_active, is_purchasable FROM public.commercial_offers ORDER BY id")).rows,
    plans: (await admin.query("SELECT code, entity_capacity, included_seats, sales_mode, feature_codes FROM public.commercial_plans ORDER BY code")).rows,
  };

  await check(`${MIGRATION} applies; a second application is refused before any change (PREFLIGHT_REFUSED)`, async () => {
    await applyMigration(MIGRATION);
    let second = null;
    try { await applyMigration(MIGRATION); } catch (e) { second = e; }
    for (const f of files.slice(cut + 1)) await applyMigration(f);
    return second && /already in force/.test(second.message) ? true : second?.message ?? "applied twice";
  });
  await check("history is kept: every licence (with its recorded purchased seats), override, suspension and audit row is unchanged; no row was deleted", async () => {
    const same = async (sql, prev) => JSON.stringify((await admin.query(sql)).rows) === JSON.stringify(prev);
    const ok = await same("SELECT id, plan_id, status, additional_seats, effective_start, effective_end FROM public.commercial_licences ORDER BY id", before.licences)
      && await same("SELECT to_jsonb(e) j FROM public.entitlement_overrides e ORDER BY id", before.overrides)
      && await same("SELECT to_jsonb(s) j FROM public.named_user_billing_suspensions s ORDER BY id", before.suspensions)
      && await same("SELECT to_jsonb(b) j FROM public.billing_audit_events b ORDER BY id", before.audit);
    const recorded = (await admin.query("SELECT additional_seats FROM public.commercial_licences WHERE id=$1", [practice.licence])).rows[0].additional_seats;
    return ok && recorded === 2 ? true : { ok, recorded };
  });
  await check("the offer: Solo, Practice and Firm have unlimited team members and sell no seats; Enterprise is unchanged; prices, entity capacities and features are unchanged", async () => {
    const plans = (await admin.query("SELECT code, members_unlimited, additional_seats_purchasable FROM public.commercial_plans WHERE code IN ('SOLO','PRACTICE','FIRM','ENTERPRISE') ORDER BY code")).rows;
    const flags = Object.fromEntries(plans.map((p) => [p.code, `${p.members_unlimited}/${p.additional_seats_purchasable}`]));
    const offersSame = JSON.stringify((await admin.query("SELECT id, plan_id, amount_minor, currency_code, billing_interval, is_active, is_purchasable FROM public.commercial_offers ORDER BY id")).rows) === JSON.stringify(before.offers);
    const plansSame = JSON.stringify((await admin.query("SELECT code, entity_capacity, included_seats, sales_mode, feature_codes FROM public.commercial_plans ORDER BY code")).rows) === JSON.stringify(before.plans);
    return flags.SOLO === "true/false" && flags.PRACTICE === "true/false" && flags.FIRM === "true/false" && flags.ENTERPRISE === "false/false" && offersSame && plansSame
      ? true : { flags, offersSame, plansSame };
  });
  await check("the proposed USD 200 additional-seat price is retired, not deleted: the same rows, inactive, never purchasable", async () => {
    const rows = (await admin.query("SELECT id, plan_id, amount_minor, billing_interval, is_purchasable, is_active FROM public.commercial_additional_seat_prices ORDER BY id")).rows;
    const sameRows = JSON.stringify(rows.map(({ is_active, ...r }) => r)) === JSON.stringify(before.seatPrices);
    return rows.length === before.seatPrices.length && rows.length > 0 && sameRows && rows.every((r) => !r.is_active && !r.is_purchasable) ? true : { rows, sameRows };
  });
  await check("unlimited is an explicit flag, never a number: a CHECK refuses it on Enterprise and refuses seat sales on an unlimited plan", async () => {
    const ent = await codeOf(() => admin.query("UPDATE public.commercial_plans SET members_unlimited = true WHERE code='ENTERPRISE'"));
    const sell = await codeOf(() => admin.query("UPDATE public.commercial_plans SET additional_seats_purchasable = true WHERE code='PRACTICE'"));
    return ent === "23514" && sell === "23514" ? true : { ent, sell };
  });

  group("Unlimited team members on Solo, Practice and Firm");
  await check("before the change Solo refused a second member (SEAT_LIMIT_REACHED); now every unlimited plan answers {unlimited: true, determined: true} with no number", async () => {
    const caps = await Promise.all([solo, practice, firm].map(cap));
    return before.soloRefused === "seat_limit_reached" && caps.every((c) => c.unlimited === true && c.determined === true && c.allowed_named_users === null && c.source === "PLAN_UNLIMITED_TEAM_MEMBERS")
      ? true : { soloRefused: before.soloRefused, caps };
  });
  for (const [label, acct] of [["Solo", solo], ["Practice", practice], ["Firm", firm]]) {
    await check(`${label}: a second authorised member is invited, accepts and is active (and can open the workspace)`, async () => {
      const { p, r, a } = await join(acct);
      const access = await workspaceAccess(p, acct.co);
      return r.outcome === "reserved" && (await accepted(acct, p)) && (await isActive(acct, p)) && access !== null && access?.access !== false ? true : { r, a, access };
    });
    await check(`${label}: eight more members, well past the former boundary, are all active; the seat state and roster are never over an allowance`, async () => {
      const people = [];
      for (let i = 0; i < 8; i++) people.push((await join(acct)).p);
      const active = await Promise.all(people.map((p) => isActive(acct, p)));
      const s = await seatState(acct), ro = await roster(acct);
      return active.every(Boolean) && s.unlimited === true && s.over_allowance === false && ro.unlimited === true && ro.over_allowance === false ? true : { active, s, ro };
    });
  }
  await check(`${CONCURRENCY} concurrent invitations to one Practice workspace all reserve; ${CONCURRENCY} concurrent acceptances all succeed; all active`, async () => {
    const people = await Promise.all(Array.from({ length: CONCURRENCY }, () => mkUser("concurrent")));
    const reserved = await Promise.all(people.map((p) => reserve(practice.co, p, practice.uid)));
    const acc = await Promise.all(people.map((p) => accept(p)));
    const active = await Promise.all(people.map((p) => isActive(practice, p)));
    const acceptedAll = (await Promise.all(people.map((p) => accepted(practice, p)))).every(Boolean);
    return reserved.every((r) => r.outcome === "reserved") && acceptedAll && active.every(Boolean) ? true : { reserved: reserved.map((r) => r.outcome), acc, active };
  });
  await check("the invitation pre-check used before any email is sent answers ALLOWED with unlimited = true", async () => {
    const r = (await one(SERVICE, "SELECT public.seat_check_for_invitation($1,$2) r", [firm.co, await mkUser("pre")])).r;
    return r.allowed === true && r.code === "ALLOWED" && r.unlimited === true ? true : r;
  });
  await check("the entitlement resolver states the capacity is unlimited (status ENTITLED, capacity null, unlimited true)", async () => {
    const r = (await admin.query("SELECT public._resolve_entitlement_for_owner($1,'NAMED_USER_SEATS') r", [practice.uid])).rows[0].r;
    return r.status === "ENTITLED" && r.capacity === null && r.unlimited === true ? true : r;
  });

  group("Authority is unchanged: membership never grants more than its title");
  const memberOf = async (acct) => (await join(acct)).p;
  await check("an ordinary member (preparer) cannot invite anyone: no manage_members, and a direct membership insert is refused", async () => {
    const m = await memberOf(firm);
    const canManage = (await admin.query("SELECT public.has_workspace_capability($1,$2,'manage_members') r", [firm.co, m])).rows[0].r;
    const direct = await codeOf(() => q(user(m), "INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'preparer',NULL)", [firm.co, uuid()]));
    return canManage === false && direct !== "ok" ? true : { canManage, direct };
  });
  await check("a member cannot change their own title to partner or owner, and cannot grant themselves a capability", async () => {
    const m = await memberOf(practice);
    // Refused either with an error or as a no-op (RLS / guard): the EFFECT is what is asserted.
    const changed = async (title) => { try { return (await q(user(m), `UPDATE public.firm_members SET role='${title}' WHERE company_id=$1 AND user_id=$2 RETURNING id`, [practice.co, m])).length; } catch { return 0; } };
    const partner = await changed("partner"), owner = await changed("owner");
    let grant;
    try { grant = (await one(user(m), "SELECT * FROM public.grant_workspace_capability($1,$2,'manage_source_files')", [practice.co, m]))?.outcome; } catch (e) { grant = e.code; }
    const role = (await admin.query("SELECT role FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [practice.co, m])).rows[0].role;
    const elevated = await count(`SELECT count(*) n FROM public.workspace_member_capabilities WHERE company_id=$1 AND user_id=$2 AND revoked_at IS NULL
       AND capability IN ('review_close','approve_certification','manage_members')`, [practice.co, m]);
    return partner === 0 && owner === 0 && grant !== "granted" && role === "preparer" && elevated === 0 ? true : { partner, owner, grant, role, elevated };
  });
  await check("joining as a preparer or viewer confers no review or approval capability (review_close, approve_certification)", async () => {
    const pre = await memberOf(firm), view = (await join(firm, "viewer")).p;
    const caps = (await admin.query(`SELECT user_id, array_agg(capability ORDER BY capability) c FROM public.workspace_member_capabilities
       WHERE company_id=$1 AND user_id = ANY($2::uuid[]) AND revoked_at IS NULL GROUP BY user_id`, [firm.co, [pre, view]])).rows;
    const bad = caps.filter((r) => r.c.some((x) => ["review_close", "approve_certification", "manage_members"].includes(x)));
    return bad.length === 0 && caps.length === 2 ? true : caps;
  });
  await check("cross-tenant: the owner of one account cannot add a member to another account's workspace; an outsider reads no members", async () => {
    const cross = await codeOf(() => q(user(solo.uid), "INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'preparer',now())", [firm.co, solo.uid]));
    const seen = await q(user(U.outsider), "SELECT id FROM public.firm_members WHERE company_id=$1", [firm.co]);
    const seat = await seatState({ uid: U.outsider, co: firm.co });
    return cross !== "ok" && seen.length === 0 && seat.access === false ? true : { cross, seen: seen.length, seat };
  });
  await check("a revoked member loses access at once: membership removed, its capabilities ended, workspace access and member list gone", async () => {
    const m = await memberOf(solo);
    const had = await workspaceAccess(m, solo.co);
    await q(user(solo.uid), "DELETE FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [solo.co, m]);
    const after = await workspaceAccess(m, solo.co);
    const open = await count("SELECT count(*) n FROM public.workspace_member_capabilities WHERE company_id=$1 AND user_id=$2 AND revoked_at IS NULL", [solo.co, m]);
    const rows = await q(user(m), "SELECT id FROM public.firm_members WHERE company_id=$1", [solo.co]);
    return had?.access !== false && had !== null && (after === null || after?.access === false) && open === 0 && rows.length === 0 ? true : { had, after, open, rows: rows.length };
  });

  group("Preserved controls");
  await check("invitation lifecycle: an expired invitation cannot be accepted; a cancelled one cannot be accepted", async () => {
    const p1 = await mkUser("exp"), p2 = await mkUser("can");
    const r1 = await reserve(practice.co, p1, practice.uid), r2 = await reserve(practice.co, p2, practice.uid);
    await admin.query("UPDATE public.firm_members SET invitation_expires_at = now() - interval '1 minute' WHERE id=$1", [r1.member_id]);
    await one(user(practice.uid), "SELECT public.cancel_workspace_invitation($1) r", [r2.member_id]);
    await accept(p1); await accept(p2);
    return !(await accepted(practice, p1)) && !(await accepted(practice, p2)) ? true : "an invalid invitation was accepted";
  });
  await check("a person suspended before the change stays suspended (no access) until the account holder reactivates them; nobody else is suspended", async () => {
    const stillSuspended = !(await isActive(suspendedAcct, suspendedPerson));
    const r = await roster(suspendedAcct);
    const chosen = (await one(user(suspendedAcct.uid), "SELECT public.choose_active_named_users($1::uuid[], $2) r", [[suspendedPerson], r.roster_version])).r;
    const nowActive = await isActive(suspendedAcct, suspendedPerson);
    const open = await count("SELECT count(*) n FROM public.named_user_billing_suspensions WHERE account_user_id=$1 AND lifted_at IS NULL", [suspendedAcct.uid]);
    const history = await count("SELECT count(*) n FROM public.named_user_billing_suspensions WHERE account_user_id=$1", [suspendedAcct.uid]);
    return stillSuspended && chosen.outcome === "applied" && nowActive && open === 0 && history >= 1 ? true : { stillSuspended, chosen, nowActive, open, history };
  });
  await check("losing the plan still falls back to the account holder only: everyone else is suspended (history kept), the holder keeps access", async () => {
    const acct = await account("FIRM");
    const people = [(await join(acct)).p, (await join(acct)).p, (await join(acct)).p];
    await admin.query("UPDATE public.commercial_licences SET status='EXPIRED', effective_end = now() - interval '1 minute' WHERE id=$1", [acct.licence]);
    await admin.query("SELECT public.reconcile_named_user_allowance($1)", [acct.uid]);
    const c = await cap(acct);
    const active = await Promise.all(people.map((p) => isActive(acct, p)));
    const holder = await isActive(acct, acct.uid);
    return c.unlimited === false && c.allowed_named_users === 1 && active.every((x) => x === false) && holder === true ? true : { c, active, holder };
  });
  await check("active-entity limits still apply: Solo cannot open a second entity (ENTITY_CAPACITY_REACHED)", async () => {
    const code = await codeOf(() => q(user(solo.uid), "INSERT INTO public.companies (user_id,name) VALUES ($1,'Second entity')", [solo.uid]));
    return code === "PT402" ? true : code;
  });
  await check("Enterprise keeps its agreed numeric allowance: two named users, the third is refused (SEAT_LIMIT_REACHED)", async () => {
    const c = await cap(enterprise);
    const second = (await join(enterprise)).r.outcome;
    const third = (await join(enterprise)).r.outcome;
    return c.unlimited === false && c.allowed_named_users === 2 && second === "reserved" && third === "seat_limit_reached" ? true : { c, second, third };
  });
  await check("purchased-seat history on an unlimited plan can be lowered (recorded, audited) but never raised", async () => {
    const raise = await codeOf(() => one(user(U.admin), "SELECT public.admin_set_licence_additional_seats($1,3,'more seats') r", [practice.licence]));
    const lower = await codeOf(() => one(user(U.admin), "SELECT public.admin_set_licence_additional_seats($1,1,'customer agreed record') r", [practice.licence]));
    const now = (await admin.query("SELECT additional_seats FROM public.commercial_licences WHERE id=$1", [practice.licence])).rows[0].additional_seats;
    const audited = await count("SELECT count(*) n FROM public.billing_audit_events WHERE action='LICENCE_ADDITIONAL_SEATS_SET' AND (new_state->>'licence_id')::uuid=$1", [practice.licence]);
    return raise === "22023" && lower === "ok" && now === 1 && audited === 1 ? true : { raise, lower, now, audited };
  });
  await check("the existing Practice members (joined under the former two-seat purchase) are all still active", async () => {
    const active = await Promise.all(practiceFull.members.map((p) => isActive(practice, p)));
    return active.every(Boolean) ? true : active;
  });

  group("Suspension, revocation and reactivation after the change (every path re-proved on the new chain)");
  const authz = async (who, co, capCode = "COMPARATIVE_REPORTING") => (await one(user(who), "SELECT public.authorize_paid_action($1,$2) r", [co, capCode])).r;
  const suspendAll = async (acct) => {   // loss of the plan: the account falls back to the holder; everyone else suspended
    await admin.query("UPDATE public.commercial_licences SET status='EXPIRED', effective_end = now() - interval '1 minute' WHERE id=$1", [acct.licence]);
    await admin.query("SELECT public.reconcile_named_user_allowance($1)", [acct.uid]);
  };
  const restorePlan = async (acct, code) => {   // a new current licence on an unlimited plan (renewal)
    acct.licence = (await admin.query(`INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats)
      VALUES ($1,$2,'ACTIVE','ADMIN_GRANT',now() - interval '1 second',0) RETURNING id`, [acct.bc, await planId(code)])).rows[0].id;
    await admin.query("SELECT public.reconcile_named_user_allowance($1)", [acct.uid]);
  };
  const openSuspensions = (acct) => count("SELECT count(*) n FROM public.named_user_billing_suspensions WHERE account_user_id=$1 AND lifted_at IS NULL", [acct.uid]);
  const lapsed = await account("PRACTICE");
  const lapsedPeople = [];
  for (let i = 0; i < 4; i++) lapsedPeople.push((await join(lapsed)).p);
  await suspendAll(lapsed);
  const S = lapsedPeople[0];
  const sameDenial = async (fn) => JSON.stringify(await fn(S)) === JSON.stringify(await fn(U.outsider));
  await check("a suspended person gets exactly an outsider's answer: paid-action authority, seat state, workspace access, member rows", async () =>
    (await sameDenial((w) => authz(w, lapsed.co)))
    && (await sameDenial(async (w) => (await one(user(w), "SELECT public.get_workspace_seat_capacity($1) r", [lapsed.co])).r))
    && (await sameDenial(async (w) => (await q(user(w), "SELECT * FROM public.get_workspace_access($1)", [lapsed.co])).length))
    && (await sameDenial(async (w) => (await q(user(w), "SELECT id FROM public.firm_members WHERE company_id=$1", [lapsed.co])).length))
    ? true : "a suspended person sees more than an outsider");
  await check("re-inviting a suspended person is refused (named_user_suspended); the pre-invitation check says NAMED_USER_SUSPENDED", async () => {
    const r = await reserve(lapsed.co, S, lapsed.uid);
    const pre = (await one(SERVICE, "SELECT public.seat_check_for_invitation($1,$2) r", [lapsed.co, S])).r;
    return ["named_user_suspended", "already_member"].includes(r.outcome) && pre.allowed === false && pre.code === "NAMED_USER_SUSPENDED" ? true : { r, pre };
  });
  await check("suspension history stays append-only on the new chain: no client write, no delete; a suspension changes only by a single lift", async () => {
    const del = await codeOf(() => admin.query("DELETE FROM public.named_user_billing_suspensions WHERE account_user_id=$1", [lapsed.uid]));
    const client = await codeOf(() => q(user(lapsed.uid), "UPDATE public.named_user_billing_suspensions SET lifted_at=now() WHERE account_user_id=$1", [lapsed.uid]));
    const rewrite = await codeOf(() => admin.query("UPDATE public.named_user_billing_suspensions SET reason='OTHER' WHERE account_user_id=$1", [lapsed.uid]));
    return del === "P0001" && client !== "ok" && rewrite === "P0001" && (await openSuspensions(lapsed)) === 4 ? true : { del, client, rewrite, open: await openSuspensions(lapsed) };
  });
  await check("restoring an unlimited plan reactivates NOBODY by itself: all four stay suspended with no access", async () => {
    await restorePlan(lapsed, "PRACTICE");
    const c = await cap(lapsed);
    const active = await Promise.all(lapsedPeople.map((p) => isActive(lapsed, p)));
    return c.unlimited === true && active.every((a) => a === false) && (await openSuspensions(lapsed)) === 4 ? true : { c, active };
  });
  await check("the holder's reactivation is version-checked: a stale roster version and an invalid selection change nothing", async () => {
    const stale = (await one(user(lapsed.uid), "SELECT public.choose_active_named_users($1::uuid[], 'not-the-version') r", [[S]])).r;
    const r = await roster(lapsed);
    const invalid = (await one(user(lapsed.uid), "SELECT public.choose_active_named_users($1::uuid[], $2) r", [[U.outsider], r.roster_version])).r;
    const self = (await one(user(lapsed.uid), "SELECT public.choose_active_named_users($1::uuid[], $2) r", [[lapsed.uid], r.roster_version])).r;
    return stale.outcome === "stale_selection" && invalid.outcome === "invalid_selection" && self.outcome === "invalid_selection" && (await openSuspensions(lapsed)) === 4
      ? true : { stale, invalid, self };
  });
  await check(`${CONCURRENCY} simultaneous reactivations from one roster version: exactly one applies, the rest are stale; only the chosen people are reactivated`, async () => {
    const r = await roster(lapsed);
    const outs = await Promise.all(Array.from({ length: CONCURRENCY }, () => one(user(lapsed.uid), "SELECT public.choose_active_named_users($1::uuid[], $2) r", [[lapsedPeople[0], lapsedPeople[1]], r.roster_version]).then((x) => x.r.outcome)));
    const active = await Promise.all(lapsedPeople.map((p) => isActive(lapsed, p)));
    return outs.filter((o) => o === "applied").length === 1 && outs.filter((o) => o === "stale_selection").length === CONCURRENCY - 1
      && JSON.stringify(active) === JSON.stringify([true, true, false, false]) && (await openSuspensions(lapsed)) === 2 ? true : { outs, active };
  });
  await check("a reactivation under unlimited never suspends anyone else, and is audited once with the people it lifted", async () => {
    const r = await roster(lapsed);
    const before = await count("SELECT count(*) n FROM public.billing_audit_events WHERE billing_customer_id=$1 AND action='NAMED_USER_SELECTION_APPLIED'", [lapsed.bc]);
    const out = (await one(user(lapsed.uid), "SELECT public.choose_active_named_users($1::uuid[], $2) r", [[lapsedPeople[2]], r.roster_version])).r;
    const active = await Promise.all(lapsedPeople.map((p) => isActive(lapsed, p)));
    const after = await count("SELECT count(*) n FROM public.billing_audit_events WHERE billing_customer_id=$1 AND action='NAMED_USER_SELECTION_APPLIED'", [lapsed.bc]);
    return out.outcome === "applied" && JSON.stringify(out.suspended) === "[]" && JSON.stringify(active) === JSON.stringify([true, true, true, false]) && after === before + 1
      ? true : { out, active, before, after };
  });
  await check("revoking a reactivated member ends their access at once; their suspension history is kept", async () => {
    const m = lapsedPeople[1];
    await q(user(lapsed.uid), "DELETE FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [lapsed.co, m]);
    const active = await isActive(lapsed, m);
    const access = await workspaceAccess(m, lapsed.co);
    const history = await count("SELECT count(*) n FROM public.named_user_billing_suspensions WHERE account_user_id=$1 AND user_id=$2", [lapsed.uid, m]);
    return (await accepted(lapsed, m)) === false && (access === null || access?.access === false) && history === 1 ? true : { active, access, history };
  });
  await check("Enterprise (numeric allowance) keeps the original rule: a reduced allowance suspends everyone but the holder; the holder reactivates within the allowance, never beyond it", async () => {
    const ent = await account("ENTERPRISE");
    await admin.query(`INSERT INTO public.entitlement_overrides (billing_customer_id, feature_code, capacity_value, effective_start, granted_by, reason)
      VALUES ($1,'NAMED_USER_SEATS',3,now() - interval '1 day',$2,'agreed Enterprise allowance')`, [ent.bc, U.admin]);
    const people = [(await join(ent)).p, (await join(ent)).p];
    await admin.query("UPDATE public.entitlement_overrides SET revoked_at = now(), revoked_by = $2 WHERE billing_customer_id=$1 AND feature_code='NAMED_USER_SEATS'", [ent.bc, U.admin]);
    await admin.query(`INSERT INTO public.entitlement_overrides (billing_customer_id, feature_code, capacity_value, effective_start, granted_by, reason)
      VALUES ($1,'NAMED_USER_SEATS',2,now() - interval '1 second',$2,'agreed reduction')`, [ent.bc, U.admin]);
    await admin.query("SELECT public.reconcile_named_user_allowance($1)", [ent.uid]);
    const afterReduction = await Promise.all(people.map((p) => isActive(ent, p)));
    const r = await roster(ent);
    const out = (await one(user(ent.uid), "SELECT public.choose_active_named_users($1::uuid[], $2) r", [[people[1]], r.roster_version])).r;
    const tooMany = (await one(user(ent.uid), "SELECT public.choose_active_named_users($1::uuid[], $2) r", [people, (await roster(ent)).roster_version])).r;
    const active = await Promise.all(people.map((p) => isActive(ent, p)));
    return r.unlimited === false && afterReduction.every((a) => a === false) && out.outcome === "applied" && tooMany.outcome === "selection_exceeds_allowance"
      && JSON.stringify(active) === JSON.stringify([false, true]) ? true : { r: { u: r.unlimited, o: r.over_allowance }, afterReduction, out, tooMany, active };
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  return failed.length === 0;
}

main().then(async (ok) => { await stopDatabase(); process.exit(ok ? 0 : 1); })
  .catch(async (e) => { console.error(e); await stopDatabase(); process.exit(1); });
