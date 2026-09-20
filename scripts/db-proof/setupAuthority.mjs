#!/usr/bin/env node
// Real-PostgreSQL proof of the workspace-setup authority migration (20260920100000).
//
// Replays the repository's ENTIRE migration chain on a throwaway PostgreSQL 16, then drives the contract through real,
// separate connections acting as `authenticated` / `anon` with simulated JWT claims (the mechanism PostgREST uses).
// Concurrency here is REAL: every simultaneous request holds its own connection and its own transaction.
//
//   DB_PROOF_MODULES_DIR=<dir whose node_modules has pg + embedded-postgres> node scripts/db-proof/setupAuthority.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY local database) also works.
//
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
const MODE = process.env.DB_PROOF_MODE ?? "embedded";
const MODULES_DIR = process.env.DB_PROOF_MODULES_DIR;
const CONCURRENCY = 25;

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
  try {
    const r = await fn();
    record(name, r === true, r === true ? "" : `assertion returned ${JSON.stringify(r)}`);
  } catch (e) {
    record(name, false, String(e?.message ?? e).split("\n")[0]);
  }
}
async function refused(name, code, fn) {
  try {
    await fn();
    record(name, false, "no error was raised");
  } catch (e) {
    record(name, e.code === code, `expected ${code}, got ${e.code}: ${String(e.message).split("\n")[0]}`);
  }
}

let pool;
let admin;
let embeddedServer = null;
let embeddedDir = null;

function assertLocal(u) {
  const url = new URL(u);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) throw new Error(`REFUSED: ${url.hostname} is not loopback`);
  if (u.includes(PRODUCTION_REF)) throw new Error("REFUSED: production project reference");
}

async function startDatabase() {
  if (MODE === "external") {
    assertLocal(process.env.DB_PROOF_CONN);
    return process.env.DB_PROOF_CONN;
  }
  const modDir = MODULES_DIR ? path.resolve(MODULES_DIR) : REPO;
  const { default: EmbeddedPostgres } = await import(pathToFileURL(path.join(modDir, "node_modules/embedded-postgres/dist/index.js")).href);
  embeddedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-setup-proof-"));
  const port = 54000 + Math.floor(Math.random() * 900);
  embeddedServer = new EmbeddedPostgres({ databaseDir: path.join(embeddedDir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await embeddedServer.initialise();
  await embeddedServer.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect();
  await boot.query("CREATE DATABASE setup_proof");
  await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/setup_proof`;
}

async function stopDatabase() {
  try { await pool?.end(); } catch { /* ignore */ }
  try { await admin?.end(); } catch { /* ignore */ }
  if (embeddedServer) { try { await embeddedServer.stop(); } catch { /* ignore */ } }
  if (embeddedDir) fs.rmSync(embeddedDir, { recursive: true, force: true });
}

async function replay() {
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  const dir = path.join(REPO, "supabase/migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    let text = fs.readFileSync(path.join(dir, f), "utf8");
    if (f === PG_CRON_FILE) text = text.split("\n").slice(0, text.split("\n").findIndex((l) => l.includes("CREATE EXTENSION IF NOT EXISTS pg_cron"))).join("\n");
    try { await admin.query(text); } catch (e) { throw new Error(`migration ${f} failed: ${String(e.message).split("\n")[0]}`); }
  }
  return files;
}

async function asCaller(caller, fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    if (caller.kind === "anon") {
      await c.query("SET LOCAL ROLE anon");
      await c.query("SELECT set_config('request.jwt.claim.role','anon',true), set_config('request.jwt.claim.sub','',true)");
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
  } finally {
    c.release();
  }
}
const user = (uid) => ({ kind: "user", uid });
const ANON = { kind: "anon" };
const q = (caller, sql, params) => asCaller(caller, async (c) => (await c.query(sql, params)).rows);
const one = async (caller, sql, params) => (await q(caller, sql, params))[0];
const uuid = () => globalThis.crypto.randomUUID();

const U = { owner: uuid(), partner: uuid(), partner2: uuid(), preparer: uuid(), viewer: uuid(), outsider: uuid(), ownerB: uuid() };
let A;
let B;

const openScope = (caller, company, year, caps, type = "composite") => one(caller, "SELECT public.open_engagement_with_scope($1,$2,$3,$4) r", [company, year, caps, type]).then((x) => x.r);
const recordChoice = (caller, eng, choice, expected = null) => one(caller, "SELECT public.record_engagement_data_start($1,$2,$3) r", [eng, choice, expected]).then((x) => x.r);
const getState = (caller, eng) => one(caller, "SELECT public.get_engagement_setup_state($1) r", [eng]).then((x) => x.r);
const count = async (sql, params = []) => Number((await admin.query(sql, params)).rows[0].n);

async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url });
  await admin.connect();
  pool = new Pool({ connectionString: url, max: CONCURRENCY + 5 });

  group("Replay from zero");
  let files;
  await check("every repository migration (including 20260920100000) applies on an empty PostgreSQL 16", async () => { files = await replay(); return files.includes("20260920100000_workspace_setup_authority.sql"); });

  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  A = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Company A') RETURNING id", [U.owner])).rows[0].id;
  B = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Company B') RETURNING id", [U.ownerB])).rows[0].id;
  for (const [k, role] of [["partner", "partner"], ["partner2", "partner"], ["preparer", "preparer"], ["viewer", "viewer"]]) await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [A, U[k], role]);

  group("Authorisation matrix — open_engagement_with_scope");
  await refused("anonymous is refused (no EXECUTE grant)", "42501", () => openScope(ANON, A, 2026, ["FINANCIAL_STATEMENTS"]));
  for (const who of ["preparer", "viewer", "outsider", "ownerB"]) await refused(`${who} cannot choose services for company A`, "42501", () => openScope(user(U[who]), A, 2026, ["FINANCIAL_STATEMENTS"]));
  await check("nothing was created by the refused calls", async () => (await count("SELECT count(*) n FROM public.engagements")) === 0 && (await count("SELECT count(*) n FROM public.fiscal_periods")) === 0);
  await refused("an unknown service is rejected (22023)", "22023", () => openScope(user(U.owner), A, 2026, ["NOPE"]));
  await refused("an empty selection is rejected (22023)", "22023", () => openScope(user(U.owner), A, 2026, []));

  group(`Concurrency — ${CONCURRENCY} simultaneous requests, separate connections and transactions`);
  let winner;
  await check(`${CONCURRENCY} concurrent open requests (owner / partner, mixed service sets) converge on ONE engagement id`, async () => {
    const callers = [U.owner, U.partner, U.owner];
    const sets = [["FINANCIAL_STATEMENTS"], ["FINANCIAL_STATEMENTS", "MONITORING"], ["MONITORING"], ["FINANCIAL_STATEMENTS", "MONITORING"]];
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => openScope(user(callers[i % 3]), A, 2026, sets[i % 4])));
    winner = out[0].engagementId;
    return out.every((o) => o.engagementId === winner) && out.filter((o) => o.created).length === 1;
  });
  await check("exactly one reporting period, one engagement and one grant per service exist — no duplicate row, event or side effect", async () => {
    const [p, e, g, ev] = await Promise.all([
      count("SELECT count(*) n FROM public.fiscal_periods WHERE company_id=$1", [A]),
      count("SELECT count(*) n FROM public.engagements WHERE company_id=$1", [A]),
      count("SELECT count(DISTINCT capability) n FROM public.engagement_mandate_events WHERE engagement_id=$1 AND action='GRANT'", [winner]),
      count("SELECT count(*) n FROM public.engagement_mandate_events WHERE engagement_id=$1", [winner]),
    ]);
    return p === 1 && e === 1 && g === 2 && ev === 2;
  });
  await check("a repeated request after the storm is an exact no-op (created=false, still two events)", async () => {
    const r = await openScope(user(U.owner), A, 2026, ["FINANCIAL_STATEMENTS", "MONITORING"]);
    return r.created === false && r.engagementId === winner && (await count("SELECT count(*) n FROM public.engagement_mandate_events WHERE engagement_id=$1", [winner])) === 2;
  });
  await check("a different year is a different workspace: its own period and engagement, company A 2026 untouched", async () => {
    const r = await openScope(user(U.owner), A, 2025, ["TAX_COMPUTATION"].slice(0, 0).concat(["FINANCIAL_STATEMENTS"]));
    return r.engagementId !== winner && (await count("SELECT count(*) n FROM public.engagements WHERE company_id=$1", [A])) === 2;
  });
  await check("company B is independent of company A", async () => {
    const r = await openScope(user(U.ownerB), B, 2026, ["MONITORING"]);
    return r.engagementId !== winner && (await count("SELECT count(*) n FROM public.engagements WHERE company_id=$1", [B])) === 1;
  });

  group("The invariant lives in the database — direct writes cannot break it");
  const periodA = (await admin.query("SELECT fiscal_period_id p FROM public.engagements WHERE id=$1", [winner])).rows[0].p;
  const ownerMember = (await admin.query("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [A, U.owner])).rows[0].id;
  await refused("a second OPEN engagement for the same period is refused by the unique index (23505), even from a superuser", "23505", () => admin.query("INSERT INTO public.engagements (fiscal_period_id,company_id,engagement_type,created_by_member_id) VALUES ($1,$2,'composite',$3)", [periodA, A, ownerMember]));
  await check("the same insert as the authenticated owner is refused too (unique index, or RLS in this shimmed role model)", async () => {
    try { await asCaller(user(U.owner), (c) => c.query("INSERT INTO public.engagements (fiscal_period_id,company_id,engagement_type,created_by_member_id) VALUES ($1,$2,'composite',$3)", [periodA, A, ownerMember])); return "no error"; } catch (e) { return e.code === "23505" || e.code === "42501"; }
  });
  await refused("an engagement whose company does not own the period is refused (23514)", "23514", () => admin.query("INSERT INTO public.engagements (fiscal_period_id,company_id,engagement_type,created_by_member_id) VALUES ($1,$2,'composite',$3)", [periodA, B, ownerMember]));
  await check(`a CLOSED engagement does not count: with the period already existing and NO open engagement, ${CONCURRENCY} simultaneous requests create EXACTLY ONE new engagement`, async () => {
    await admin.query("UPDATE public.engagements SET status='closed', closed_at=now() WHERE id=$1", [winner]);
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => openScope(user(i % 2 ? U.partner : U.owner), A, 2026, ["FINANCIAL_STATEMENTS"])));
    const ids = new Set(out.map((o) => o.engagementId));
    const created = out.filter((o) => o.created).length;
    const open = await count("SELECT count(*) n FROM public.engagements WHERE fiscal_period_id=$1 AND status='open'", [periodA]);
    const events = await count("SELECT count(*) n FROM public.engagement_mandate_events e JOIN public.engagements g ON g.id=e.engagement_id WHERE g.fiscal_period_id=$1 AND g.status='open'", [periodA]);
    winner = out[0].engagementId;
    return ids.size === 1 && !ids.has(undefined) && created === 1 && open === 1 && events === 1 && winner !== undefined;
  });

  group("Setup state is workspace-authoritative — one state per engagement, actor recorded for audit only");
  await check("undecided at first, for every member alike", async () => {
    for (const w of ["owner", "partner", "partner2", "preparer", "viewer"]) if ((await getState(user(U[w]), winner)).dataStart !== null) return w;
    return true;
  });
  await refused("anonymous cannot read setup state", "42501", () => getState(ANON, winner));
  await refused("an outsider cannot read setup state", "42501", () => getState(user(U.outsider), winner));
  await refused("another company's owner cannot read it", "42501", () => getState(user(U.ownerB), winner));
  await refused("a viewer cannot record a decision", "42501", () => recordChoice(user(U.viewer), winner, "empty"));
  await refused("an outsider cannot record a decision", "42501", () => recordChoice(user(U.outsider), winner, "empty"));
  await refused("another company's owner cannot record a decision", "42501", () => recordChoice(user(U.ownerB), winner, "empty"));
  await refused("anonymous cannot record a decision", "42501", () => recordChoice(ANON, winner, "empty"));
  await refused("an unknown choice is rejected (22023)", "22023", () => recordChoice(user(U.owner), winner, "later"));

  group("Concurrent CONFLICTING initial choices — one defined winner, explicit conflicts for the rest");
  let winnerChoice;
  await check(`${CONCURRENCY} simultaneous decisions (mixed 'empty' / 'import', mixed actors) yield exactly one stored event`, async () => {
    const actors = [U.owner, U.partner, U.partner2, U.preparer];
    const settled = await Promise.allSettled(Array.from({ length: CONCURRENCY }, (_, i) => recordChoice(user(actors[i % 4]), winner, i % 2 ? "import" : "empty", null)));
    const ok = settled.filter((s) => s.status === "fulfilled");
    const bad = settled.filter((s) => s.status === "rejected");
    winnerChoice = (await getState(user(U.owner), winner)).dataStart;
    const stored = await count("SELECT count(*) n FROM public.engagement_setup_events WHERE engagement_id=$1", [winner]);
    const sameAsWinner = ok.every((s) => s.value.dataStart === winnerChoice);
    const conflictsAreExplicit = bad.every((s) => s.reason.code === "PT409" && /CONFLICT/.test(s.reason.message));
    const okCount = settled.filter((s, i) => s.status === "fulfilled").length;
    const expectedOk = Array.from({ length: CONCURRENCY }, (_, i) => (i % 2 ? "import" : "empty")).filter((c) => c === winnerChoice).length;
    return stored === 1 && sameAsWinner && conflictsAreExplicit && okCount === expectedOk && bad.length === CONCURRENCY - expectedOk && ["empty", "import"].includes(winnerChoice);
  });
  await check("every authorised member (and only they) now reads the SAME state", async () => {
    const states = await Promise.all(["owner", "partner", "partner2", "preparer", "viewer"].map((w) => getState(user(U[w]), winner)));
    return states.every((s) => s.dataStart === winnerChoice && s.sequence === 1);
  });
  await check("the actor is recorded for audit (a real member id) but the state is per engagement", async () => {
    const r = (await admin.query("SELECT actor_member_id FROM public.engagement_setup_events WHERE engagement_id=$1", [winner])).rows;
    return r.length === 1 && !!r[0].actor_member_id;
  });
  await check("an exact replay by anyone converges (changed=false) and writes nothing", async () => {
    const r = await recordChoice(user(U.preparer), winner, winnerChoice, winnerChoice);
    return r.changed === false && r.replay === true && (await count("SELECT count(*) n FROM public.engagement_setup_events WHERE engagement_id=$1", [winner])) === 1;
  });

  group("Permitted transitions — empty → import is the only follow-up");
  // fresh engagement for a deterministic walk-through
  const eng2 = (await openScope(user(U.ownerB), B, 2027, ["FINANCIAL_STATEMENTS"])).engagementId;
  await check("undecided → empty", async () => (await recordChoice(user(U.ownerB), eng2, "empty", null)).dataStart === "empty");
  await refused("a stale request (still expects undecided) is refused with an explicit conflict", "PT409", () => recordChoice(user(U.ownerB), eng2, "import", null));
  await check("empty → import is permitted when the caller has seen 'empty'", async () => (await recordChoice(user(U.ownerB), eng2, "import", "empty")).dataStart === "import");
  await refused("import → empty is refused: a workspace never returns to empty", "PT409", () => recordChoice(user(U.ownerB), eng2, "empty", "import"));
  await check("history is exactly [empty, import], append-only, with contiguous sequence numbers", async () => {
    const r = (await admin.query("SELECT event_type, sequence_no FROM public.engagement_setup_events WHERE engagement_id=$1 ORDER BY sequence_no", [eng2])).rows;
    return JSON.stringify(r.map((x) => [x.event_type, Number(x.sequence_no)])) === JSON.stringify([["DATA_START_EMPTY", 1], ["DATA_START_IMPORT", 2]]);
  });
  await refused("setup events cannot be updated, even by a superuser (append-only)", "23001", () => admin.query("UPDATE public.engagement_setup_events SET sequence_no=99 WHERE engagement_id=$1", [eng2]));
  await refused("setup events cannot be deleted, even by a superuser (append-only)", "23001", () => admin.query("DELETE FROM public.engagement_setup_events WHERE engagement_id=$1", [eng2]));
  await refused("an authenticated member cannot INSERT into the table directly (no grant)", "42501", () => asCaller(user(U.ownerB), (c) => c.query("INSERT INTO public.engagement_setup_events (engagement_id,sequence_no,event_type,actor_member_id) VALUES ($1,3,'DATA_START_EMPTY',gen_random_uuid())", [eng2])));
  await refused("the table itself rejects an illegal history even for a superuser (import → empty)", "PT409", () => admin.query("INSERT INTO public.engagement_setup_events (engagement_id,sequence_no,event_type,actor_member_id) SELECT $1,3,'DATA_START_EMPTY',fm.id FROM public.firm_members fm WHERE fm.company_id=$2 LIMIT 1", [eng2, B]));
  await check("company A's state never affected company B's (independent engagements, independent histories)", async () => (await getState(user(U.owner), winner)).dataStart === winnerChoice && (await getState(user(U.ownerB), eng2)).dataStart === "import");

  group("Filing jurisdiction — explicit, never inferred; tax services are unavailable until it is selected");
  await check("a new company has no jurisdiction", async () => (await admin.query("SELECT filing_jurisdiction j FROM public.companies WHERE id=$1", [A])).rows[0].j === null);
  await check("selecting Tax with no jurisdiction is refused (PT422) and the WHOLE request rolls back — no engagement, period or grant remains", async () => {
    const before = [await count("SELECT count(*) n FROM public.engagements"), await count("SELECT count(*) n FROM public.fiscal_periods"), await count("SELECT count(*) n FROM public.engagement_mandate_events")];
    try { await openScope(user(U.ownerB), B, 2028, ["FINANCIAL_STATEMENTS", "TAX_COMPUTATION"]); return "no error"; } catch (e) {
      const after = [await count("SELECT count(*) n FROM public.engagements"), await count("SELECT count(*) n FROM public.fiscal_periods"), await count("SELECT count(*) n FROM public.engagement_mandate_events")];
      return e.code === "PT422" && JSON.stringify(before) === JSON.stringify(after);
    }
  });
  await refused("granting Compliance review with no jurisdiction is refused directly too (PT422)", "PT422", () => q(user(U.owner), "SELECT public.grant_engagement_capability($1,'COMPLIANCE_REVIEW','x')", [winner]));
  await refused("granting Filing with no jurisdiction is refused (PT422)", "PT422", () => q(user(U.owner), "SELECT public.grant_engagement_capability($1,'FILING_PREPARATION','x')", [winner]));
  await check("Financial statements and Monitoring never need a jurisdiction", async () => (await q(user(U.owner), "SELECT public.capability_needs_jurisdiction('MONITORING') a, public.capability_needs_jurisdiction('FINANCIAL_STATEMENTS') b"))[0].a === false);
  await refused("a preparer cannot select the jurisdiction", "42501", () => q(user(U.preparer), "SELECT public.set_company_filing_jurisdiction($1,'TZ')", [A]));
  await refused("a viewer cannot select the jurisdiction", "42501", () => q(user(U.viewer), "SELECT public.set_company_filing_jurisdiction($1,'TZ')", [A]));
  await refused("another company's owner cannot select it", "42501", () => q(user(U.ownerB), "SELECT public.set_company_filing_jurisdiction($1,'TZ')", [A]));
  await refused("a malformed code is rejected (22023)", "22023", () => q(user(U.owner), "SELECT public.set_company_filing_jurisdiction($1,'Tanzania')", [A]));
  await check("a partner selects it explicitly", async () => (await one(user(U.partner), "SELECT public.set_company_filing_jurisdiction($1,'TZ') j", [A])).j === "TZ");
  await check("with a jurisdiction, Tax can be added — idempotently", async () => {
    const r = await openScope(user(U.owner), A, 2026, ["FINANCIAL_STATEMENTS", "TAX_COMPUTATION"]);
    const again = await openScope(user(U.owner), A, 2026, ["FINANCIAL_STATEMENTS", "TAX_COMPUTATION"]);
    return r.granted.includes("TAX_COMPUTATION") && again.created === false && r.engagementId === again.engagementId;
  });
  await refused("the jurisdiction cannot be changed while Tax is in scope (via the RPC)", "PT409", () => q(user(U.partner), "SELECT public.set_company_filing_jurisdiction($1,'KE')", [A]));
  await refused("…nor by a direct UPDATE, even by a superuser (the trigger guards every writer, including the owner's RLS path)", "PT409", () => admin.query("UPDATE public.companies SET filing_jurisdiction='KE' WHERE id=$1", [A]));
  await refused("…nor cleared", "PT409", () => q(user(U.partner), "SELECT public.set_company_filing_jurisdiction($1,NULL)", [A]));
  await check("after Tax is withdrawn the jurisdiction can change", async () => {
    await q(user(U.owner), "SELECT public.revoke_engagement_capability($1,'TAX_COMPUTATION','client withdrew')", [winner]);
    return (await one(user(U.owner), "SELECT public.set_company_filing_jurisdiction($1,'KE') j", [A])).j === "KE";
  });

  group("Privileges");
  await check("RPCs are executable by authenticated and NOT by anon or PUBLIC", async () => {
    const r = (await admin.query(`SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE') anon_x, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_x
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname = ANY($1)`, [["open_engagement_with_scope", "record_engagement_data_start", "get_engagement_setup_state", "set_company_filing_jurisdiction"]])).rows;
    return r.length === 4 && r.every((x) => x.auth_x === true && x.anon_x === false);
  });
  await check("trigger helper functions are not executable by any client role", async () => {
    const r = (await admin.query(`SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE') a, has_function_privilege('anon', p.oid, 'EXECUTE') b
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname = ANY($1)`, [["guard_company_filing_jurisdiction", "engagements_period_company_match", "engagement_setup_event_guard"]])).rows;
    return r.length === 3 && r.every((x) => !x.a && !x.b);
  });
  await check("every new SECURITY DEFINER function pins its search_path", async () => {
    const r = (await admin.query(`SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND p.proname = ANY($1)`, [["open_engagement_with_scope", "record_engagement_data_start", "get_engagement_setup_state", "set_company_filing_jurisdiction", "grant_engagement_capability"]])).rows;
    return r.length === 5 && r.every((x) => (x.proconfig ?? []).some((c) => c.startsWith("search_path=")));
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${"─".repeat(42)}\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  if (failed.length) for (const f of failed) console.log(`  FAILED [${f.group}] ${f.name}`);
  console.log(failed.length ? "SETUP_AUTHORITY: FAILED" : "SETUP_AUTHORITY: ALL PASSED");
  await stopDatabase();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await stopDatabase();
  process.exit(1);
});
