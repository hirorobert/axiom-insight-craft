#!/usr/bin/env node
// Retrieval of a trial balance's ORIGINAL file, end to end on the LOCAL Supabase stack (`supabase start` in CI): real Auth,
// PostgREST, RLS, private Storage, and the trial-balance-source-signer / trial-balance-source-download Edge Functions served
// from this repository. API level (the visible "Download original" action in the browser is covered by the "Download original"
// group of scripts/e2e/localStackJourney.mjs).
//
// REAL here: every person signs in with a password through GoTrue and every call carries their JWT; the bytes go through the
// app's own upload sequence (reserve_trial_balance_source -> signer -> signed upload to the PRIVATE bucket ->
// register_trial_balance_upload); the collaborator's right is granted and revoked by the OWNER through grant_workspace_capability /
// revoke_workspace_capability (the application's own RPCs, not the service role); the download is the Edge Function's answer; a
// URL is fetched like a browser would and allowed to EXPIRE.
// OPERATOR actions by the service role (recorded in the results): creating the Auth users and granting the owners a plan,
// creating the two companies, deleting one stored object to prove "unavailable", and READING database rows to compare the
// recorded fingerprint. NOT proven here: invitations, membership acceptance, or rollout configuration through the UI.
//
//   node scripts/e2e/sourceDownloadJourney.mjs <evidence-dir>       (after `supabase start`; reads `supabase status -o json`)
//
// Test credentials are generated for this run and never printed. Every request stays on loopback. Fixtures are invented.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { assertLocalStack } from "./localStackFixtures.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.resolve(process.argv[2] ?? path.join(REPO, "e2e-evidence/source-download"));
fs.mkdirSync(OUT, { recursive: true });
const BUCKET = "trial-balance-files";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const uuid = () => crypto.randomUUID();
const results = [];
const gaps = [];
let group = "";
// A signed URL is a bearer credential: nothing this journey prints or records may contain one or its token.
const redact = (text) => String(text).replace(/([?&](?:token|apikey|access_token)=)[^&"\s]*/gi, "$1…").replace(/("(?:url|signedUrl|token)"\s*:\s*)"[^"]*"/gi, '$1"…"');
const log = (s) => { const t = redact(s); console.log(t); fs.appendFileSync(path.join(OUT, "journey.log"), t + "\n"); };
const startGroup = (g) => { group = g; log(`\n== ${g}`); };
async function check(name, fn) {
  try {
    const r = await fn();
    results.push({ group, name, ok: r === true, detail: r === true ? undefined : JSON.parse(redact(JSON.stringify(r) ?? "null")) });
    log(`  ${r === true ? "PASS" : "FAIL"}  ${name}${r === true ? "" : `\n        ${JSON.stringify(r)?.slice(0, 1500)}`}`);
  } catch (e) {
    results.push({ group, name, ok: false, detail: redact(String(e?.message ?? e)) });
    log(`  FAIL  ${name}\n        ${String(e?.stack ?? e).split("\n").slice(0, 3).join(" | ")}`);
  }
}

// ── The stack (never printed) ────────────────────────────────────────────────────────────────────────────────────
const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const apiUrl = status.API_URL, anonKey = status.ANON_KEY ?? status.PUBLISHABLE_KEY, serviceKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
assertLocalStack({ apiUrl, anonKey, serviceRoleKey: serviceKey });
const admin = createClient(apiUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

// ── People (real Auth users) and entities (invented) ───────────────────────────────────────────────────────────────
const run = Date.now().toString(36);
const mk = (who) => ({ email: `${who}.${run}@e2e-local.test`, password: `E2e!${crypto.randomBytes(12).toString("base64url")}` });
const U = { owner: mk("dl-owner"), collaborator: mk("dl-collab"), bystander: mk("dl-bystander"), other: mk("dl-other") };
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
await grantPlan(U.owner.id); await grantPlan(U.other.id);
const signIn = async (u) => {
  const c = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await c.auth.signInWithPassword({ email: u.email, password: u.password });
  if (error) throw new Error(`api sign-in failed: ${error.message}`);
  return { c, token: data.session.access_token };
};
const owner = await signIn(U.owner), collaborator = await signIn(U.collaborator), bystander = await signIn(U.bystander), other = await signIn(U.other);
const newCompany = async (u, name) => {
  const { data, error } = await admin.from("companies").insert({ user_id: u.id, name }).select("id").single();
  if (error) throw new Error(`company: ${error.message}`);
  return data.id;
};
const A = await newCompany(U.owner, "Invented Download Trading Ltd");
const B = await newCompany(U.other, "Invented Other Holdings Ltd");

// ── The application's own upload sequence (src/lib/workspace/sourceUpload.ts), as a signed-in person ────────────────
const csv = (tag) => Buffer.from(`Account code,Account name,Debit,Credit\n10457,Invented bank ${tag},1500.00,\n30111,Invented share capital ${tag},,1500.00\n`);
const callFn = async (who, name, body, headers = {}) => {
  const res = await fetch(`${apiUrl}/functions/v1/${name}`, { method: "POST", headers: { Authorization: `Bearer ${who?.token ?? anonKey}`, apikey: anonKey, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, body: json };
};
async function uploadAs(who, companyId, bytes, year, fileName) {
  const r = await who.c.rpc("reserve_trial_balance_source", { p_company_id: companyId, p_file_name: fileName });
  const reserved = r.data?.[0];
  if (r.error || reserved?.outcome !== "reserved") throw new Error(`reserve: ${r.error?.message ?? reserved?.outcome}`);
  const signed = await callFn(who, "trial-balance-source-signer", { reservation_id: reserved.reservation_id });
  if (signed.body?.outcome !== "signed") throw new Error(`sign: ${JSON.stringify(signed)}`);
  const up = await who.c.storage.from(BUCKET).uploadToSignedUrl(signed.body.path, signed.body.token, new Blob([bytes], { type: "text/csv" }));
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  const reg = await who.c.rpc("register_trial_balance_upload", { p_reservation_id: reserved.reservation_id, p_file_size: bytes.length, p_period_year: year, p_period_id: null, p_engagement_id: null });
  const row = reg.data?.[0];
  if (reg.error || !["registered", "already_registered"].includes(row?.outcome)) throw new Error(`register: ${reg.error?.message ?? JSON.stringify(row)}`);
  return { uploadId: row.upload_id, path: signed.body.path };
}
const dbRow = async (id) => (await admin.from("trial_balance_uploads").select("id,company_id,file_path,file_name,source_file_hash,file_size").eq("id", id).single()).data;
const download = (who, uploadId, companyId, extra = {}) => callFn(who, "trial-balance-source-download", { upload_id: uploadId, company_id: companyId, ...extra });
// The function signs against its OWN view of the project URL (inside the local stack's containers: http://kong:8000), which the browser and this
// script cannot reach. The client (src/lib/workspace/sourceDownload.ts rebaseSignedUrl) therefore fetches the same signed path and token
// from the API origin it is configured with; this does exactly that. The signed path and token are untouched.
const rebase = (u) => { const x = new URL(u); return `${new URL(apiUrl).origin}${x.pathname}${x.search}`; };
const fetchUrl = async (url) => { const res = await fetch(rebase(url)); return { status: res.status, bytes: res.status === 200 ? Buffer.from(await res.arrayBuffer()) : null, disposition: res.headers.get("content-disposition") }; };
const jwtExp = (url) => { try { const t = new URL(url).searchParams.get("token"); const p = JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()); return { exp: p.exp, iat: p.iat }; } catch { return null; } };

const BYTES_A = csv("A"), BYTES_B = csv("B"), BYTES_GONE = csv("gone");
const FILE_A = "Invented TB FY2026.csv";
let UA, UB, UGONE;

startGroup("Set-up through the application's own upload sequence (real Auth, private Storage, signer function)");
await check("the owner of each company uploads a file through reserve → signer → signed upload → register; the object is in the private bucket", async () => {
  UA = await uploadAs(owner, A, BYTES_A, 2026, FILE_A);
  UB = await uploadAs(other, B, BYTES_B, 2026, "Invented Other TB.csv");
  UGONE = await uploadAs(owner, A, BYTES_GONE, 2027, "Invented TB FY2027.csv");
  const bucket = await admin.storage.getBucket(BUCKET);
  const stored = await admin.storage.from(BUCKET).download(UA.path);
  const bytes = stored.data ? Buffer.from(await stored.data.arrayBuffer()) : null;
  return bucket.data?.public === false && UA.path.startsWith(`workspaces/${A}/`) && bytes && sha(bytes) === sha(BYTES_A) ? true : { public: bucket.data?.public, path: UA.path };
});
await check("the first check of the file records the server's SHA-256 fingerprint (process-trial-balance) - needed to test integrity against the server's own record", async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt === 1) {
      const op = uuid();
      const r = await owner.c.rpc("tbu_request_reprocess", { p_upload_id: UA.uploadId, p_operation_id: op, p_expected_source_hash: null });
      if (r.error) log(`        reprocess request: ${r.error.message}`);
      await callFn(owner, "process-trial-balance", { uploadId: UA.uploadId, clientRequestId: op });
    } else {
      await callFn(owner, "process-trial-balance", { uploadId: UA.uploadId, clientRequestId: uuid() });
    }
    for (let i = 0; i < 45; i++) {
      const row = await dbRow(UA.uploadId);
      if (row?.source_file_hash) return row.source_file_hash === sha(BYTES_A) ? true : { recorded: row.source_file_hash, expected: sha(BYTES_A) };
      await sleep(2000);
    }
  }
  return "no fingerprint was recorded (the checks below that compare against it are reported against the uploaded bytes instead)";
});

startGroup("Authorized retrieval: exact upload, byte integrity, short expiry");
let ownerAnswer = null;
await check("the owner is served: a signed URL for exactly this object, the original file name, the recorded fingerprint, and an expiry of a minute or less", async () => {
  ownerAnswer = await download(owner, UA.uploadId, A);
  const b = ownerAnswer.body, exp = jwtExp(b?.url ?? "");
  const row = await dbRow(UA.uploadId);
  return ownerAnswer.status === 200 && b.outcome === "ready" && b.file_name === FILE_A && b.expires_in <= 120 && b.size === BYTES_A.length
    && (b.sha256 ?? null) === (row.source_file_hash ?? null) && exp && exp.exp - exp.iat <= 120 && exp.exp * 1000 > Date.now() ? true : { ownerAnswer: { ...ownerAnswer, body: { ...b, url: "…" } }, exp, recorded: row.source_file_hash };
});
await check("the decision record is an authorised ISSUANCE decision with the signer's own expiry (the real Storage token's exp), the signing interval, and no URL, token or path", async () => {
  // Real Storage signed this link: its token's exp is what the function recorded (source signer_token_exp), not decision time + 60 s. The record says the
  // function authorised and issued; it cannot say the bytes were transferred (that is the next check, made by this journey, not by the function).
  const { data, error } = await admin.from("trial_balance_source_download_events").select("*").eq("upload_id", UA.uploadId).eq("actor_user_id", U.owner.id).eq("outcome", "issued").order("occurred_at", { ascending: false }).limit(1);
  const e = data?.[0], exp = jwtExp(ownerAnswer.body?.url ?? "");
  const text = JSON.stringify(e ?? {});
  return !error && e && exp?.exp && e.link_expiry_source === "signer_token_exp" && Date.parse(e.link_expires_at) === exp.exp * 1000
    && Date.parse(e.signing_started_at) <= Date.parse(e.signing_completed_at) && Date.parse(e.link_expires_at) <= Date.parse(e.signing_completed_at) + 90_000
    && !/token|https?:|workspaces\//i.test(text) ? true : { error: error?.message, source: e?.link_expiry_source, expires: e?.link_expires_at, signed: [e?.signing_started_at, e?.signing_completed_at], tokenExp: exp ? new Date(exp.exp * 1000).toISOString() : null };
});
await check("the bytes fetched through the URL are the bytes that were uploaded, byte for byte (and match the server's recorded fingerprint when there is one)", async () => {
  const got = await fetchUrl(ownerAnswer.body.url);
  const row = await dbRow(UA.uploadId);
  return got.status === 200 && sha(got.bytes) === sha(BYTES_A) && got.bytes.equals(BYTES_A) && (!row.source_file_hash || sha(got.bytes) === row.source_file_hash)
    && /attachment/i.test(got.disposition ?? "") && (got.disposition ?? "").includes("Invented TB FY2026.csv") ? true : { status: got.status, disposition: got.disposition, intact: got.bytes && got.bytes.equals(BYTES_A) };
});
await check("a collaborator the OWNER granted manage_source_files (through the application's own RPC) is served the same bytes", async () => {
  const g = (await owner.c.rpc("grant_workspace_capability", { p_company_id: A, p_grantee_user_id: U.collaborator.id, p_capability: "manage_source_files" })).data?.[0];
  const r = await download(collaborator, UA.uploadId, A);
  const got = r.body?.url ? await fetchUrl(r.body.url) : null;
  return ["granted", "already_granted"].includes(g?.outcome) && r.status === 200 && got?.status === 200 && got.bytes.equals(BYTES_A) ? true : { g, r: r.status, outcome: r.body?.outcome };
});

startGroup("Refusals: no right, another company, injected fields, no session");
await check("a signed-in person with no right on the company is refused (403, no URL)", async () => {
  const r = await download(bystander, UA.uploadId, A);
  return r.status === 403 && r.body?.outcome === "forbidden" && !r.body?.url ? true : r;
});
await check("cross-company: another company's owner is refused for this upload whether they name this company or their own; this owner is refused for theirs", async () => {
  const names = await download(other, UA.uploadId, A), theirs = await download(other, UA.uploadId, B);
  const ownerForB = await download(owner, UB.uploadId, A), ownerForBNamed = await download(owner, UB.uploadId, B);
  const positive = await download(other, UB.uploadId, B);
  const refused = [names, theirs, ownerForB, ownerForBNamed].every((r) => r.status === 403 && r.body?.outcome === "forbidden" && !r.body?.url);
  const same = JSON.stringify(names.body) === JSON.stringify((await download(other, uuid(), A)).body);
  return refused && positive.status === 200 && same ? true : { names, theirs, ownerForB, ownerForBNamed, positive: positive.status, sameAsUnknown: same };
});
await check("a request that tries to name a path, bucket or user, or omits a field, is refused before anything is read (400)", async () => {
  const out = [];
  for (const extra of [{ path: UA.path }, { bucket: "avatars" }, { user_id: U.owner.id }]) out.push((await download(owner, UA.uploadId, A, extra)).status);
  out.push((await callFn(owner, "trial-balance-source-download", { upload_id: UA.uploadId })).status);
  out.push((await callFn(owner, "trial-balance-source-download", { upload_id: "not-a-uuid", company_id: A })).status);
  return out.every((s) => s === 400) ? true : out;
});
await check("no session: the anonymous key alone, and no Authorization header at all, are refused", async () => {
  const anon = await callFn(null, "trial-balance-source-download", { upload_id: UA.uploadId, company_id: A });
  const res = await fetch(`${apiUrl}/functions/v1/trial-balance-source-download`, { method: "POST", headers: { apikey: anonKey, "Content-Type": "application/json" }, body: JSON.stringify({ upload_id: UA.uploadId, company_id: A }) });
  return [401, 403].includes(anon.status) && !anon.body?.url && res.status >= 400 && res.status < 500 ? true : { anon: anon.status, bare: res.status };
});

startGroup("Direct bucket restrictions are preserved (nothing was widened to make retrieval work)");
await check("no session - owner, collaborator, bystander, other company, anon, public URL - can read the object or sign it directly; the bucket is private", async () => {
  const bucket = await admin.storage.getBucket(BUCKET);
  const direct = {};
  for (const [who, c] of Object.entries({ owner: owner.c, collaborator: collaborator.c, bystander: bystander.c, other: other.c })) {
    const dl = await c.storage.from(BUCKET).download(UA.path);
    const signed = await c.storage.from(BUCKET).createSignedUrl(UA.path, 60);
    const listed = await c.storage.from(BUCKET).list(`workspaces/${A}`);
    direct[who] = { download: !dl.error, signed: !signed.error && !!signed.data?.signedUrl, listed: (listed.data ?? []).length };
  }
  const pub = await fetch(`${apiUrl}/storage/v1/object/public/${BUCKET}/${UA.path}`);
  const anon = await fetch(`${apiUrl}/storage/v1/object/${BUCKET}/${UA.path}`, { headers: { apikey: anonKey } });
  const open = Object.entries(direct).filter(([, d]) => d.download || d.signed || d.listed > 0);
  return bucket.data?.public === false && open.length === 0 && pub.status !== 200 && anon.status !== 200 ? true : { public: bucket.data?.public, open, pub: pub.status, anon: anon.status };
});

startGroup("Revoked access and expiry");
let issuedBeforeRevocation = null;
await check("the owner revokes the collaborator; the very next request is refused, while the earlier history is untouched", async () => {
  issuedBeforeRevocation = (await download(collaborator, UA.uploadId, A)).body?.url ?? null;
  const rv = await owner.c.rpc("revoke_workspace_capability", { p_company_id: A, p_grantee_user_id: U.collaborator.id, p_capability: "manage_source_files" });
  const after = await download(collaborator, UA.uploadId, A);
  const ownerStill = await download(owner, UA.uploadId, A);
  const row = await dbRow(UA.uploadId);
  return !rv.error && issuedBeforeRevocation && after.status === 403 && after.body?.outcome === "forbidden" && !after.body?.url && ownerStill.status === 200 && row.file_path === UA.path ? true : { rv: rv.error?.message, after: after.status, ownerStill: ownerStill.status };
});
await check("RESIDUAL WINDOW (observed, not a pass criterion): a URL issued before the revocation still works until it expires", async () => {
  const got = await fetchUrl(issuedBeforeRevocation);
  gaps.push({ id: "DOWNLOAD-URL-OUTLIVES-REVOCATION-UNTIL-EXPIRY", observed: got.status === 200 ? "a URL issued before the revocation was still served within its 60 s window" : `the earlier URL was already refused (${got.status})`,
    note: "Authorization is re-checked on every request; an already-issued bearer URL cannot be recalled, so the residual access is bounded by the 60 s expiry." });
  return true;
});
await check("an object that is no longer in storage is reported as unavailable (404), not as a bad URL", async () => {
  const rm = await admin.storage.from(BUCKET).remove([UGONE.path]);
  const r = await download(owner, UGONE.uploadId, A);
  return !rm.error && r.status === 404 && r.body?.outcome === "unavailable" && !r.body?.url ? true : { rm: rm.error?.message, r };
});
await check("an issued URL stops working after its expiry (waited for, real clock)", async () => {
  const fresh = await download(owner, UA.uploadId, A);
  const exp = jwtExp(fresh.body.url);
  const early = await fetchUrl(fresh.body.url);
  const waitMs = Math.max(0, exp.exp * 1000 - Date.now()) + 4000;
  log(`        waiting ${Math.round(waitMs / 1000)} s for the URL to expire`);
  await sleep(waitMs);
  const late = await fetchUrl(fresh.body.url);
  return early.status === 200 && late.status !== 200 ? true : { early: early.status, late: late.status };
});

fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ results, gaps, boundaries: {
  real: ["GoTrue sign-in for every person", "PostgREST and RLS", "private Storage and its policies", "trial-balance-source-signer and trial-balance-source-download Edge Functions", "the owner's own grant/revoke RPCs", "a real URL fetch including expiry"],
  operatorActionsByServiceRole: ["create Auth users", "grant the owners a plan", "create the two companies", "remove one stored object", "read database rows to compare the recorded fingerprint"],
  notProven: ["invitations and membership acceptance through the UI", "rollout configuration through the UI", "lapsed-plan behaviour"] }, finishedAt: new Date().toISOString() }, null, 2));
const failed = results.filter((r) => !r.ok);
log(`\nchecks: ${results.length}  passed: ${results.length - failed.length}  failed: ${failed.length}`);
log(failed.length || !results.length ? "SOURCE_DOWNLOAD_JOURNEY: FAILED" : "SOURCE_DOWNLOAD_JOURNEY: ALL PASSED");
setTimeout(() => process.exit(results.length && failed.length === 0 ? 0 : 1), 500);
