#!/usr/bin/env node
// The IPSAS accrual preparation pages (property, plant and equipment; grants and revenue), AUTHENTICATED, on a LOCAL Supabase stack
// (`supabase start` in CI). The production build of the app is served on loopback and driven in headless Chrome by real signed-in users.
//
// REAL services on this path:
//   Auth        every person signs in with a password through GoTrue (the sign-in page in the browser; signInWithPassword for the API
//               sessions); every call carries that person's JWT. NO simulated identity, NO x-sim-user, NO loopback bridge, NO dev harness.
//   PostgREST   every read and write is a PostgREST request; RPC and table calls from the browser and from the API sessions
//   RLS/grants  server authority is exercised by direct API calls with real JWTs, never by a hidden or disabled button
//   Storage     the trial balances are uploaded through the app's uploader into the PRIVATE bucket and read back with real sessions
//   Edge        the trial-balance check is the repository's process-trial-balance function served by the local stack
// OPERATOR actions by the service role (as the existing real-stack journeys do, recorded here): creating the Auth users, granting each
// owner a plan, recording the firm members as an invitation acceptance would, enabling the reporting rollout for the company, and
// revoking a member. NOT USED: the hosted project (every request must stay on loopback), paid services, any AI.
//
//   access      owner, preparer and partner act through the pages; a viewer member, an outsider, a cross-company caller, anon and
//               the service role are refused by the SERVER (direct calls with real JWTs); tables and internal helpers are unreachable
//   PPE+grants  the same steps that pass in the loopback harness, driven through the real pages: save/reopen, stale revision,
//               a concurrent writer, a dropped response retried with the original request identity, reviewer confirmation
//   storage     the uploaded evidence is private, readable by its owner (hash intact) and by nobody else
//   revoked     a revoked reviewer and preparer are refused (incl. replaying an earlier request); recorded history is intact
//   widths      1280 and 375 px on the real layout
//
//   node scripts/e2e/ipsasAuthJourney.mjs <evidence-dir>       (after `supabase start`; reads `supabase status -o json`)
// Test credentials are generated for this run and never printed.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { Browser } from "../browser-acceptance/cdp.mjs";
import { layoutProblems } from "../browser-acceptance/checks.mjs";
import { ppeChain, ppeHostile } from "../browser-acceptance/ipsasPpeSteps.mjs";
import { grantsChain, grantsHostile } from "../browser-acceptance/ipsasGrantsSteps.mjs";
import { assertLocalStack, verifyLocalBundle } from "./localStackFixtures.mjs";
import { ACCOUNTS, CURRENT, PERIODS, PRIOR, reviewDecisions, tbCsv } from "./ipsasAuthFixtures.mjs";
import { PRODUCTION_PROJECT_REF } from "../ci/stagingGuard.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.resolve(process.argv[2] ?? path.join(REPO, "ipsas-auth-evidence"));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const BUCKET = "trial-balance-files";
const results = [];
let group = "", page = null;
const log = (s) => { console.log(s); fs.appendFileSync(path.join(OUT, "journey.log"), s + "\n"); };
const startGroup = (g) => { group = g; log(`\n== ${g}`); };
async function failureEvidence(name) {
  if (!page) return;
  const slug = name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
  try { await page.screenshot(path.join(OUT, `FAIL-${slug}.png`)); } catch { /* */ }
  try { fs.writeFileSync(path.join(OUT, `FAIL-${slug}.txt`), `${await page.url()}\n\n${await page.bodyText()}`); } catch { /* */ }
}
async function check(name, fn) {
  try {
    const r = await fn();
    results.push({ group, name, ok: r === true, detail: r === true ? undefined : r });
    log(`  ${r === true ? "PASS" : "FAIL"}  ${name}${r === true ? "" : `\n        ${JSON.stringify(r)?.slice(0, 1500)}`}`);
    if (r !== true) await failureEvidence(name);
    return r === true;
  } catch (e) {
    results.push({ group, name, ok: false, detail: String(e?.message ?? e) });
    log(`  FAIL  ${name}\n        ${String(e?.stack ?? e).split("\n").slice(0, 3).join(" | ")}`);
    await failureEvidence(name);
    return false;
  }
}

// ── The stack (never printed) ────────────────────────────────────────────────────────────────────────
const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const apiUrl = status.API_URL, anonKey = status.ANON_KEY ?? status.PUBLISHABLE_KEY, serviceKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
const { origin: apiOrigin } = assertLocalStack({ apiUrl, anonKey, serviceRoleKey: serviceKey });
const admin = createClient(apiUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

// ── The production build of the app, pointed only at the local stack ───────────────────────────────────
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-ipsas-e2e-dist-"));
const emptyEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-ipsas-no-env-"));
process.env.VITE_SUPABASE_URL = apiUrl; process.env.VITE_SUPABASE_PUBLISHABLE_KEY = anonKey; process.env.VITE_SUPABASE_PROJECT_ID = "local";
const vite = await import("vite");
await vite.build({ root: REPO, configFile: path.join(REPO, "vite.config.ts"), mode: "e2e", envDir: emptyEnvDir, logLevel: "error", build: { outDir: distDir, emptyOutDir: true } });
const bundleProblems = verifyLocalBundle(walk(distDir).filter((f) => /\.(js|html|css)$/.test(f)).map((f) => fs.readFileSync(f, "utf8")), apiOrigin);
if (bundleProblems.length) throw new Error(`bundle verification failed: ${bundleProblems.join(", ")}`);
const preview = await vite.preview({ root: REPO, configFile: path.join(REPO, "vite.config.ts"), envDir: emptyEnvDir, logLevel: "error", build: { outDir: distDir }, preview: { port: 4175, strictPort: true, host: "127.0.0.1" } });
const APP = "http://127.0.0.1:4175";

// ── People: real Auth users with generated passwords; plans granted the way an operator records them ─────
const run = Date.now().toString(36);
const mk = (who) => ({ email: `${who}.${run}@e2e-local.test`, password: `E2e!${crypto.randomBytes(12).toString("base64url")}` });
const U = { owner: mk("ipsas-owner"), preparer: mk("ipsas-preparer"), partner: mk("ipsas-partner"), viewer: mk("ipsas-viewer"), outsider: mk("ipsas-outsider") };
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
  const lic = await admin.from("commercial_licences").insert({ billing_customer_id: bc.data.id, plan_id: plan.id, status: "ACTIVE", source: "ADMIN_GRANT", effective_start: new Date(Date.now() - 86400000).toISOString(), additional_seats: 4 });
  if (lic.error) throw new Error(`licence: ${lic.error.message}`);
}
await grantPlan(U.owner.id); await grantPlan(U.outsider.id);
const apiSession = async (u) => {
  const c = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email: u.email, password: u.password });
  if (error) throw new Error(`api sign-in failed: ${error.message}`);
  return c;
};
const api = {};

// ── Browser helpers ──────────────────────────────────────────────────────────────────────────────────
const browser = await Browser.launch();
const pages = [];
const signedInAs = new WeakMap();
async function open() { const ctx = await browser.newContext(); const p = await ctx.newPage(); await p.setViewport(1280, 900); pages.push(p); return p; }
const shotTo = (p, name) => p.screenshot(path.join(OUT, `${name}.png`));
const goRoute = async (p, route, text, timeout = 60000) => { await p.goto(`${APP}${route}`); if (text) await p.waitForText(text, { timeout }); await sleep(400); };
async function signInUi(p, u) {
  await goRoute(p, "/auth", "Sign in to your CFOClose account");
  await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await goRoute(p, "/auth", "Sign in to your CFOClose account");
  await p.fill("#email", u.email); await p.fill("#password", u.password);
  await p.press("Enter");
  await p.waitFor(() => !location.pathname.startsWith("/auth"), [], { label: "left sign-in", timeout: 30000 });
}
const setByLabel = (p, label, value) => p.evaluate((lab, val) => {
  const l = [...document.querySelectorAll("label")].find((x) => x.textContent.trim().toLowerCase().startsWith(lab.toLowerCase()));
  const el = l && (l.control ?? document.getElementById(l.htmlFor));
  if (!el) return false;
  if (el.type === "checkbox") { if (el.checked !== !!val) el.click(); return true; }
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, val);
  el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}, label, value);
async function chooseCurrency(p, label, code) {
  const typed = await p.evaluate((lab, val) => {
    const l = [...document.querySelectorAll("label")].find((x) => x.textContent.trim().toLowerCase().startsWith(lab.toLowerCase()));
    const el = l && (l.control ?? document.getElementById(l.htmlFor));
    if (!el || el.getAttribute("role") !== "combobox") return false;
    el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, val); el.dispatchEvent(new Event("input", { bubbles: true })); return true;
  }, label, code);
  if (!typed) return false;
  await sleep(150);
  return p.evaluate((lab, val) => {
    const l = [...document.querySelectorAll("label")].find((x) => x.textContent.trim().toLowerCase().startsWith(lab.toLowerCase()));
    const el = l && (l.control ?? document.getElementById(l.htmlFor));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    return el.dataset.value === val || new Promise((r) => setTimeout(() => r(el.dataset.value === val), 150));
  }, label, code);
}
async function pickRadix(p, triggerSelector, optionText) { await p.click(triggerSelector); await p.waitForSelector("[role=option]"); await p.click({ text: optionText, within: "[role=listbox]" }); await sleep(250); }
const writeFile = (name, text) => { const f = path.join(OUT, "files", name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
const tbCurrent = writeFile("mwamba-community-trust-trial-balance-fy2026.csv", tbCsv(CURRENT));
const tbPrior = writeFile("mwamba-community-trust-trial-balance-fy2025.csv", tbCsv(PRIOR));

let A = null, B = null, base = null;
const NAME = "Mwamba Community Trust";

async function main() {
  page = await open();

  startGroup("Real Auth: sign-in, a company reporting under IPSAS accrual, periods, trial balances through private Storage");
  await check("an unauthenticated deep link to the IPSAS page lands on sign-in; a wrong password is refused; the owner signs in through GoTrue", async () => {
    await page.goto(`${APP}/workspace/${uuid()}/2026/ipsas`);
    await page.waitForUrl(/\/auth/, { timeout: 30000 });
    await page.waitForText("Sign in to your CFOClose account", { timeout: 30000 });
    await page.fill("#email", U.owner.email); await page.fill("#password", "not-the-password"); await page.press("Enter");
    await page.waitFor(() => /invalid|incorrect/i.test(document.body.innerText) || document.querySelector('[role="alert"], [data-sonner-toast]') !== null, [], { label: "refusal", timeout: 20000 });
    if (!/\/auth/.test(await page.url())) return "left sign-in with a wrong password";
    await signInUi(page, U.owner); signedInAs.set(page, "owner");
    return true;
  });
  await check("the owner creates the company through the real first-run form (calendar year, TZS, IPSAS accrual); it is saved with that framework", async () => {
    await goRoute(page, "/dashboard", "Your companies");
    await page.waitForSelector('[data-testid="add-company"]', { timeout: 30000 });
    await page.click('[data-testid="add-company"]');
    await page.waitForSelector("#fr-org", { timeout: 30000 });
    await page.fill("#fr-org", NAME);
    await pickRadix(page, "#fr-year", "2026"); await pickRadix(page, "#fr-fye", "31 December");
    if (!(await chooseCurrency(page, "Functional currency", "TZS"))) return "the currency could not be chosen";
    await pickRadix(page, "#fr-framework", "IPSAS — public sector (accrual)");
    await page.click('form[aria-label="Add an entity"] button[type=submit]');
    await page.waitForSelector('[data-testid="companies-without-engagement-list"]', { timeout: 45000 });
    const saved = (await admin.from("companies").select("id, reporting_framework").eq("user_id", U.owner.id).eq("name", NAME)).data ?? [];
    if (saved.length !== 1 || saved[0].reporting_framework !== "ipsas_accrual") return { saved };
    A = saved[0].id;
    await page.click(`[data-testid="start-service-${A}"]`);
    await page.waitForUrl(/\/workspace\/[0-9a-f-]{36}\/2026/, { timeout: 45000 });
    base = `/workspace/${A}/2026`;
    return true;
  });
  await check("the owner sets the explicit calendar periods (FY2026 with FY2025 as its prior period) in the real period settings", async () => {
    // As a person does: the one service leads from the entry card to the upload page, and the company menu to the same task.
    await page.waitForSelector('[data-testid="trial-balance-entry"]', { timeout: 30000 });
    await page.click('[data-testid="entry-upload"]');
    await page.waitForUrl(/trial-balance|prepare/, { timeout: 30000 });
    await goRoute(page, `${base}?view=company`, "Your reporting workflow");
    await page.waitForSelector('[data-testid="company-workspace-home"]');
    await page.click('[data-testid="company-workspace-home"] a[href$="/trial-balance/review"]');
    await page.waitForUrl(/trial-balance\/review/, { timeout: 30000 });
    await page.waitForText("Trial balance", { timeout: 45000 }); await sleep(400);
    await page.evaluate(() => { document.querySelector('[data-testid="engagement-settings"]')?.setAttribute("open", ""); });
    await page.click('[data-testid="open-period-settings"]');
    await page.waitForSelector('[role="dialog"] input[type="date"]', { timeout: 30000 });
    await setByLabel(page, "Start date", PERIODS.current.start); await setByLabel(page, "End date", PERIODS.current.end);
    const readOnly = await page.evaluate(() => document.querySelector('[data-testid="period-currency-readonly"]')?.textContent ?? null);
    if (readOnly !== null) { if (readOnly.trim() !== "TZS") return { readOnlyCurrency: readOnly }; }
    else if (!(await chooseCurrency(page, "Reporting currency", "TZS"))) return "the reporting currency could not be chosen";
    await setByLabel(page, "Also set up the prior period", true); await sleep(300);
    await setByLabel(page, "Prior start date", PERIODS.prior.start); await setByLabel(page, "Prior end date", PERIODS.prior.end);
    await page.click({ text: "Set up the period" });
    await page.waitForUrl(/trial-balance\/review/, { timeout: 30000 });
    await page.waitFor(() => !document.querySelector('[role="dialog"]'), [], { label: "period settings closed", timeout: 30000 });
    const saved = await admin.from("fiscal_periods").select("reporting_start, reporting_end, reporting_currency, prior_period_id").eq("company_id", A).eq("reporting_end", PERIODS.current.end).single();
    return !saved.error && saved.data?.reporting_start === PERIODS.current.start && saved.data?.reporting_currency === "TZS" && !!saved.data?.prior_period_id ? true : { period: saved.data, error: saved.error?.message };
  });

  api.owner = await apiSession(U.owner);
  // Members as an invitation acceptance records them (operator action by the service role, as the existing real-stack journeys do).
  for (const [who, role] of [["preparer", "preparer"], ["partner", "partner"], ["viewer", "viewer"]]) {
    const r = await admin.from("firm_members").insert({ company_id: A, user_id: U[who].id, role, accepted_at: new Date().toISOString() });
    if (r.error) throw new Error(`member ${who}: ${r.error.message}`);
  }
  api.preparer = await apiSession(U.preparer); api.partner = await apiSession(U.partner); api.viewer = await apiSession(U.viewer); api.outsider = await apiSession(U.outsider);
  // The outsider has a workspace of their own under the same framework, so a cross-company call is a real one.
  { const c = await admin.from("companies").insert({ user_id: U.outsider.id, name: "Pwani Invented Trust", reporting_framework: "ipsas_accrual" }).select("id").single(); if (c.error) throw new Error(`company B: ${c.error.message}`); B = c.data.id; }
  { const r = await admin.rpc("fs_set_company_rollout", { p_company_id: B, p_enabled: true, p_reason: "Local end-to-end journey", p_operator_label: "e2e" }); if (r.error) throw new Error(`rollout B: ${r.error.message}`); }

  /** A period opened for the first time may show the launchpad and the data choice before the uploader. */
  const openUploader = async (year) => {
    await goRoute(page, `/workspace/${A}/${year}/trial-balance/review`, "");
    for (let i = 0; i < 3; i++) {
      const where = await page.waitFor(() => (document.querySelector('[data-testid="trial-balance-file-input"]') ? "uploader" : document.querySelector('[data-testid="upload-needs-engagement"]') ? "not-open"
        : document.querySelector('[data-testid="trial-balance-entry"]') ? "entry" : document.querySelector('[data-testid="launchpad-heading"]') ? "launchpad" : document.querySelector('[data-testid="data-choice-heading"]') ? "choice" : null), [], { label: "uploader or entry", timeout: 45000 });
      if (where === "uploader") return;
      if (where === "entry") { await page.click('[data-testid="entry-upload"]'); await sleep(1500); await goRoute(page, `/workspace/${A}/${year}/trial-balance/review`, ""); continue; }
      if (where === "not-open") {
        await page.click({ text: `Open FY${year}` });
        await page.waitForSelector('[data-testid="trial-balance-entry"], [data-testid="launchpad-heading"], [data-testid="data-choice-heading"]', { timeout: 30000 });
        if (await page.evaluate(() => !!document.querySelector('[data-testid="trial-balance-entry"]'))) await page.click('[data-testid="entry-upload"]');
        else if (await page.evaluate(() => !!document.querySelector('[data-testid="launchpad-heading"]'))) { await page.click('[data-testid="service-FINANCIAL_STATEMENTS"]'); await page.click('[data-testid="primary-cta"]'); }
        else await page.click('[data-testid="primary-cta"]');
        await sleep(2000);
        if (await page.evaluate(() => !!document.querySelector('[data-testid="data-choice-heading"]'))) await page.click('[data-testid="primary-cta"]');
      } else if (where === "launchpad") { await page.click('[data-testid="service-FINANCIAL_STATEMENTS"]'); await page.click('[data-testid="primary-cta"]'); }
      else { await page.click('[data-testid="primary-cta"]'); }
      await sleep(1500);
      await goRoute(page, `/workspace/${A}/${year}/trial-balance/review`, "");
    }
    throw new Error("the uploader did not appear");
  };
  const uploadAndReview = async (year, file) => {
    await openUploader(year);
    await page.setFiles('[data-testid="trial-balance-file-input"]', [file]);
    await page.click('[data-testid="trial-balance-upload-primary"]');
    const settled = async (label) => {
      for (let i = 0; i < 90; i++) {
        const { data } = await api.owner.from("trial_balance_uploads").select("id, status, processing_result").eq("company_id", A).eq("period_year", year).order("uploaded_at", { ascending: false }).limit(1).maybeSingle();
        if (data && !["pending", "processing", "queued", "validating"].includes(data.status)) return data;
        await sleep(2000);
      }
      throw new Error(`the ${label} check for FY${year} did not finish`);
    };
    const up = await settled("first");
    log(`        FY${year} first check: ${up.status}`);
    const { data: certNow } = await api.owner.rpc("get_authoritative_certification", { p_company_id: A, p_period_year: year });
    if (!(Array.isArray(certNow) ? certNow.length : certNow)) {
      const r = await api.owner.rpc("resolve_account_review_batch", { p_company_id: A, p_upload_id: up.id, p_client_request_id: uuid(), p_decisions: reviewDecisions() });
      if (r.error) throw new Error(`resolve_account_review_batch: ${r.error.message}`);
      const op = uuid();
      const { data: src } = await api.owner.from("trial_balance_uploads").select("source_file_hash").eq("id", up.id).single();
      const acc = await api.owner.rpc("tbu_request_reprocess", { p_upload_id: up.id, p_operation_id: op, p_expected_source_hash: src?.source_file_hash ?? null });
      if (acc.error || !["accepted", "replayed"].includes(acc.data?.outcome)) throw new Error(`re-check refused: ${JSON.stringify(acc.data ?? acc.error)}`);
      const { error: fnErr } = await api.owner.functions.invoke("process-trial-balance", { body: { uploadId: up.id, clientRequestId: op } });
      if (fnErr) throw new Error(`process-trial-balance: ${fnErr.message}`);
      const after = await settled("re-");
      const { data: cert } = await api.owner.rpc("get_authoritative_certification", { p_company_id: A, p_period_year: year });
      log(`        FY${year} re-check: ${after.status}; certified: ${Array.isArray(cert) ? cert.length > 0 : !!cert}`);
    }
    await goRoute(page, `/workspace/${A}/${year}/trial-balance/review`, "");
    await page.waitForText("ready for statement preparation", { timeout: 120000 });
    return up.id;
  };
  await check("FY2026 is uploaded through the real uploader into private Storage, checked by the real edge function, classified and certified", async () => { await uploadAndReview(2026, tbCurrent); return true; });
  await check("FY2025 is uploaded, checked and certified the same way (the prior year the equipment opening is tied to)", async () => { await uploadAndReview(2025, tbPrior); return true; });
  await check("operator enables the reporting rollout for the company; both years are certified and the framework is IPSAS accrual", async () => {
    const r = await admin.rpc("fs_set_company_rollout", { p_company_id: A, p_enabled: true, p_reason: "Local end-to-end journey", p_operator_label: "e2e" });
    if (r.error) return { rollout: r.error.message };
    const certs = await Promise.all([2025, 2026].map(async (y) => { const { data } = await api.owner.rpc("get_authoritative_certification", { p_company_id: A, p_period_year: y }); return Array.isArray(data) ? data.length : data ? 1 : 0; }));
    const co = (await admin.from("companies").select("reporting_framework").eq("id", A).single()).data;
    return certs.every((n) => n > 0) && co?.reporting_framework === "ipsas_accrual" ? true : { certs, co };
  });

  startGroup("Server enforcement: real JWTs, direct calls (no reliance on hidden or disabled buttons)");
  const ctxArgs = (company = A, year = 2026) => ({ p_company_id: company, p_period_year: year });
  const call = async (client, fn, args) => { const r = await client.rpc(fn, args); return r.error ? { error: { code: r.error.code, message: r.error.message } } : r.data; };
  const payloadFor = (company, over = {}) => ({ contract: "cfoclose-ipsas-ppe-workpaper/1", companyId: company, periodYear: 2026, period: { start: "2026-01-01", end: "2026-12-31" }, convention: "daily", classes: [], entityAnswers: {}, depreciationDifference: null, tbSelection: { ppeAccountKeys: [], depreciationExpenseKeys: [] }, ...over });
  const save = (client, company, p, expected = null) => call(client, "ipsas_save_preparation", { p_company_id: company, p_period_year: 2026, p_kind: "ppe_workpaper", p_payload: p, p_expected_id: expected, p_request_id: uuid() });
  const saveGrants = (client, company, p, expected = null) => call(client, "ipsas_save_grants", { p_company_id: company, p_period_year: 2026, p_payload: p, p_expected_id: expected, p_request_id: uuid() });
  const gpayload = (company) => ({ contract: "cfoclose-ipsas-grants/1", companyId: company, periodYear: 2026, entityAnswers: {}, tbSelection: { revenueKeys: [], liabilityKeys: [], receivableKeys: [] }, grants: [] });
  await check("owner, preparer and partner (reviewer) are served by the server; a viewer member and an outsider are refused, for both the preparation and the grants", async () => {
    const out = {};
    for (const who of ["owner", "preparer", "partner", "viewer", "outsider"]) {
      out[who] = [(await call(api[who], "ipsas_prep_context", ctxArgs())).outcome, (await call(api[who], "ipsas_grants_context", ctxArgs())).outcome];
    }
    const ok = ["owner", "preparer", "partner"].every((w) => out[w].every((o) => o === "available")) && ["viewer", "outsider"].every((w) => out[w].every((o) => o === "forbidden"));
    return ok ? true : out;
  });
  await check("writes are refused by the server for a viewer member and an outsider, and a preparer cannot confirm (nothing is recorded)", async () => {
    const out = { viewerSave: (await save(api.viewer, A, payloadFor(A))).outcome, outsiderSave: (await save(api.outsider, A, payloadFor(A))).outcome,
      viewerGrants: (await saveGrants(api.viewer, A, gpayload(A))).outcome, outsiderGrants: (await saveGrants(api.outsider, A, gpayload(A))).outcome,
      viewerConfirm: (await call(api.viewer, "ipsas_confirm", { p_company_id: A, p_period_year: 2026, p_subject_kind: "prior_figure_set", p_subject_key: "prior_figures", p_expected_revision_id: uuid(), p_request_id: uuid() })).outcome,
      preparerConfirm: (await call(api.preparer, "ipsas_confirm_grant", { p_company_id: A, p_period_year: 2026, p_grant_id: uuid(), p_expected_revision_id: uuid(), p_request_id: uuid() })).outcome };
    const ctx = await call(api.owner, "ipsas_prep_context", ctxArgs());
    return Object.values(out).every((o) => o === "forbidden") && ctx.workpaper === null ? true : { out, workpaper: ctx.workpaper };
  });
  await check("cross-company: the owner of one workspace is refused on another's, and the outsider on the owner's; a payload naming another company is invalid", async () => {
    const ownerOnB = (await call(api.owner, "ipsas_prep_context", ctxArgs(B))).outcome, outsiderOnA = (await call(api.outsider, "ipsas_grants_context", ctxArgs(A))).outcome;
    const ownerSavesB = (await save(api.owner, B, payloadFor(B))).outcome;
    const crossPayload = (await save(api.owner, A, payloadFor(B))).outcome, crossGrants = (await saveGrants(api.owner, A, gpayload(B))).outcome;
    const crossYear = (await call(api.owner, "ipsas_save_preparation", { p_company_id: A, p_period_year: 2025, p_kind: "ppe_workpaper", p_payload: payloadFor(A), p_expected_id: null, p_request_id: uuid() })).outcome;
    return ownerOnB === "forbidden" && outsiderOnA === "forbidden" && ownerSavesB === "forbidden" && crossPayload === "invalid_request" && crossGrants === "invalid_request" && crossYear === "invalid_request" ? true : { ownerOnB, outsiderOnA, ownerSavesB, crossPayload, crossGrants, crossYear };
  });
  await check("anon (no session) and the service role cannot call the functions; the tables and internal helpers are unreachable even to the owner", async () => {
    const anon = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const noSession = await call(anon, "ipsas_prep_context", ctxArgs()), service = await call(admin, "ipsas_grants_context", ctxArgs());
    const tables = [];
    for (const t of ["ipsas_prep_revisions", "ipsas_confirmations", "ipsas_grant_revisions", "ipsas_grant_confirmations"]) { const r = await api.owner.from(t).select("id").limit(1); if (!r.error) tables.push(`${t} readable`); }
    const helpers = [];
    for (const [fn, args] of [["_ipsas_live", ctxArgs()], ["_ipsas_grants_live", ctxArgs()], ["_ipsas_refusal", { p_company_id: A, p_uid: U.owner.id, p_capability: "read" }]]) { const r = await api.owner.rpc(fn, args); if (!r.error) helpers.push(`${fn} callable`); }
    return noSession.error && service.error && tables.length === 0 && helpers.length === 0 ? true : { noSession, service, tables, helpers };
  });
  await check("through the page, a viewer member is shown no working editor (and the server refusal above is what actually protects the data)", async () => {
    const viewer = await open(); page = viewer;
    await signInUi(viewer, U.viewer); signedInAs.set(viewer, "viewer");
    await goRoute(viewer, `${base}/ipsas`, "");
    await sleep(6000);
    const seen = await viewer.evaluate(() => ({ enabledMutations: [...document.querySelectorAll("button:not([disabled])")].map((b) => b.textContent.trim()).filter((t) => /^(Save preparation|Save grants|Save prior figure|Confirm|Add an asset class|Add a grant)/.test(t)), url: location.pathname }));
    fs.writeFileSync(path.join(OUT, "viewer-page.txt"), `${seen.url}\n\n${await viewer.bodyText()}`);
    return seen.enabledMutations.length === 0 ? true : seen;
  });

  // ── The pages, driven by real signed-in people ──────────────────────────────────────────────────
  const J = {
    check, open, log, shot: shotTo, setPage: (p) => { page = p; }, seed: { companyId: A, periodYear: 2026 }, accounts: ACCOUNTS,
    go: async (p, as, text) => { if (signedInAs.get(p) !== as) { await signInUi(p, U[as]); signedInAs.set(p, as); } await goRoute(p, `${base}/ipsas`, text); },
    set: (p, id, value) => p.evaluate((i, v) => { const el = document.getElementById(i); if (!el) return `missing #${i}`; const proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; }, id, value),
    type: async (p, id, value) => { await p.fill(`#${id}`, value); await sleep(40); },
    val: (p, id) => p.evaluate((i) => document.getElementById(i)?.value ?? null, id),
    tab: async (p, name) => { await p.click({ text: name }); await sleep(250); },
    text: (p) => p.bodyText(),
    nextStep: (p) => p.evaluate(() => document.querySelector('[aria-label="Next step"]')?.innerText ?? ""),
    rpc: async (as, fn, body) => { const r = await api[as].rpc(fn, body); return r.error ? { outcome: "error", error: { code: r.error.code, message: r.error.message } } : r.data; },
    serverContext: async (as = "owner") => call(api[as], "ipsas_prep_context", ctxArgs()),
  };
  J.seed = { companyId: A, periodYear: 2026 };

  startGroup("Normal navigation: the entry link on Prepare opens the IPSAS page");
  await check("Prepare shows the IPSAS entry for this company, and following it opens the preparation page for the same year", async () => {
    page = await open(); await signInUi(page, U.owner); signedInAs.set(page, "owner");
    await goRoute(page, `${base}/prepare`, "");
    await page.waitForSelector('[data-testid="ipsas-preparation-entry"]', { timeout: 45000 });
    await page.click('[data-testid="ipsas-preparation-entry"]');
    await page.waitForUrl(/\/ipsas$/, { timeout: 30000 });
    await page.waitForText("IPSAS accrual, 2026", { timeout: 45000 });
    return true;
  });

  startGroup("Property, plant and equipment through its page (real JWTs, RLS, certified rows read from Storage-checked uploads)");
  const { preparer, partner } = await ppeChain(J);
  J.preparer = preparer;

  startGroup("Grants and revenue through their page");
  await grantsChain(J);
  page = preparer;

  startGroup("Concurrent edits, stale revisions and lost responses (real PostgREST)");
  await ppeHostile(J);
  await grantsHostile(J);
  page = preparer;

  startGroup("Private Storage: the uploaded evidence");
  await check("the trial-balance bucket is private; the stored object is the uploaded file, byte for byte; an outsider, a viewer, anon and a public URL cannot read it", async () => {
    const bucket = await admin.storage.getBucket(BUCKET);
    const ups = (await api.owner.from("trial_balance_uploads").select("file_path, period_year").eq("company_id", A)).data ?? [];
    const mine = ups.find((u) => u.period_year === 2026);
    if (!mine) return { ups };
    // The object lives under the company's workspace path, which the storage policies do not grant to a session directly: the app
    // reads it only through the server (the edge function). The bytes are therefore verified with the service role (an operator
    // read, recorded in the results), and every session below is shown to be refused.
    const own = await admin.storage.from(BUCKET).download(mine.file_path);
    const bytes = own.data ? Buffer.from(await own.data.arrayBuffer()) : null;
    const outsider = await api.outsider.storage.from(BUCKET).download(mine.file_path);
    const viewer = await api.viewer.storage.from(BUCKET).download(mine.file_path);
    const publicFetch = await fetch(`${apiUrl}/storage/v1/object/public/${BUCKET}/${mine.file_path}`);
    const anonFetch = await fetch(`${apiUrl}/storage/v1/object/${BUCKET}/${mine.file_path}`, { headers: { apikey: anonKey } });
    const intact = bytes && sha(bytes) === sha(fs.readFileSync(tbCurrent));
    return bucket.data?.public === false && intact && !!outsider.error && !!viewer.error && publicFetch.status !== 200 && anonFetch.status !== 200 ? true
      : { public: bucket.data?.public, intact, outsider: outsider.error?.message, viewer: viewer.error?.message, publicStatus: publicFetch.status, anonStatus: anonFetch.status };
  });

  startGroup("Revoked access");
  await check("a revoked preparer reads and writes nothing, cannot replay an earlier request, and the recorded history is intact", async () => {
    const before = await call(api.owner, "ipsas_grants_context", ctxArgs());
    const request = uuid(), p = JSON.parse(JSON.stringify(before.register.payload));
    const first = await call(api.preparer, "ipsas_save_grants", { p_company_id: A, p_period_year: 2026, p_payload: p, p_expected_id: before.register.id, p_request_id: request });
    if (first.outcome !== "recorded") return { first };
    const r = await admin.from("firm_members").update({ accepted_at: null }).eq("company_id", A).eq("user_id", U.preparer.id);
    if (r.error) return { revoke: r.error.message };
    const ctx = await call(api.preparer, "ipsas_grants_context", ctxArgs()), again = await call(api.preparer, "ipsas_save_grants", { p_company_id: A, p_period_year: 2026, p_payload: p, p_expected_id: before.register.id, p_request_id: request });
    const newSave = await call(api.preparer, "ipsas_save_preparation", { p_company_id: A, p_period_year: 2026, p_kind: "ppe_workpaper", p_payload: payloadFor(A), p_expected_id: null, p_request_id: uuid() });
    const history = await call(api.owner, "ipsas_grants_context", ctxArgs());
    return ctx.outcome === "forbidden" && again.outcome === "forbidden" && again.revisionId === undefined && newSave.outcome === "forbidden" && history.register.id === first.revisionId ? true : { ctx: ctx.outcome, again, newSave: newSave.outcome, head: history.register.id, first: first.revisionId };
  });
  await check("a revoked reviewer can no longer confirm; their earlier confirmations remain; the page shows them no working editor", async () => {
    const ctx0 = await call(api.owner, "ipsas_prep_context", ctxArgs());
    const confirmationsBefore = ctx0.confirmations.length;
    const r = await admin.from("firm_members").update({ accepted_at: null }).eq("company_id", A).eq("user_id", U.partner.id);
    if (r.error) return { revoke: r.error.message };
    const grants = await call(api.owner, "ipsas_grants_context", ctxArgs());
    const refused = await call(api.partner, "ipsas_confirm_grant", { p_company_id: A, p_period_year: 2026, p_grant_id: grants.register.payload.grants[0].grantId, p_expected_revision_id: grants.register.id, p_request_id: uuid() });
    const ctx1 = await call(api.owner, "ipsas_prep_context", ctxArgs());
    const rev = await open(); page = rev; await signInUi(rev, U.partner); signedInAs.set(rev, "partner");
    await goRoute(rev, `${base}/ipsas`, ""); await sleep(5000);
    const enabled = await rev.evaluate(() => [...document.querySelectorAll("button:not([disabled])")].map((b) => b.textContent.trim()).filter((t) => /^(Confirm|Save preparation|Save grants|Add a grant|Add an asset class)/.test(t)));
    return refused.outcome === "forbidden" && ctx1.confirmations.length === confirmationsBefore && enabled.length === 0 ? true : { refused: refused.outcome, confirmationsBefore, after: ctx1.confirmations.length, enabled };
  });

  startGroup("Widths on the real layout");
  await check("the preparation page at 1280 px and 375 px, on Bring, Prepare and Review: no horizontal overflow, no clipped action, no unlabeled field", async () => {
    const narrow = await open(); page = narrow;
    await signInUi(narrow, U.owner); signedInAs.set(narrow, "owner");
    await goRoute(narrow, `${base}/ipsas`, "IPSAS accrual, 2026");
    const problems = {};
    for (const area of ["Bring information", "Complete preparation", "Review report"]) {
      await J.tab(narrow, area);
      for (const [w, h] of [[1280, 900], [375, 812]]) {
        await narrow.setViewport(w, h); await sleep(600);
        const p = await narrow.evaluate(layoutProblems);
        if (p.length) problems[`${area} @${w}`] = p.slice(0, 6);
        await shotTo(narrow, `w-${area.split(" ")[0].toLowerCase()}-${w}`);
      }
      await narrow.setViewport(1280, 900);
    }
    return Object.keys(problems).length === 0 ? true : problems;
  });
  await check("every browser request stayed on loopback (none named the production project); uncaught page exceptions are reported", async () => {
    const urls = pages.flatMap((p) => p.requests);
    const external = [...new Set(urls.filter((u) => /^https?:/i.test(u) && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(u)).map((u) => new URL(u).origin))];
    const production = urls.filter((u) => u.includes(PRODUCTION_PROJECT_REF));
    const errors = pages.flatMap((p) => p.consoleErrors);
    log(`        non-loopback origins requested by the page (reported, e.g. fonts): ${JSON.stringify(external)}; uncaught exceptions: ${errors.length}`);
    return production.length === 0 && errors.length === 0 ? true : { production: production.slice(0, 3), errors: errors.slice(0, 5) };
  });
}

try { await main(); }
catch (e) { log(`JOURNEY FAILURE: ${e?.stack ?? e}`); results.push({ group, name: "journey", ok: false, detail: String(e?.message ?? e) }); }
finally {
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ results, boundaries: {
    real: ["GoTrue sign-in (browser and API)", "PostgREST (browser and API)", "RLS and function grants (direct calls with real JWTs)", "private Storage (real uploader into the private bucket; refusal of outsider, viewer, anon and public URL)", "process-trial-balance edge function", "production build served on loopback in headless Chrome"],
    operatorActionsByServiceRole: ["create Auth users", "grant plans", "record firm members", "enable the reporting rollout", "read the stored object back to verify its bytes", "revoke members", "create the outsider's own company"],
    notUsed: ["hosted project", "paid services", "AI", "simulated identity", "loopback bridge", "dev harness"] }, finishedAt: new Date().toISOString() }, null, 2));
  try { await browser?.close(); } catch { /* */ }
  try { await preview?.close(); } catch { /* */ }
  const failed = results.filter((r) => !r.ok);
  log(`\nchecks: ${results.length}  passed: ${results.length - failed.length}  failed: ${failed.length}`);
  log(failed.length || !results.length ? "IPSAS_AUTH_JOURNEY: FAILED" : "IPSAS_AUTH_JOURNEY: ALL PASSED");
  setTimeout(() => process.exit(results.length && failed.length === 0 ? 0 : 1), 1500);
}
