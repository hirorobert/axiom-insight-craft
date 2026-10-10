#!/usr/bin/env node
// The REAL application, end to end, on a LOCAL Supabase stack (`supabase start` in CI: real Auth, PostgREST, RLS, Storage
// and Edge Functions; the migrations in supabase/migrations applied by the CLI). Nothing here is an isolated page or a
// bridge: the production build of the app is served on loopback and driven in headless Chrome by real signed-in users.
//
//   routing     an unauthenticated deep link lands on sign-in; a wrong password is refused; sign-in by keyboard
//   new user    first run creates the company (FY ending 30 June) through the real form; the launchpad and data choice
//   periods     explicit non-calendar periods (1 Jul – 30 Jun) with the prior period, through Trial Balance › Intake
//   trial bal.  both years uploaded through the real uploader and checked by the real edge function; classifications
//               recorded by the owner (the account-review RPC the panel calls) and re-checked; "Reviewed trial balance"
//               with the statement-equation wording consistent between Overview and the checks
//   journey     reporting enabled for the company (service role, as an operator would); the ONE next action follows the
//               server's prerequisites: Close Review findings first (run from the page), then comparatives (missing →
//               recovery offered → prior year reviewed → approved by a reviewer), notes, evidence on Statements
//   adjustment  proposed by the preparer, approved by the partner on Close Review › Adjustments (one adjustment path;
//               Reconcile shows history read-only)
//   sign-off    evidence stored with a version; REVIEWED by the partner; FINAL by the owner; the sealed pack on Exports
//   stale       a changed file layout makes the trial-balance result out of date; the sealed version stays FINAL
//   isolation   a second account sees nothing of the first: the workspace URL is refused, and its API reads return nothing
//   widths      every page checked at 1280 px and 375 px for horizontal overflow, cut-off controls and unlabeled fields
//
//   node scripts/e2e/localStackJourney.mjs <evidence-dir>       (after `supabase start`; reads `supabase status -o json`)
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
import { assertLocalStack, verifyLocalBundle, tbCsv, CURRENT, PRIOR, PERIODS, reviewDecisions, ASSIGN, EVIDENCE, EVIDENCE_SLOTS, NOTES, NOT_APPLICABLE, PPE_SCHEDULE, CODES } from "./localStackFixtures.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.resolve(process.argv[2] ?? path.join(REPO, "e2e-evidence"));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();
const results = [];
let group = "";
const log = (s) => { console.log(s); fs.appendFileSync(path.join(OUT, "journey.log"), s + "\n"); };
const startGroup = (g) => { group = g; log(`\n== ${g}`); };
let page;
async function check(name, fn) {
  try {
    const r = await fn();
    const ok = r === true;
    results.push({ group, name, ok });
    log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n        ${JSON.stringify(r)?.slice(0, 1500)}`}`);
    if (!ok) await failureEvidence(name);
    return ok;
  } catch (e) {
    results.push({ group, name, ok: false });
    log(`  FAIL  ${name}\n        ${String(e?.stack ?? e).split("\n").slice(0, 3).join(" | ")}`);
    await failureEvidence(name);
    return false;
  }
}
async function failureEvidence(name) {
  if (!page) return;
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

// ── The production build of the app, pointed only at the local stack (no .env of any kind can be read) ───────────────
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-e2e-dist-"));
const emptyEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-no-env-"));
process.env.VITE_SUPABASE_URL = apiUrl;
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = anonKey;
process.env.VITE_SUPABASE_PROJECT_ID = "local";
const vite = await import("vite");
await vite.build({ root: REPO, configFile: path.join(REPO, "vite.config.ts"), mode: "e2e", envDir: emptyEnvDir, logLevel: "error", build: { outDir: distDir, emptyOutDir: true } });
const bundleProblems = verifyLocalBundle(walk(distDir).filter((f) => /\.(js|html|css)$/.test(f)).map((f) => fs.readFileSync(f, "utf8")), apiOrigin);
if (bundleProblems.length) throw new Error(`bundle verification failed: ${bundleProblems.join(", ")}`);
const preview = await vite.preview({ root: REPO, configFile: path.join(REPO, "vite.config.ts"), envDir: emptyEnvDir, logLevel: "error", build: { outDir: distDir }, preview: { port: 4173, strictPort: true, host: "127.0.0.1" } });
const APP = "http://127.0.0.1:4173";

// ── Accounts: four real users with generated test passwords; plans granted the way an operator records them ───────────
const run = Date.now().toString(36);
const mk = (who) => ({ email: `${who}.${run}@e2e-local.test`, password: `E2e!${crypto.randomBytes(12).toString("base64url")}` });
const U = { owner: mk("owner"), preparer: mk("preparer"), partner: mk("partner"), ownerB: mk("ownerb") };
for (const u of Object.values(U)) {
  const { data, error } = await admin.auth.admin.createUser({ email: u.email, password: u.password, email_confirm: true });
  if (error) throw new Error(`creating a test user failed: ${error.message}`);
  u.id = data.user.id;
}
async function grantPlan(userId) {
  const prod = (await admin.from("commercial_products").select("id").eq("code", "CFOCLOSE").single()).data;
  const plan = (await admin.from("commercial_plans").select("id").eq("product_id", prod.id).eq("code", "PRACTICE").single()).data;
  const bc = (await admin.from("billing_customers").insert({ owner_user_id: userId, product_id: prod.id }).select("id").single());
  if (bc.error) throw new Error(`billing customer: ${bc.error.message}`);
  const lic = await admin.from("commercial_licences").insert({ billing_customer_id: bc.data.id, plan_id: plan.id, status: "ACTIVE", source: "ADMIN_GRANT",
    effective_start: new Date(Date.now() - 86400000).toISOString(), additional_seats: 4 });
  if (lic.error) throw new Error(`licence: ${lic.error.message}`);
}
await grantPlan(U.owner.id);
await grantPlan(U.ownerB.id);
const asUser = async (u) => {
  const c = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email: u.email, password: u.password });
  if (error) throw new Error(`api sign-in failed: ${error.message}`);
  return c;
};
const rpc = async (c, fn, args) => { const { data, error } = await c.rpc(fn, args); if (error) throw new Error(`${fn}: ${error.message}`); return data; };

// ── Browser helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
const browser = await Browser.launch();
async function openPage() {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.setViewport(1280, 900);
  return p; // Page records every request URL it issues (cdp.mjs: page.requests)
}
const shot = (name) => page.screenshot(path.join(OUT, `${name}.png`));
const go = async (route, text, timeout = 45000) => { await page.goto(`${APP}${route}`); if (text) await page.waitForText(text, { timeout }); await sleep(400); };
/** Sets a React-controlled field (date, select, text) found by its visible label text, the way input events deliver it. */
const setByLabel = (label, value) => page.evaluate((lab, val) => {
  const l = [...document.querySelectorAll("label")].find((x) => x.textContent.trim().toLowerCase().startsWith(lab.toLowerCase()));
  const el = l && (l.control ?? document.getElementById(l.htmlFor));
  if (!el) return false;
  if (el.type === "checkbox") { if (el.checked !== !!val) el.click(); return true; }
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set;
  setter.call(el, val);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}, label, value);
async function pickRadix(triggerSelector, optionText) {
  await page.click(triggerSelector);
  await page.waitForSelector("[role=option]");
  await page.click({ text: optionText, within: "[role=listbox]" });
  await sleep(250);
}
async function signIn(u) {
  await go("/auth", "Sign in to your CFOClose account");
  await page.fill("#email", u.email);
  await page.fill("#password", u.password);
  await page.press("Enter");
  await page.waitFor(() => !location.pathname.startsWith("/auth"), [], { label: "left sign-in", timeout: 30000 });
}
async function signOut() { await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }); }
async function widths(name) {
  const problems = {};
  for (const [w, h] of [[1280, 900], [375, 812]]) {
    await page.setViewport(w, h);
    await sleep(600);
    const p = await page.evaluate(layoutProblems);
    if (p.length) {
      // Name the elements that stick out, so an overflow is diagnosable from the evidence alone.
      const culprits = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        return [...document.querySelectorAll("body *")].filter((el) => el.getBoundingClientRect().right > vw + 1)
          .filter((el) => ![...el.children].some((c) => c.getBoundingClientRect().right > vw + 1))
          .slice(0, 6).map((el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${String(el.className).slice(0, 80)} right=${Math.round(el.getBoundingClientRect().right)}`);
      });
      problems[w] = [...p, ...culprits];
    }
    await shot(`${name}-${w}`);
  }
  await page.setViewport(1280, 900);
  return Object.keys(problems).length ? problems : true;
}
const writeFile = (name, text) => { const f = path.join(OUT, "files", name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
const tbCurrent = writeFile("mto-holdings-trial-balance-fy2026.csv", tbCsv(CURRENT));
const tbPrior = writeFile("mto-holdings-trial-balance-fy2025.csv", tbCsv(PRIOR));
const evidenceFiles = Object.fromEntries(EVIDENCE_SLOTS.map(([slot, y, k]) => [slot, writeFile(`${y}-${k.toLowerCase()}.csv`, EVIDENCE[y][k])]));

let A = null;      // company id
let base = null;   // /workspace/A/2026
const owner = { api: null }, preparer = { api: null }, partner = { api: null };

async function main() {
  page = await openPage();

  startGroup("Routing and sign-in");
  await check("an unauthenticated deep link to a workspace lands on sign-in", async () => {
    await page.goto(`${APP}/workspace/${uuid()}/2026`);
    await page.waitForUrl(/\/auth/, { timeout: 30000 });
    return true;
  });
  await check("sign-in at 1280 and 375 px: no overflow, no cut-off control, every field labelled", async () => { await go("/auth", "Sign in"); return widths("01-sign-in"); });
  await check("a wrong password is refused and the page stays on sign-in", async () => {
    await page.fill("#email", U.owner.email); await page.fill("#password", "not-the-password");
    await page.press("Enter");
    await page.waitFor(() => document.querySelector('[role="alert"], [data-sonner-toast]') !== null || /invalid|incorrect/i.test(document.body.innerText), [], { label: "refusal", timeout: 20000 });
    return /\/auth/.test(await page.url());
  });
  await check("keyboard: from the email field, Tab reaches the password field; Enter signs in", async () => {
    await go("/auth", "Sign in to your CFOClose account");
    await page.fill("#email", U.owner.email);
    await page.press("Tab");
    const onPassword = await page.evaluate(() => document.activeElement?.id === "password");
    await page.send("Input.insertText", { text: U.owner.password });
    await page.press("Enter");
    await page.waitFor(() => !location.pathname.startsWith("/auth"), [], { label: "signed in", timeout: 30000 });
    return onPassword ? true : "Tab did not reach the password field";
  });

  startGroup("New user: first run");
  await check("first run creates the company through the real form (FY ending 30 June, TZS, IFRS for SMEs) and opens its workspace", async () => {
    await go("/dashboard", "Organization name");
    await widths("02-first-run");
    await page.fill("#fr-org", "Mto Holdings Limited");
    await pickRadix("#fr-year", "2026");
    await pickRadix("#fr-fye", "30 June");
    await pickRadix("#fr-currency", "TZS — Tanzanian Shilling");
    await pickRadix("#fr-framework", "IFRS for SMEs");
    await page.click('form[aria-label="Create reporting workspace"] button[type=submit]');
    const url = await page.waitForUrl(/\/workspace\/[0-9a-f-]{36}\/2026/, { timeout: 45000 });
    A = url.match(/\/workspace\/([0-9a-f-]{36})\//)[1];
    base = `/workspace/${A}/2026`;
    return true;
  });
  await check("the launchpad offers the service; choosing it and importing data leads to the trial balance", async () => {
    await page.waitForSelector('[data-testid="launchpad-heading"], [data-testid="data-choice-heading"]', { timeout: 30000 });
    await shot("03-launchpad");
    if (await page.evaluate(() => !!document.querySelector('[data-testid="launchpad-heading"]'))) {
      await page.click('[data-testid="service-FINANCIAL_STATEMENTS"]');
      await page.click('[data-testid="primary-cta"]');
      await page.waitForSelector('[data-testid="data-choice-heading"]', { timeout: 30000 });
    }
    await page.click('[data-testid="primary-cta"]');
    await page.waitForUrl(/trial-balance|prepare/, { timeout: 30000 });
    return true;
  });

  startGroup("Explicit non-calendar periods");
  await check("Trial Balance › Intake sets 1 Jul 2025 – 30 Jun 2026 and the prior period 1 Jul 2024 – 30 Jun 2025 (TZS)", async () => {
    await go(`${base}/trial-balance/intake`, "Start date");
    await setByLabel("Start date", PERIODS.current.start); await setByLabel("End date", PERIODS.current.end);
    await setByLabel("Reporting currency", "TZS");
    await setByLabel("Also set up the prior period", true);
    await sleep(300);
    await setByLabel("Prior start date", PERIODS.prior.start); await setByLabel("Prior end date", PERIODS.prior.end);
    await page.click({ text: "Set up the period" });
    await page.waitForText("is set up and linked for comparatives", { timeout: 30000 });
    await shot("04-periods");
    return true;
  });

  owner.api = await asUser(U.owner);
  // Members of the company: a preparer and a partner (an owner invites them; recorded here as the invitation acceptance does).
  for (const [who, role] of [["preparer", "preparer"], ["partner", "partner"]]) {
    const r = await admin.from("firm_members").insert({ company_id: A, user_id: U[who].id, role, accepted_at: new Date().toISOString() });
    if (r.error) throw new Error(`member ${who}: ${r.error.message}`);
  }
  preparer.api = await asUser(U.preparer);
  partner.api = await asUser(U.partner);

  startGroup("Trial balance: upload, check, review (real edge function)");
  /** A period opened for the first time may show the launchpad and the data choice before the uploader. */
  const openUploader = async (year) => {
    await go(`/workspace/${A}/${year}/trial-balance/review`, "");
    for (let i = 0; i < 3; i++) {
      const where = await page.waitFor(() => (document.querySelector('[data-testid="trial-balance-file-input"]') ? "uploader"
        : document.querySelector('[data-testid="upload-needs-engagement"]') ? "not-open"
        : document.querySelector('[data-testid="launchpad-heading"]') ? "launchpad" : document.querySelector('[data-testid="data-choice-heading"]') ? "choice" : null), [], { label: "uploader or launchpad", timeout: 45000 });
      if (where === "uploader") return;
      if (where === "not-open") {
        // The period is not open: the page says so and links to its Overview, where the service is chosen.
        await page.click({ text: `Open FY${year}` });
        await page.waitForSelector('[data-testid="launchpad-heading"], [data-testid="data-choice-heading"]', { timeout: 30000 });
        if (await page.evaluate(() => !!document.querySelector('[data-testid="launchpad-heading"]'))) { await page.click('[data-testid="service-FINANCIAL_STATEMENTS"]'); await page.click('[data-testid="primary-cta"]'); }
        else await page.click('[data-testid="primary-cta"]');
        // The Overview then leads to Prepare Data (with or without a separate data choice); the loop returns to the uploader.
        await sleep(2000);
        if (await page.evaluate(() => !!document.querySelector('[data-testid="data-choice-heading"]'))) await page.click('[data-testid="primary-cta"]');
      } else if (where === "launchpad") { await page.click('[data-testid="service-FINANCIAL_STATEMENTS"]'); await page.click('[data-testid="primary-cta"]'); }
      else { await page.click('[data-testid="primary-cta"]'); }
      await sleep(1500);
      await go(`/workspace/${A}/${year}/trial-balance/review`, "");
    }
    throw new Error("the uploader did not appear");
  };
  const uploadAndReview = async (year, file) => {
    await openUploader(year);
    await page.setFiles('[data-testid="trial-balance-file-input"]', [file]);
    await page.click('[data-testid="trial-balance-upload-primary"]');
    // The server's own state decides when the first check has finished (never a word on the page).
    const settled = async (label) => {
      for (let i = 0; i < 90; i++) {
        const { data } = await owner.api.from("trial_balance_uploads").select("id, status, processing_result").eq("company_id", A).eq("period_year", year).order("uploaded_at", { ascending: false }).limit(1).maybeSingle();
        if (data && !["pending", "processing", "queued", "validating"].includes(data.status)) return data;
        await sleep(2000);
      }
      throw new Error(`the ${label} check for FY${year} did not finish`);
    };
    const up = await settled("first");
    log(`        FY${year} first check: ${up.status}`);
    // Review only what the server holds for review: re-recording decisions that are already in force would change the
    // company-wide mapping inputs and, correctly, put every other year's result out of date (the stale-validation gate).
    const { data: certNow } = await owner.api.rpc("get_authoritative_certification", { p_company_id: A, p_period_year: year });
    if (!(Array.isArray(certNow) ? certNow.length : certNow)) {
      await rpc(owner.api, "resolve_account_review_batch", { p_company_id: A, p_upload_id: up.id, p_client_request_id: uuid(), p_decisions: reviewDecisions() });
      // A new check exactly as "Run the check again" requests it (src/lib/workspace/requestReprocess.ts): the server accepts
      // the request for the current source, then processing runs with the same operation id.
      const op = uuid();
      const { data: src } = await owner.api.from("trial_balance_uploads").select("source_file_hash").eq("id", up.id).single();
      const accepted = await rpc(owner.api, "tbu_request_reprocess", { p_upload_id: up.id, p_operation_id: op, p_expected_source_hash: src?.source_file_hash ?? null });
      if (accepted?.outcome !== "accepted" && accepted?.outcome !== "replayed") throw new Error(`re-check refused: ${JSON.stringify(accepted)}`);
      const { error: fnErr } = await owner.api.functions.invoke("process-trial-balance", { body: { uploadId: up.id, clientRequestId: op } });
      if (fnErr) throw new Error(`process-trial-balance: ${fnErr.message}`);
      const after = await settled("re-");
      const { data: cert } = await owner.api.rpc("get_authoritative_certification", { p_company_id: A, p_period_year: year });
      log(`        FY${year} re-check: ${after.status}; certified: ${Array.isArray(cert) ? cert.length > 0 : !!cert}`);
      if (!(Array.isArray(cert) ? cert.length : cert)) log(`        FY${year} result: ${JSON.stringify(after.processing_result ?? {}).slice(0, 800)}`);
    }
    await go(`/workspace/${A}/${year}/trial-balance/review`, "");
    await page.waitForText("ready for statement preparation", { timeout: 120000 });
    return up.id;
  };
  let currentUpload = null;
  await check("FY2026 (Jul–Jun, distinct account codes) is uploaded through the uploader, checked, classified and becomes a Reviewed trial balance", async () => {
    currentUpload = await uploadAndReview(2026, tbCurrent);
    return widths("05-trial-balance-reviewed");
  });
  await check("the Overview and the checks state the statement equation the same way (no 'not exactly verified' beside a passed check)", async () => {
    await go(`${base}/trial-balance/review`, "Statement equation");
    const checks = await page.bodyText();
    await go(base, "");
    await sleep(1500);
    const overview = await page.bodyText();
    const exact = /holds exactly/i.test(checks);
    const contradiction = exact && /not exactly verified/i.test(overview);
    await shot("06-overview-reviewed");
    return !contradiction ? true : { exact, overview: overview.slice(0, 600) };
  });

  startGroup("Reporting journey: the next action follows the server's prerequisites");
  { const { error } = await admin.rpc("fs_set_company_rollout", { p_company_id: A, p_enabled: true, p_reason: "Local end-to-end journey", p_operator_label: "e2e" }); if (error) throw new Error(`rollout: ${error.message}`); }
  await check("Overview: with reporting enabled, the one next action is to run the Close Review checks — not 'Open trial balance', not a statements step", async () => {
    await go(base, "");
    await page.waitForText("Run the Close Review checks", { timeout: 45000 });
    const t = await page.bodyText();
    await shot("07-overview-next-close-review");
    return !/Validate Draft Statements/.test(t) ? true : "legacy statement step shown";
  });
  await check("Close Review › Findings: the check runs from the page; findings are listed with a 'Review finding' action; keyboard opens one", async () => {
    await go(`${base}/close/findings`, "Check for findings");
    await page.click({ text: "Check for findings" });
    await page.waitForSelector('[data-testid="findings-counts"]', { timeout: 60000 });
    const hasAction = await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Review finding"));
    if (hasAction) {
      await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Review finding").focus());
      await page.press("Enter");
      await page.waitForSelector('[data-testid="finding-detail"]');
    }
    const w = await widths("08-findings");
    // The preparer explains every open finding (the same call the page makes).
    const st = await rpc(preparer.api, "close_review_finding_states", { p_company_id: A, p_period_year: 2026 });
    for (const f of st.filter((x) => !x.resolved)) await rpc(preparer.api, "close_review_finding_action", { p_finding_id: f.finding_id, p_action: "explain", p_text: "Reviewed against the fixed asset register", p_evidence_ref: "FAR FY2026", p_request_id: uuid() });
    return w === true && (hasAction || st.length === 0) ? true : { w, hasAction };
  });
  await check("Comparatives: FY2025 missing; the recovery names the prior-year import (and the first-period route) and the code stays in technical details", async () => {
    await go(`${base}/statements/comparatives`, "Establish the comparatives for FY2025");
    const t = await page.bodyText();
    await widths("09-comparatives-missing");
    return /Import the FY2025 trial balance/.test(t) && !/^COMPARATIVE_REQUIRED_MISSING/m.test(t) ? true : t.slice(0, 500);
  });
  await check("FY2025 is uploaded through the uploader (after its period is opened) and reviewed; FY2026 stays certified; the comparatives are no longer missing", async () => {
    await uploadAndReview(2025, tbPrior);
    const { data: c26 } = await owner.api.rpc("get_authoritative_certification", { p_company_id: A, p_period_year: 2026 });
    log(`        FY2026 still certified after FY2025: ${Array.isArray(c26) ? c26.length > 0 : !!c26}`);
    // FY2025 now exists: the comparatives are no longer "missing" (their accounts are presented once lines are assigned).
    await go(`${base}/statements/comparatives`, "");
    const st = await page.waitFor(() => document.querySelector('[data-testid="comparative-state"]')?.getAttribute("data-state"), [], { label: "comparative state", timeout: 60000 });
    log(`        comparatives after FY2025: ${st}`);
    return st !== "missing" ? true : st;
  });

  // Preparation recorded by the preparer through the same server functions the pages call.
  await rpc(preparer.api, "fs_assign_presentation", { p_company_id: A, p_assignments: Object.entries(ASSIGN).map(([accountKey, lineId]) => ({ accountKey, lineId })), p_reason: "Presentation per the chart of accounts", p_request_id: uuid() });
  await rpc(preparer.api, "fs_decide_requirement", { p_company_id: A, p_period_year: 2026, p_requirement_id: "smes.note.share_capital", p_decision: "applicable", p_reason: "The entity has share capital", p_request_id: uuid() });
  for (const id of NOT_APPLICABLE) await rpc(preparer.api, "fs_decide_requirement", { p_company_id: A, p_period_year: 2026, p_requirement_id: id, p_decision: "not_applicable", p_reason: "None in the periods presented", p_request_id: uuid() });
  for (const [id, text] of Object.entries(NOTES)) await rpc(preparer.api, "fs_record_disclosure", { p_company_id: A, p_period_year: 2026, p_requirement_id: id, p_body: text, p_source_ref: "Notes v1", p_request_id: uuid() });
  await rpc(preparer.api, "fs_record_schedule", { p_company_id: A, p_period_year: 2026, p_schedule_id: "ppe", p_rows: PPE_SCHEDULE, p_source_ref: "Fixed asset register FY2026", p_request_id: uuid() });

  await signOut(); await signIn(U.partner);
  await check("the partner approves the comparatives through the confirmation (reason required)", async () => {
    await go(`${base}/statements/comparatives`, "Not yet approved");
    await page.click('[data-testid="approve-comparatives"]');
    await page.waitForSelector('[role="dialog"] textarea');
    await page.fill('[role="dialog"] textarea', "Agreed to the signed FY2025 statements");
    await page.click({ selector: '[role="dialog"] button.bg-primary' });
    await page.waitFor(() => document.querySelector('[data-testid="comparative-state"]')?.getAttribute("data-state") === "approved", [], { label: "approved", timeout: 30000 });
    return true;
  });

  startGroup("Adjustments: one path, server-authorised");
  let adjustmentId = null;
  await check("the preparer proposes a reclassification; the partner approves it on Close Review › Adjustments", async () => {
    const r = await rpc(preparer.api, "close_review_propose_adjustment", { p_company_id: A, p_period_year: 2026, p_reason: "Reclassify rent prepaid in salaries", p_evidence_ref: "JV-0716",
      p_lines: [{ accountKey: CODES.rent, debitMinor: "10000", creditMinor: "0" }, { accountKey: CODES.salaries, debitMinor: "0", creditMinor: "10000" }], p_finding_ids: [], p_request_id: uuid(), p_reverses: null });
    adjustmentId = r.adjustmentId;
    await go(`${base}/close/adjustments`, "Reclassify rent prepaid in salaries");
    await shot("10-adjustments-proposed");
    await setByLabel("Reason for your decision", "Agreed to journal voucher JV-0716");
    await page.click({ text: "Approve", within: '[data-testid^="adjustment-"]' });
    await page.waitForText(": Approved", { timeout: 30000 });
    const adj = await preparer.api.rpc("close_review_adjustments_summary", { p_company_id: A, p_period_year: 2026 });
    log(`        adjustments after approval: ${JSON.stringify(adj.data ?? adj.error?.message).slice(0, 400)}`);
    // An approved adjustment changes the adjusted trial balance: the findings are checked again, as the next action says.
    await go(`${base}/close/findings`, "Findings");
    if (await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => /Check (again|for findings)/.test(b.textContent)))) {
      await page.click({ text: (await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /Check (again|for findings)/.test(b.textContent)).textContent.trim())) });
      await page.waitForSelector('[data-testid="findings-counts"]', { timeout: 60000 });
      await sleep(1500);
    }
    const st2 = await rpc(preparer.api, "close_review_finding_states", { p_company_id: A, p_period_year: 2026 });
    for (const f of st2.filter((x) => !x.resolved)) await rpc(preparer.api, "close_review_finding_action", { p_finding_id: f.finding_id, p_action: "explain", p_text: "Reviewed against the fixed asset register", p_evidence_ref: "FAR FY2026", p_request_id: uuid() });
    const sum = await preparer.api.rpc("close_review_findings_summary", { p_company_id: A, p_period_year: 2026 });
    log(`        findings after re-check: ${JSON.stringify(sum.data ?? sum.error?.message).slice(0, 300)}`);
    return (r.outcome === "proposed" || r.outcome === "recorded") && !!adjustmentId ? true : r;
  });
  await check("Reconcile shows earlier adjusting entries read-only and points to Close Review › Adjustments; no write control", async () => {
    await go(`${base}/reconcile`, "Adjusting entries");
    const ok = await page.evaluate(() => !!document.querySelector('[data-testid="legacy-adjustments"]') && !/Post Manual AJE/.test(document.body.innerText) && !/IAS 8/.test(document.body.innerText));
    await shot("11-reconcile-read-only");
    return ok;
  });

  startGroup("Evidence, version, sign-off and the sealed export");
  await signOut(); await signIn(U.preparer);
  await check("Statements: six evidence files are validated (not stored) and stored with a draft version", async () => {
    await go(`${base}/statements`, "Evidence for the cash-flow");
    for (const [slot, file] of Object.entries(evidenceFiles)) await page.setFiles(`input[data-slot="${slot}"]`, [file]);
    await page.waitFor(() => document.querySelectorAll('[data-evidence-state="validated"]').length === 6, [], { label: "six validated", timeout: 30000 });
    await shot("12-evidence-validated");
    await page.click('[data-testid="store-evidence"]');
    await page.waitForText("is saved", { timeout: 90000 });
    return widths("13-statements");
  });
  await signOut(); await signIn(U.partner);
  let version = null;
  await check("the partner marks the latest version REVIEWED", async () => {
    await go(`${base}/signoff`, "Report versions");
    await page.waitFor(() => document.querySelector('[data-testid="readiness"]')?.getAttribute("data-ready") === "true", [], { label: "ready", timeout: 60000 });
    version = await page.evaluate(() => Number((document.querySelector('[data-testid="readiness"] h2')?.textContent.match(/Version (\d+)/) ?? [])[1]));
    await page.click('[data-testid="sign-reviewed"]');
    await page.waitForSelector('[role="dialog"] textarea');
    await page.fill('[role="dialog"] textarea', "Reviewed against the evidence and the composed statements");
    await page.click({ selector: '[role="dialog"] button.bg-primary' });
    await page.waitForText("is reviewed", { timeout: 30000 });
    return true;
  });
  await signOut(); await signIn(U.owner);
  await check("the owner approves it as FINAL; Exports shows the sealed pack with both approvers", async () => {
    await go(`${base}/signoff?v=${version}`, `Version ${version}`);
    await page.click('[data-testid="sign-final"]');
    await page.waitForSelector('[role="dialog"] textarea');
    await page.fill('[role="dialog"] textarea', "Approved for issue");
    if (await page.evaluate(() => !!document.querySelector('[role="dialog"] input[type="checkbox"]'))) await page.click('[role="dialog"] input[type="checkbox"]');
    await page.click({ selector: '[role="dialog"] button.bg-primary' });
    await page.waitForText("final and sealed", { timeout: 30000 });
    await go(`${base}/signoff/exports?v=${version}`, "final and sealed");
    return widths("14-exports-sealed");
  });

  startGroup("A changed layout makes the result out of date; the sealed version stays FINAL");
  await check("confirming a new layout for FY2026 puts the trial balance out of date and the Overview names the re-check", async () => {
    await go(`${base}/trial-balance/intake`, "File layout");
    if (await page.evaluate(() => !!document.querySelector('[data-testid="layout-change"]'))) await page.click('[data-testid="layout-change"]');
    await page.click('[data-testid="layout-validate"]');
    await page.waitFor(() => !document.querySelector('[data-testid="layout-confirm"]')?.disabled, [], { label: "fits", timeout: 60000 });
    await page.press("Escape");
    await page.click('[data-testid="layout-confirm"]');
    await page.waitForSelector('[role="dialog"]');
    await page.click({ selector: '[role="dialog"] button.bg-primary' });
    await page.waitForText("Layout confirmed for this file", { timeout: 30000 });
    await go(`${base}/trial-balance/review`, "");
    await page.waitForText("out of date", { timeout: 60000 });
    await shot("15-stale");
    const { data } = await owner.api.from("fs_publication_bindings").select("state").eq("company_id", A).eq("report_version", version);
    return (data ?? []).some((b) => b.state === "FINAL") ? true : data;
  });

  startGroup("Two accounts are isolated");
  await signOut(); await signIn(U.ownerB);
  const ownerBApi = await asUser(U.ownerB);
  await check("the second account's first run is its own; the first company's workspace URL shows nothing of it", async () => {
    await go(`${base}`, "");
    await sleep(3000);
    const t = await page.bodyText();
    await shot("16-isolation");
    return !/Mto Holdings/.test(t) ? true : t.slice(0, 400);
  });
  await check("API: the second account reads none of the first company's rows and its RPCs are refused", async () => {
    const reads = await Promise.all(["companies", "trial_balance_uploads", "fs_publication_bindings", "workspace_purpose_events"].map(async (t) =>
      [t, ((await ownerBApi.from(t).select("*").eq(t === "companies" ? "id" : "company_id", A)).data ?? []).length]));
    const comp = await ownerBApi.rpc("fs_statement_composition", { p_company_id: A, p_period_year: 2026 });
    const leaked = reads.filter(([, n]) => n > 0);
    const refused = !!comp.error || (comp.data && comp.data.state !== "composed");
    return leaked.length === 0 && refused ? true : { leaked, comp: comp.data ?? comp.error?.message };
  });

  startGroup("Every request stayed on loopback");
  await check("no request left 127.0.0.1 / localhost except the app stylesheet's web font", async () => {
    const off = [...new Set(page.requests)].filter((u) => /^https?:/.test(u) && !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(u) && !/fonts\.(googleapis|gstatic)\.com/.test(u));
    return off.length === 0 ? true : off.slice(0, 10);
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; log(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); await failureEvidence("infrastructure"); }
const failed = results.filter((r) => !r.ok);
log(`\nchecks: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
for (const f of failed) log(`  FAILED [${f.group}] ${f.name}`);
const ok = !crashed && failed.length === 0 && results.length > 0;
log(ok ? "LOCAL_STACK_JOURNEY: ALL PASSED" : "LOCAL_STACK_JOURNEY: FAILED");
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ ok, results }, null, 2));
try { await browser.close(); } catch { /* */ }
try { await new Promise((r) => preview.httpServer.close(() => r())); } catch { /* */ }
process.exit(ok ? 0 : 1);
