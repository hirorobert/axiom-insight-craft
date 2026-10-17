#!/usr/bin/env node
// Evidence (NORMAL; evidence branch only, never merged): an OVERSIZED replacement through the candidate's own replace
// sequence (PrepareWorkspace → retireUpload: reserve → signer → signed upload → retire_trial_balance_upload, then the
// check), against this checkout's migrations and Edge Functions on the local stack. The browser's replace check validates
// only type and emptiness, so the file reaches storage and is swapped in before the server sees it. This establishes, on a
// certified prior trial balance:
//   - the server refuses it by name (FILE_TOO_LARGE) without resource exhaustion (HTTP 200, never 546; timed), at 12 MiB
//     and near the storage object ceiling (45 MiB; the local default object limit is 50 MiB);
//   - nothing is accepted from it (0 accounts, 0 certifications);
//   - the prior evidence is kept (row superseded, not deleted; its certification unchanged; its source object present);
//   - what the user can then do (removal eligibility of the refused replacement), and that a valid replacement recovers;
//   - the function keeps processing normally afterwards.
//   node research/compat/oversizedReplacement.mjs <outDir>     (after `supabase start` from this checkout)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.resolve(process.argv[2] ?? path.join(REPO, "compat-evidence/oversized"));
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const log = (s) => { console.log(s); fs.appendFileSync(path.join(OUT, "oversized.log"), s + "\n"); };
async function check(name, fn) {
  let ok = false, detail = null;
  try { const r = await fn(); ok = r === true; if (!ok) detail = r; } catch (e) { detail = String(e?.stack ?? e).slice(0, 600); }
  results.push({ name, ok, detail }); log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${JSON.stringify(detail).slice(0, 500)}`}`);
}
const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const apiUrl = status.API_URL, anonKey = status.ANON_KEY ?? status.PUBLISHABLE_KEY, serviceKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiUrl)) throw new Error("not a loopback stack");
const admin = createClient(apiUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

const run = Date.now().toString(36);
const U = { email: `oversize-owner.${run}@compat-local.test`, password: `0ver!${crypto.randomBytes(12).toString("base64url")}` };
{ const { data, error } = await admin.auth.admin.createUser({ email: U.email, password: U.password, email_confirm: true }); if (error) throw error; U.id = data.user.id; }
{
  const prod = (await admin.from("commercial_products").select("id").eq("code", "CFOCLOSE").single()).data;
  const plan = (await admin.from("commercial_plans").select("id").eq("product_id", prod.id).eq("code", "PRACTICE").single()).data;
  const bc = await admin.from("billing_customers").insert({ owner_user_id: U.id, product_id: prod.id }).select("id").single(); if (bc.error) throw bc.error;
  const lic = await admin.from("commercial_licences").insert({ billing_customer_id: bc.data.id, plan_id: plan.id, status: "ACTIVE", source: "ADMIN_GRANT", effective_start: new Date(Date.now() - 86400000).toISOString(), additional_seats: 4 });
  if (lic.error) throw lic.error;
}
const user = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const token = (await user.auth.signInWithPassword({ email: U.email, password: U.password })).data.session.access_token;
const C = (await admin.from("companies").insert({ user_id: U.id, name: "Invented Oversize Ltd" }).select("id").single()).data.id;
const { data: per, error: perr } = await user.rpc("open_engagement_with_period", { p_company_id: C, p_period_start: "2040-01-01", p_period_end: "2040-12-31", p_reporting_currency: "TZS", p_capabilities: ["FINANCIAL_STATEMENTS"] });
if (perr) throw perr;

// The candidate's uploadWorkspaceSource (src/lib/workspace/sourceUpload.ts), step for step.
const storeSource = async (name, bytes) => {
  const { data: rs, error: re } = await user.rpc("reserve_trial_balance_source", { p_company_id: C, p_file_name: name });
  const r = Array.isArray(rs) ? rs[0] : rs; if (re || r?.outcome !== "reserved") throw new Error(`reserve: ${re?.message ?? JSON.stringify(rs)}`);
  const signed = await user.functions.invoke("trial-balance-source-signer", { body: { reservation_id: r.reservation_id } });
  if (signed.error || signed.data?.outcome !== "signed") throw new Error(`signer: ${JSON.stringify(signed.data ?? signed.error?.message)}`);
  const t0 = Date.now();
  const up = await user.storage.from("trial-balance-files").uploadToSignedUrl(signed.data.path, signed.data.token, new Blob([bytes], { type: "text/csv" }));
  return { reservationId: r.reservation_id, path: signed.data.path, uploadError: up.error?.message ?? null, uploadMs: Date.now() - t0 };
};
const processOnce = async (uploadId) => {
  const t0 = Date.now();
  const res = await fetch(`${apiUrl}/functions/v1/process-trial-balance`, { method: "POST", headers: { Authorization: `Bearer ${token}`, apikey: anonKey, "Content-Type": "application/json" }, body: JSON.stringify({ uploadId, clientRequestId: crypto.randomUUID() }) });
  let body = null; try { body = await res.json(); } catch { /* none */ }
  return { http: res.status, ms: Date.now() - t0, body };
};
const row = async (id) => (await admin.from("trial_balance_uploads").select("id,status,lifecycle_state,version,superseded_by_upload_id,file_path,processing_result").eq("id", id).single()).data;
const certsOf = async (id) => (await admin.from("tb_certifications").select("id,output_hash,is_blocking,sequence_no").eq("upload_id", id).order("sequence_no")).data ?? [];
const objectPresent = async (p) => { const { data, error } = await admin.storage.from("trial-balance-files").download(p); return !error && !!data; };
const balanced = (n) => { const rows = ["Account code,Account name,Debit,Credit"]; for (let i = 0; i < n - 1; i++) rows.push(`${100000 + i},Invented account ${i},1.00,0.00`); rows.push(`999999,Invented equity,0.00,${(n - 1).toFixed(2)}`); return Buffer.from(rows.join("\n") + "\n"); };
// A well-formed CSV padded to `bytes` with invented rows (it is refused by size before any reader runs).
const oversized = (bytes) => { const line = "100001,Invented padding account with a long descriptive name for size,1.00,0.00\n"; const head = "Account code,Account name,Debit,Credit\n"; return Buffer.from(head + line.repeat(Math.ceil((bytes - head.length) / line.length))); };
const replace = async (current, name, bytes) => {
  const s = await storeSource(name, bytes);
  if (s.uploadError) return { stored: false, ...s };
  const { data: rr, error } = await user.rpc("retire_trial_balance_upload", { p_old_upload_id: current.id, p_expected_version: current.version, p_reservation_id: s.reservationId, p_new_file_size: bytes.length, p_reason: "Replaced via Prepare Data" });
  const r = Array.isArray(rr) ? rr[0] : rr;
  return { stored: true, ...s, retire: error ? { error: error.message } : r, newId: r?.new_upload_id ?? null };
};

// ── A certified prior trial balance ──────────────────────────────────────────────────────────────────────────────────
const s0 = await storeSource("prior-valid.csv", balanced(3));
const { data: rg } = await user.rpc("register_trial_balance_upload", { p_reservation_id: s0.reservationId, p_file_size: balanced(3).length, p_period_year: 2040, p_period_id: per.periodId, p_engagement_id: per.engagementId });
const U0 = (Array.isArray(rg) ? rg[0] : rg).upload_id;
const p0 = await processOnce(U0);
const prior = { row: await row(U0), certs: await certsOf(U0) };
await check("baseline: the prior trial balance is processed and certified", async () => (p0.http === 200 && prior.certs.length >= 1 ? true : { p0: p0.http, certs: prior.certs.length }));

const evidence = { prior: { id: U0, certs: prior.certs }, cases: [] };
let current = prior.row;
for (const size of [12 * 1_048_576, 45 * 1_048_576]) {
  log(`\n== oversized replacement, ${Math.round(size / 1_048_576)} MiB`);
  const bytes = oversized(size);
  const beforeCerts = await certsOf(current.id);
  const rp = await replace(current, `oversized-${Math.round(size / 1_048_576)}mb.csv`, bytes);
  const c = { sizeBytes: bytes.length, stored: rp.stored, uploadMs: rp.uploadMs, uploadError: rp.uploadError, retire: rp.retire };
  if (!rp.stored || !rp.newId) {
    c.note = "storage or the swap refused the file before any check (nothing was replaced)";
    const still = await row(current.id);
    await check(`${Math.round(size / 1_048_576)} MiB: refused before the swap; the current trial balance is untouched`, async () => (still.lifecycle_state !== "superseded" ? true : still));
    evidence.cases.push(c); continue;
  }
  const pr = await processOnce(rp.newId);
  const nu = await row(rp.newId), ncerts = await certsOf(rp.newId);
  const oldRow = await row(current.id), oldCerts = await certsOf(current.id);
  const codes = (nu.processing_result?.ingestion?.issues ?? []).map((i) => i.code);
  const elig = (await user.rpc("get_trial_balance_removal_eligibility", { p_upload_id: rp.newId })).data;
  Object.assign(c, { newId: rp.newId, checkHttp: pr.http, checkMs: pr.ms, codes, newStatus: nu.status, newLifecycle: nu.lifecycle_state, newCerts: ncerts.length,
    accounts: nu.processing_result?.summary?.total_accounts ?? null, prior: { lifecycle: oldRow.lifecycle_state, supersededBy: oldRow.superseded_by_upload_id, certs: oldCerts.map((x) => x.id), objectPresent: await objectPresent(oldRow.file_path) },
    removalEligibility: elig });
  evidence.cases.push(c);
  const mb = Math.round(size / 1_048_576);
  await check(`${mb} MiB: refused by name (FILE_TOO_LARGE), HTTP 200, never 546`, async () => (pr.http === 200 && codes.includes("FILE_TOO_LARGE") ? true : c));
  await check(`${mb} MiB: nothing accepted (0 accounts, no certification)`, async () => (c.accounts === 0 && ncerts.length === 0 ? true : c));
  await check(`${mb} MiB: the prior evidence is kept (superseded, certification unchanged, source object present)`, async () =>
    oldRow.lifecycle_state === "superseded" && oldRow.superseded_by_upload_id === rp.newId && JSON.stringify(oldCerts.map((x) => [x.id, x.output_hash])) === JSON.stringify(beforeCerts.map((x) => [x.id, x.output_hash])) && c.prior.objectPresent ? true : c);
  current = nu;
}

log("\n== recovery: a valid replacement of the refused upload, then a normal check");
const rv = await replace(current, "recovery-valid.csv", balanced(5));
const pv = rv.newId ? await processOnce(rv.newId) : null;
const rec = rv.newId ? { row: await row(rv.newId), certs: await certsOf(rv.newId) } : null;
evidence.recovery = { retire: rv.retire, http: pv?.http ?? null, ms: pv?.ms ?? null, status: rec?.row.status ?? null, lifecycle: rec?.row.lifecycle_state ?? null, certs: rec?.certs.length ?? 0 };
await check("recovery: a valid replacement is swapped in, processed and certified", async () => (pv?.http === 200 && rec?.certs.length >= 1 ? true : evidence.recovery));
await check("the original prior certification still exists unchanged after everything", async () => {
  const now = await certsOf(U0); return JSON.stringify(now.map((x) => [x.id, x.output_hash])) === JSON.stringify(prior.certs.map((x) => [x.id, x.output_hash])) ? true : now;
});

const summary = { total: results.length, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
fs.writeFileSync(path.join(OUT, "oversized-results.json"), JSON.stringify({ summary, results, evidence }, null, 2));
log(`\nchecks: ${summary.total}   passed: ${summary.passed}   failed: ${summary.failed}`);
process.exit(summary.failed ? 1 : 0);
