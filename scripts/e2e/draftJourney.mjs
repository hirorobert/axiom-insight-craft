#!/usr/bin/env bun
// Trial balance drafts, end to end on the LOCAL Supabase stack (`supabase start` in CI: real Auth, PostgREST, RLS,
// Storage and the trial-balance-draft Edge Function served from this repository; the migrations in
// supabase/migrations applied by the CLI). API level: no browser and no page (the one-page journey UI is P2-3).
//
// What is EXERCISED for real here: sign-in; the reserve/get/list/delete RPCs as the user; the Edge Function's sign,
// commit and cancel; signed upload to Storage; the server-side copy, read-back and SHA-256 verification; registration;
// RLS on Storage objects; the scheduled sweeper's orchestration (supabase/functions/_shared/sourceSweeper.ts) deleting
// real Storage objects.
// What is SIMULATED, and how: a worker stopping between steps is reproduced by performing exactly the steps the function
// would have performed (the same RPCs and the same Storage copy) and then calling the real function to resume; a lost
// response is the same request sent again; time passing (7-day expiry, a reservation's 30 minutes) is moved by the
// service role on the row's expiry column; pg_cron and pg_net are not used (the sweeper orchestration is called with the
// service role directly instead of through the database-minted ticket).
//
//   bun scripts/e2e/draftJourney.mjs <evidence-dir>       (after `supabase start`; reads `supabase status -o json`)
//
// Test credentials are generated for this run and never printed. Every request stays on loopback. Fixtures are invented.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { assertLocalStack } from "./localStackFixtures.mjs";
import { runSourceSweep } from "../../supabase/functions/_shared/sourceSweeper.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.resolve(process.argv[2] ?? path.join(REPO, "e2e-evidence/drafts"));
fs.mkdirSync(OUT, { recursive: true });
const BUCKET = "trial-balance-files";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const key = () => crypto.randomBytes(18).toString("base64url");
const results = [];
let group = "";
const log = (s) => { console.log(s); fs.appendFileSync(path.join(OUT, "journey.log"), s + "\n"); };
const startGroup = (g) => { group = g; log(`\n== ${g}`); };
async function check(name, fn) {
  try {
    const r = await fn();
    results.push({ group, name, ok: r === true });
    log(`  ${r === true ? "PASS" : "FAIL"}  ${name}${r === true ? "" : `\n        ${JSON.stringify(r)?.slice(0, 1500)}`}`);
  } catch (e) {
    results.push({ group, name, ok: false });
    log(`  FAIL  ${name}\n        ${String(e?.stack ?? e).split("\n").slice(0, 3).join(" | ")}`);
  }
}

// ── The stack (never printed) ────────────────────────────────────────────────────────────────────────────────────────
const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const apiUrl = status.API_URL;
const anonKey = status.ANON_KEY ?? status.PUBLISHABLE_KEY;
const serviceKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
assertLocalStack({ apiUrl, anonKey, serviceRoleKey: serviceKey });
const admin = createClient(apiUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const adminStorage = admin.storage.from(BUCKET);

// ── Accounts and entities (invented) ─────────────────────────────────────────────────────────────────────────────────
const run = Date.now().toString(36);
const mk = (who) => ({ email: `${who}.${run}@e2e-local.test`, password: `E2e!${crypto.randomBytes(12).toString("base64url")}` });
const U = { owner: mk("draft-owner"), other: mk("draft-other") };
for (const u of Object.values(U)) {
  const { data, error } = await admin.auth.admin.createUser({ email: u.email, password: u.password, email_confirm: true });
  if (error) throw new Error(`creating a test user failed: ${error.message}`);
  u.id = data.user.id;
}
async function grantPlan(userId) {
  const prod = (await admin.from("commercial_products").select("id").eq("code", "CFOCLOSE").single()).data;
  const plan = (await admin.from("commercial_plans").select("id").eq("product_id", prod.id).eq("code", "PRACTICE").single()).data;
  const bc = await admin.from("billing_customers").insert({ owner_user_id: userId, product_id: prod.id }).select("id").single();
  if (bc.error) throw new Error(`billing customer: ${bc.error.message}`);
  const lic = await admin.from("commercial_licences").insert({ billing_customer_id: bc.data.id, plan_id: plan.id, status: "ACTIVE", source: "ADMIN_GRANT",
    effective_start: new Date(Date.now() - 86400000).toISOString(), additional_seats: 4 });
  if (lic.error) throw new Error(`licence: ${lic.error.message}`);
}
await grantPlan(U.owner.id);
await grantPlan(U.other.id);
const signIn = async (u) => {
  const c = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await c.auth.signInWithPassword({ email: u.email, password: u.password });
  if (error) throw new Error(`api sign-in failed: ${error.message}`);
  return { c, token: data.session.access_token };
};
const owner = await signIn(U.owner);
const other = await signIn(U.other);
const newCompany = async (u, name) => {
  const { data, error } = await admin.from("companies").insert({ user_id: u.id, name }).select("id").single();
  if (error) throw new Error(`company: ${error.message}`);
  return data.id;
};
const A = await newCompany(U.owner, "Invented Drafts Trading Ltd");
const B = await newCompany(U.other, "Invented Other Holdings Ltd");

// ── Helpers: exactly what the browser does (src/lib/workspace/trialBalanceDraft.ts) ─────────────────────────────────
const csv = (tag) => Buffer.from(`code,name,debit,credit\n1000,Cash at bank ${tag},1500.00,0\n3000,Share capital,0,1500.00\n`);
const fn = async (who, body) => {
  const res = await fetch(`${apiUrl}/functions/v1/trial-balance-draft`, { method: "POST", headers: { Authorization: `Bearer ${who.token}`, apikey: anonKey, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, body: json };
};
const reserve = async (who, bytes, k = key(), name = "invented-tb.csv", declared = sha(bytes)) => {
  const { data, error } = await who.c.rpc("reserve_trial_balance_draft", { p_file_name: name, p_file_size: bytes.length, p_content_sha256: declared, p_idempotency_key: k });
  if (error) throw new Error(`reserve: ${error.code} ${error.message}`);
  return { ...data[0], k };
};
const upload = async (who, d, bytes) => {
  const s = await fn(who, { action: "sign", draft_id: d.draft_id });
  if (s.body?.outcome !== "signed") return s;
  const { error } = await who.c.storage.from(BUCKET).uploadToSignedUrl(s.body.path, s.body.token, new Blob([bytes], { type: "text/csv" }));
  return error ? { status: 0, body: { outcome: "upload_failed", error: error.message } } : s;
};
const CONF = { entity: "Invented Drafts Trading Ltd", period: "1 Jan – 31 Dec", currency: "TZS" };
let year = 2001;
const commitBody = (d, over = {}) => ({ action: "commit", draft_id: d.draft_id, commit_key: d.ck ?? (d.ck = key()), company_id: A, period_year: d.year ?? (d.year = ++year), period_id: null, engagement_id: null, confirmation: CONF, ...over });
const stored = async (p) => { const r = await adminStorage.download(p); return r.error ? null : Buffer.from(await r.data.arrayBuffer()); };
const uploadsOf = async (co) => (await admin.from("trial_balance_uploads").select("id,file_path,period_year,status").eq("company_id", co)).data ?? [];
const draftRow = async (id) => (await admin.from("trial_balance_drafts").select("*").eq("id", id).single()).data;
const commitRow = async (draftId) => (await admin.from("trial_balance_draft_commits").select("*").eq("draft_id", draftId).order("created_at")).data ?? [];
const readyDraft = async (tag) => { const bytes = csv(tag); const d = await reserve(owner, bytes); await upload(owner, d, bytes); return { ...d, bytes }; };

// The REAL sweeper orchestration with real Storage deletion; only the ticket (pg_cron/pg_net) is bypassed.
const deletions = [];
const sweep = () => runSourceSweep({
  redeemTicket: async () => true,
  listCandidates: async (n) => { const { data, error } = await admin.rpc("tbu_sweeper_candidates", { p_limit: n }); if (error) throw error; return data ?? []; },
  claim: async (k, id) => (await admin.rpc("tbu_sweeper_claim", { p_kind: k, p_target_id: id })).data === "claimed",
  removeObject: async (p) => { const { data, error } = await adminStorage.remove([p]); if (!error && data?.length) deletions.push(p); return !error; },
  objectExists: async (p) => { const { data, error } = await admin.rpc("tbu_storage_object_exists", { p_path: p }); return error ? null : data === true; },
  complete: async (k, id) => (await admin.rpc("tbu_sweeper_complete", { p_kind: k, p_target_id: id })).data ?? null,
}, "a".repeat(64));

// ── The journey ──────────────────────────────────────────────────────────────────────────────────────────────────────
startGroup("Rollout preconditions — the gateway's answers the browser client relies on");
await check("the trial-balance-draft function is served from this repository (an empty body is refused by it, not by the gateway)", async () => {
  for (let i = 0; i < 30; i++) {
    const r = await fn(owner, {});
    if (r.status === 400 && r.body?.outcome === "invalid_request") return true;
    await sleep(2000);
  }
  return "the function did not answer";
});
await check("a function that is not deployed answers 404 WITHOUT an 'outcome' (what the client reads as drafts_unavailable)", async () => {
  const res = await fetch(`${apiUrl}/functions/v1/trial-balance-draft-not-deployed`, { method: "POST", headers: { Authorization: `Bearer ${owner.token}`, apikey: anonKey, "Content-Type": "application/json" }, body: "{}" });
  let b = null; try { b = await res.json(); } catch { /* */ }
  return res.status === 404 && typeof b?.outcome !== "string" ? true : { status: res.status, b };
});
await check("a database function that does not exist answers PGRST202 (what the client reads as drafts_unavailable)", async () => {
  const { error } = await owner.c.rpc("reserve_trial_balance_draft_not_applied", { p_x: 1 });
  return error?.code === "PGRST202" ? true : error;
});

startGroup("Draft upload — owner-scoped, idempotent, real Storage");
const F1 = csv("one");
let D1;
await check("reserve as the user: drafts/<owner>/<draft>/<name>, 7 days", async () => {
  D1 = await reserve(owner, F1);
  return D1.outcome === "reserved" && D1.object_path === `drafts/${U.owner.id}/${D1.draft_id}/invented-tb.csv`
    && Math.abs(new Date(D1.expires_at) - Date.now() - 7 * 86400000) < 120000 ? true : D1;
});
await check("the same key and file replays the same draft; the same key with other bytes is a conflict", async () => {
  const again = await reserve(owner, F1, D1.k);
  const changed = await reserve(owner, csv("changed"), D1.k);
  return again.outcome === "replayed" && again.draft_id === D1.draft_id && changed.outcome === "conflict" ? true : { again, changed };
});
await check("signed upload of exactly that object; a second sign answers already_stored (nothing uploaded twice)", async () => {
  const s = await upload(owner, D1, F1);
  const again = await fn(owner, { action: "sign", draft_id: D1.draft_id });
  const bytes = await stored(D1.object_path);
  return s.body?.outcome === "signed" && again.status === 409 && again.body?.outcome === "already_stored" && bytes && sha(bytes) === sha(F1) ? true : { s, again };
});
await check("another user cannot sign, read (RLS), commit or delete the owner's draft", async () => {
  const s = await fn(other, { action: "sign", draft_id: D1.draft_id });
  const dl = await other.c.storage.from(BUCKET).download(D1.object_path);
  const c = await fn(other, commitBody(D1, { company_id: B, commit_key: key() }));
  const del = (await other.c.rpc("delete_trial_balance_draft", { p_draft_id: D1.draft_id })).data;
  const get = (await other.c.rpc("get_trial_balance_draft", { p_draft_id: D1.draft_id })).data;
  return s.status === 404 && dl.error && c.status === 404 && del === "not_found" && get?.length === 0 ? true : { s, dl: !!dl.error, c, del, get };
});
await check("the owner cannot write a drafts/ object directly (only through the signed URL)", async () => {
  const { error } = await owner.c.storage.from(BUCKET).upload(`drafts/${U.owner.id}/${crypto.randomUUID()}/x.csv`, new Blob([F1]));
  return error ? true : "a direct client write into drafts/ succeeded";
});

startGroup("Commit — copy, verification, registration; replay and conflicts");
let C1;
await check("commit: the workspace copy's bytes hash to the draft's; one upload registered at workspaces/<entity>/…", async () => {
  C1 = await fn(owner, commitBody(D1));
  const ups = await uploadsOf(A);
  const up = ups.find((u) => u.id === C1.body?.upload_id);
  const copy = up ? await stored(up.file_path) : null;
  const [c] = await commitRow(D1.draft_id);
  return C1.status === 200 && C1.body.outcome === "committed" && up && up.file_path.startsWith(`workspaces/${A}/`) && up.period_year === D1.year
    && copy && sha(copy) === sha(F1) && copy.length === F1.length && c.copy_verified_at && c.state === "committed" ? true : { C1, up, c };
});
await check("a lost response (the same request again): 'committed', replayed, the same upload, nothing new", async () => {
  const n = (await uploadsOf(A)).length;
  const again = await fn(owner, commitBody(D1));
  return again.status === 200 && again.body.replayed === true && again.body.upload_id === C1.body.upload_id && (await uploadsOf(A)).length === n ? true : again;
});
await check("the same key with a changed period or confirmed currency is a conflict; a new key with other inputs too (committed once)", async () => {
  const a = await fn(owner, commitBody(D1, { period_year: D1.year + 1 }));
  const b = await fn(owner, commitBody(D1, { confirmation: { ...CONF, currency: "USD" } }));
  const c = await fn(owner, commitBody(D1, { commit_key: key(), period_year: D1.year + 1 }));
  return [a, b, c].every((r) => r.status === 409 && r.body.outcome === "commit_conflict") ? true : { a, b, c };
});
await check("a replay after authority was revoked is refused (403): retrying never bypasses current authorisation", async () => {
  // A collaborator holding an explicit manage_source_files grant on the owner's entity commits their own draft; the owner
  // then revokes the grant; the collaborator's replay of the very same request is refused.
  const g = (await owner.c.rpc("grant_workspace_capability", { p_company_id: A, p_grantee_user_id: U.other.id, p_capability: "manage_source_files" })).data?.[0];
  const bytes = csv("collaborator");
  const d = await reserve(other, bytes);
  await upload(other, d, bytes);
  const ok = await fn(other, commitBody(d));
  const rv = await owner.c.rpc("revoke_workspace_capability", { p_company_id: A, p_grantee_user_id: U.other.id, p_capability: "manage_source_files" });
  const replay = await fn(other, commitBody(d));
  return g?.outcome && ok.body?.outcome === "committed" && !rv.error && replay.status === 403 && replay.body.outcome === "forbidden" ? true : { g, ok, rv: rv.error?.message, replay };
});

startGroup("Recovery — interruptions, partial success, retries");
await check("copy succeeded but registration failed (period already active): actionable 409; copy verified, reservation unconsumed; cancel; a new key to another period commits", async () => {
  const d = await readyDraft("occupied");
  const r = await fn(owner, commitBody(d, { period_year: D1.year }));
  const [c] = await commitRow(d.draft_id);
  const res = (await admin.from("trial_balance_source_reservations").select("*").eq("id", c.reservation_id).single()).data;
  const copy = await stored(res.object_path);
  const cancel = await fn(owner, { action: "cancel", commit_id: r.body?.commit_id });
  const respent = await fn(owner, commitBody(d, { period_year: D1.year }));
  d.ck = key(); d.year = ++year;
  const done = await fn(owner, commitBody(d));
  d.orphanReservation = res;
  globalThis.ORPHAN = res;
  return r.status === 409 && r.body.outcome === "active_upload_exists" && /already active/.test(r.body.detail) && c.copy_verified_at && res.consumed_at === null
    && copy && sha(copy) === sha(d.bytes) && cancel.body?.outcome === "cancelled" && respent.body?.outcome === "not_eligible" && done.body?.outcome === "committed" ? true : { r, c, cancel, respent, done };
});
await check("replace the period's active trial balance with a draft: a stale version is refused and the current one is kept; the right version replaces it (old kept as history)", async () => {
  const active = async () => (await admin.from("trial_balance_uploads").select("id, version, lifecycle_state").eq("company_id", A).eq("period_year", D1.year)
    .in("lifecycle_state", ["active_unprocessed", "active_processing", "active_processed", "blocked"])).data ?? [];
  const before = await active();
  const d = await readyDraft("replacement");
  const refused = await fn(owner, commitBody(d, { period_year: D1.year }));
  await fn(owner, { action: "cancel", commit_id: refused.body?.commit_id });
  const stale = await fn(owner, commitBody(d, { commit_key: key(), period_year: D1.year, replaces_upload_id: before[0].id, expected_version: Number(before[0].version) - 1 }));
  const stillActive = await active();
  // A stale attempt's commit is cancelled before the user tries again (as the card does).
  await fn(owner, { action: "cancel", commit_id: stale.body?.commit_id });
  const ok = await fn(owner, commitBody(d, { commit_key: key(), period_year: D1.year, replaces_upload_id: before[0].id, expected_version: Number(before[0].version) }));
  const after = await active();
  const old = (await admin.from("trial_balance_uploads").select("lifecycle_state, superseded_by_upload_id").eq("id", before[0].id).single()).data;
  const copy = after[0] ? await stored((await admin.from("trial_balance_uploads").select("file_path").eq("id", after[0].id).single()).data.file_path) : null;
  return before.length === 1 && refused.body?.outcome === "active_upload_exists" && stale.status === 409 && stale.body?.outcome === "replace_conflict"
    && stillActive.length === 1 && stillActive[0].id === before[0].id
    && ok.body?.outcome === "committed" && after.length === 1 && after[0].id === ok.body.upload_id && old.lifecycle_state === "superseded" && old.superseded_by_upload_id === ok.body.upload_id
    && copy && sha(copy) === sha(d.bytes) ? true : { before, refused: refused.body, stale: stale.body, stillActive, ok: ok.body, after, old };
});
await check("the worker stopped after reserving and recording the workspace reservation: the real function resumes; one reservation, one upload", async () => {
  const d = await readyDraft("stop-record");
  const t = commitBody(d);
  const b = (await admin.rpc("tbd_begin_commit", { p_draft_id: d.draft_id, p_user_id: U.owner.id, p_commit_key: t.commit_key, p_company_id: A, p_period_year: t.period_year, p_period_id: null, p_engagement_id: null, p_confirmation: CONF })).data[0];
  const r = (await owner.c.rpc("reserve_trial_balance_source", { p_company_id: A, p_file_name: "invented-tb.csv" })).data[0];
  await admin.rpc("tbd_record_commit_reservation", { p_commit_id: b.commit_id, p_user_id: U.owner.id, p_reservation_id: r.reservation_id });
  const done = await fn(owner, t);
  const [c] = await commitRow(d.draft_id);
  const up = (await uploadsOf(A)).filter((u) => u.id === done.body?.upload_id);
  return done.body?.outcome === "committed" && c.reservation_id === r.reservation_id && up.length === 1 && up[0].file_path === r.object_path ? true : { done, c };
});
await check("the worker stopped after the copy, before recording verification: the function re-reads the existing copy (no second copy) and finishes", async () => {
  const d = await readyDraft("stop-copy");
  const t = commitBody(d);
  const b = (await admin.rpc("tbd_begin_commit", { p_draft_id: d.draft_id, p_user_id: U.owner.id, p_commit_key: t.commit_key, p_company_id: A, p_period_year: t.period_year, p_period_id: null, p_engagement_id: null, p_confirmation: CONF })).data[0];
  const r = (await owner.c.rpc("reserve_trial_balance_source", { p_company_id: A, p_file_name: "invented-tb.csv" })).data[0];
  await admin.rpc("tbd_record_commit_reservation", { p_commit_id: b.commit_id, p_user_id: U.owner.id, p_reservation_id: r.reservation_id });
  const cp = await adminStorage.copy(d.object_path, r.object_path);
  const done = await fn(owner, t);
  const copy = await stored(r.object_path);
  return !cp.error && done.body?.outcome === "committed" && copy && sha(copy) === sha(d.bytes) ? true : { cp: cp.error?.message, done };
});
await check("the worker stopped after registration (the answer never reached the browser): the retry finishes without registering again", async () => {
  const d = await readyDraft("stop-register");
  const t = commitBody(d);
  const b = (await admin.rpc("tbd_begin_commit", { p_draft_id: d.draft_id, p_user_id: U.owner.id, p_commit_key: t.commit_key, p_company_id: A, p_period_year: t.period_year, p_period_id: null, p_engagement_id: null, p_confirmation: CONF })).data[0];
  const r = (await owner.c.rpc("reserve_trial_balance_source", { p_company_id: A, p_file_name: "invented-tb.csv" })).data[0];
  await admin.rpc("tbd_record_commit_reservation", { p_commit_id: b.commit_id, p_user_id: U.owner.id, p_reservation_id: r.reservation_id });
  await adminStorage.copy(d.object_path, r.object_path);
  await admin.rpc("tbd_record_copy_verified", { p_commit_id: b.commit_id, p_user_id: U.owner.id, p_copy_sha256: sha(d.bytes), p_copy_size: d.bytes.length });
  const g = (await owner.c.rpc("register_trial_balance_upload", { p_reservation_id: r.reservation_id, p_file_size: d.bytes.length, p_period_year: t.period_year, p_period_id: null, p_engagement_id: null })).data[0];
  const n = (await uploadsOf(A)).length;
  const done = await fn(owner, t);
  return g.outcome === "registered" && done.body?.outcome === "committed" && done.body.upload_id === g.upload_id && (await uploadsOf(A)).length === n ? true : { g, done };
});
await check("five concurrent identical commits: one upload, every answer 'committed' or retryable, none a different upload", async () => {
  const d = await readyDraft("concurrent");
  const t = commitBody(d);
  const rs = await Promise.all(Array.from({ length: 5 }, () => fn(owner, t)));
  const final = await fn(owner, t);
  const ids = new Set(rs.filter((r) => r.body?.outcome === "committed").map((r) => r.body.upload_id));
  const ups = (await uploadsOf(A)).filter((u) => u.period_year === t.period_year);
  return final.body?.outcome === "committed" && ups.length === 1 && [...ids].every((i) => i === final.body.upload_id)
    && rs.every((r) => r.body?.outcome === "committed" || r.body?.retryable === true || r.body?.outcome === "commit_conflict") ? true : rs.map((r) => [r.status, r.body?.outcome]);
});

startGroup("Integrity");
await check("a stored draft whose bytes are not the declared file: 422 content_mismatch; rejected; nothing copied or registered", async () => {
  const declared = csv("declared"), actual = csv("actual!");
  const d = await reserve(owner, declared, key(), "invented-tb.csv", sha(declared));
  // The browser declares one file and uploads another (the signed URL does not check content).
  const s = await fn(owner, { action: "sign", draft_id: d.draft_id });
  await owner.c.storage.from(BUCKET).uploadToSignedUrl(s.body.path, s.body.token, new Blob([actual]));
  const n = (await uploadsOf(A)).length;
  const r = await fn(owner, commitBody(d));
  const row = await draftRow(d.draft_id);
  return r.status === 422 && r.body.outcome === "content_mismatch" && row.state === "rejected" && (await uploadsOf(A)).length === n ? true : { r, row };
});

startGroup("Upload policy on the REAL processing function: hostile files fail explicitly, nothing partial, the worker stays healthy");
// Invented hostile inputs. Each is stored as a draft, committed to its own period, then checked by process-trial-balance.
const lyingZip = (actual, declared) => {
  const data = zlib.deflateRawSync(actual, { level: 9 });
  const name = Buffer.from("xl/worksheets/sheet1.xml");
  const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0), u32(0), u32(data.length), u32(declared), u16(name.length), u16(0), name, data]);
  const central = Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0), u32(0), u32(data.length), u32(declared), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(0), name]);
  return Buffer.concat([local, central, u32(0x06054b50), u16(0), u16(0), u16(1), u16(1), u32(central.length), u32(local.length), u16(0)]);
};
const policy = await import("../../supabase/functions/_shared/uploadPolicy.ts");
const MAX = policy.TB_UPLOAD_POLICY.maxRows; // lines including the header
let policyYear = 2040;
/** A dated TZS period of its own (calendar year), opened through the real authority, so processing does its full work. */
const openYear = async () => {
  const y = ++policyYear;
  const { data, error } = await owner.c.rpc("open_engagement_with_period", { p_company_id: A, p_period_start: `${y}-01-01`, p_period_end: `${y}-12-31`, p_reporting_currency: "TZS", p_capabilities: ["FINANCIAL_STATEMENTS"] });
  if (error || !data?.periodId) throw new Error(`period ${y}: ${error?.message ?? JSON.stringify(data)}`);
  return { year: y, periodId: data.periodId, engagementId: data.engagementId };
};
/** Balanced invented rows: n accounts with realistic, varied names and amounts; the last one credits their total. */
const W1 = ["Trade", "Other", "Accrued", "Prepaid", "Deferred", "Staff", "Motor", "Office", "Bank", "Loan", "Interest", "Rental", "Consulting", "Insurance", "Freight"];
const W2 = ["receivables", "payables", "expenses", "income", "charges", "deposits", "advances", "fees", "costs", "provisions", "allowances", "levies"];
const W3 = ["Dar es Salaam", "Arusha", "Mwanza", "Dodoma", "head office", "branch 2", "project Kilima", "USD account", "petty", "suspense"];
const balancedRows = (n) => {
  const rows = []; let total = 0;
  for (let i = 0; i < n - 1; i++) {
    const minor = 100 + ((i * 7919) % 9_999_900);
    rows.push([String(100000 + i), `${W1[i % W1.length]} ${W2[(i * 7) % W2.length]} - ${W3[(i * 3) % W3.length]} ${1000 + ((i * 7919) % 9000)}`, (minor / 100).toFixed(2), "0.00"]);
    total += minor;
  }
  rows.push(["999999", "Retained earnings and reserves", "0.00", (total / 100).toFixed(2)]);
  return rows;
};
const HEADER = ["Account code", "Account name", "Debit", "Credit"];
const csvOf = (rows, { blankEvery = 0, extra = 0 } = {}) => {
  const head = [...HEADER, ...Array.from({ length: extra }, (_, k) => `Memo ${k + 1}`)].join(",");
  const lines = [head];
  rows.forEach((r, i) => {
    lines.push([...r, ...Array.from({ length: extra }, () => "x")].join(","));
    for (let b = 0; b < blankEvery && i < rows.length - 1; b++) lines.push(",,,");
  });
  return Buffer.from(lines.join("\n") + "\n");
};
const workbookOf = async (rows, { bookType = "xlsx", extra = 0, cover = false } = {}) => {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  if (cover) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Invented Holdings Ltd"], ["Trial balance pack"], ["Prepared for review"]]), "Cover");
  const head = [...HEADER, ...Array.from({ length: extra }, (_, k) => `Memo ${k + 1}`)];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([head, ...rows.map((r) => [r[0], r[1], Number(r[2]), Number(r[3]), ...Array.from({ length: extra }, () => "x")])]), "TB");
  return Buffer.from(XLSX.write(wb, { type: "array", bookType, ...(bookType === "xlsx" ? { compression: true } : {}) }));
};
const xlsxOf = (rows, o = {}) => workbookOf(rows, { ...o, bookType: "xlsx" });
/** The certification the real function recorded for an upload: its counts and how many findings are stored in full. */
const certificationOf = async (uploadId) => {
  const c = (await admin.from("tb_certifications").select("id, requires_review, is_blocking, findings_count, findings_summarized, exceptions").eq("upload_id", uploadId).order("sequence_no", { ascending: false }).limit(1)).data?.[0] ?? null;
  if (!c) return null;
  const { count } = await admin.from("tb_certification_findings").select("ordinal", { count: "exact", head: true }).eq("certification_id", c.id);
  return { requiresReview: c.requires_review, blocking: c.is_blocking, findingsCount: c.findings_count, summarized: c.findings_summarized, stored: count, summaryEntries: c.exceptions?.length ?? null };
};
const commitAndProcess = async (bytes, name) => {
  const p = await openYear();
  const d = await reserve(owner, bytes, key(), name);
  await upload(owner, d, bytes);
  const c = await fn(owner, commitBody({ ...d, bytes, year: p.year }, { period_id: p.periodId, engagement_id: p.engagementId }));
  if (c.body?.outcome !== "committed") return { commit: c.body };
  const t0 = Date.now();
  const res = await fetch(`${apiUrl}/functions/v1/process-trial-balance`, { method: "POST", headers: { Authorization: `Bearer ${owner.token}`, apikey: anonKey, "Content-Type": "application/json" }, body: JSON.stringify({ uploadId: c.body.upload_id, clientRequestId: crypto.randomUUID() }) });
  const ms = Date.now() - t0;
  const bodyText = res.status === 200 ? "" : (await res.text().catch(() => "")).slice(0, 400);
  const row = (await admin.from("trial_balance_uploads").select("status, processing_result, accounting_errors").eq("id", c.body.upload_id).single()).data;
  const ing = row?.processing_result?.ingestion ?? null;
  const cert = await certificationOf(c.body.upload_id);
  const r = { httpStatus: res.status, ms, bytes: bytes.length, status: row?.status, codes: (ing?.issues ?? []).map((i) => i.code), accounts: ing?.lineage_summary?.account ?? null, totals: ing?.totals ?? null, cert };
  log(`        [policy] ${name}: ${(bytes.length / 1024).toFixed(0)} KB, HTTP ${r.httpStatus} in ${ms} ms, status ${r.status}, accounts ${r.accounts}, issues ${r.codes.join(",") || "none"}, certification ${cert ? `findings ${cert.findingsCount} (stored ${cert.stored}, summary ${cert.summaryEntries}${cert.summarized ? ", summarized" : ""})` : "none"}${bodyText ? `, body ${bodyText}` : ""}${r.status === "error" ? `, errors ${JSON.stringify(row?.accounting_errors ?? null).slice(0, 300)}` : ""}`);
  return r;
};
const refusedCleanly = (r, code) => r.httpStatus === 200 && r.codes?.includes(code) && (r.accounts === 0 || r.accounts === null) && !r.totals && !["complete", "valid"].includes(r.status);
// Processed in full: every account read, and a certification whose COMPLETE findings are all stored (at least one finding
// per unclassified account: nothing here is mapped), review still required.
const processedFully = (r, accounts) => r.httpStatus === 200 && r.accounts === accounts && !r.codes.some((c) => /TOO_|LARGE|UNSUPPORTED|CURRENCY/.test(c))
  && !!r.cert && r.cert.findingsCount !== null && r.cert.stored === r.cert.findingsCount && r.cert.findingsCount >= accounts && r.cert.requiresReview === true;
const ACCOUNTS = policy.TB_UPLOAD_POLICY.maxAccounts;
// Where does the real function's capacity end? Balanced files of increasing size, each processed in full or not.
for (const n of [1_000, ACCOUNTS]) {
  await check(`capacity: ${n} accounts (realistic varied names) as a workbook and as CSV are processed in full, every finding stored (HTTP 200)`, async () => {
    const x = await commitAndProcess(await xlsxOf(balancedRows(n)), `cap-${n}.xlsx`);
    const c = await commitAndProcess(csvOf(balancedRows(n)), `cap-${n}.csv`);
    return processedFully(x, n) && processedFully(c, n) ? true : { xlsx: x, csv: c };
  });
}
await check(`an .xls (BIFF8) workbook at the account limit (${ACCOUNTS}) is processed in full`, async () => {
  const r = await commitAndProcess(await workbookOf(balancedRows(ACCOUNTS), { bookType: "biff8" }), "at-limit.xls");
  return processedFully(r, ACCOUNTS) ? true : r;
});
await check("a multi-sheet workbook (a cover sheet, then the trial balance) at the account limit is processed in full", async () => {
  const r = await commitAndProcess(await xlsxOf(balancedRows(ACCOUNTS), { cover: true }), "multi-sheet.xlsx");
  return processedFully(r, ACCOUNTS) ? true : r;
});
await check(`a SPARSE CSV at the row limit (up to ${MAX} lines: ${ACCOUNTS} accounts separated by blank lines) is processed in full`, async () => {
  const blankEvery = Math.floor((MAX - 1 - ACCOUNTS) / (ACCOUNTS - 1));
  const bytes = csvOf(balancedRows(ACCOUNTS), { blankEvery });
  const lines = bytes.toString().trimEnd().split("\n").length;
  const r = await commitAndProcess(bytes, "sparse-at-limit.csv");
  return lines <= MAX && lines > MAX - ACCOUNTS && processedFully(r, ACCOUNTS) ? true : { lines, r };
});
await check("a WIDE CSV within the cell limit (1,500 accounts × 70 columns = 105,070 cells) is processed in full", async () => {
  const r = await commitAndProcess(csvOf(balancedRows(1_500), { extra: 66 }), "wide.csv");
  return processedFully(r, 1_500) ? true : r;
});
await check("a WIDE CSV over the cell limit (2,000 accounts × 70 columns): refused by name (TOO_MANY_CELLS)", async () => {
  const r = await commitAndProcess(csvOf(balancedRows(ACCOUNTS), { extra: 66 }), "wide-over.csv");
  return refusedCleanly(r, "TOO_MANY_CELLS") ? true : r;
});
await check("the same wide sheet as a WORKBOOK expands past 2 MB first: refused by name (WORKBOOK_TOO_LARGE_EXPANDED) before any parse", async () => {
  const r = await commitAndProcess(await xlsxOf(balancedRows(1_500), { extra: 66 }), "wide.xlsx");
  return refusedCleanly(r, "WORKBOOK_TOO_LARGE_EXPANDED") ? true : r;
});
await check(`one account over the account limit (${ACCOUNTS + 1}): refused by name (TOO_MANY_ACCOUNTS); nothing certified in part`, async () => {
  const r = await commitAndProcess(csvOf(balancedRows(ACCOUNTS + 1)), "accounts-over.csv");
  return refusedCleanly(r, "TOO_MANY_ACCOUNTS") && (!r.cert || r.cert.blocking === true) ? true : r;
});
// Concurrency at the account limit. The Edge Runtime limits CPU time per isolate (runtime log, CI run 38892294850): one
// isolate running two 2,000-account checks reached its soft limit and the requests queued in it hit the hard limit (546).
// process-trial-balance therefore runs ONE check per isolate and queues nothing: a request arriving meanwhile is refused
// at once (503 PROCESSING_BUSY, nothing begun) and is retried as the SAME request, as the browser does.
const attemptsOf = async (uploadId) => (await admin.from("engine_runs").select("id, status, attempt_no").eq("source_record_id", uploadId)).data ?? [];
const certsOf = async (uploadId) => (await admin.from("tb_certifications").select("id").eq("upload_id", uploadId)).data ?? [];
const commitOnly = async (bytes, name) => {
  const p = await openYear();
  const d = await reserve(owner, bytes, key(), name);
  await upload(owner, d, bytes);
  const c = await fn(owner, commitBody({ ...d, bytes, year: p.year }, { period_id: p.periodId, engagement_id: p.engagementId }));
  return c.body.upload_id;
};
const processOnce = async (uploadId, requestId) => {
  const t0 = Date.now();
  const res = await fetch(`${apiUrl}/functions/v1/process-trial-balance`, { method: "POST", headers: { Authorization: `Bearer ${owner.token}`, apikey: anonKey, "Content-Type": "application/json" }, body: JSON.stringify({ uploadId, clientRequestId: requestId }) });
  const body = await res.json().catch(() => null);
  return { http: res.status, code: body?.code ?? null, ms: Date.now() - t0, retryAfter: res.headers.get("retry-after") };
};
for (const n of [4, 8]) {
  await check(`${n} simultaneous requests at the account limit: none exhausts the runtime; each is processed in full exactly once (one attempt, one certification, complete findings) — at once, or after being refused as busy at once with NOTHING begun and retried as the same request; nothing stranded`, async () => {
    const files = await Promise.all(Array.from({ length: n }, () => xlsxOf(balancedRows(ACCOUNTS))));
    const ids = [];
    for (let k = 0; k < n; k++) ids.push(await commitOnly(files[k], `concurrent${n}-${k}.xlsx`));
    const reqIds = ids.map(() => crypto.randomUUID());
    const first = await Promise.all(ids.map((id, k) => processOnce(id, reqIds[k])));
    const busy = first.map((f, k) => ({ ...f, k })).filter((f) => f.http === 503 && f.code === "PROCESSING_BUSY");
    const busyClean = [];
    for (const b of busy) busyClean.push((await attemptsOf(ids[b.k])).length === 0);
    // Retries as the browser does them: the same request, after the server's Retry-After, until processed (bounded).
    const retries = [];
    for (const b of busy) {
      let r = null;
      for (let t = 0; t < 10; t++) {
        await new Promise((res) => setTimeout(res, 1000 * Number(b.retryAfter ?? 3)));
        r = await processOnce(ids[b.k], reqIds[b.k]);
        if (r.http !== 503 || r.code !== "PROCESSING_BUSY") break;
      }
      retries.push(r.http);
    }
    const final = [];
    for (let k = 0; k < n; k++) {
      const row = (await admin.from("trial_balance_uploads").select("status").eq("id", ids[k]).single()).data;
      const cert = await certificationOf(ids[k]);
      final.push({ k, status: row?.status, attempts: (await attemptsOf(ids[k])).length, certs: (await certsOf(ids[k])).length, stored: cert?.stored ?? null, findings: cert?.findingsCount ?? null });
    }
    log(`        [policy] ${n}-way at ${ACCOUNTS} accounts: first answers ${first.map((f) => f.http).join("/")} (${first.map((f) => f.ms).join("/")} ms); busy ${busy.length} (refused in ≤ ${Math.max(0, ...busy.map((b) => b.ms))} ms), retried ${retries.join("/") || "-"}`);
    const ok = first.every((f) => f.http === 200 || (f.http === 503 && f.code === "PROCESSING_BUSY"))
      && busyClean.every(Boolean) && retries.every((h) => h === 200)
      && final.every((f) => f.status === "needs_review" && f.attempts === 1 && f.certs === 1 && f.stored === f.findings && f.findings >= ACCOUNTS);
    return ok ? true : { first, busy: busy.length, busyClean, retries, final };
  });
}
await check("a workbook one row over the limit: refused by name (TOO_MANY_ROWS); no account accepted, no totals, HTTP 200", async () => {
  const r = await commitAndProcess(await xlsxOf(balancedRows(MAX)), "over.xlsx");
  return refusedCleanly(r, "TOO_MANY_ROWS") ? true : r;
});
await check("a CSV one row over the limit: refused by name (TOO_MANY_ROWS); nothing truncated or partially accepted", async () => {
  const r = await commitAndProcess(csvOf(balancedRows(MAX)), "over.csv");
  return refusedCleanly(r, "TOO_MANY_ROWS") ? true : r;
});
await check("a workbook whose directory claims 10 bytes but really inflates past the limit: refused (WORKBOOK_TOO_LARGE_EXPANDED) before any parse", async () => {
  const r = await commitAndProcess(lyingZip(Buffer.alloc(policy.TB_UPLOAD_POLICY.maxExpandedBytes + 1_048_576), 10), "lying.xlsx");
  return refusedCleanly(r, "WORKBOOK_TOO_LARGE_EXPANDED") ? true : r;
});
await check("after all of them, an ordinary trial balance is processed normally (the worker is healthy)", async () => {
  const r = await commitAndProcess(csvOf(balancedRows(3)), "after.csv");
  return processedFully(r, 3) ? true : r;
});

startGroup("Retention — the real sweeper orchestration against real Storage");
const evidence = async () => {
  const ups = (await admin.from("trial_balance_uploads").select("id,file_path").in("company_id", [A])).data ?? [];
  const out = [];
  for (const u of ups) { const b = await stored(u.file_path); out.push(`${u.id}:${b ? sha(b) : "MISSING"}`); }
  return out.sort().join("|");
};
const before = await evidence();
await check("after commits: each committed draft's own drafts/ copy is removed once; every upload's workspace file is still there with the same bytes", async () => {
  deletions.length = 0; await sweep(); await sweep();
  const gone = !(await stored(D1.object_path));
  return gone && deletions.filter((p) => p === D1.object_path).length === 1 && deletions.every((p) => p.startsWith("drafts/")) && (await evidence()) === before && !before.includes("MISSING") ? true : { deletions, gone };
});
await check("cleanup racing a replay of a committed draft: the replay still answers the same upload; the workspace file is intact", async () => {
  const d = await readyDraft("race-replay");
  const ok = await fn(owner, commitBody(d));
  const [replay] = await Promise.all([fn(owner, commitBody(d)), sweep()]);
  const up = (await uploadsOf(A)).find((u) => u.id === ok.body.upload_id);
  const copy = await stored(up.file_path);
  return replay.body?.outcome === "committed" && replay.body.upload_id === ok.body.upload_id && copy && sha(copy) === sha(d.bytes) ? true : { ok, replay };
});
await check("cleanup racing a commit at the moment of expiry: either the commit began first (the draft is kept, and finishes) or the sweep expired it first (410); never a lost file", async () => {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const d = await readyDraft(`race-expiry-${i}`);
    await admin.from("trial_balance_drafts").update({ expires_at: new Date(Date.now() + 1500).toISOString() }).eq("id", d.draft_id);
    await sleep(1500);
    const [r] = await Promise.all([fn(owner, commitBody(d)), sweep()]);
    await sweep();
    const row = await draftRow(d.draft_id);
    const up = r.body?.upload_id ? (await uploadsOf(A)).find((u) => u.id === r.body.upload_id) : null;
    const copy = up ? await stored(up.file_path) : null;
    out.push({ outcome: r.body?.outcome, state: row.state, ok: r.body?.outcome === "committed" ? !!copy && sha(copy) === sha(d.bytes) : (r.status === 410 && row.state === "expired") });
  }
  return out.every((o) => o.ok) ? true : out;
});
await check("an unconfirmed draft past 7 days: its object is removed exactly once; the draft reads 'expired'", async () => {
  const d = await readyDraft("old");
  await admin.from("trial_balance_drafts").update({ expires_at: new Date(Date.now() - 60000).toISOString() }).eq("id", d.draft_id);
  deletions.length = 0; await Promise.all([sweep(), sweep()]); await sweep();
  const g = (await owner.c.rpc("get_trial_balance_draft", { p_draft_id: d.draft_id })).data[0];
  return deletions.filter((p) => p === d.object_path).length === 1 && !(await stored(d.object_path)) && g.state === "expired" && g.stored === false ? true : { deletions, g };
});
await check("the cancelled commit's unconsumed workspace copy is reclaimed by the existing reservation sweep once that reservation expires", async () => {
  const res = globalThis.ORPHAN;
  await admin.from("trial_balance_source_reservations").update({ expires_at: new Date(Date.now() - 86400000).toISOString() }).eq("id", res.id);
  deletions.length = 0; await sweep();
  return deletions.includes(res.object_path) && !(await stored(res.object_path)) && (await evidence()).split("|").every((e) => !e.endsWith("MISSING")) ? true : deletions;
});
await check("repeated cleanup: further sweeps delete nothing; committed evidence unchanged", async () => {
  const snap = await evidence();
  deletions.length = 0; await sweep(); await sweep(); await sweep();
  return deletions.length === 0 && (await evidence()) === snap ? true : deletions;
});
await check("the owner deletes an unused draft: deleted, then removed by the next sweep", async () => {
  const d = await readyDraft("delete-me");
  const del = (await owner.c.rpc("delete_trial_balance_draft", { p_draft_id: d.draft_id })).data;
  deletions.length = 0; await sweep();
  return del === "deleted" && deletions.includes(d.object_path) ? true : { del, deletions };
});

const failed = results.filter((r) => !r.ok);
log("\n──────────────────────────────────────────");
log(`assertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
for (const f of failed) log(`  FAILED [${f.group}] ${f.name}`);
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ results, failed: failed.length }, null, 2));
const ok = failed.length === 0 && results.length > 0;
log(ok ? "DRAFT_JOURNEY: ALL PASSED" : "DRAFT_JOURNEY: FAILED");
process.exit(ok ? 0 : 1);
