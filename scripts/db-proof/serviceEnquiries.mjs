#!/usr/bin/env node
// Real-PostgreSQL proof of the service-enquiry intake authority (migration 20260921100000).
//
// Replays the repository's ENTIRE migration chain on a throwaway PostgreSQL, under the same default-privilege model a
// Supabase project has (new public tables/functions are granted to anon / authenticated / service_role), then drives the
// contract through real, separate connections acting as `anon` / `authenticated` / `service_role` with simulated JWT
// claims (the mechanism PostgREST uses). Concurrency is REAL: every simultaneous request holds its own connection and
// its own transaction. Test identities are synthetic `.test` addresses only.
//
//   DB_PROOF_MODULES_DIR=<dir whose node_modules has pg + embedded-postgres> node scripts/db-proof/serviceEnquiries.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY local database) also works.
//
// It reads no Supabase credential and refuses every non-loopback host and the production project reference.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { migrationExists, sortsImmediatelyAfter } from "./migrationOrderingChecks.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const PRODUCTION_REF = "bvyivmmfjejbmqoydezk";
const MIGRATION_FILE = "20260921100000_service_enquiry_intake.sql";
const READINESS_FILE = "20260922100000_service_enquiry_activation_readiness.sql";
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
  embeddedDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-enquiry-proof-"));
  const port = 54000 + Math.floor(Math.random() * 900);
  embeddedServer = new EmbeddedPostgres({ databaseDir: path.join(embeddedDir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => {}, onError: () => {} });
  await embeddedServer.initialise();
  await embeddedServer.start();
  const boot = new Client({ host: "localhost", port, user: "postgres", password: "postgres", database: "postgres" });
  await boot.connect();
  await boot.query("CREATE DATABASE enquiry_proof");
  await boot.end();
  return `postgres://postgres:postgres@localhost:${port}/enquiry_proof`;
}

async function stopDatabase() {
  try { await pool?.end(); } catch { /* ignore */ }
  try { await admin?.end(); } catch { /* ignore */ }
  if (embeddedServer) { try { await embeddedServer.stop(); } catch { /* ignore */ } }
  if (embeddedDir) fs.rmSync(embeddedDir, { recursive: true, force: true });
}

async function replay() {
  await admin.query(fs.readFileSync(path.join(REPO, "scripts/db-contract-tests/00_bootstrap_roles_and_shims.sql"), "utf8"));
  // A Supabase project grants every new public table / function / sequence to anon, authenticated and service_role by default.
  // Reproduce that BEFORE the chain runs, so the proof shows the migration's own REVOKEs hold under the real model.
  await admin.query(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
  `);
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
    } else if (caller.kind === "service") {
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
  } finally {
    c.release();
  }
}
const user = (uid) => ({ kind: "user", uid });
const ANON = { kind: "anon" };
const SERVICE = { kind: "service" };
const q = (caller, sql, params) => asCaller(caller, async (c) => (await c.query(sql, params)).rows);
const one = async (caller, sql, params) => (await q(caller, sql, params))[0];
const uuid = () => globalThis.crypto.randomUUID();
const count = async (sql, params = []) => Number((await admin.query(sql, params)).rows[0].n);
const sha = async (s) => Buffer.from(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("hex");

// Every canonical table: the proof asserts that no client role — and not even service_role — can write any of them.
const TABLES = ["platform_staff_members", "platform_staff_audit", "service_enquiries", "service_enquiry_events", "service_enquiry_status_transitions", "service_enquiry_notifications", "service_enquiry_rate_limits"];
const HARMLESS_UPDATE = {
  platform_staff_members: "updated_at = now()",
  platform_staff_audit: "created_at = now()",
  service_enquiries: "status = 'closed'",
  service_enquiry_events: "created_at = now()",
  service_enquiry_status_transitions: "to_status = to_status",
  service_enquiry_notifications: "updated_at = now()",
  service_enquiry_rate_limits: "hits = 0",
};
const STATUSES = ["submitted", "triage", "awaiting_client", "scoping", "proposal_sent", "accepted", "declined", "spam", "withdrawn", "closed"];
// The transition matrix exactly as specified — written out independently of the database's own table.
const EXPECTED_MATRIX = {
  submitted: ["triage", "spam", "withdrawn"],
  triage: ["awaiting_client", "scoping", "declined", "spam"],
  awaiting_client: ["triage", "scoping", "withdrawn"],
  scoping: ["awaiting_client", "proposal_sent", "declined"],
  proposal_sent: ["accepted", "declined", "withdrawn"],
  accepted: ["closed"],
  declined: ["closed"],
  spam: [],
  withdrawn: [],
  closed: [],
};
// The shortest legal route from `submitted` to each status (used to place an enquiry in any state).
const ROUTE = {
  submitted: [],
  triage: ["triage"],
  awaiting_client: ["triage", "awaiting_client"],
  scoping: ["triage", "scoping"],
  proposal_sent: ["triage", "scoping", "proposal_sent"],
  accepted: ["triage", "scoping", "proposal_sent", "accepted"],
  declined: ["triage", "declined"],
  spam: ["spam"],
  withdrawn: ["withdrawn"],
  closed: ["triage", "declined", "closed"],
};

const U = { owner: uuid(), admin: uuid(), ownerB: uuid(), requester: uuid(), agent: uuid(), agent2: uuid(), manager: uuid(), outsider: uuid(), notStaff: uuid() };
let counter = 0;

/** A valid, minimal submission request. Overrides replace top-level fields; `payload` replaces wholesale. */
function request(over = {}) {
  counter += 1;
  const base = {
    idempotency_key: uuid(),
    request_fingerprint: "a".repeat(64),
    requester_user_id: null,
    requester_name: "Test Requester",
    requester_email: `requester${counter}@example.test`,
    organization: "Example Test Org",
    country_code: null,
    service_code: "general",
    source_context: "contact_page",
    subject: "Question about reporting",
    message: "Synthetic enquiry message for the disposable proof database.",
    payload_schema_version: 1,
    payload: {},
    rate: [],
  };
  return { ...base, ...over };
}
const submit = (req, caller = SERVICE) => one(caller, "SELECT public.submit_service_enquiry($1::jsonb) r", [JSON.stringify(req)]).then((x) => x.r);
const stat = (caller, id, to, note = null, expected = null) => one(caller, "SELECT public.staff_transition_service_enquiry($1,$2,$3,$4) r", [id, to, note, expected]).then((x) => x.r);
const idOf = async (reference) => (await admin.query("SELECT id FROM public.service_enquiries WHERE public_reference=$1", [reference])).rows[0].id;
const statusOf = async (id) => (await admin.query("SELECT status FROM public.service_enquiries WHERE id=$1", [id])).rows[0].status;

async function newEnquiry(over = {}) {
  const r = await submit(request(over));
  if (r.outcome !== "created") throw new Error(`fixture submission was ${r.outcome}`);
  return { reference: r.reference, id: await idOf(r.reference), result: r };
}
async function enquiryInState(actor, status) {
  const e = await newEnquiry();
  for (const step of ROUTE[status]) await stat(actor, e.id, step);
  return e;
}

async function main() {
  const url = await startDatabase();
  admin = new Client({ connectionString: url });
  await admin.connect();
  pool = new Pool({ connectionString: url, max: CONCURRENCY + 10 });

  group("Replay from zero");
  let files;
  // Later, unrelated migrations (e.g. 20260922180000_discard_trial_balance_authority.sql, trial-
  // balance discard authority) may exist after READINESS_FILE; they do not touch service_enquiry_*
  // objects and this check does not need to know about them — it only asserts both named files exist
  // and that READINESS_FILE sorts immediately after MIGRATION_FILE, never a position from the end of
  // the directory. See migrationOrderingChecks.mjs and its append-regression test.
  await check(`every repository migration (including ${MIGRATION_FILE}) applies on an empty PostgreSQL`, async () => {
    files = await replay();
    return migrationExists(files, MIGRATION_FILE) && migrationExists(files, READINESS_FILE) && sortsImmediatelyAfter(files, MIGRATION_FILE, READINESS_FILE);
  });

  for (const [k, id] of Object.entries(U)) await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [id, `${k}@example.test`]);
  const companyA = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Company A') RETURNING id", [U.owner])).rows[0].id;
  const companyB = (await admin.query("INSERT INTO public.companies (user_id,name) VALUES ($1,'Company B') RETURNING id", [U.ownerB])).rows[0].id;
  await admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'partner',now())", [companyA, U.admin]);

  await check("the migration has no file, attachment or upload column anywhere (no attachment surface exists)", async () => {
    const r = await admin.query(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND table_name = ANY($1) AND (column_name ~* '(file|attach|upload|blob|binary|document)' OR data_type = 'bytea')`, [TABLES]);
    return r.rows.length === 0;
  });
  await check("no platform staff exist after the migration (nobody is seeded)", async () => (await count("SELECT count(*) n FROM public.platform_staff_members")) === 0);

  group("No direct table access — under Supabase's default-privilege model");
  for (const t of TABLES) {
    await refused(`anon cannot SELECT ${t}`, "42501", () => q(ANON, `SELECT * FROM public.${t}`));
    await refused(`authenticated cannot SELECT ${t}`, "42501", () => q(user(U.owner), `SELECT * FROM public.${t}`));
    await refused(`authenticated cannot INSERT into ${t}`, "42501", () => q(user(U.owner), `INSERT INTO public.${t} DEFAULT VALUES`));
    await refused(`anon cannot DELETE from ${t}`, "42501", () => q(ANON, `DELETE FROM public.${t}`));
    await refused(`service_role cannot INSERT into ${t} directly`, "42501", () => q(SERVICE, `INSERT INTO public.${t} DEFAULT VALUES`));
    await refused(`service_role cannot UPDATE ${t} directly`, "42501", () => q(SERVICE, `UPDATE public.${t} SET ${HARMLESS_UPDATE[t]}`));
    await refused(`service_role cannot DELETE from ${t} directly`, "42501", () => q(SERVICE, `DELETE FROM public.${t}`));
  }
  await check("service_role keeps read access for operations (SELECT only)", async () => { await q(SERVICE, "SELECT count(*) FROM public.service_enquiries"); return true; });
  await refused("anon cannot execute submit_service_enquiry", "42501", () => submit(request(), ANON));
  await refused("authenticated cannot execute submit_service_enquiry (the browser never submits directly)", "42501", () => submit(request(), user(U.owner)));

  group("Submission — one atomic, validated, idempotent write path");
  let first;
  await check("a valid submission returns only a receipt (reference, time, status) plus the outbox ids for the Edge Function", async () => {
    const before = [await count("SELECT count(*) n FROM public.service_enquiries"), await count("SELECT count(*) n FROM public.service_enquiry_events"), await count("SELECT count(*) n FROM public.service_enquiry_notifications")];
    first = await submit(request({ requester_user_id: U.requester }));
    const after = [await count("SELECT count(*) n FROM public.service_enquiries"), await count("SELECT count(*) n FROM public.service_enquiry_events"), await count("SELECT count(*) n FROM public.service_enquiry_notifications")];
    return first.outcome === "created" && first.status === "submitted" && first.acknowledgement === "pending" && /^CFQ-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(first.reference) && !!first.submitted_at
      && after[0] === before[0] + 1 && after[1] === before[1] + 1 && after[2] === before[2] + 2;
  });
  await check("the initial 'submitted' event names the verified requester; the outbox holds two queued rows", async () => {
    const id = await idOf(first.reference);
    const ev = (await admin.query("SELECT * FROM public.service_enquiry_events WHERE enquiry_id=$1", [id])).rows;
    const nt = (await admin.query("SELECT kind,status FROM public.service_enquiry_notifications WHERE enquiry_id=$1 ORDER BY kind", [id])).rows;
    return ev.length === 1 && ev[0].event_kind === "submitted" && ev[0].actor_kind === "requester" && ev[0].actor_user_id === U.requester && ev[0].previous_status === null
      && nt.length === 2 && nt.every((n) => n.status === "queued");
  });
  await check("an anonymous submission records a 'system' actor and no user id", async () => {
    const e = await newEnquiry();
    const ev = (await admin.query("SELECT actor_kind, actor_user_id FROM public.service_enquiry_events WHERE enquiry_id=$1", [e.id])).rows[0];
    const row = (await admin.query("SELECT requester_user_id FROM public.service_enquiries WHERE id=$1", [e.id])).rows[0];
    return ev.actor_kind === "system" && ev.actor_user_id === null && row.requester_user_id === null;
  });
  await check("a failure part-way through (outbox insert) rolls back the enquiry AND its event — nothing partial survives", async () => {
    await admin.query("CREATE OR REPLACE FUNCTION public.__proof_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'proof: forced failure' USING ERRCODE='P0001'; END $$");
    await admin.query("CREATE TRIGGER __proof_fail BEFORE INSERT ON public.service_enquiry_notifications FOR EACH ROW EXECUTE FUNCTION public.__proof_fail()");
    const before = [await count("SELECT count(*) n FROM public.service_enquiries"), await count("SELECT count(*) n FROM public.service_enquiry_events")];
    let raised = false;
    try { await submit(request()); } catch { raised = true; }
    await admin.query("DROP TRIGGER __proof_fail ON public.service_enquiry_notifications; DROP FUNCTION public.__proof_fail()");
    return raised && (await count("SELECT count(*) n FROM public.service_enquiries")) === before[0] && (await count("SELECT count(*) n FROM public.service_enquiry_events")) === before[1];
  });

  group("Public reference — non-guessable, unique, never a database id or a counter");
  await check("300 enquiries: every reference is unique, well-formed, is not the row id, and the sequence is not monotonic", async () => {
    const refs = [];
    for (let i = 0; i < 300; i++) refs.push((await submit(request())).reference);
    const unique = new Set(refs).size === refs.length;
    const ids = (await admin.query("SELECT id::text, public_reference FROM public.service_enquiries")).rows;
    const notId = ids.every((r) => !r.id.replace(/-/g, "").toUpperCase().includes(r.public_reference.slice(4).replace(/-/g, "")));
    const sorted = [...refs].sort();
    const monotonic = refs.every((r, i) => r === sorted[i]);
    return unique && notId && !monotonic && refs.every((r) => /^CFQ-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(r));
  });
  await check("the reference space is 48 random bits: a duplicate reference is refused by the unique constraint (23505)", async () => {
    const ref = (await admin.query("SELECT public_reference FROM public.service_enquiries LIMIT 1")).rows[0].public_reference;
    try {
      await admin.query(`INSERT INTO public.service_enquiries (public_reference, requester_name, requester_email, service_code, source_context, subject, message, idempotency_key, request_fingerprint)
        VALUES ($1,'A','dup@example.test','general','contact_page','Subject here','Long enough message body', $2, $3)`, [ref, uuid(), "b".repeat(64)]);
      return false;
    } catch (e) { return e.code === "23505"; }
  });

  // ── validation ────────────────────────────────────────────────────────────────────────────────────────────────────
  group("Database validation — constraints re-check everything the Edge Function already validated");
  const bad = (name, over, code = "23514") => refused(name, code, () => submit(request(over)));
  await bad("a name over 120 characters is refused", { requester_name: "x".repeat(121) });
  await bad("an empty name is refused", { requester_name: "" });
  await bad("an un-normalised (upper-case) email is refused", { requester_email: "Upper@example.test" });
  await bad("an email with no dot in the domain is refused", { requester_email: "a@b" });
  await bad("an unknown country code (XX) is refused", { country_code: "XX" });
  await bad("a lower-case country code is refused", { country_code: "tz" });
  await bad("an unknown service code is refused", { service_code: "tax_other" });
  await bad("an unknown source context is refused", { source_context: "popup" });
  await bad("a subject under 3 characters is refused", { subject: "ab" });
  await bad("a message under 10 characters is refused", { message: "too short" });
  await bad("a message over 4000 characters is refused", { message: "m".repeat(4001) });
  await bad("a control character in the subject is refused", { subject: "Bad\u0007bell" });
  await bad("a general enquiry cannot carry structured payload keys", { payload: { report_type: "other" } });
  await bad("a donor payload with an unknown key is refused", { service_code: "donor_reporting", source_context: "workflow_donor", payload: { report_type: "other", secret: "x" } });
  await bad("a donor payload with an unknown report type is refused", { service_code: "donor_reporting", source_context: "workflow_donor", payload: { report_type: "audit" } });
  await bad("a donor payload with an impossible deadline is refused", { service_code: "donor_reporting", source_context: "workflow_donor", payload: { deadline: "2026-13-40" } });
  await bad("a donor payload with a lower-case currency is refused", { service_code: "donor_reporting", source_context: "workflow_donor", payload: { currency: "usd" } });
  await bad("a payload value that is not a string is refused", { service_code: "donor_reporting", source_context: "workflow_donor", payload: { project_name: 5 } });
  await bad("an unsupported payload schema version is refused", { payload_schema_version: 2 });
  await bad("the preview tax code with any other country is refused", { service_code: "tax_tanzania_preview", source_context: "workflow_tax", country_code: "KE", payload: { jurisdiction_source: "user_selected" } });
  await bad("the preview tax code with no country is refused", { service_code: "tax_tanzania_preview", source_context: "workflow_tax", payload: { jurisdiction_source: "user_selected" } });
  await bad("the general tax code for the preview jurisdiction is refused (routing cannot be mismatched)", { service_code: "tax_general", source_context: "workflow_tax", country_code: "TZ", payload: { jurisdiction_source: "user_selected" } });
  await bad("the general tax code with no country is refused", { service_code: "tax_general", source_context: "workflow_tax", payload: { jurisdiction_source: "user_selected" } });
  await bad("a malformed fingerprint is refused", { request_fingerprint: "xyz" }, "22023");
  await check("valid donor, preview-tax, general-tax and country-optional general enquiries are all accepted", async () => {
    const donor = await submit(request({ service_code: "donor_reporting", source_context: "workflow_donor", payload: { report_type: "fund_accountability", donor_name: "Example Fund", project_name: "Programme A", reporting_period: "FY2026 Q1", reporting_frequency: "quarterly", currency: "USD", deadline: "2026-12-31", additional_context: "Line one\nLine two" } }));
    const tz = await submit(request({ service_code: "tax_tanzania_preview", source_context: "workflow_tax", country_code: "TZ", payload: { jurisdiction_source: "user_selected", tax_period: "FY2025" } }));
    const ke = await submit(request({ service_code: "tax_general", source_context: "workflow_tax", country_code: "KE", payload: { jurisdiction_source: "company_setting_confirmed" } }));
    const generalTz = await submit(request({ country_code: "TZ" }));
    return [donor, tz, ke, generalTz].every((r) => r.outcome === "created");
  });

  const corpus = JSON.parse(fs.readFileSync(path.join(REPO, "supabase/functions/_shared/serviceEnquiryEmailCorpus.json"), "utf8"));
  await check(`the SQL email rule accepts all ${corpus.valid.length} valid and rejects all ${corpus.invalid.length} invalid corpus addresses`, async () => {
    for (const e of corpus.valid) if ((await admin.query("SELECT public.enquiry_email_is_valid($1) v", [e])).rows[0].v !== true) return `valid rejected: ${e}`;
    for (const e of corpus.invalid) if ((await admin.query("SELECT public.enquiry_email_is_valid($1) v", [e])).rows[0].v !== false) return `invalid accepted: ${e}`;
    return true;
  });

  // ── idempotency ──────────────────────────────────────────────────────────────────────────────────────────────────
  group("Idempotency — a key is bound to the request's fingerprint");
  const key = uuid();
  const fp = await sha("content-1");
  let r1;
  await check("the first use of a key creates the enquiry; a replay returns the ORIGINAL receipt and creates nothing", async () => {
    r1 = await submit(request({ idempotency_key: key, request_fingerprint: fp }));
    const rows0 = await count("SELECT count(*) n FROM public.service_enquiries WHERE idempotency_key=$1", [key]);
    const r2 = await submit(request({ idempotency_key: key, request_fingerprint: fp }));
    const rows1 = await count("SELECT count(*) n FROM public.service_enquiries WHERE idempotency_key=$1", [key]);
    return r1.outcome === "created" && r2.outcome === "replayed" && r2.reference === r1.reference && r2.submitted_at === r1.submitted_at && rows0 === 1 && rows1 === 1;
  });
  await check("re-using the key with DIFFERENT content is an idempotency conflict: nothing is created, the original is untouched", async () => {
    const before = await count("SELECT count(*) n FROM public.service_enquiries");
    const r = await submit(request({ idempotency_key: key, request_fingerprint: await sha("content-2"), subject: "A different subject entirely" }));
    const original = (await admin.query("SELECT subject FROM public.service_enquiries WHERE idempotency_key=$1", [key])).rows[0].subject;
    return r.outcome === "idempotency_conflict" && !r.reference && (await count("SELECT count(*) n FROM public.service_enquiries")) === before && original === "Question about reporting";
  });
  await check(`${CONCURRENCY} simultaneous submissions with ONE key create exactly one enquiry, one event, two outbox rows`, async () => {
    const k = uuid(); const f = await sha(k);
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, () => submit(request({ idempotency_key: k, request_fingerprint: f }))));
    const id = (await admin.query("SELECT id FROM public.service_enquiries WHERE idempotency_key=$1", [k])).rows;
    const ev = await count("SELECT count(*) n FROM public.service_enquiry_events WHERE enquiry_id=$1", [id[0].id]);
    const nt = await count("SELECT count(*) n FROM public.service_enquiry_notifications WHERE enquiry_id=$1", [id[0].id]);
    return out.filter((o) => o.outcome === "created").length === 1 && out.filter((o) => o.outcome === "replayed").length === CONCURRENCY - 1
      && new Set(out.map((o) => o.reference)).size === 1 && id.length === 1 && ev === 1 && nt === 2;
  });
  await check(`${CONCURRENCY} simultaneous submissions with distinct keys all succeed with distinct references`, async () => {
    const out = await Promise.all(Array.from({ length: CONCURRENCY }, () => submit(request())));
    return out.every((o) => o.outcome === "created") && new Set(out.map((o) => o.reference)).size === CONCURRENCY;
  });

  // ── rate limiting ────────────────────────────────────────────────────────────────────────────────────────────────
  group("Rate limiting — keyed hashes only, counters persist, replays are free");
  const WINDOW = 3600;
  const secsLeft = () => WINDOW - (Math.floor(Date.now() / 1000) % WINDOW);
  if (secsLeft() < 45) await new Promise((r) => setTimeout(r, (secsLeft() + 1) * 1000)); // never straddle a window boundary mid-test
  const hash = (c) => c.repeat(32);
  const limited = (h, limit = 3) => ({ rate: [{ bucket: `ip:${hash(h)}`, limit, window_seconds: WINDOW }] });
  await check("the first three requests in a window succeed; the fourth and fifth are refused with a retry-after; no rows are created for them", async () => {
    const before = await count("SELECT count(*) n FROM public.service_enquiries");
    const ok = [await submit(request(limited("c"))), await submit(request(limited("c"))), await submit(request(limited("c")))];
    const no1 = await submit(request(limited("c")));
    const no2 = await submit(request(limited("c")));
    const after = await count("SELECT count(*) n FROM public.service_enquiries");
    return ok.every((o) => o.outcome === "created") && no1.outcome === "rate_limited" && no2.outcome === "rate_limited" && no1.retry_after_seconds >= 1 && no1.retry_after_seconds <= WINDOW && after === before + 3;
  });
  await check("the counter of a refused request is COMMITTED (a refusal still counts), so a flood cannot reset itself", async () => {
    const hits = (await admin.query("SELECT hits FROM public.service_enquiry_rate_limits WHERE bucket=$1 ORDER BY window_start DESC LIMIT 1", [`ip:${hash("c")}/${WINDOW}`])).rows[0].hits;
    return hits === 5;
  });
  await check("a different client hash is independent of a limited one", async () => (await submit(request(limited("d")))).outcome === "created");
  await check("an idempotent replay of an already-accepted request is not rate limited and consumes nothing", async () => {
    const k = uuid(); const f = await sha(k);
    const a = await submit(request({ idempotency_key: k, request_fingerprint: f, ...limited("e", 1) }));
    const blocked = await submit(request(limited("e", 1)));
    const replay = await submit(request({ idempotency_key: k, request_fingerprint: f, ...limited("e", 1) }));
    const hits = (await admin.query("SELECT hits FROM public.service_enquiry_rate_limits WHERE bucket=$1 ORDER BY window_start DESC LIMIT 1", [`ip:${hash("e")}/${WINDOW}`])).rows[0].hits;
    return a.outcome === "created" && blocked.outcome === "rate_limited" && replay.outcome === "replayed" && hits === 2;
  });
  await check("email-hash and global buckets are enforced the same way", async () => {
    const em = { rate: [{ bucket: `email:${hash("f")}`, limit: 1, window_seconds: WINDOW }] };
    const gl = { rate: [{ bucket: "global:all", limit: 100000, window_seconds: WINDOW }] };
    return (await submit(request(em))).outcome === "created" && (await submit(request(em))).outcome === "rate_limited" && (await submit(request(gl))).outcome === "created";
  });
  await refused("a raw IP address can never be used as a bucket key (refused by constraint)", "23514", () => submit(request({ rate: [{ bucket: "ip:203.0.113.9", limit: 5, window_seconds: WINDOW }] })));
  await check("no stored row anywhere contains a raw IP-looking value", async () => (await count("SELECT count(*) n FROM public.service_enquiry_rate_limits WHERE bucket ~ '[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+'")) === 0);
  await refused("an out-of-range window is refused (22023)", "22023", () => submit(request({ rate: [{ bucket: `ip:${hash("a")}`, limit: 5, window_seconds: 5 }] })));
  await refused("a non-positive limit is refused (22023)", "22023", () => submit(request({ rate: [{ bucket: `ip:${hash("a")}`, limit: 0, window_seconds: WINDOW }] })));

  // ── platform staff ───────────────────────────────────────────────────────────────────────────────────────────────
  group("Platform staff authority — a separate authority; company roles never grant it");
  const grant = (caller, uid, role, reason = "Verified by the proof harness operator", label = "proof-operator") => one(caller, "SELECT public.platform_staff_grant($1,$2,$3,$4) r", [uid, role, reason, label]).then((x) => x.r);
  await refused("an authenticated company owner cannot enrol staff (42501)", "42501", () => grant(user(U.owner), U.owner, "manager"));
  await refused("a company administrator cannot enrol staff (42501)", "42501", () => grant(user(U.admin), U.admin, "manager"));
  await refused("anon cannot enrol staff (42501)", "42501", () => grant(ANON, U.agent, "manager"));
  await refused("enrolling a non-existent account is refused (P0002)", "P0002", () => grant(SERVICE, uuid(), "manager"));
  await refused("an unknown staff role is refused (22023)", "22023", () => grant(SERVICE, U.agent, "superuser"));
  await refused("enrolment without a real reason is refused (audit constraint)", "23514", () => grant(SERVICE, U.agent, "manager", "short"));
  await check("the service role can enrol a triage agent, a second agent and a manager; each enrolment is audited", async () => {
    await grant(SERVICE, U.agent, "triage_agent"); await grant(SERVICE, U.agent2, "triage_agent"); await grant(SERVICE, U.manager, "manager");
    return (await count("SELECT count(*) n FROM public.platform_staff_members WHERE is_active")) === 3 && (await count("SELECT count(*) n FROM public.platform_staff_audit WHERE action='GRANT'")) === 3;
  });
  await check("current_platform_staff_role reports each caller's OWN role; company owners and administrators report none", async () => {
    const roles = {};
    for (const k of ["agent", "manager", "owner", "admin", "ownerB", "requester", "outsider", "notStaff"]) roles[k] = (await one(user(U[k]), "SELECT public.current_platform_staff_role() r")).r;
    return roles.agent === "triage_agent" && roles.manager === "manager" && ["owner", "admin", "ownerB", "requester", "outsider", "notStaff"].every((k) => roles[k] === null);
  });
  const STAFF_CALLS = {
    list: (c) => q(c, "SELECT public.staff_list_service_enquiries() r"),
    get: (c, id) => q(c, "SELECT public.staff_get_service_enquiry($1) r", [id]),
    transition: (c, id) => q(c, "SELECT public.staff_transition_service_enquiry($1,'triage') r", [id]),
    assign: (c, id) => q(c, "SELECT public.staff_assign_service_enquiry($1,$2) r", [id, U.agent]),
    note: (c, id) => q(c, "SELECT public.staff_add_service_enquiry_note($1,'note text here') r", [id]),
    directory: (c) => q(c, "SELECT public.staff_list_platform_staff() r"),
  };
  const target = await newEnquiry({ organization: "Isolation Test Org" });
  for (const [who, caller] of [["a company owner", user(U.owner)], ["a company administrator (partner)", user(U.admin)], ["an owner of ANOTHER company (cross-tenant)", user(U.ownerB)], ["the requester themself", user(U.requester)], ["an authenticated non-staff account", user(U.notStaff)]]) {
    for (const [fnName, fn] of Object.entries(STAFF_CALLS)) await refused(`${who} cannot use staff ${fnName} (42501)`, "42501", () => fn(caller, target.id));
  }
  for (const [fnName, fn] of Object.entries(STAFF_CALLS)) await refused(`anon cannot use staff ${fnName} (42501, no EXECUTE)`, "42501", () => fn(ANON, target.id));
  await check("the row was not changed by any refused staff call", async () => (await statusOf(target.id)) === "submitted" && (await count("SELECT count(*) n FROM public.service_enquiry_events WHERE enquiry_id=$1", [target.id])) === 1);
  await check("revoking staff is audited and takes effect immediately; re-enrolment restores access", async () => {
    await one(SERVICE, "SELECT public.platform_staff_revoke($1,'Left the triage rota, verified by operator','proof-operator') r", [U.agent2]);
    let denied = false;
    try { await STAFF_CALLS.list(user(U.agent2)); } catch (e) { denied = e.code === "42501"; }
    await grant(SERVICE, U.agent2, "triage_agent");
    const back = (await STAFF_CALLS.list(user(U.agent2)))[0].r;
    return denied && back.total >= 1 && (await count("SELECT count(*) n FROM public.platform_staff_audit WHERE action='REVOKE'")) === 1;
  });
  await refused("revoking someone who is not active staff is refused (P0002)", "P0002", () => one(SERVICE, "SELECT public.platform_staff_revoke($1,'Not staff so this must fail','proof-operator') r", [U.notStaff]));
  for (const [what, sql] of [["UPDATE", "UPDATE public.platform_staff_audit SET reason='tampered reason text'"], ["DELETE", "DELETE FROM public.platform_staff_audit"], ["TRUNCATE", "TRUNCATE public.platform_staff_audit"]]) {
    await refused(`the staff audit trail refuses ${what}, even from a superuser`, "P0001", () => admin.query(sql));
  }

  const agent = user(U.agent), agent2 = user(U.agent2), manager = user(U.manager);

  // ── queue reads ──────────────────────────────────────────────────────────────────────────────────────────────────
  group("Staff queue — filters, search and detail (RPC only)");
  const listAs = (caller, args = {}) => one(caller, "SELECT public.staff_list_service_enquiries($1,$2,$3,$4,$5,$6,$7,$8) r", [args.status ?? null, args.service ?? null, args.country ?? null, args.from ?? null, args.to ?? null, args.search ?? null, args.limit ?? 25, args.offset ?? 0]).then((x) => x.r);
  const seed = await newEnquiry({ organization: "Zebra 100%_Search Holdings", requester_email: "needle.person@example.test", service_code: "tax_general", source_context: "workflow_tax", country_code: "KE", payload: { jurisdiction_source: "user_selected" } });
  await check("the list row carries triage fields but NOT the message body or the structured payload", async () => {
    const r = await listAs(agent, { search: seed.reference });
    const row = r.rows[0];
    return r.total === 1 && row.public_reference === seed.reference && !("message" in row) && !("payload" in row) && row.acknowledgement === "queued" && row.staff_notification === "queued";
  });
  await check("search matches the public reference (case-insensitive), an organisation substring and an email substring", async () => {
    const byRef = await listAs(agent, { search: seed.reference.toLowerCase() });
    const byOrg = await listAs(agent, { search: "zebra 100%_search" });
    const byEmail = await listAs(agent, { search: "NEEDLE.person" });
    return byRef.total === 1 && byOrg.total === 1 && byEmail.total === 1;
  });
  await check("search is a literal substring match: '%' and '_' are ordinary characters, never wildcards", async () => {
    const pct = await listAs(agent, { search: "100%_" });
    const usc = await listAs(agent, { search: "___________" });
    return pct.total === 1 && usc.total === 0;
  });
  await check("filters combine: service + country + status + date window", async () => {
    const hit = await listAs(agent, { service: ["tax_general"], country: "KE", status: ["submitted"], from: new Date(Date.now() - 3600e3).toISOString(), to: new Date(Date.now() + 3600e3).toISOString() });
    const miss = await listAs(agent, { service: ["donor_reporting"], country: "KE" });
    const past = await listAs(agent, { to: new Date(Date.now() - 86400e3).toISOString() });
    return hit.total >= 1 && hit.rows.every((r) => r.service_code === "tax_general" && r.country_code === "KE") && miss.total === 0 && past.total === 0;
  });
  await check("pagination is stable and clamped: limit is capped at 100 and offset pages do not overlap", async () => {
    const big = await listAs(agent, { limit: 100000 });
    const p1 = await listAs(agent, { limit: 5, offset: 0 });
    const p2 = await listAs(agent, { limit: 5, offset: 5 });
    const ids = [...p1.rows, ...p2.rows].map((r) => r.id);
    return big.limit === 100 && big.rows.length === 100 && new Set(ids).size === 10 && p1.total === big.total;
  });
  await refused("an unknown status filter is refused (22023)", "22023", () => listAs(agent, { status: ["nope"] }));
  await refused("an unknown service filter is refused (22023)", "22023", () => listAs(agent, { service: ["general", "nope"] }));
  await refused("an unknown country filter is refused (22023)", "22023", () => listAs(agent, { country: "XX" }));
  await check("detail returns the full request, structured payload, event timeline, notification state and the allowed next statuses", async () => {
    const d = (await one(agent, "SELECT public.staff_get_service_enquiry($1) r", [seed.id])).r;
    return d.enquiry.message.startsWith("Synthetic enquiry") && d.enquiry.payload.jurisdiction_source === "user_selected" && d.events.length === 1 && d.events[0].event_kind === "submitted"
      && JSON.stringify(d.allowed_transitions) === JSON.stringify(["spam", "triage", "withdrawn"]) && d.notifications.length === 2;
  });
  await refused("detail of a non-existent enquiry is P0002", "P0002", () => one(agent, "SELECT public.staff_get_service_enquiry($1) r", [uuid()]));

  // ── status matrix ────────────────────────────────────────────────────────────────────────────────────────────────
  group("Status transition matrix — all 100 (from, to) pairs against the specification");
  for (const from of STATUSES) {
    await check(`from '${from}': exactly ${EXPECTED_MATRIX[from].length ? EXPECTED_MATRIX[from].join(" / ") : "no destination (terminal)"} are permitted; every other pair is refused and changes nothing`, async () => {
      const problems = [];
      for (const to of STATUSES) {
        const e = await enquiryInState(agent, from);
        const eventsBefore = await count("SELECT count(*) n FROM public.service_enquiry_events WHERE enquiry_id=$1", [e.id]);
        const allowed = EXPECTED_MATRIX[from].includes(to);
        try {
          const r = await stat(agent, e.id, to, allowed ? "matrix proof note" : null);
          if (!allowed) { problems.push(`${from}->${to} was ACCEPTED`); continue; }
          const ev = (await admin.query("SELECT * FROM public.service_enquiry_events WHERE enquiry_id=$1 ORDER BY seq DESC LIMIT 1", [e.id])).rows[0];
          if (r.previous_status !== from || r.status !== to || (await statusOf(e.id)) !== to) problems.push(`${from}->${to} result wrong`);
          if (ev.event_kind !== "status_change" || ev.previous_status !== from || ev.new_status !== to || ev.actor_kind !== "staff" || ev.actor_user_id !== U.agent || ev.note !== "matrix proof note") problems.push(`${from}->${to} event wrong`);
          if ((await count("SELECT count(*) n FROM public.service_enquiry_events WHERE enquiry_id=$1", [e.id])) !== eventsBefore + 1) problems.push(`${from}->${to} event count`);
        } catch (err) {
          if (allowed) problems.push(`${from}->${to} was REFUSED: ${err.code} ${String(err.message).split("\n")[0]}`);
          else if (err.code !== "23514") problems.push(`${from}->${to} refused with ${err.code}, expected 23514`);
          else if ((await statusOf(e.id)) !== from || (await count("SELECT count(*) n FROM public.service_enquiry_events WHERE enquiry_id=$1", [e.id])) !== eventsBefore) problems.push(`${from}->${to} refusal changed state`);
        }
      }
      return problems.length === 0 ? true : problems.join("; ");
    });
  }
  await check("the database's own transition table equals the specification (18 permitted pairs, three terminal statuses)", async () => {
    const rows = (await admin.query("SELECT from_status, to_status FROM public.service_enquiry_status_transitions")).rows;
    const expected = Object.entries(EXPECTED_MATRIX).flatMap(([f, ts]) => ts.map((t) => `${f}>${t}`)).sort();
    return JSON.stringify(rows.map((r) => `${r.from_status}>${r.to_status}`).sort()) === JSON.stringify(expected) && rows.length === 18;
  });
  await refused("an unknown target status is refused (22023)", "22023", async () => stat(agent, (await newEnquiry()).id, "reopened"));
  await check("a manager may transition too; both staff roles use the same server-side matrix", async () => { const e = await newEnquiry(); return (await stat(manager, e.id, "triage")).status === "triage"; });
  await check("a stale screen is refused: expected_status that no longer matches raises 40001 and changes nothing", async () => {
    const e = await enquiryInState(agent, "triage");
    try { await stat(agent, e.id, "scoping", null, "submitted"); return false; } catch (err) { return err.code === "40001" && (await statusOf(e.id)) === "triage"; }
  });
  await check("a matching expected_status is accepted", async () => { const e = await enquiryInState(agent, "triage"); return (await stat(agent, e.id, "scoping", null, "triage")).status === "scoping"; });

  // ── concurrency ──────────────────────────────────────────────────────────────────────────────────────────────────
  group(`Concurrent transitions — ${CONCURRENCY} simultaneous staff requests on one enquiry`);
  await check("competing destinations from 'triage' serialise: every ACCEPTED move was legal from the status it actually replaced, every other request is refused (23514), and the timeline is one linear chain ending at the row's status", async () => {
    const e = await enquiryInState(agent, "triage");
    const targets = ["scoping", "declined", "awaiting_client", "spam"];
    const callers = [agent, agent2, manager];
    const settled = await Promise.allSettled(Array.from({ length: CONCURRENCY }, (_, i) => stat(callers[i % 3], e.id, targets[i % 4])));
    const wins = settled.filter((s) => s.status === "fulfilled");
    const losers = settled.filter((s) => s.status === "rejected");
    const events = (await admin.query("SELECT previous_status, new_status FROM public.service_enquiry_events WHERE enquiry_id=$1 AND event_kind='status_change' ORDER BY seq", [e.id])).rows;
    // events[0] is the setup move (submitted -> triage); the rest are exactly the accepted concurrent moves.
    let cursor = "triage";
    for (const ev of events.slice(1)) {
      if (ev.previous_status !== cursor || !EXPECTED_MATRIX[cursor].includes(ev.new_status)) return `illegal or broken step ${ev.previous_status} -> ${ev.new_status} (expected to start at ${cursor})`;
      cursor = ev.new_status;
    }
    return wins.length >= 1 && events.length === wins.length + 1 && losers.every((l) => l.reason.code === "23514") && (await statusOf(e.id)) === cursor;
  });
  await check("identical requests (triage -> scoping, x25): exactly one succeeds, 24 are refused as invalid transitions", async () => {
    const e = await enquiryInState(agent, "triage");
    const settled = await Promise.allSettled(Array.from({ length: CONCURRENCY }, () => stat(agent, e.id, "scoping")));
    return settled.filter((s) => s.status === "fulfilled").length === 1 && settled.filter((s) => s.status === "rejected" && s.reason.code === "23514").length === CONCURRENCY - 1
      && (await statusOf(e.id)) === "scoping" && (await count("SELECT count(*) n FROM public.service_enquiry_events WHERE enquiry_id=$1 AND event_kind='status_change'", [e.id])) === 2;
  });
  await check("the event history is never inconsistent with the row: each status_change event chains from the previous one", async () => {
    const rows = (await admin.query("SELECT enquiry_id, previous_status, new_status FROM public.service_enquiry_events WHERE event_kind='status_change' ORDER BY enquiry_id, seq")).rows;
    const last = new Map();
    for (const r of rows) { const prev = last.get(r.enquiry_id) ?? "submitted"; if (r.previous_status !== prev) return `broken chain on ${r.enquiry_id}`; last.set(r.enquiry_id, r.new_status); }
    for (const [id, s] of last) if ((await statusOf(id)) !== s) return `row status differs from last event on ${id}`;
    return true;
  });

  // ── direct writes ────────────────────────────────────────────────────────────────────────────────────────────────
  group("Direct writes are refused at the database layer — even from a superuser");
  const victim = await newEnquiry();
  await refused("UPDATE of status outside a transition function is refused", "P0001", () => admin.query("UPDATE public.service_enquiries SET status='closed' WHERE id=$1", [victim.id]));
  await refused("UPDATE of the assignee outside the assignment function is refused", "P0001", () => admin.query("UPDATE public.service_enquiries SET assigned_to_user_id=$2 WHERE id=$1", [victim.id, U.agent]));
  for (const col of ["message", "subject", "requester_email", "requester_name", "organization", "country_code", "service_code", "source_context", "public_reference", "idempotency_key", "request_fingerprint"]) {
    const val = { message: "'tampered message body'", subject: "'Tampered subject'", requester_email: "'x@example.test'", requester_name: "'X'", organization: "'X'", country_code: "'KE'", service_code: "'support'", source_context: "'site_footer'", public_reference: "'CFQ-0000-0000-0000'", idempotency_key: `'${uuid()}'`, request_fingerprint: `'${"9".repeat(64)}'` }[col];
    await refused(`the submitted ${col} is immutable`, "P0001", () => admin.query(`UPDATE public.service_enquiries SET ${col}=${val} WHERE id=$1`, [victim.id]));
  }
  await refused("the payload is immutable", "P0001", () => admin.query("UPDATE public.service_enquiries SET payload='{}'::jsonb, payload_schema_version=1, submitted_at = now() - interval '1 day' WHERE id=$1", [victim.id]));
  await refused("DELETE of an enquiry is refused", "P0001", () => admin.query("DELETE FROM public.service_enquiries WHERE id=$1", [victim.id]));
  for (const [tbl, upd] of [["service_enquiry_events", "note='x'"], ["service_enquiry_status_transitions", "to_status='closed'"]]) {
    await refused(`${tbl}: UPDATE is refused`, "P0001", () => admin.query(`UPDATE public.${tbl} SET ${upd}`));
    await refused(`${tbl}: DELETE is refused`, "P0001", () => admin.query(`DELETE FROM public.${tbl}`));
    await refused(`${tbl}: TRUNCATE is refused`, "P0001", () => admin.query(`TRUNCATE public.${tbl} CASCADE`));
  }
  await check("the victim enquiry is exactly as submitted after every refused write", async () => (await statusOf(victim.id)) === "submitted" && (await count("SELECT count(*) n FROM public.service_enquiry_events WHERE enquiry_id=$1", [victim.id])) === 1);

  // ── assignment and notes ─────────────────────────────────────────────────────────────────────────────────────────
  group("Assignment and internal notes — staff only, append-only, in the timeline");
  const work = await enquiryInState(agent, "triage");
  const assign = (caller, id, who, note = null) => one(caller, "SELECT public.staff_assign_service_enquiry($1,$2,$3) r", [id, who, note]).then((x) => x.r);
  await check("staff can assign to any ACTIVE staff member: recorded as an 'assignment' event that leaves the status unchanged", async () => {
    const r = await assign(agent, work.id, U.agent2, "Please take this one");
    const ev = (await admin.query("SELECT * FROM public.service_enquiry_events WHERE enquiry_id=$1 ORDER BY seq DESC LIMIT 1", [work.id])).rows[0];
    return r.changed === true && ev.event_kind === "assignment" && ev.assigned_to_user_id === U.agent2 && ev.previous_status === "triage" && ev.new_status === "triage" && ev.actor_user_id === U.agent && (await statusOf(work.id)) === "triage";
  });
  await check("assigning to the same person again is a no-op and writes no event", async () => {
    const before = await count("SELECT count(*) n FROM public.service_enquiry_events WHERE enquiry_id=$1", [work.id]);
    const r = await assign(manager, work.id, U.agent2);
    return r.changed === false && (await count("SELECT count(*) n FROM public.service_enquiry_events WHERE enquiry_id=$1", [work.id])) === before;
  });
  await refused("assigning to a non-staff account is refused (22023)", "22023", () => assign(agent, work.id, U.notStaff));
  await refused("assigning to a company owner is refused (22023)", "22023", () => assign(agent, work.id, U.owner));
  await check("assigning to REVOKED staff is refused; unassigning (null) is allowed and recorded", async () => {
    await one(SERVICE, "SELECT public.platform_staff_revoke($1,'Temporary revocation for the proof','proof-operator') r", [U.manager]);
    let refusedRevoked = false;
    try { await assign(agent, work.id, U.manager); } catch (e) { refusedRevoked = e.code === "22023"; }
    await grant(SERVICE, U.manager, "manager");
    const r = await assign(agent, work.id, null);
    return refusedRevoked && r.changed === true && (await admin.query("SELECT assigned_to_user_id FROM public.service_enquiries WHERE id=$1", [work.id])).rows[0].assigned_to_user_id === null;
  });
  await check("removing an assignee's account clears the assignment without error (FK SET NULL is not blocked by the guard)", async () => {
    const tmp = uuid();
    await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,'temp.staff@example.test')", [tmp]);
    await grant(SERVICE, tmp, "triage_agent");
    await assign(agent, work.id, tmp);
    await admin.query("DELETE FROM auth.users WHERE id=$1", [tmp]);
    return (await admin.query("SELECT assigned_to_user_id FROM public.service_enquiries WHERE id=$1", [work.id])).rows[0].assigned_to_user_id === null;
  });
  const addNote = (caller, id, note) => one(caller, "SELECT public.staff_add_service_enquiry_note($1,$2) r", [id, note]).then((x) => x.r);
  await check("an internal note is an append-only event visible in the staff timeline and NOT in the list rows", async () => {
    await addNote(agent, work.id, "Internal: client is a known donor-funded NGO.");
    const d = (await one(agent, "SELECT public.staff_get_service_enquiry($1) r", [work.id])).r;
    const note = d.events.find((e) => e.event_kind === "note");
    const list = JSON.stringify(await listAs(agent, { search: work.reference }));
    return !!note && note.note.includes("known donor-funded") && note.previous_status === note.new_status && note.actor_email === "agent@example.test" && !list.includes("known donor-funded");
  });
  await refused("an empty note is refused (22023)", "22023", () => addNote(agent, work.id, "   "));
  await refused("a note over 2000 characters is refused (22023)", "22023", () => addNote(agent, work.id, "n".repeat(2001)));
  await refused("a note with a control character is refused (22023)", "22023", () => addNote(agent, work.id, "bad\u0007note"));
  await refused("the requester cannot read internal notes or staff events (42501)", "42501", () => one(user(U.requester), "SELECT public.staff_get_service_enquiry($1) r", [work.id]));
  await refused("the requester cannot read them straight from the table either (42501)", "42501", () => q(user(U.requester), "SELECT note FROM public.service_enquiry_events"));

  // ── notification outbox ──────────────────────────────────────────────────────────────────────────────────────────
  group("Notification outbox — a failed or unconfigured email never loses or rolls back an enquiry");
  // Test plumbing only: mark every existing row accepted so later claims see just the rows a check creates. The transition guard
  // (which forbids queued -> accepted) is switched off for this one statement and back on immediately.
  const clearOutbox = async () => {
    await admin.query("ALTER TABLE public.service_enquiry_notifications DISABLE TRIGGER trg_service_enquiry_notification_transition");
    await admin.query("UPDATE public.service_enquiry_notifications SET status='accepted', sent_at=now() WHERE status IN ('queued','processing')");
    await admin.query("ALTER TABLE public.service_enquiry_notifications ENABLE TRIGGER trg_service_enquiry_notification_transition");
  };
  await clearOutbox();
  const claim = (limit = 10, id = null) => one(SERVICE, "SELECT public.enquiry_notification_claim($1,$2) r", [limit, id]).then((x) => x.r);
  const complete = (id, outcome, provider = null, code = null) => one(SERVICE, "SELECT public.enquiry_notification_complete($1,$2,$3,$4) r", [id, outcome, provider, code]).then((x) => x.r);
  await refused("authenticated callers cannot claim notifications (42501)", "42501", () => one(user(U.owner), "SELECT public.enquiry_notification_claim(5, NULL) r"));
  await refused("authenticated callers cannot complete notifications (42501)", "42501", () => one(user(U.owner), "SELECT public.enquiry_notification_complete($1,'accepted',NULL,NULL) r", [uuid()]));
  const mail = await newEnquiry({ requester_name: "Grace Example", requester_email: "grace@example.test", subject: "Confidential subject XYZZY", message: "Confidential message body XYZZY that must never appear in a notification payload." });
  let claimed;
  await check("claiming returns what a message needs — the requester's address only for the acknowledgement — and NEVER the subject or message text", async () => {
    claimed = await claim(10, mail.id);
    const ack = claimed.find((c) => c.kind === "requester_acknowledgement"), staff = claimed.find((c) => c.kind === "staff_notification");
    return claimed.length === 2 && ack.requester_email === "grace@example.test" && ack.requester_name === "Grace Example" && ack.attempt === 1 && staff.requester_email === null && staff.requester_name === null
      && ack.reference === mail.reference && !JSON.stringify(claimed).includes("XYZZY");
  });
  await check("an immediate second claim returns nothing (attempts are backed off for five minutes)", async () => (await claim(10, mail.id)).length === 0);
  const ackRow = () => claimed.find((c) => c.kind === "requester_acknowledgement");
  const staffRow = () => claimed.find((c) => c.kind === "staff_notification");
  await check("'blocked' (delivery not configured) returns the row to queued, records a machine code, and does not charge an attempt", async () => {
    const r = await complete(staffRow().id, "blocked");
    const row = (await admin.query("SELECT status, attempt_count, last_error_code FROM public.service_enquiry_notifications WHERE id=$1", [staffRow().id])).rows[0];
    return r.status === "queued" && row.status === "queued" && row.attempt_count === 0 && row.last_error_code === "EMAIL_NOT_CONFIGURED";
  });
  await check("the enquiry itself is intact and still 'submitted' while its notifications are undelivered", async () => (await statusOf(mail.id)) === "submitted" && (await count("SELECT count(*) n FROM public.service_enquiry_events WHERE enquiry_id=$1", [mail.id])) === 1);
  await check("a transient failure ('retry') returns the row to queued; after five attempts it becomes 'failed' and the receipt state is 'unavailable'", async () => {
    await complete(ackRow().id, "retry", null, "PROVIDER_TIMEOUT");
    const stillQueued = (await admin.query("SELECT status FROM public.service_enquiry_notifications WHERE id=$1", [ackRow().id])).rows[0].status === "queued";
    await admin.query("UPDATE public.service_enquiry_notifications SET status='processing', attempt_count=5 WHERE id=$1", [ackRow().id]); // the fifth attempt is in flight
    const r = await complete(ackRow().id, "retry", null, "PROVIDER_TIMEOUT");
    const ack = (await admin.query("SELECT public.service_enquiry_ack_state($1) s", [mail.id])).rows[0].s;
    return stillQueued && r.status === "failed" && ack === "unavailable" && (await statusOf(mail.id)) === "submitted";
  });
  await check("a terminal notification never moves again", async () => (await complete(ackRow().id, "accepted", "late-provider-id")).changed === false);
  await admin.query("UPDATE public.service_enquiry_notifications SET status='processing' WHERE id=$1", [staffRow().id]); // in flight again, so the completion below reaches the constraint
  await refused("a provider error message (free text that could echo an address) cannot be stored — only a machine code", "23514", () => complete(staffRow().id, "failed", null, "boom for grace@example.test"));
  await check("'accepted' records the provider's acceptance time and id; the requester's receipt then reports 'sent' (acceptance, never delivery); terminal rows do not change", async () => {
    const m2 = await newEnquiry();
    const c2 = await claim(10, m2.id);
    const ack2 = c2.find((c) => c.kind === "requester_acknowledgement");
    const r = await complete(ack2.id, "accepted", "provider-msg-1");
    const row = (await admin.query("SELECT status, sent_at, provider_message_id FROM public.service_enquiry_notifications WHERE id=$1", [ack2.id])).rows[0];
    const replay = await submit(request({ idempotency_key: (await admin.query("SELECT idempotency_key FROM public.service_enquiries WHERE id=$1", [m2.id])).rows[0].idempotency_key, request_fingerprint: (await admin.query("SELECT request_fingerprint FROM public.service_enquiries WHERE id=$1", [m2.id])).rows[0].request_fingerprint }));
    return r.status === "accepted" && row.sent_at !== null && row.provider_message_id === "provider-msg-1" && replay.outcome === "replayed" && replay.acknowledgement === "sent";
  });
  await check("two concurrent dispatchers never claim the same row (FOR UPDATE SKIP LOCKED)", async () => {
    await clearOutbox();
    for (let i = 0; i < 8; i++) await newEnquiry();
    const [a, b] = await Promise.all([claim(50), claim(50)]);
    const ids = [...a, ...b].map((c) => c.id);
    return new Set(ids).size === ids.length && ids.length === 16;
  });

  await clearOutbox();

  // ── the honest status model (activation readiness) ─────────────────────────────────────────────────────────────────
  group("Email status model — accepted is not delivered; transitions are enforced by the database");
  const setStatus = (id, status, extra = "") => admin.query(`UPDATE public.service_enquiry_notifications SET status=$2${extra} WHERE id=$1`, [id, status]);
  const statusRow = async (id) => (await admin.query("SELECT status, attempt_count, last_error_code, sent_at, provider_message_id FROM public.service_enquiry_notifications WHERE id=$1", [id])).rows[0];
  const nrows = async (enquiryId) => (await admin.query("SELECT id, kind, status FROM public.service_enquiry_notifications WHERE enquiry_id=$1 ORDER BY kind", [enquiryId])).rows;
  const sm = await newEnquiry();
  const [smAck, smStaff] = await nrows(sm.id);

  await check("the outbox accepts exactly queued, processing, accepted, delivered, failed and bounced — the legacy 'pending' and 'sent' are gone", async () => {
    const legal = (await admin.query("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='chk_service_enquiry_notification_status'")).rows[0].d;
    return ["queued", "processing", "accepted", "delivered", "failed", "bounced"].every((w) => legal.includes(`'${w}'`)) && !legal.includes("'pending'") && !legal.includes("'sent'");
  });
  await check("a new enquiry creates exactly ONE requester acknowledgement and ONE internal notification, with different ids, both queued", async () => {
    const rows = await nrows(sm.id);
    return rows.length === 2 && rows[0].kind === "requester_acknowledgement" && rows[1].kind === "staff_notification" && rows[0].id !== rows[1].id && rows.every((r) => r.status === "queued");
  });
  await refused("a second acknowledgement row for the same enquiry cannot exist (unique per enquiry and kind, 23505)", "23505", () => admin.query("INSERT INTO public.service_enquiry_notifications (enquiry_id, kind) VALUES ($1,'requester_acknowledgement')", [sm.id]));
  await refused("the legacy status 'sent' is rejected by the table (23514)", "23514", () => setStatus(smAck.id, "sent"));
  await refused("the legacy status 'pending' is rejected by the table (23514)", "23514", () => setStatus(smAck.id, "pending"));
  await refused("queued cannot jump straight to accepted (23514) — it must be claimed first", "23514", () => setStatus(smAck.id, "accepted", ", sent_at=now()"));
  await refused("queued cannot jump to delivered (23514)", "23514", () => setStatus(smAck.id, "delivered", ", sent_at=now()"));
  await refused("queued cannot jump to failed (23514) — only an in-flight row can fail", "23514", () => setStatus(smAck.id, "failed"));
  await check("the requester-facing state of a queued acknowledgement is 'pending', never 'sent'", async () => (await admin.query("SELECT public.service_enquiry_ack_state($1) s", [sm.id])).rows[0].s === "pending");

  const smClaim = await claim(10, sm.id);
  await check("claiming moves both rows to processing and returns them; each is charged one attempt", async () => {
    const rows = await nrows(sm.id);
    return smClaim.length === 2 && rows.every((r) => r.status === "processing") && (await statusRow(smAck.id)).attempt_count === 1 && (await admin.query("SELECT public.service_enquiry_ack_state($1) s", [sm.id])).rows[0].s === "pending";
  });
  await refused("an in-flight row cannot jump to delivered without a verified provider event (23514)", "23514", () => setStatus(smAck.id, "delivered", ", sent_at=now()"));
  await check("one recipient's permanent failure does not touch the other notification", async () => {
    const f = await complete(smAck.id, "failed", null, "NON_DELIVERABLE_TEST_ADDRESS");
    const a = await statusRow(smAck.id), s2 = await statusRow(smStaff.id);
    return f.status === "failed" && a.last_error_code === "NON_DELIVERABLE_TEST_ADDRESS" && a.sent_at === null && s2.status === "processing" && s2.last_error_code === null;
  });
  await check("a failed acknowledgement reads as 'unavailable' to the requester", async () => (await admin.query("SELECT public.service_enquiry_ack_state($1) s", [sm.id])).rows[0].s === "unavailable");
  await check("the internal notice is then ACCEPTED independently: it records the provider id and acceptance time, and is not 'delivered'", async () => {
    const r = await complete(smStaff.id, "accepted", "provider-internal-1");
    const s2 = await statusRow(smStaff.id);
    return r.status === "accepted" && s2.status === "accepted" && s2.sent_at !== null && s2.provider_message_id === "provider-internal-1" && s2.status !== "delivered";
  });
  await check("a duplicate completion of the same notification changes nothing (no double acceptance, no overwrite)", async () => {
    const again = await complete(smStaff.id, "accepted", "provider-internal-2");
    const failedAgain = await complete(smStaff.id, "failed", null, "LATE");
    const s2 = await statusRow(smStaff.id);
    return again.changed === false && failedAgain.changed === false && s2.provider_message_id === "provider-internal-1" && s2.last_error_code === null;
  });
  await check("nothing already claimed can be claimed again: a second dispatcher receives no rows for the same enquiry", async () => (await claim(10, sm.id)).length === 0);
  await check("ten concurrent completions of one in-flight row apply exactly once", async () => {
    const e = await newEnquiry();
    const [ack] = await nrows(e.id);
    await claim(10, e.id);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => complete(ack.id, "accepted", `provider-${i}`)));
    return results.filter((r) => r.changed === true).length === 1 && (await statusRow(ack.id)).status === "accepted";
  });
  await check("a processing lease that expired is claimed again (a crashed dispatcher cannot strand a row)", async () => {
    const e = await newEnquiry();
    const [ack] = await nrows(e.id);
    await claim(10, e.id);
    const held = (await claim(10, e.id)).length === 0;
    await admin.query("UPDATE public.service_enquiry_notifications SET last_attempt_at = now() - interval '11 minutes' WHERE id=$1", [ack.id]);
    const again = await claim(10, e.id);
    return held && again.length === 1 && again[0].id === ack.id && again[0].attempt === 2 && (await statusRow(ack.id)).status === "processing";
  });
  await check("an expired lease on a row with no attempts left becomes 'failed' (LEASE_EXPIRED) rather than staying in limbo", async () => {
    const e = await newEnquiry();
    const [ack] = await nrows(e.id);
    await claim(10, e.id);
    await admin.query("UPDATE public.service_enquiry_notifications SET attempt_count=5, last_attempt_at = now() - interval '11 minutes' WHERE id=$1", [ack.id]);
    await claim(10, e.id);
    const a = await statusRow(ack.id);
    return a.status === "failed" && a.last_error_code === "LEASE_EXPIRED";
  });
  await check("delivery is a VERIFIED-provider-event fact only: with the event marker set the guard permits accepted -> delivered / bounced, and nothing else does", async () => {
    const e = await newEnquiry();
    const [ack, staff] = await nrows(e.id);
    await claim(10, e.id);
    await complete(ack.id, "accepted", "p-a");
    await complete(staff.id, "accepted", "p-s");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.enquiry_provider_event','verified',true)");
      await c.query("UPDATE public.service_enquiry_notifications SET status='delivered' WHERE id=$1", [ack.id]);
      await c.query("UPDATE public.service_enquiry_notifications SET status='bounced' WHERE id=$1", [staff.id]);
      await c.query("COMMIT");
    } catch { await c.query("ROLLBACK"); return false; } finally { c.release(); }
    const rows = await nrows(e.id);
    return rows[0].status === "delivered" && rows[1].status === "bounced"
      && (await admin.query("SELECT public.service_enquiry_ack_state($1) s", [e.id])).rows[0].s === "sent";
  });
  await refused("a terminal notification cannot move again, even with the event marker (23514)", "23514", async () => {
    const e = await newEnquiry();
    const [ack] = await nrows(e.id);
    await claim(10, e.id);
    await complete(ack.id, "failed", null, "X");
    const c = await pool.connect();
    try { await c.query("BEGIN"); await c.query("SELECT set_config('app.enquiry_provider_event','verified',true)"); await c.query("UPDATE public.service_enquiry_notifications SET status='delivered', sent_at=now() WHERE id=$1", [ack.id]); await c.query("COMMIT"); } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
  });
  await check("no outbox function can set delivered or bounced: their bodies never name those states", async () => {
    const bodies = (await admin.query("SELECT proname, prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND proname IN ('enquiry_notification_claim','enquiry_notification_complete','submit_service_enquiry')")).rows;
    return bodies.length === 3 && bodies.every((b) => !/'delivered'|'bounced'/.test(b.prosrc));
  });
  await refused("the outbox outcome 'delivered' is not accepted by the completion function (22023)", "22023", () => complete(uuid(), "delivered"));
  await refused("the outbox outcome 'sent' (the retired word) is not accepted by the completion function (22023)", "22023", () => complete(uuid(), "sent"));

  // ── public-reference search ────────────────────────────────────────────────────────────────────────────────────────
  group("Staff queue — public-reference search");
  const agentS = user(U.agent);
  const sRef = await newEnquiry({ organization: "Reference Search Holdings", requester_email: "reference.search@example.test" });
  const other = await newEnquiry({ organization: "Another Holdings", requester_email: "another.person@example.test" });
  const list = (caller, search, extra = {}) => one(caller, "SELECT public.staff_list_service_enquiries($1,$2,$3,$4,$5,$6,$7,$8) r", [extra.status ?? null, null, null, null, null, search, extra.limit ?? 25, 0]).then((x) => x.r);
  const refs = (r) => r.rows.map((x) => x.public_reference);
  const ref = sRef.reference; // CFQ-XXXX-XXXX-XXXX
  const [, g1, g2, g3] = ref.split("-");

  await check("the COMPLETE reference finds exactly that enquiry", async () => { const r = await list(agentS, ref); return r.total === 1 && refs(r)[0] === ref; });
  await check("lower-case and mixed-case references find it", async () => (await list(agentS, ref.toLowerCase())).total === 1 && (await list(agentS, ref[0] + ref.slice(1).toLowerCase())).total === 1);
  await check("surrounding, internal and repeated whitespace is normalised away", async () => {
    const spaced = `   ${ref.replace(/-/g, "  -  ")}   `;
    const tabbed = `\t${ref}\n`;
    return (await list(agentS, spaced)).total === 1 && (await list(agentS, tabbed)).total === 1 && (await list(agentS, `CFQ ${g1} ${g2} ${g3}`)).total === 1;
  });
  await check("a PARTIAL reference (prefix, with or without dashes) finds it — including when typed without the CFQ- prefix", async () => {
    const partials = [`CFQ-${g1}`, `CFQ-${g1}-${g2}`, `cfq-${g1.toLowerCase()}-${g2.toLowerCase().slice(0, 2)}`, `CFQ${g1}${g2}${g3}`, `${g1}-${g2}-${g3}`, `${g1} ${g2}`, `${g1}${g2}`];
    for (const p of partials) { const r = await list(agentS, p); if (!refs(r).includes(ref)) return false; }
    return true;
  });
  await check("a partial reference returns every enquiry that shares it, and only those", async () => {
    const r = await list(agentS, `CFQ-${g1}`);
    return r.rows.every((x) => x.public_reference.startsWith(`CFQ-${g1}`)) && refs(r).includes(ref);
  });
  await check("a reference that does not exist returns nothing (a well-formed miss is not an error)", async () => {
    const missing = "CFQ-0000-0000-000F";
    const r = await list(agentS, missing);
    const s = await list(agentS, "ZZZZ-9999");
    return r.total === 0 && r.rows.length === 0 && s.total === 0;
  });
  await check("the reference search does not disturb the existing organisation and email substring search", async () => {
    const org = await list(agentS, "reference search hold");
    const email = await list(agentS, "REFERENCE.SEARCH@");
    const orgSpaced = await list(agentS, "  Reference   Search  ");
    return org.total === 1 && refs(org)[0] === ref && email.total === 1 && refs(email)[0] === ref && orgSpaced.total === 1;
  });
  await check("wildcards are inert: %, _, [], *, regex and SQL metacharacters in a reference-shaped term match nothing and inject nothing", async () => {
    const hostile = [`CFQ-%`, `CFQ-____-____-____`, `CFQ-${g1}%`, `CFQ-${g1}-%`, `%${g1}`, `CFQ-[0-9A-F]+`, `CFQ-.*`, `CFQ-${g1}'; DROP TABLE public.service_enquiries; --`, `CFQ-${g1}" OR 1=1`, `%%%`, `__`, "\\"];
    for (const h of hostile) {
      const r = await list(agentS, h);
      if (r.total !== 0) return false; // none of these is a real reference, organisation or email fragment
    }
    return (await count("SELECT count(*) n FROM public.service_enquiries")) > 0;
  });
  await check("a term longer than the cap is bounded (100 characters) rather than scanned as given", async () => {
    const r = await list(agentS, `${ref} ${"x".repeat(5000)}`);
    return r.total === 0;
  });
  await check("search combines with the other filters (status) and pagination without leaking rows outside them", async () => {
    const wrongStatus = await list(agentS, ref, { status: ["closed"] });
    const rightStatus = await list(agentS, ref, { status: ["submitted"] });
    return wrongStatus.total === 0 && rightStatus.total === 1;
  });
  await check("the queue rows carry the RAW outbox statuses (queued / processing / accepted …), never a blended 'sent'", async () => {
    const r = await list(agentS, ref);
    return r.rows[0].acknowledgement === "queued" && r.rows[0].staff_notification === "queued" && !("message" in r.rows[0]);
  });
  await check("the detail view reports notification statuses and acceptance time under 'accepted_at'", async () => {
    const d = (await one(agentS, "SELECT public.staff_get_service_enquiry($1) r", [sm.id])).r;
    const n = d.notifications;
    return n.length === 2 && n.every((x) => "accepted_at" in x && !("sent_at" in x)) && n.some((x) => x.status === "failed") && n.some((x) => x.status === "accepted" && x.accepted_at !== null);
  });
  for (const [who, caller] of [["a company owner", user(U.owner)], ["a company administrator", user(U.admin)], ["an owner of another company", user(U.ownerB)], ["the requester", user(U.requester)], ["an authenticated non-staff account", user(U.notStaff)]]) {
    await refused(`${who} cannot search by public reference (42501) — and learns nothing about whether it exists`, "42501", () => list(caller, ref));
    await refused(`${who} cannot search by a partial or missing reference either (42501)`, "42501", () => list(caller, "CFQ-0000"));
  }
  await refused("anon cannot search by public reference (42501)", "42501", () => list(ANON, ref));
  await check("an INACTIVE (revoked) staff member cannot search: the same refusal as a stranger, before any row is read", async () => {
    const gone = uuid();
    await admin.query("INSERT INTO auth.users (id,email) VALUES ($1,'revoked.staff@example.test')", [gone]);
    await one(SERVICE, "SELECT public.platform_staff_grant($1,'triage_agent','Search authorization proof enrolment','proof-operator') r", [gone]).catch(async () => one(SERVICE, "SELECT public.platform_staff_grant($1,'triage_agent','Search authorization proof enrolment','proof-operator','proof-operator') r", [gone]));
    const before = await list(user(gone), ref); // active: allowed
    await one(SERVICE, "SELECT public.platform_staff_revoke($1,'Search authorization proof revocation','proof-operator') r", [gone]);
    let code = null;
    try { await list(user(gone), ref); } catch (e) { code = e.code; }
    return before.total === 1 && code === "42501";
  });
  await check("the compact-reference lookup is index-backed: with sequential scans disabled the planner uses idx_service_enquiries_reference_compact", async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL enable_seqscan = off");
      const plan = (await c.query("EXPLAIN SELECT id FROM public.service_enquiries r WHERE replace(r.public_reference, '-', '') COLLATE \"C\" >= 'CFQ1234' AND replace(r.public_reference, '-', '') COLLATE \"C\" < 'CFQ1234' || chr(127) LIMIT 200")).rows.map((x) => x["QUERY PLAN"]).join("\n");
      await c.query("ROLLBACK");
      return /idx_service_enquiries_reference_compact/.test(plan);
    } finally { c.release(); }
  });
  await check("the search function builds no dynamic SQL and no LIKE on user input", async () => {
    const src = (await admin.query("SELECT prosrc FROM pg_proc WHERE proname='staff_list_service_enquiries'")).rows[0].prosrc;
    return !/EXECUTE\s/i.test(src) && !/\bLIKE\b|\bILIKE\b|~~/i.test(src.replace(/--.*$/gm, ""));
  });
  await check("the staff check is the function's FIRST statement, ahead of any table access", async () => {
    const src = (await admin.query("SELECT prosrc FROM pg_proc WHERE proname='staff_list_service_enquiries'")).rows[0].prosrc;
    return src.indexOf("current_platform_staff_role()") > -1 && src.indexOf("current_platform_staff_role()") < src.indexOf("FROM public.service_enquiries");
  });

  await finish();
}

async function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) for (const f of failed) console.log(`  FAILED [${f.group}] ${f.name}`);
  await stopDatabase();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (e) => {
  console.error("HARNESS ERROR:", e);
  await stopDatabase();
  process.exit(2);
});
