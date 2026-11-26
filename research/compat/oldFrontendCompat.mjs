#!/usr/bin/env node
// Compatibility evidence (NORMAL; evidence branch only, never merged): the SERVED frontend — main 00a2653, which the live
// bundle at cfoclose.com matches — built unchanged and driven against the PROPOSED backend (this checkout's migrations and
// Edge Functions on the local stack). It covers the interval between the hosted backend release and Publish.
//
//   normal   a balanced trial balance through the old upload path (reserve → signer → signed upload → register) and the
//            new process-trial-balance: processed by generation 6, certified; the OLD page renders it.
//   refused  a file one account over the limit: refused by name, nothing certified; what the OLD page shows is recorded.
//   busy     concurrent checks: a refusal is 503 PROCESSING_BUSY with Retry-After and begins nothing; what the OLD page
//            shows for that upload is recorded; the same request retried later is processed.
//
//   node research/compat/oldFrontendCompat.mjs <oldFrontendDir> <outDir>     (after `supabase start` from this checkout)
// Test credentials are generated for this run and never printed. Every request stays on loopback.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { Browser } from "../../scripts/browser-acceptance/cdp.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OLD = path.resolve(process.argv[2] ?? "/tmp/old-frontend");
const OUT = path.resolve(process.argv[3] ?? path.join(REPO, "compat-evidence"));
fs.mkdirSync(path.join(OUT, "screenshots"), { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const log = (s) => { console.log(s); fs.appendFileSync(path.join(OUT, "compat.log"), s + "\n"); };
async function check(name, fn) {
  let ok = false, detail = null;
  try { const r = await fn(); ok = r === true; if (!ok) detail = r; } catch (e) { detail = String(e?.stack ?? e).slice(0, 600); }
  results.push({ name, ok, detail });
  log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  — ${JSON.stringify(detail).slice(0, 500)}`}`);
}
const git = (cwd, ...a) => { try { return execFileSync("git", a, { cwd, encoding: "utf8" }).trim(); } catch { return null; } };

const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const apiUrl = status.API_URL, anonKey = status.ANON_KEY ?? status.PUBLISHABLE_KEY, serviceKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(apiUrl)) throw new Error("not a loopback stack");
const admin = createClient(apiUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const provenance = { backendCheckout: git(REPO, "rev-parse", "HEAD"), oldFrontend: git(OLD, "rev-parse", "HEAD"), oldFrontendTree: git(OLD, "rev-parse", "HEAD^{tree}") };
log(`backend (migrations + functions) from ${provenance.backendCheckout}; frontend built from ${provenance.oldFrontend}`);

// ── The OLD frontend, built unchanged from its own directory, pointed only at the local stack ───────────────────────────
const dist = fs.mkdtempSync(path.join(os.tmpdir(), "compat-old-dist-"));
const noEnv = fs.mkdtempSync(path.join(os.tmpdir(), "compat-no-env-"));
process.env.VITE_SUPABASE_URL = apiUrl; process.env.VITE_SUPABASE_PUBLISHABLE_KEY = anonKey; process.env.VITE_SUPABASE_PROJECT_ID = "local";
const vite = await import(pathToFileURL(path.join(OLD, "node_modules/vite/dist/node/index.js")).href);
await vite.build({ root: OLD, configFile: path.join(OLD, "vite.config.ts"), mode: "e2e", envDir: noEnv, logLevel: "error", build: { outDir: dist, emptyOutDir: true } });
const preview = await vite.preview({ root: OLD, configFile: path.join(OLD, "vite.config.ts"), envDir: noEnv, logLevel: "error", build: { outDir: dist }, preview: { port: 4176, strictPort: true, host: "127.0.0.1" } });
const APP = "http://127.0.0.1:4176";

// ── One owner with a plan (granted the way an operator records it), one company, dated TZS periods ─────────────────────
const run = Date.now().toString(36);
const U = { email: `compat-owner.${run}@compat-local.test`, password: `C0mpat!${crypto.randomBytes(12).toString("base64url")}` };
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
const C = (await admin.from("companies").insert({ user_id: U.id, name: "Invented Compatibility Ltd" }).select("id").single()).data.id;
const openYear = async (y) => {
  const { data, error } = await user.rpc("open_engagement_with_period", { p_company_id: C, p_period_start: `${y}-01-01`, p_period_end: `${y}-12-31`, p_reporting_currency: "TZS", p_capabilities: ["FINANCIAL_STATEMENTS"] });
  if (error || !data?.periodId) throw new Error(`period ${y}: ${error?.message ?? JSON.stringify(data)}`);
  return { year: y, periodId: data.periodId, engagementId: data.engagementId };
};
// The OLD frontend's own upload path (main src/lib/workspace/sourceUpload.ts), step for step.
const uploadOld = async (p, name, bytes) => {
  const { data: rs, error: re } = await user.rpc("reserve_trial_balance_source", { p_company_id: C, p_file_name: name });
  const r = Array.isArray(rs) ? rs[0] : rs; if (re || r?.outcome !== "reserved") throw new Error(`reserve: ${re?.message ?? JSON.stringify(rs)}`);
  const signed = await user.functions.invoke("trial-balance-source-signer", { body: { reservation_id: r.reservation_id } });
  if (signed.error || signed.data?.outcome !== "signed") throw new Error(`signer: ${JSON.stringify(signed.data ?? signed.error?.message)}`);
  const up = await user.storage.from("trial-balance-files").uploadToSignedUrl(signed.data.path, signed.data.token, new Blob([bytes], { type: "text/csv" }));
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  const { data: rg, error: ge } = await user.rpc("register_trial_balance_upload", { p_reservation_id: r.reservation_id, p_file_size: bytes.length, p_period_year: p.year, p_period_id: p.periodId, p_engagement_id: p.engagementId });
  const g = Array.isArray(rg) ? rg[0] : rg; if (ge || !g?.upload_id) throw new Error(`register: ${ge?.message ?? JSON.stringify(rg)}`);
  return g.upload_id;
};
const processOnce = async (uploadId, clientRequestId) => {
  const res = await fetch(`${apiUrl}/functions/v1/process-trial-balance`, { method: "POST", headers: { Authorization: `Bearer ${token}`, apikey: anonKey, "Content-Type": "application/json" }, body: JSON.stringify({ uploadId, clientRequestId }) });
  let body = null; try { body = await res.json(); } catch { /* none */ }
  return { http: res.status, code: body?.code ?? null, retryAfter: res.headers.get("retry-after"), body };
};
const facts = async (id) => {
  const u = (await admin.from("trial_balance_uploads").select("id,status,lifecycle_state,version,processing_attempt,current_engine_run_id,processing_result").eq("id", id).single()).data;
  const certs = (await admin.from("tb_certifications").select("id", { count: "exact", head: true }).eq("upload_id", id)).count;
  const run = u?.current_engine_run_id ? (await admin.from("engine_runs").select("status,engine_generation,error_code").eq("id", u.current_engine_run_id).maybeSingle()).data : null;
  return { u, certs, run };
};
const balanced = (n, tag) => {
  const rows = ["Account code,Account name,Debit,Credit"]; for (let i = 0; i < n - 1; i++) rows.push(`${100000 + i},Invented ${tag} account ${i},1.00,0.00`);
  rows.push(`999999,Invented ${tag} equity,0.00,${(n - 1).toFixed(2)}`); return Buffer.from(rows.join("\n") + "\n");
};

// ── The OLD page, as the owner sees it ────────────────────────────────────────────────────────────────────────────────
const browser = await Browser.launch({ headless: true });
const page = await (await browser.newContext()).newPage();
// Uncaught errors and rejections on every document, collected in the page itself (the driver has no event API).
await page.send("Page.addScriptToEvaluateOnNewDocument", { source: "window.__compatErrors=[];addEventListener('error',e=>window.__compatErrors.push(String(e.message)));addEventListener('unhandledrejection',e=>window.__compatErrors.push(String(e.reason&&e.reason.message||e.reason)));" });
await page.goto(`${APP}/auth`); await page.waitForText("Sign in to your CFOClose account", { timeout: 45000 });
await page.fill("#email", U.email); await page.fill("#password", U.password); await page.press("Enter");
await page.waitFor(() => !location.pathname.startsWith("/auth"), [], { label: "signed in", timeout: 30000 });
const oldView = async (y, shot) => {
  await page.goto(`${APP}/workspace/${C}/${y}/trial-balance/review`);
  await page.waitFor(() => /Trial balance/i.test(document.body.innerText), [], { label: "old trial-balance page", timeout: 45000 }).catch(() => {});
  await sleep(2500);
  const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ")).catch(() => "");
  await page.screenshot(path.join(OUT, "screenshots", `${shot}.png`)).catch(() => {});
  const errors = await page.evaluate(() => window.__compatErrors ?? []).catch(() => []);
  return { url: await page.url().catch(() => null), text: text.slice(0, 1500), uncaughtErrors: errors, crashed: /Something went wrong|Unexpected Application Error/i.test(text) };
};
const evidence = { provenance, normal: null, refused: null, busy: null };

log("\n== normal processing (old upload path, generation 6, old page)");
const pN = await openYear(2031);
const idN = await uploadOld(pN, "compat-normal.csv", balanced(3, "normal"));
const rN = await processOnce(idN, crypto.randomUUID());
const fN = await facts(idN);
const vN = await oldView(2031, "old-normal");
evidence.normal = { uploadId: idN, http: rN.http, status: fN.u?.status, lifecycle: fN.u?.lifecycle_state, certs: fN.certs, run: fN.run, page: vN };
await check("normal: the old upload path is accepted and processed by the new function (HTTP 200, generation 6, certified)", async () =>
  rN.http === 200 && fN.run?.engine_generation === 6 && fN.certs >= 1 && ["needs_review", "complete", "valid"].includes(fN.u?.status) ? true : evidence.normal);
await check("normal: the old page renders the result (file named, no crash)", async () => (!vN.crashed && /compat-normal\.csv/.test(vN.text) ? true : vN));

log("\n== refused file (one account over the limit)");
const pR = await openYear(2032);
const idR = await uploadOld(pR, "compat-over-limit.csv", balanced(2001, "over"));
const rR = await processOnce(idR, crypto.randomUUID());
const fR = await facts(idR);
const vR = await oldView(2032, "old-refused");
evidence.refused = { uploadId: idR, http: rR.http, codes: (fR.u?.processing_result?.ingestion?.issues ?? []).map((i) => i.code), status: fR.u?.status, lifecycle: fR.u?.lifecycle_state, certs: fR.certs, run: fR.run, page: vR };
await check("refused: refused by name (TOO_MANY_ACCOUNTS), nothing certified, no attempt left running", async () =>
  rR.http === 200 && evidence.refused.codes.includes("TOO_MANY_ACCOUNTS") && fR.certs === 0 && fR.run?.status !== "running" ? true : evidence.refused);
await check("refused: the old page renders without crashing (its wording is recorded as evidence)", async () => (!vR.crashed && /compat-over-limit\.csv/.test(vR.text) ? true : vR));

log("\n== busy (concurrent checks)");
const ids = [];
for (let k = 0; k < 4; k++) { const p = await openYear(2033 + k); ids.push({ id: await uploadOld(p, `compat-busy-${k}.csv`, balanced(2000, `busy${k}`)), year: p.year, req: crypto.randomUUID() }); }
const first = await Promise.all(ids.map((x) => processOnce(x.id, x.req)));
const busy = ids.map((x, k) => ({ ...x, r: first[k] })).filter((x) => x.r.http === 503 && x.r.code === "PROCESSING_BUSY");
const busyFacts = await Promise.all(busy.map((x) => facts(x.id)));
const vB = busy.length ? await oldView(busy[0].year, "old-busy-before-retry") : null;
const retried = [];
for (const x of busy) {
  let r = x.r, n = 0;
  while (r.http === 503 && r.code === "PROCESSING_BUSY" && n < 10) { n++; await sleep(1000 * Number(r.retryAfter ?? 3)); r = await processOnce(x.id, x.req); }
  retried.push({ id: x.id, http: r.http, tries: n, after: (await facts(x.id)).u?.status });
}
evidence.busy = { answers: first.map((r) => ({ http: r.http, code: r.code, retryAfter: r.retryAfter })), busyCount: busy.length,
  busyBeforeRetry: busyFacts.map((f) => ({ status: f.u?.status, lifecycle: f.u?.lifecycle_state, attempt: f.u?.processing_attempt, certs: f.certs })), page: vB, retried };
await check("busy: a concurrent check was refused as 503 PROCESSING_BUSY with Retry-After (never 546)", async () =>
  busy.length >= 1 && busy.every((x) => x.r.retryAfter) && first.every((r) => r.http !== 546) ? true : evidence.busy);
await check("busy: a busy refusal began nothing (no attempt, no certification)", async () =>
  busyFacts.every((f) => !f.u?.processing_attempt && f.certs === 0) ? true : evidence.busy.busyBeforeRetry);
await check("busy: the old page renders the untouched upload without crashing (its wording is recorded)", async () => (vB && !vB.crashed ? true : vB ?? "no busy upload to view"));
await check("busy: the same request retried after Retry-After is processed", async () =>
  retried.length >= 1 && retried.every((r) => r.http === 200 && r.after !== "pending") ? true : retried);

const summary = { total: results.length, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
fs.writeFileSync(path.join(OUT, "compat-results.json"), JSON.stringify({ summary, results, evidence }, null, 2));
log(`\nchecks: ${summary.total}   passed: ${summary.passed}   failed: ${summary.failed}`);
await browser.close().catch(() => {}); await new Promise((r) => preview.httpServer.close(r));
process.exit(summary.failed ? 1 : 0);
