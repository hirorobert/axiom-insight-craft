#!/usr/bin/env node
// The "account 95000" journey, in the REAL application on a LOCAL Supabase stack (`supabase start` in CI: real Auth,
// PostgREST, RLS, Storage and Edge Functions; the migrations in supabase/migrations applied by the CLI). The production
// build is served on loopback and driven in headless Chrome by real signed-in users. Invented data only.
//
// A cost-of-sales account was saved as Revenue (the suggestion a reviewer accepted, as on the hosted test company), so its
// debit balance sits on the wrong side of its class and Close Review raises A01 for it. The preparer:
//   finding      opens the A01 finding on Close Review › Findings; the finding offers "Review this account's classification"
//   account      lands on that account on the trial balance page of the same company and year (deep link, Back, reload)
//   refused      a save refused by the server (Prepare withdrawn meanwhile) says nothing was saved — and nothing was
//   unknown      a save whose answer is lost (the response is cut by the browser) says it could not be confirmed and keeps
//                the request; "Try again" sends the same request id — exactly ONE decision is recorded
//   recheck      the saved correction is applied through the confirmed new check; the findings are checked again; the
//                page says the finding is no longer raised; "Back to the finding" lands on the findings page saying so
//   preserved    the uploaded file (object bytes, path, source hash), every earlier decision and the earlier findings run
//                are unchanged; the new certification's class totals are the expected ones
//   access       a viewer sees the account read-only (no correction form); another account's user is refused the workspace
//                and sees none of its figures
//   widths       the account and findings pages at 1280 px and 375 px
//
//   node scripts/e2e/findingCorrectionJourney.mjs <evidence-dir>    (after `supabase start`; reads `supabase status -o json`)
//
// Test credentials are generated for this run and never printed. Every request must stay on loopback.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { Browser } from "../browser-acceptance/cdp.mjs";
import { layoutProblems } from "../browser-acceptance/checks.mjs";
import { assertLocalStack, verifyLocalBundle, tbCsv, TB, CURRENT, PERIODS, CODES } from "./localStackFixtures.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.resolve(process.argv[2] ?? path.join(REPO, "e2e-evidence/finding-correction"));
fs.mkdirSync(OUT, { recursive: true });
const BUCKET = "trial-balance-files";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const key = () => crypto.randomBytes(18).toString("base64url");
const results = [];
let group = "";
const log = (s) => { console.log(s); fs.appendFileSync(path.join(OUT, "journey.log"), s + "\n"); };
/** A GitHub annotation (readable through the checks API even where the run's logs and artifacts are not). */
const annotate = (level, title, msg) => { if (process.env.GITHUB_ACTIONS) console.log(`::${level} title=${title.replace(/[\r\n:,]/g, " ").slice(0, 120)}::${String(msg).replace(/%/g, "%25").replace(/\r/g, "").replace(/\n/g, "%0A").slice(0, 60000)}`); };
/** What each failed check saw: its detail, the address and the panel's visible text (one annotation at the end). */
const failures = [];
// A failure during setup (before the first check) is reported, never silent.
process.on("uncaughtException", (e) => { annotate("error", "finding-correction setup", e?.stack ?? e); log(`SETUP FAILURE: ${e?.stack ?? e}`); process.exit(1); });
process.on("unhandledRejection", (e) => { annotate("error", "finding-correction setup", e?.stack ?? e); log(`SETUP FAILURE: ${e?.stack ?? e}`); process.exit(1); });
const startGroup = (g) => { group = g; log(`\n== ${g}`); };
let page;
async function check(name, fn) {
  try {
    const r = await fn();
    const ok = r === true;
    results.push({ group, name, ok });
    log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        ${JSON.stringify(r)?.slice(0, 1500)}`}`);
    if (!ok) await failureEvidence(name, JSON.stringify(r)?.slice(0, 1500));
    return ok;
  } catch (e) {
    results.push({ group, name, ok: false });
    log(`  FAIL  ${name}\n        ${String(e?.stack ?? e).split("\n").slice(0, 3).join(" | ")}`);
    await failureEvidence(name, String(e?.stack ?? e).split("\n").slice(0, 2).join(" | "));
    return false;
  }
}
async function failureEvidence(name, detail = "") {
  if (!page) return;
  try {
    const where = await page.url();
    const panel = await page.evaluate(() => (document.querySelector('[data-testid="account-correction"]') ?? document.querySelector("main") ?? document.body)?.innerText?.slice(0, 700) ?? "");
    failures.push(`FAIL [${group}] ${name}\n  detail: ${detail}\n  at: ${where}\n  saw: ${panel.replace(/\s+/g, " ")}`);
  } catch { failures.push(`FAIL [${group}] ${name}\n  detail: ${detail}`); }
  const slug = name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
  try { await page.screenshot(path.join(OUT, `FAIL-${slug}.png`)); } catch { /* */ }
  try { fs.writeFileSync(path.join(OUT, `FAIL-${slug}.txt`), `${await page.url()}\n\n${await page.bodyText()}`); } catch { /* */ }
}

// ── The stack (never printed) ────────────────────────────────────────────────────────────────────────────────────────
const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const apiUrl = status.API_URL;
const anonKey = status.ANON_KEY ?? status.PUBLISHABLE_KEY;
const serviceKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
const { origin: apiOrigin } = assertLocalStack({ apiUrl, anonKey, serviceRoleKey: serviceKey });
const admin = createClient(apiUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

// ── The production build, pointed only at the local stack ────────────────────────────────────────────────────────────
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-e2e-correction-dist-"));
const emptyEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-no-env-"));
process.env.VITE_SUPABASE_URL = apiUrl;
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = anonKey;
process.env.VITE_SUPABASE_PROJECT_ID = "local";
const vite = await import("vite");
await vite.build({ root: REPO, configFile: path.join(REPO, "vite.config.ts"), mode: "e2e", envDir: emptyEnvDir, logLevel: "error", build: { outDir: distDir, emptyOutDir: true } });
const bundleProblems = verifyLocalBundle(walk(distDir).filter((f) => /\.(js|html|css)$/.test(f)).map((f) => fs.readFileSync(f, "utf8")), apiOrigin);
if (bundleProblems.length) throw new Error(`bundle verification failed: ${bundleProblems.join(", ")}`);
const preview = await vite.preview({ root: REPO, configFile: path.join(REPO, "vite.config.ts"), envDir: emptyEnvDir, logLevel: "error", build: { outDir: distDir }, preview: { port: 4175, strictPort: true, host: "127.0.0.1" } });
const APP = "http://127.0.0.1:4175";

// ── People (generated credentials) and the invented company ─────────────────────────────────────────────────────────
const run = Date.now().toString(36);
const mk = (who) => ({ email: `${who}.${run}@e2e-local.test`, password: `E2e!${crypto.randomBytes(12).toString("base64url")}` });
const U = { owner: mk("fc-owner"), preparer: mk("fc-preparer"), viewer: mk("fc-viewer"), stranger: mk("fc-stranger") };
for (const u of Object.values(U)) {
  const { data, error } = await admin.auth.admin.createUser({ email: u.email, password: u.password, email_confirm: true });
  if (error) throw new Error(`creating a test user failed: ${error.message}`);
  u.id = data.user.id;
}
{
  const prod = (await admin.from("commercial_products").select("id").eq("code", "CFOCLOSE").single()).data;
  const plan = (await admin.from("commercial_plans").select("id").eq("product_id", prod.id).eq("code", "PRACTICE").single()).data;
  const bc = await admin.from("billing_customers").insert({ owner_user_id: U.owner.id, product_id: prod.id }).select("id").single();
  if (bc.error) throw new Error(`billing customer: ${bc.error.message}`);
  const lic = await admin.from("commercial_licences").insert({ billing_customer_id: bc.data.id, plan_id: plan.id, status: "ACTIVE", source: "ADMIN_GRANT", effective_start: new Date(Date.now() - 86400000).toISOString(), additional_seats: 4 });
  if (lic.error) throw new Error(`licence: ${lic.error.message}`);
}
const apiAs = async (u) => {
  const c = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await c.auth.signInWithPassword({ email: u.email, password: u.password });
  if (error) throw new Error(`api sign-in failed: ${error.message}`);
  return { c, token: data.session.access_token };
};
const rpc = async (who, fn, args) => { const { data, error } = await who.c.rpc(fn, args); if (error) throw new Error(`${fn}: ${error.message}`); return data; };
const owner = await apiAs(U.owner), preparer = await apiAs(U.preparer);

const { data: company, error: companyError } = await admin.from("companies").insert({ user_id: U.owner.id, name: "Bahari Invented Traders Ltd", reporting_framework: "ifrs_for_smes" }).select("id").single();
if (companyError) throw new Error(`company: ${companyError.message}`);
const A = company.id;
for (const [who, role] of [["preparer", "preparer"], ["viewer", "viewer"]]) {
  const r = await admin.from("firm_members").insert({ company_id: A, user_id: U[who].id, role, accepted_at: new Date().toISOString() });
  if (r.error) throw new Error(`member ${role}: ${r.error.message}`);
}
{ const { error } = await admin.rpc("fs_set_company_rollout", { p_company_id: A, p_enabled: true, p_reason: "Finding correction journey (invented company)", p_operator_label: "e2e" }); if (error) throw new Error(`rollout: ${error.message}`); }

const Y = PERIODS.current.year;
const ACC = CODES.costOfSales; // the "95000" of this journey: Cost of sales
const FINDING = `A01:${ACC}`;
const base = `/workspace/${A}/${Y}`;
const accountUrl = `${base}/trial-balance/review?account=${encodeURIComponent(ACC)}&finding=${encodeURIComponent(FINDING)}`;

// ── The trial balance: draft → signed upload → commit → check; reviewed with Cost of sales accepted as Revenue ───────
const fnPost = async (who, fn, body) => {
  const res = await fetch(`${apiUrl}/functions/v1/${fn}`, { method: "POST", headers: { Authorization: `Bearer ${who.token}`, apikey: anonKey, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, body: json };
};
const settled = async (uploadId) => {
  for (let i = 0; i < 120; i++) {
    const { data } = await admin.from("trial_balance_uploads").select("id, status, processing_result").eq("id", uploadId).single();
    if (data && !["pending", "processing", "queued", "validating"].includes(data.status)) return data;
    await sleep(1500);
  }
  throw new Error("the check did not finish");
};
const certification = async (who) => { const { data } = await who.c.rpc("get_authoritative_certification", { p_company_id: A, p_period_year: Y }); return Array.isArray(data) ? data[0] ?? null : data ?? null; };

const period = await rpc(owner, "open_engagement_with_period", { p_company_id: A, p_period_start: PERIODS.current.start, p_period_end: PERIODS.current.end, p_reporting_currency: "TZS", p_capabilities: ["FINANCIAL_STATEMENTS"] });
if (!period?.periodId) throw new Error(`period: ${JSON.stringify(period)}`);
const bytes = Buffer.from(tbCsv(CURRENT), "utf8");
const draft = (await rpc(owner, "reserve_trial_balance_draft", { p_file_name: `bahari-FY${Y}.csv`, p_file_size: bytes.length, p_content_sha256: sha(bytes), p_idempotency_key: key() }))[0];
const signed = await fnPost(owner, "trial-balance-draft", { action: "sign", draft_id: draft.draft_id });
if (signed.body?.outcome !== "signed") throw new Error(`sign: ${JSON.stringify(signed.body)}`);
{ const up = await owner.c.storage.from(BUCKET).uploadToSignedUrl(signed.body.path, signed.body.token, new Blob([bytes], { type: "text/csv" })); if (up.error) throw new Error(`upload: ${up.error.message}`); }
const committed = await fnPost(owner, "trial-balance-draft", { action: "commit", draft_id: draft.draft_id, commit_key: key(), company_id: A, period_year: Y, period_id: period.periodId, engagement_id: period.engagementId, confirmation: { entity: "Bahari Invented Traders Ltd", period: "Year ended 30 June 2026", currency: "TZS" } });
if (committed.body?.outcome !== "committed") throw new Error(`commit: ${JSON.stringify(committed.body)}`);
const UPLOAD = committed.body.upload_id;
await fnPost(owner, "process-trial-balance", { uploadId: UPLOAD, clientRequestId: uuid() });
await settled(UPLOAD);
// The reviewed decisions: every account as the fixture classifies it, except Cost of sales, accepted as the machine's
// Revenue suggestion (the hosted test company's record: USER_ACCEPTED_SUGGESTION of a MACHINE_SUGGESTION).
const decisions = TB.map(([code, name, cls, st, nb]) => (code === ACC
  ? { account_code: code, account_name: name, proposal_type: "MACHINE_SUGGESTION", decision_action: "USER_ACCEPTED_SUGGESTION", statement: "income_statement", classification: "revenue", normal_balance: "credit" }
  : { account_code: code, account_name: name, proposal_type: "NONE", decision_action: "USER_MANUAL_CLASSIFICATION", statement: st, classification: cls, normal_balance: nb, is_cash_account: code === CODES.bank }));
await rpc(owner, "resolve_account_review_batch", { p_company_id: A, p_upload_id: UPLOAD, p_client_request_id: uuid(), p_decisions: decisions });
{
  const op = uuid();
  const { data: src } = await owner.c.from("trial_balance_uploads").select("source_file_hash").eq("id", UPLOAD).single();
  const accepted = await rpc(owner, "tbu_request_reprocess", { p_upload_id: UPLOAD, p_operation_id: op, p_expected_source_hash: src?.source_file_hash ?? null });
  if (!["accepted", "replayed"].includes(accepted?.outcome)) throw new Error(`re-check refused: ${JSON.stringify(accepted)}`);
  await fnPost(owner, "process-trial-balance", { uploadId: UPLOAD, clientRequestId: op });
  const row = await settled(UPLOAD);
  if (!(await certification(owner))) throw new Error(`not certified after review: ${row.status} ${JSON.stringify(row.processing_result ?? {}).slice(0, 400)}`);
}
const refresh = await rpc(preparer, "close_review_refresh_findings", { p_company_id: A, p_period_year: Y });
if (refresh?.outcome !== "generated") throw new Error(`findings: ${JSON.stringify(refresh)}`);
const FIRST_RUN = refresh.runId;

// What must not change (read with the service role: the record, not what a page shows).
const decisionRows = async () => (await admin.from("account_review_decisions").select("id, decision_action, new_value, sequence_no, created_at").eq("company_id", A).order("sequence_no")).data ?? [];
const uploadRow = async () => (await admin.from("trial_balance_uploads").select("file_path, source_file_hash, status").eq("id", UPLOAD).single()).data;
const objectHash = async (p) => { const { data, error } = await admin.storage.from(BUCKET).download(p); if (error) throw new Error(`download: ${error.message}`); return sha(Buffer.from(await data.arrayBuffer())); };
const BEFORE = { decisions: await decisionRows(), upload: await uploadRow() };
BEFORE.object = await objectHash(BEFORE.upload.file_path);
BEFORE.firstRun = (await admin.from("close_review_findings").select("finding_key, classification, debit_minor, credit_minor").eq("run_id", FIRST_RUN).order("finding_key")).data;
log(`setup: company ${A.slice(0, 8)}…, upload ${UPLOAD.slice(0, 8)}…, first findings run ${FIRST_RUN.slice(0, 8)}… with ${BEFORE.firstRun.length} finding(s): ${BEFORE.firstRun.map((f) => f.finding_key).join(", ")}`);

// ── Browser helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
const browser = await Browser.launch();
async function openPage() { const ctx = await browser.newContext(); const p = await ctx.newPage(); await p.setViewport(1280, 900); return p; }
const shot = (name) => page.screenshot(path.join(OUT, `${name}.png`));
const go = async (route, text, timeout = 45000) => { await page.goto(`${APP}${route}`); if (text) await page.waitForText(text, { timeout }); await sleep(400); };
async function signIn(u) {
  await go("/auth", "Sign in to your CFOClose account");
  await page.fill("#email", u.email);
  await page.fill("#password", u.password);
  await page.press("Enter");
  await page.waitFor(() => !location.pathname.startsWith("/auth"), [], { label: "left sign-in", timeout: 30000 });
}
const tText = (id) => page.evaluate((t) => document.querySelector(`[data-testid="${t}"]`)?.innerText ?? null, id);
/** Sets a React-controlled select / textarea found by its label, the way input events deliver it. */
const setByLabel = (label, value) => page.evaluate((lab, val) => {
  const l = [...document.querySelectorAll("label")].find((x) => x.textContent.trim().toLowerCase().startsWith(lab.toLowerCase()));
  const el = l && (l.control ?? document.getElementById(l.htmlFor));
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set;
  setter.call(el, val);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}, label, value);
async function widths(name) {
  const problems = {};
  for (const [w, h] of [[1280, 900], [375, 812]]) {
    await page.setViewport(w, h);
    await sleep(600);
    const p = await page.evaluate(layoutProblems);
    if (p.length) problems[w] = p;
    await shot(`${name}-${w}`);
  }
  await page.setViewport(1280, 900);
  return Object.keys(problems).length ? problems : true;
}
/** Lets the request reach the server, then cuts its response in the browser: the save happened; its answer is lost. */
async function cutResponses(urlPattern) {
  const cut = [];
  const handler = (msg) => {
    if (msg.sessionId !== page.sessionId || msg.method !== "Fetch.requestPaused") return;
    const { requestId, request } = msg.params;
    if (request.method === "POST") { cut.push(request.url); void page.send("Fetch.failRequest", { requestId, errorReason: "ConnectionReset" }); }
    else void page.send("Fetch.continueResponse", { requestId }).catch(() => page.send("Fetch.continueRequest", { requestId }));
  };
  page.browser.listeners.add(handler);
  await page.send("Fetch.enable", { patterns: [{ urlPattern, requestStage: "Response" }] });
  return { cut, stop: async () => { page.browser.listeners.delete(handler); await page.send("Fetch.disable"); } };
}

async function main() {
  page = await openPage();
  await signIn(U.preparer);

  startGroup("The finding offers its account");
  await check("Close Review › Findings: the A01 finding for Cost of sales opens; it offers 'Review this account's classification'; the address keeps the finding", async () => {
    await go(`${base}/close/findings`, "Findings");
    await page.waitForSelector(`[data-testid="finding-${FINDING}"]`, { timeout: 60000 });
    await page.click({ selector: `[data-testid="finding-${FINDING}"] button` });
    await page.waitForSelector('[data-testid="finding-correct-account"]');
    const url = await page.waitForUrl(/[?&]finding=A01%3A/);
    const w = await widths("01-finding-offers-account");
    return w === true && url.includes(encodeURIComponent(FINDING)) ? true : { w, url };
  });
  await check("the link opens that account on the trial balance page of the same company and year: code, name, exact balance, the class the check used and the saved class with its provenance", async () => {
    await page.click('[data-testid="finding-correct-account"]');
    await page.waitForSelector('[data-testid="correction-account"]', { timeout: 45000 });
    const url = await page.url();
    const acc = await tText("correction-account");
    const ok = url.startsWith(`${APP}${base}/trial-balance/review?`) && url.includes(`account=${ACC}`) && /Cost of sales/.test(acc) && /14,000\.00/.test(await tText("correction-balance"))
      && /Revenue/.test(await tText("correction-checked-class")) && /Revenue — Suggestion confirmed by /.test(await tText("correction-saved-class"));
    const w = await widths("02-account-from-finding");
    return ok && w === true ? true : { url, acc, w };
  });

  startGroup("Back, forward and reload keep the place");
  await check("Back returns to the same finding, opened; Forward returns to the account", async () => {
    await page.evaluate(() => history.back());
    await page.waitForSelector('[data-testid="finding-detail"]', { timeout: 30000 });
    const detail = await tText("finding-detail");
    const url = await page.url();
    await page.evaluate(() => history.forward());
    await page.waitForSelector('[data-testid="correction-account"]', { timeout: 30000 });
    return /Cost of sales/.test(detail) && url.includes(`finding=${encodeURIComponent(FINDING)}`) ? true : { detail, url };
  });
  await check("a reload (and the same address opened directly) shows the same account, with nothing chosen", async () => {
    await go(accountUrl, "");
    await page.waitForSelector('[data-testid="correction-form"]', { timeout: 45000 });
    const chosen = await page.evaluate(() => document.querySelector('[data-testid="correction-form"] select').value);
    const disabled = await page.evaluate(() => document.querySelector('[data-testid="correction-save"]').disabled);
    return chosen === "" && disabled ? true : { chosen, disabled };
  });
  await check("an altered address (the finding names another account) opens nothing", async () => {
    await go(`${base}/trial-balance/review?account=${CODES.sales}&finding=${encodeURIComponent(FINDING)}`, "");
    await page.waitForSelector('[data-testid="trial-balance-current-task"]', { timeout: 45000 });
    await sleep(800);
    return (await page.evaluate(() => !document.querySelector('[data-testid="account-correction"]'))) ? true : "panel shown";
  });

  startGroup("A refused save, and a save whose answer is lost");
  await check("refused: Prepare withdrawn after the page opened → 'Nothing was saved', and nothing was", async () => {
    await go(accountUrl, "");
    await page.waitForSelector('[data-testid="correction-form"]', { timeout: 45000 });
    await rpc(owner, "revoke_member_capability", { p_company_id: A, p_user: U.preparer.id, p_capability: "prepare_close", p_reason: "Journey: refused save" });
    let words = null;
    try {
      await setByLabel("Correct classification", "cost_of_goods_sold");
      await setByLabel("Reason for the correction", "Cost of goods sold, not revenue: debit balance from purchases");
      await page.click('[data-testid="correction-save"]');
      await page.waitForSelector('[data-testid="correction-refused"], [data-testid="correction-unknown"], [data-testid="correction-saved-not-checked"]', { timeout: 30000 });
      words = await tText("correction-refused") ?? `NOT REFUSED: ${await tText("account-correction")}`;
    } finally {
      // Restored whatever happened, so a failure here never cascades into the checks that follow.
      await rpc(owner, "grant_member_capability", { p_company_id: A, p_user: U.preparer.id, p_capability: "prepare_close", p_reason: "Journey: restored" });
    }
    const after = await decisionRows();
    return /Nothing was saved/.test(words) && after.length === BEFORE.decisions.length ? true : { words, decisions: after.length };
  });
  let unknownRequest = null;
  await check("unknown: the save reaches the server but its answer is cut → 'could not confirm', the choice is kept; the decision WAS recorded once", async () => {
    await go(accountUrl, "");
    await page.waitForSelector('[data-testid="correction-form"]', { timeout: 45000 });
    await setByLabel("Correct classification", "cost_of_goods_sold");
    await setByLabel("Reason for the correction", "Cost of goods sold, not revenue: debit balance from purchases");
    const cutter = await cutResponses("*resolve_account_review_batch*");
    await page.click('[data-testid="correction-save"]');
    await page.waitForSelector('[data-testid="correction-unknown"]', { timeout: 30000 });
    await cutter.stop();
    const words = await tText("correction-unknown");
    const kept = await page.evaluate(() => document.querySelector('[data-testid="correction-form"] select')?.value);
    const after = await decisionRows();
    unknownRequest = (await admin.from("account_review_batches").select("client_request_id").eq("company_id", A).order("created_at", { ascending: false }).limit(1).single()).data?.client_request_id ?? null;
    await shot("03-save-unknown");
    return cutter.cut.length >= 1 && /could not confirm/.test(words) && kept === "cost_of_goods_sold" && after.length === BEFORE.decisions.length + 1 ? true : { cut: cutter.cut.length, words, kept, decisions: after.length };
  });
  await check("'Try again' sends the SAME request id: the server replays it; still exactly one new decision; the page says saved, not yet checked", async () => {
    await page.click('[data-testid="correction-save"]');
    await page.waitForSelector('[data-testid="correction-saved-not-checked"]', { timeout: 30000 });
    const after = await decisionRows();
    const batches = (await admin.from("account_review_batches").select("client_request_id").eq("company_id", A).eq("client_request_id", unknownRequest)).data ?? [];
    const mapping = (await admin.from("account_mappings").select("classification, normal_balance, is_cash_account").eq("company_id", A).eq("account_key", ACC).single()).data;
    const newest = after[after.length - 1];
    return after.length === BEFORE.decisions.length + 1 && batches.length === 1 && mapping?.classification === "cost_of_goods_sold" && mapping?.normal_balance === "debit"
      && newest.decision_action === "USER_MANUAL_CLASSIFICATION" && newest.new_value?.reason === "Cost of goods sold, not revenue: debit balance from purchases"
      && String(newest.new_value?.source ?? "").startsWith("close_review_finding:A01:") ? true : { decisions: after.length, batches: batches.length, mapping, newest };
  });
  await check("a reload keeps 'saved, not yet checked' (from the server: the saved class differs from the class the check used)", async () => {
    await go(accountUrl, "");
    await page.waitForSelector('[data-testid="correction-saved-not-checked"]', { timeout: 45000 });
    const saved = await tText("correction-saved-class");
    const checked = await tText("correction-checked-class");
    const unknown = await page.evaluate(() => !!document.querySelector('[data-testid="correction-unknown"]'));
    const w = await widths("04-saved-not-checked");
    return /Cost of Goods Sold — Classification chosen by you/.test(saved) && /Revenue/.test(checked) && !unknown && w === true ? true : { saved, checked, unknown, w };
  });

  startGroup("Who may see and act");
  {
    const keep = page;
    page = await openPage();
    await signIn(U.viewer);
    await check("a viewer sees the account read-only: no correction form and no new check", async () => {
      await go(accountUrl, "");
      await page.waitForSelector('[data-testid="account-correction"]', { timeout: 45000 });
      await sleep(1500);
      const t = await tText("account-correction");
      const form = await page.evaluate(() => !!document.querySelector('[data-testid="correction-form"], [data-testid="correction-check-again"]'));
      return !form && /needs Prepare in this workspace/.test(t) ? true : { form, t: t?.slice(0, 400) };
    });
    page = await openPage();
    await signIn(U.stranger);
    await check("another account's user is refused the workspace and sees none of its figures", async () => {
      await go(accountUrl, "");
      await page.waitForSelector('[data-testid="workspace-access-denied"]', { timeout: 45000 });
      const body = await page.bodyText();
      return !/Cost of sales|14,000\.00|Bahari/.test(body) ? true : body.slice(0, 300);
    });
    page = keep;
  }

  startGroup("The confirmed new check, the findings checked again, and the return");
  await check("after the save there is no reviewed result (the server's stale-validation gate); 'Check the trial balance again' asks for confirmation (period and consequences); Cancel changes nothing on the server", async () => {
    const snap = async () => JSON.stringify({ cert: await certification(preparer), up: (await admin.from("trial_balance_uploads").select("status, processed_at, source_file_hash").eq("id", UPLOAD).single()).data,
      runs: ((await admin.from("close_review_finding_runs").select("id").eq("company_id", A)).data ?? []).length });
    const before = await snap();
    await go(accountUrl, "");
    await page.click('[data-testid="correction-check-again"]');
    await page.waitForSelector('[role="dialog"]');
    const d = await page.evaluate(() => document.querySelector('[role="dialog"]').innerText);
    await page.press("Escape");
    await sleep(800);
    const after = await snap();
    const noCertNow = !(await certification(preparer));
    return /FY2026/.test(d) && /earlier decisions and earlier findings stay in the record/.test(d) && before === after && noCertNow ? true : { d, before, after, noCertNow };
  });
  await check("confirmed: the trial balance is checked with the correction, the findings are checked again, and the page says the finding is no longer raised", async () => {
    await page.click('[data-testid="correction-check-again"]');
    await page.waitForSelector('[role="dialog"]');
    await page.click({ text: "Check again", within: '[role="dialog"]' });
    await page.waitForSelector('[data-testid="correction-result"]', { timeout: 240000 });
    const kind = await page.evaluate(() => document.querySelector('[data-testid="correction-result"]').dataset.result);
    const w = await widths("05-finding-no-longer-raised");
    return kind === "no_longer_raised" && w === true ? true : { kind, text: await tText("correction-result"), w };
  });
  await check("the server agrees: a new certification; the current findings run has no A01 for Cost of sales; the class totals are the expected ones", async () => {
    const cert = await certification(preparer);
    const s = await rpc(preparer, "close_review_findings_summary", { p_company_id: A, p_period_year: Y });
    const now = (await admin.from("close_review_findings").select("finding_key").eq("run_id", s.runId)).data ?? [];
    const row = (await admin.from("trial_balance_uploads").select("processing_result").eq("id", UPLOAD).single()).data;
    const is = row?.processing_result?.statements?.income_statement ?? {};
    return !!cert && s.state === "current" && s.runId !== FIRST_RUN && !now.some((f) => f.finding_key === FINDING)
      && is.revenue?.total === 30000 && is.cost_of_goods_sold?.total === 14000 ? true : { cert: !!cert, s, now, revenue: is.revenue?.total, cogs: is.cost_of_goods_sold?.total };
  });
  await check("preserved: the uploaded object's bytes, its path and source hash; every earlier decision unchanged; the earlier findings run still holds its finding", async () => {
    const up = await uploadRow();
    const obj = await objectHash(up.file_path);
    const after = await decisionRows();
    const unchanged = BEFORE.decisions.every((d, i) => after[i]?.id === d.id && JSON.stringify(after[i].new_value) === JSON.stringify(d.new_value));
    const firstRun = (await admin.from("close_review_findings").select("finding_key, classification, debit_minor, credit_minor").eq("run_id", FIRST_RUN).order("finding_key")).data;
    return obj === BEFORE.object && up.file_path === BEFORE.upload.file_path && up.source_file_hash === BEFORE.upload.source_file_hash && unchanged
      && after.length === BEFORE.decisions.length + 1 && JSON.stringify(firstRun) === JSON.stringify(BEFORE.firstRun) ? true
      : { objectSame: obj === BEFORE.object, pathSame: up.file_path === BEFORE.upload.file_path, hashSame: up.source_file_hash === BEFORE.upload.source_file_hash, unchanged, decisions: after.length };
  });
  await check("'Back to the finding' lands on Close Review › Findings for that finding, which says the current check no longer raises it", async () => {
    await page.click('[data-testid="correction-back"]');
    await page.waitForText("no longer raises that finding", { timeout: 45000 });
    const url = await page.url();
    const w = await widths("06-back-to-findings");
    return url.includes(`/close/findings?finding=${encodeURIComponent(FINDING)}`) && w === true ? true : { url, w };
  });
  await check("the account's address, opened again, says the current check does not raise this finding (no form)", async () => {
    await go(accountUrl, "");
    await page.waitForSelector('[data-testid="correction-not-raised"]', { timeout: 45000 });
    return (await page.evaluate(() => !document.querySelector('[data-testid="correction-form"]'))) ? true : "form shown";
  });

  startGroup("Every request stayed on loopback");
  await check("no request left 127.0.0.1 / localhost except the app stylesheet's web font", async () => {
    const off = [...new Set(page.requests)].filter((u) => /^https?:/.test(u) && !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(u) && !/fonts\.(googleapis|gstatic)\.com/.test(u));
    return off.length === 0 ? true : off.slice(0, 10);
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; log(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); annotate("error", "finding-correction infrastructure", e?.stack ?? e); await failureEvidence("infrastructure"); }
const failed = results.filter((r) => !r.ok);
log(`\nchecks: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
for (const f of failed) log(`  FAILED [${f.group}] ${f.name}`);
const ok = !crashed && failed.length === 0 && results.length > 0;
log(ok ? "FINDING_CORRECTION_JOURNEY: ALL PASSED" : "FINDING_CORRECTION_JOURNEY: FAILED");
annotate(ok ? "notice" : "error", `finding-correction ${ok ? "ALL PASSED" : "FAILED"} (${results.length - failed.length}/${results.length})`,
  [...results.map((r) => `${r.ok ? "PASS" : "FAIL"} [${r.group}] ${r.name}`), "", ...failures].join("\n"));
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ ok, results }, null, 2));
try { await browser.close(); } catch { /* */ }
try { await new Promise((r) => preview.httpServer.close(() => r())); } catch { /* */ }
process.exit(ok ? 0 : 1);
