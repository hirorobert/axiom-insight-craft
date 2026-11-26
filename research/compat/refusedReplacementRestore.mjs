#!/usr/bin/env node
// Evidence (NORMAL; evidence branch only, never merged): the refused-replacement restore (20261109100000) on the local
// stack with this checkout's migrations and Edge Functions. Each refused replacement goes through the user's own replace
// sequence (reserve → signer → signed upload → retire_trial_balance_upload → the check), is refused BY NAME by the real
// process-trial-balance, and is then restored through the user's own RPC (cancel_trial_balance_replacement). It covers a
// size refusal at 12 MiB and near the storage object ceiling (45 MiB), an account-limit refusal and an unreadable file:
//   - the refusal: HTTP 200 (never 546), the exact code, zero accounts, no certification;
//   - eligibility 'restore_previous' for exactly that upload; restore 'restored';
//   - the exact predecessor is the period's only active upload again, its certifications byte-identical;
//   - the refused upload is kept (retired) with its result and its stored object;
//   - a stale version is refused, a repeat answers already_restored, another user is forbidden; nothing changes.
//   node research/compat/refusedReplacementRestore.mjs <outDir>     (after `supabase start`; functions served)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.resolve(process.argv[2] ?? path.join(REPO, "compat-evidence/refused-restore"));
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const log = (s) => { console.log(s); fs.appendFileSync(path.join(OUT, "refused-restore.log"), s + "\n"); };
async function check(name, fn) {
  let ok = false, detail = null;
  try { const r = await fn(); ok = r === true; if (!ok) detail = r; } catch (e) { detail = String(e?.stack ?? e).slice(0, 600); }
  results.push({ name, ok, detail }); log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${JSON.stringify(detail).slice(0, 600)}`}`);
}
const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const apiUrl = status.API_URL, anonKey = status.ANON_KEY ?? status.PUBLISHABLE_KEY, serviceKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiUrl)) throw new Error("not a loopback stack");
const admin = createClient(apiUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

const run = Date.now().toString(36);
async function mkUser(tag) {
  const u = { email: `${tag}.${run}@compat-local.test`, password: `R3st!${crypto.randomBytes(12).toString("base64url")}` };
  const { data, error } = await admin.auth.admin.createUser({ email: u.email, password: u.password, email_confirm: true }); if (error) throw error; u.id = data.user.id;
  const prod = (await admin.from("commercial_products").select("id").eq("code", "CFOCLOSE").single()).data;
  const plan = (await admin.from("commercial_plans").select("id").eq("product_id", prod.id).eq("code", "PRACTICE").single()).data;
  const bc = await admin.from("billing_customers").insert({ owner_user_id: u.id, product_id: prod.id }).select("id").single(); if (bc.error) throw bc.error;
  const lic = await admin.from("commercial_licences").insert({ billing_customer_id: bc.data.id, plan_id: plan.id, status: "ACTIVE", source: "ADMIN_GRANT", effective_start: new Date(Date.now() - 86400000).toISOString(), additional_seats: 4 });
  if (lic.error) throw lic.error;
  u.c = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  u.token = (await u.c.auth.signInWithPassword({ email: u.email, password: u.password })).data.session.access_token;
  return u;
}
const owner = await mkUser("restore-owner"), outsider = await mkUser("restore-outsider");
const C = (await admin.from("companies").insert({ user_id: owner.id, name: "Invented Restore Ltd" }).select("id").single()).data.id;
const { data: per, error: perr } = await owner.c.rpc("open_engagement_with_period", { p_company_id: C, p_period_start: "2041-01-01", p_period_end: "2041-12-31", p_reporting_currency: "TZS", p_capabilities: ["FINANCIAL_STATEMENTS"] });
if (perr) throw perr;

const storeSource = async (name, bytes) => {
  const { data: rs, error: re } = await owner.c.rpc("reserve_trial_balance_source", { p_company_id: C, p_file_name: name });
  const r = Array.isArray(rs) ? rs[0] : rs; if (re || r?.outcome !== "reserved") throw new Error(`reserve: ${re?.message ?? JSON.stringify(rs)}`);
  const signed = await owner.c.functions.invoke("trial-balance-source-signer", { body: { reservation_id: r.reservation_id } });
  if (signed.error || signed.data?.outcome !== "signed") throw new Error(`signer: ${JSON.stringify(signed.data ?? signed.error?.message)}`);
  const up = await owner.c.storage.from("trial-balance-files").uploadToSignedUrl(signed.data.path, signed.data.token, new Blob([bytes], { type: "text/csv" }));
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  return { reservationId: r.reservation_id, path: signed.data.path };
};
const processOnce = async (uploadId) => {
  const t0 = Date.now();
  const res = await fetch(`${apiUrl}/functions/v1/process-trial-balance`, { method: "POST", headers: { Authorization: `Bearer ${owner.token}`, apikey: anonKey, "Content-Type": "application/json" }, body: JSON.stringify({ uploadId, clientRequestId: crypto.randomUUID() }) });
  try { await res.json(); } catch { /* none */ }
  return { http: res.status, ms: Date.now() - t0 };
};
const row = async (id) => (await admin.from("trial_balance_uploads").select("id,status,lifecycle_state,version,superseded_by_upload_id,replaces_upload_id,retired_reason,file_path,processing_result").eq("id", id).single()).data;
const certs = async (id) => JSON.stringify((await admin.from("tb_certifications").select("id,sequence_no,normalized_input_hash,is_blocking,requires_review,certified_at").eq("upload_id", id).order("sequence_no")).data ?? []);
const active = async () => ((await admin.from("trial_balance_uploads").select("id").eq("company_id", C).eq("period_year", 2041).in("lifecycle_state", ["active_unprocessed", "active_processing", "active_processed", "blocked"])).data ?? []).map((r) => r.id);
const objectPresent = async (p) => { const { data, error } = await admin.storage.from("trial-balance-files").download(p); return !error && !!data; };
const eligibility = async (u, id) => (await u.c.rpc("get_trial_balance_removal_eligibility", { p_upload_id: id })).data;
const restore = async (u, id, v) => { const { data } = await u.c.rpc("cancel_trial_balance_replacement", { p_replacement_upload_id: id, p_expected_version: v }); return Array.isArray(data) ? data[0] : data; };
const balanced = (n, tag) => { const rows = ["Account code,Account name,Debit,Credit"]; for (let i = 0; i < n - 1; i++) rows.push(`${100000 + i},Invented ${tag} account ${i},1.00,0.00`); rows.push(`999999,Invented ${tag} equity,0.00,${(n - 1).toFixed(2)}`); return Buffer.from(rows.join("\n") + "\n"); };
const oversized = (bytes) => { const line = "100001,Invented padding account with a long descriptive name for size,1.00,0.00\n"; const head = "Account code,Account name,Debit,Credit\n"; return Buffer.from(head + line.repeat(Math.ceil((bytes - head.length) / line.length))); };

// A certified predecessor.
const s0 = await storeSource("prior-valid.csv", balanced(3, "prior"));
const { data: rg } = await owner.c.rpc("register_trial_balance_upload", { p_reservation_id: s0.reservationId, p_file_size: balanced(3, "prior").length, p_period_year: 2041, p_period_id: per.periodId, p_engagement_id: per.engagementId });
const PRIOR = (Array.isArray(rg) ? rg[0] : rg).upload_id;
await processOnce(PRIOR);
const priorCerts = await certs(PRIOR);
await check("baseline: the predecessor is processed and certified", async () => (JSON.parse(priorCerts).length >= 1 ? true : priorCerts));

const evidence = { prior: PRIOR, cases: [] };
const cases = [
  ["FILE_TOO_LARGE", "oversized-12mb.csv", oversized(12 * 1_048_576)],
  ["FILE_TOO_LARGE", "oversized-45mb.csv", oversized(45 * 1_048_576)],
  ["TOO_MANY_ACCOUNTS", "over-account-limit.csv", balanced(2001, "over")],
  [null, "no-amount-columns.csv", Buffer.from("Account code,Account name\n1000,Cash at bank\n3000,Share capital\n")],
];
for (const [code, name, bytes] of cases) {
  log(`\n== refused replacement: ${name} (${Math.round(bytes.length / 1024)} KiB)`);
  const cur = await row(PRIOR);
  const s = await storeSource(name, bytes);
  const { data: rr } = await owner.c.rpc("retire_trial_balance_upload", { p_old_upload_id: PRIOR, p_expected_version: cur.version, p_reservation_id: s.reservationId, p_new_file_size: bytes.length, p_reason: "Replaced via Prepare Data" });
  const REP = (Array.isArray(rr) ? rr[0] : rr)?.new_upload_id;
  const pr = await processOnce(REP);
  const refused = await row(REP);
  const codes = (refused.processing_result?.ingestion?.issues ?? []).filter((i) => i.severity === "blocking").map((i) => i.code);
  const e = await eligibility(owner, REP);
  const stale = await restore(owner, REP, refused.version - 1);
  const denied = await restore(outsider, REP, refused.version);
  const r = await restore(owner, REP, refused.version);
  const again = await restore(owner, REP, refused.version);
  const prior = await row(PRIOR), after = await row(REP);
  const c = { name, bytes: bytes.length, checkHttp: pr.http, checkMs: pr.ms, codes, accounts: refused.processing_result?.summary?.total_accounts ?? null,
    eligibility: e?.outcome, restoresUploadId: e?.restores_upload_id, stale: stale?.outcome, denied: denied?.outcome, restore: r?.outcome, again: again?.outcome,
    priorState: prior.lifecycle_state, priorCertsUnchanged: (await certs(PRIOR)) === priorCerts, active: await active(),
    refusedKept: { lifecycle: after.lifecycle_state, retired_reason: after.retired_reason, codes: (after.processing_result?.ingestion?.issues ?? []).map((i) => i.code), object: await objectPresent(after.file_path) },
    refusedCerts: JSON.parse(await certs(REP)).length };
  evidence.cases.push(c);
  await check(`${name}: refused by name (${code ?? "an unreadable-file code"}), HTTP 200 (never 546), 0 accounts, no certification`, async () =>
    pr.http === 200 && (code ? codes.includes(code) : codes.length > 0) && c.accounts === 0 && c.refusedCerts === 0 ? true : c);
  await check(`${name}: eligibility offers restore_previous for this exact predecessor; a stale version is refused and another user is forbidden, changing nothing`, async () =>
    c.eligibility === "restore_previous" && c.restoresUploadId === PRIOR && c.stale === "stale_version" && c.denied === "forbidden" ? true : c);
  await check(`${name}: restore brings back the exact predecessor (the only active upload) with its certifications byte-identical; a repeat answers already_restored`, async () =>
    c.restore === "restored" && c.again === "already_restored" && ["active_processed", "blocked", "active_processing"].includes(c.priorState) && c.priorCertsUnchanged
      && JSON.stringify(c.active) === JSON.stringify([PRIOR]) ? true : c);
  await check(`${name}: the refused upload is kept, retired, with its recorded refusal and its stored object`, async () =>
    c.refusedKept.lifecycle === "retired" && /Refused replacement withdrawn/.test(c.refusedKept.retired_reason ?? "") && c.refusedKept.codes.length > 0 && c.refusedKept.object ? true : c.refusedKept);
}

const summary = { total: results.length, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
fs.writeFileSync(path.join(OUT, "refused-restore-results.json"), JSON.stringify({ summary, results, evidence }, null, 2));
log(`\nchecks: ${summary.total}   passed: ${summary.passed}   failed: ${summary.failed}`);
process.exit(summary.failed ? 1 : 0);
