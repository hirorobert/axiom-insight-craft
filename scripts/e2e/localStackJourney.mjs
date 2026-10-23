#!/usr/bin/env node
// The REAL application, end to end, on a LOCAL Supabase stack (`supabase start` in CI: real Auth, PostgREST, RLS, Storage
// and Edge Functions; the migrations in supabase/migrations applied by the CLI). Nothing here is an isolated page or a
// bridge: the production build of the app is served on loopback and driven in headless Chrome by real signed-in users.
//
//   routing     an unauthenticated deep link lands on sign-in; a wrong password is refused; sign-in by keyboard
//   new user    first visit offers Add company and a focused upload link; dedicated company setup creates the company (FY ending 30 June); with one service the entry card
//               ("Check your trial balance") replaces the launchpad and the data choice (Phase 2 §5.1); previously the launchpad and data choice
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
//   first upload the second account's first visit: drop zone → private draft → confirmation card (entity, 'Year ended
//               30 June 2026', TZS) → entity, dated period and file saved through the existing authorities → the
//               server's check on the same page → its result page (Phase 2 P2-3)
//   tb workflow a title naming the entity differently and a cash-in-transit balance are decided through the findings list
//               (same entity with confirmation and reason; an explanation with evidence), the evaluation invalidated at once,
//               re-checked and ACCEPTED citing both decisions; a rename removes authority at once; an out-of-balance year
//               uploaded on /upload is investigated (leads, never a plug); the engagements list (status, count, search,
//               filter) is the server's; a saved upload is removed only on confirmation; another entity's file is blocked
//               with its recovery
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
const U = { owner: mk("owner"), preparer: mk("preparer"), partner: mk("partner"), ownerB: mk("ownerb"), noPlan: mk("noplan"), ownerC: mk("ownerc"), ownerT: mk("ownert") };
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
await grantPlan(U.ownerC.id);
await grantPlan(U.ownerT.id);
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
/**
 * Chooses a currency in the searchable selector (CurrencySelect, an ARIA combobox) found by its label: types the code,
 * then presses Enter on the highlighted match — an explicit choice, as a person makes it. True when it took.
 */
const chooseCurrency = async (label, code) => {
  const typed = await page.evaluate((lab, val) => {
    const l = [...document.querySelectorAll("label")].find((x) => x.textContent.trim().toLowerCase().startsWith(lab.toLowerCase()));
    const el = l && (l.control ?? document.getElementById(l.htmlFor));
    if (!el || el.getAttribute("role") !== "combobox") return false;
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, val);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, label, code);
  if (!typed) return false;
  await sleep(150);
  return page.evaluate((lab, val) => {
    const l = [...document.querySelectorAll("label")].find((x) => x.textContent.trim().toLowerCase().startsWith(lab.toLowerCase()));
    const el = l && (l.control ?? document.getElementById(l.htmlFor));
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    return el.dataset.value === val || new Promise((r) => setTimeout(() => r(el.dataset.value === val), 150));
  }, label, code);
};
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
// The currency journey (invented): the same balanced trial balance with its amount columns labelled TZS, labelled USD, and
// labelled with two currencies; and a small unlabelled one that does not balance (its check is refused, so nothing is
// accepted in the period's currency).
const relabel = (debit, credit) => tbCsv(CURRENT).replace(/^Account code,Account name,Debit,Credit\n/, `Account code,Account name,${debit},${credit}\n`);
const tbLabelledTzs = writeFile("mlima-invented-tb-labelled-tzs.csv", relabel("Debit TZS", "Credit TZS"));
const tbLabelledUsd = writeFile("mlima-invented-tb-labelled-usd.csv", relabel("Debit USD", "Credit USD"));
const tbMixed = writeFile("mlima-invented-tb-mixed-labels.csv", relabel("Debit TZS", "Credit USD"));
const tbUnbalanced = writeFile("mlima-invented-tb-unbalanced.csv", "Account code,Account name,Debit,Credit\n10457,Invented bank,1000,\n30111,Invented capital,,900\n");
// The Trial Balance workflow (invented): the balanced trial balance whose title names the entity differently and which
// carries a cash-in-transit balance (with its counterpart, so it still balances); the same without a title but with one
// unmatched amount (out of balance by 120.00); and one whose title names another entity.
const withRows = (extra, title = null) => (title ? `${title}\n\n` : "") + tbCsv(CURRENT) + extra;
const tbKilimo = writeFile("kilimo-invented-tb-fy2026.csv", withRows("10990,Cash in transit,500.00,\n20990,Invented accrued charges,,500.00\n", "Kilimo Invented Trading Co"));
const tbKilimoImbalanced = writeFile("kilimo-invented-tb-fy2025.csv", withRows("11990,Invented deposits,120.00,\n"));
const tbOtherEntity = writeFile("kilimo-invented-tb-fy2027.csv", withRows("", "Pwani Invented Other Enterprises Ltd"));
const tbKilimoReplacement = writeFile("kilimo-invented-tb-fy2026-corrected.csv", withRows("10990,Cash in transit,650.00,\n20990,Invented accrued charges,,650.00\n", "Kilimo Invented Trading Co"));
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
  await check("first visit: company setup is prominent, with upload on its own page and no inline company form", async () => {
    await go("/dashboard", "Companies & engagements");
    await page.waitForSelector('[data-testid="add-company"]', { timeout: 30000 });
    const layout = await widths("02-first-visit");
    const entry = await page.evaluate(() => ({ add: document.querySelector('[data-testid="add-company"]')?.getAttribute("href"), upload: document.querySelector('[data-testid="portfolio-upload-link"]')?.getAttribute("href"), inline: !!document.getElementById("fr-org") }));
    return layout === true && entry.add === "/companies/new" && entry.upload === "/upload" && !entry.inline ? true : { entry, layout };
  });
  await check("first run creates the company through the real form, reached by Add company (FY ending 30 June, TZS, IFRS for SMEs), and opens its workspace", async () => {
    await page.click('[data-testid="add-company"]');
    await page.waitForSelector("#fr-org", { timeout: 30000 });
    await widths("02-first-run");
    await page.fill("#fr-org", "Mto Holdings Limited");
    await pickRadix("#fr-year", "2026");
    await pickRadix("#fr-fye", "30 June");
    if (!(await chooseCurrency("Functional currency", "TZS"))) return "the currency could not be chosen";
    await pickRadix("#fr-framework", "IFRS for SMEs");
    await page.click('form[aria-label="Add an entity"] button[type=submit]');
    const url = await page.waitForUrl(/\/workspace\/[0-9a-f-]{36}\/2026/, { timeout: 45000 });
    A = url.match(/\/workspace\/([0-9a-f-]{36})\//)[1];
    base = `/workspace/${A}/2026`;
    return true;
  });
  await check("one service: the service is implied — 'Check your trial balance' leads to the upload page; neither removed question appears", async () => {
    await page.waitForSelector('[data-testid="trial-balance-entry"]', { timeout: 30000 });
    await shot("03-entry");
    const removed = await page.evaluate(() => !!document.querySelector('[data-testid="launchpad-heading"], [data-testid="data-choice-heading"]'));
    await page.click('[data-testid="entry-upload"]');
    await page.waitForUrl(/trial-balance|prepare/, { timeout: 30000 });
    return removed ? { removedScreenShown: true } : true;
  });

  startGroup("Explicit non-calendar periods");
  await check("Trial Balance › Intake sets 1 Jul 2025 – 30 Jun 2026 and the prior period 1 Jul 2024 – 30 Jun 2025 (TZS)", async () => {
    await go(`${base}/trial-balance/intake`, "Start date");
    await setByLabel("Start date", PERIODS.current.start); await setByLabel("End date", PERIODS.current.end);
    // The period already exists (first run, TZS): its currency is shown read-only with the server's rule, never editable.
    const readOnly = await page.evaluate(() => document.querySelector('[data-testid="period-currency-readonly"]')?.textContent ?? null);
    if (readOnly !== null) { if (readOnly.trim() !== "TZS") return { readOnlyCurrency: readOnly }; }
    else if (!(await chooseCurrency("Reporting currency", "TZS"))) return "the reporting currency could not be chosen";
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
        : document.querySelector('[data-testid="trial-balance-entry"]') ? "entry"
        : document.querySelector('[data-testid="launchpad-heading"]') ? "launchpad" : document.querySelector('[data-testid="data-choice-heading"]') ? "choice" : null), [], { label: "uploader or entry", timeout: 45000 });
      if (where === "uploader") return;
      if (where === "entry") { await page.click('[data-testid="entry-upload"]'); await sleep(1500); await go(`/workspace/${A}/${year}/trial-balance/review`, ""); continue; }
      if (where === "not-open") {
        // The period is not open: the page says so and links to its Overview, where the service is chosen.
        await page.click({ text: `Open FY${year}` });
        await page.waitForSelector('[data-testid="trial-balance-entry"], [data-testid="launchpad-heading"], [data-testid="data-choice-heading"]', { timeout: 30000 });
        if (await page.evaluate(() => !!document.querySelector('[data-testid="trial-balance-entry"]'))) await page.click('[data-testid="entry-upload"]');
        else if (await page.evaluate(() => !!document.querySelector('[data-testid="launchpad-heading"]'))) { await page.click('[data-testid="service-FINANCIAL_STATEMENTS"]'); await page.click('[data-testid="primary-cta"]'); }
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
    // Evidence only (never a pass/fail condition): the trial balance page while accounts still wait for a mapping
    // decision — the candidate genuine product screenshot for the public landing page (1280 × 900).
    if (year === 2026) {
      try { await go(`/workspace/${A}/${year}/trial-balance/review`, ""); await sleep(2500); await shot("05a-account-review-pending"); }
      catch (e) { log(`        (account-review screenshot not captured: ${String(e?.message ?? e).slice(0, 120)})`); }
      // ...and the list itself: "Review account classifications" opens the accounts awaiting a mapping decision.
      try {
        await page.click({ text: "Review account classifications" });
        await page.waitForSelector('[data-testid="account-review-workbench"]', { timeout: 30000 });
        await sleep(2000); // the button's own smooth scroll must finish first, or it overrides the jump below
        // The panel opens one account at a time; every account already carries a suggestion, so show the full list.
        await page.click({ text: "Show the full list", within: '[data-testid="account-review-workbench"]' }).catch(() => undefined);
        await sleep(1000);
        // A taller viewport: the panel is the last section of the page, so the page cannot scroll it to the top.
        await page.setViewport(1280, 1500);
        await sleep(800);
        const top = await page.evaluate(() => {
          const el = document.querySelector('[data-testid="account-review-workbench"]');
          el.scrollIntoView({ block: "start", behavior: "instant" });
          // The workspace may scroll an inner container rather than the window: bring the panel to the top of whichever does.
          for (let p = el.parentElement; p; p = p.parentElement) if (p.scrollHeight > p.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(p).overflowY)) p.scrollTop += el.getBoundingClientRect().top - 72;
          window.scrollBy({ top: el.getBoundingClientRect().top - 72, behavior: "instant" });
          return Math.round(el.getBoundingClientRect().top);
        });
        await sleep(800);
        await shot("05b-account-review-list");
        await page.setViewport(1280, 900);
        log(`        account-review list panel top after scroll: ${top}px; rows: ${await page.evaluate(() => document.querySelectorAll('[data-testid="account-review-workbench"] tbody tr, [data-testid="account-review-workbench"] [role="row"]').length)}`);
        log(`        account-review list: ${await page.evaluate(() => document.querySelector('[data-testid="account-review-workbench"]')?.innerText.split(/\r?\n/).slice(0, 3).join(" | "))}`);
      } catch (e) { log(`        (account-review list not captured: ${String(e?.message ?? e).slice(0, 120)})`); }
    }
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
    // The decision needs its reason in React state before Approve is enabled; the click waits for the enabled button.
    await page.waitFor(() => { const b = [...document.querySelectorAll('[data-testid^="adjustment-"] button')].find((x) => x.textContent.trim() === "Approve"); return !!b && !b.disabled; }, [], { label: "Approve enabled", timeout: 15000 });
    await page.click({ text: "Approve", within: '[data-testid^="adjustment-"]' });
    await page.waitForText(`Adjustment ${r.number}: Approved`, { timeout: 30000 });
    // The server's own status decides, never the page.
    let status = null;
    for (let i = 0; i < 15 && status !== "approved"; i++) {
      const adj = await preparer.api.rpc("close_review_adjustments_summary", { p_company_id: A, p_period_year: 2026 });
      status = (adj.data?.adjustments ?? []).find((x) => x.id === adjustmentId)?.status ?? null;
      if (status !== "approved") await sleep(1000);
    }
    log(`        adjustment ${r.number} status on the server: ${status}`);
    if (status !== "approved") return { status };
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
  startGroup("Reviewer return: a blocking finding, the preparer's response, the reviewer's resolution (through PostgREST)");
  await signOut(); await signIn(U.partner);
  await check("the partner opens a BLOCKING finding on trade payables from the Statements page; the latest version is no longer ready", async () => {
    await go(`${base}/statements`, "Statement of Financial Position");
    await page.click('[data-comment-line="sfp.trade_and_other_payables"]');
    await page.waitForSelector('[data-testid="comment-composer"]', { timeout: 30000 });
    await page.fill('[data-testid="comment-body"]', "Payables look understated: the rent invoice for June is missing. Please check the accruals.");
    await page.click('[data-testid="comment-open"]');
    await page.waitForText("Recorded.", { timeout: 30000 });
    await go(`${base}/signoff`, "Reviewer comments");
    await page.waitFor(() => document.querySelector('[data-testid="readiness"]')?.getAttribute("data-ready") === "false", [], { label: "blocked by the finding", timeout: 60000 });
    const st = await page.evaluate(() => document.querySelector('[data-testid="review-comment"]')?.getAttribute("data-state"));
    await widths("12b-finding-opened");
    return st === "open" ? true : { st };
  });
  await signOut(); await signIn(U.preparer);
  await check("the preparer responds (no resolve control); the finding still blocks", async () => {
    await go(`${base}/signoff`, "Reviewer comments");
    const noResolve = await page.evaluate(() => !document.querySelector('[data-testid="comment-resolve"]'));
    await page.fill('[data-testid="comment-note"]', "Accrual checked against the June invoice; the balance is complete.");
    await page.click('[data-testid="comment-respond"]');
    await page.waitForText("Recorded.", { timeout: 30000 });
    await page.waitFor(() => document.querySelector('[data-testid="review-comment"]')?.getAttribute("data-state") === "responded", [], { label: "responded", timeout: 30000 });
    const ready = await page.evaluate(() => document.querySelector('[data-testid="readiness"]')?.getAttribute("data-ready"));
    return noResolve && ready === "false" ? true : { noResolve, ready };
  });
  await signOut(); await signIn(U.partner);
  await check("the partner resolves the finding; the version is ready again with the full history", async () => {
    await go(`${base}/signoff`, "Reviewer comments");
    await page.fill('[data-testid="comment-note"]', "Agreed: the accrual is in; resolved.");
    await page.click('[data-testid="comment-resolve"]');
    await page.waitForText("Recorded.", { timeout: 30000 });
    await page.waitFor(() => document.querySelector('[data-testid="readiness"]')?.getAttribute("data-ready") === "true", [], { label: "ready again", timeout: 60000 });
    const history = await page.evaluate(() => [...document.querySelectorAll('[data-testid="comment-history"] li')].map((li) => li.textContent.split(" ")[0]));
    await shot("12c-finding-resolved");
    return JSON.stringify(history) === JSON.stringify(["opened", "responded", "resolved"]) ? true : history;
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

  startGroup("The retained issued artifact: issue → server-sealed → verify → retrieve again (the real Edge Function and Storage)");
  let officialSha = null;
  await check("the owner issues the official pack of the FINAL version: the server stores and seals it; the page lists the sealed issuance with its SHA-256", async () => {
    await go(`${base}/signoff/exports?v=${version}`, "Official Reporting Pack");
    await page.click('[data-testid="issue-official"]');
    await page.waitForSelector('[data-testid="official-issuance"]', { timeout: 90000 });
    officialSha = await page.evaluate(() => document.querySelector('[data-testid="official-issuance"]')?.getAttribute("data-sha"));
    const t = await page.bodyText();
    const { data: rows } = await owner.api.from("reporting_pack_issuances").select("content_sha256, consumed_at, pack_kind, final_publication_id").eq("company_id", A).eq("pack_kind", "financial_statements_data").not("consumed_at", "is", null);
    await widths("14b-official-pack-issued");
    // The sealed row is bound to the FINAL publication and carries the digest the page shows.
    return /^[0-9a-f]{64}$/.test(officialSha ?? "") && /issued, stored and sealed by the server/.test(t) && rows?.length === 1 && rows[0].content_sha256 === officialSha && !!rows[0].final_publication_id ? true : { officialSha, t: t.slice(-400), rows };
  });
  await check("verify on the server re-reads the stored bytes: intact and official; retrieve returns the same bytes with the same digest as sealed", async () => {
    await page.click('[data-testid="verify-official"]');
    await page.waitForText("Verified:", { timeout: 60000 });
    await page.click('[data-testid="retrieve-official"]');
    await page.waitForText("Retrieved again", { timeout: 60000 });
    const t = await page.evaluate(() => document.querySelector('[data-testid="official-verdict"]')?.textContent ?? "");
    await shot("14c-official-pack-verified");
    return /matches the seal recorded at issue/.test(t) && !/WARNING/.test(t) ? true : t;
  });
  await check("issuing again does not duplicate or overwrite the retained artifact: a second issuance is a second sealed artifact (its canonical document names its own issuance, so its digest differs); the first row, its digest and its stored bytes are unchanged and still verify intact", async () => {
    const before = await owner.api.from("reporting_pack_issuances").select("id, content_sha256").eq("company_id", A).not("content_sha256", "is", null);
    await page.click('[data-testid="issue-official"]');
    await page.waitFor((n) => document.querySelectorAll('[data-testid="official-issuance"]').length >= n, [before.data.length + 1], { label: "second issuance", timeout: 90000 });
    const after = await owner.api.from("reporting_pack_issuances").select("id, content_sha256").eq("company_id", A).not("content_sha256", "is", null);
    const firstKept = before.data.every((b) => after.data.some((a) => a.id === b.id && a.content_sha256 === b.content_sha256));
    // The first artifact, verified again on the server after the second issuance: still intact, same digest.
    await page.click(`[data-testid="official-issuance"][data-sha="${officialSha}"] [data-testid="verify-official"]`);
    await page.waitFor((sha) => (document.querySelector(`[data-testid="official-issuance"][data-sha="${sha}"] [data-testid="official-verdict"]`)?.textContent ?? "").startsWith("Verified:"), [officialSha], { label: "first artifact verified", timeout: 60000 });
    const digests = new Set(after.data.map((a) => a.content_sha256));
    return firstKept && after.data.length === before.data.length + 1 && digests.size === after.data.length && after.data.every((a) => /^[0-9a-f]{64}$/.test(a.content_sha256)) ? true : { before: before.data, after: after.data };
  });

  startGroup("Next-period roll-forward: FY2027 from the issued FY2026 (carried decisions with provenance; evidence never carried)");
  await check("FY2027 (1 Jul 2026 - 30 Jun 2027) is uploaded through the uploader and reviewed; the prior issued report is untouched", async () => {
    const { data: fin0 } = await owner.api.from("fs_publication_bindings").select("document_sha256").eq("company_id", A).eq("report_version", version).eq("state", "FINAL");
    await uploadAndReview(2027, tbCurrent);
    const { data: fin1 } = await owner.api.from("fs_publication_bindings").select("document_sha256").eq("company_id", A).eq("report_version", version).eq("state", "FINAL");
    return fin0?.length === 1 && fin1?.[0]?.document_sha256 === fin0[0].document_sha256 ? true : { fin0, fin1 };
  });
  await signOut(); await signIn(U.preparer);
  await check("Comparatives of FY2027: the comparatives agree with the issued FY2026; the preparer carries FY2026's decisions and wording forward for review", async () => {
    await go(`/workspace/${A}/2027/statements/comparatives`, "Roll-forward from FY2026");
    await page.click('[data-testid="carry-forward"]');
    await page.waitForText("carried forward for review", { timeout: 60000 });
    await page.waitForSelector('[data-testid="carry"][data-status="carried"]', { timeout: 30000 });
    const n = await page.evaluate(() => document.querySelectorAll('[data-testid="carry"][data-status="carried"]').length);
    const pf = await page.evaluate(() => document.querySelector('[data-testid="rollforward"]')?.getAttribute("data-prior-final"));
    const ev = await page.evaluate(() => document.querySelector('[data-testid="evidence-to-supply"]')?.textContent ?? "");
    await widths("15b-rollforward-carried");
    return n >= 10 && pf === "reconciled" && /still to supply/.test(ev) ? true : { n, pf, ev };
  });
  await check("confirming one carried wording writes it for FY2027 through the notes authority; the notes page shows it provided with the FY2026 source; nothing else is current", async () => {
    await page.click('[data-testid="carry"][data-requirement="smes.note.policies"] [data-testid="carry-confirm"]');
    await page.waitForText("Confirmed for this period.", { timeout: 30000 });
    const st = await page.evaluate(() => document.querySelector('[data-testid="carry"][data-requirement="smes.note.policies"]')?.getAttribute("data-status"));
    const { data: rows } = await owner.api.from("fs_disclosure_texts").select("requirement_id, source_ref").eq("company_id", A).eq("period_year", 2027);
    return st === "confirmed" && rows?.length === 1 && rows[0].requirement_id === "smes.note.policies" && /Carried forward from FY2026/.test(rows[0].source_ref) ? true : { st, rows };
  });
  await signOut(); await signIn(U.owner);

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

  startGroup("Second account: the first upload on one page (Phase 2 P2-3; real components and server operations)");
  // The second account has a plan and no entity yet: the home links to the focused upload. Invented data only.
  let B = null;
  await check("the drop zone takes the file; it is stored privately as a draft, not yet in any entity", async () => {
    await go("/dashboard", "Companies & engagements");
    await page.click('[data-testid="portfolio-upload-link"]');
    await page.waitForSelector('[data-testid="first-upload-input"]', { timeout: 30000 });
    await page.setFiles('[data-testid="first-upload-input"]', [tbCurrent]);
    await page.waitForSelector('[data-testid="first-upload-confirm"]', { timeout: 60000 });
    const note = await page.evaluate(() => document.querySelector('[data-testid="first-upload-draft-note"]')?.textContent ?? "");
    const companies = ((await ownerBApi.from("companies").select("id")).data ?? []).length;
    const drafts = (await admin.from("trial_balance_drafts").select("state").eq("owner_ref", U.ownerB.id)).data ?? [];
    await widths("17-first-upload-draft");
    return /Stored privately as a draft\. Not yet added to your entity\./.test(note) && companies === 0 && drafts.length === 1 && drafts[0].state === "reserved" ? true : { note, companies, drafts };
  });
  await check("nothing is pre-filled or guessed; starting with empty fields lists what is missing and starts nothing", async () => {
    const empty = await page.evaluate(() => [...document.querySelectorAll('[data-testid="confirm-entity"], [data-testid="confirm-currency"]')].map((e) => e.value));
    await page.click('[data-testid="first-upload-start"]');
    await page.waitForSelector('[data-testid="first-upload-problems"]', { timeout: 10000 });
    const t = await page.evaluate(() => document.querySelector('[data-testid="first-upload-problems"]').textContent);
    const companies = ((await ownerBApi.from("companies").select("id")).data ?? []).length;
    return empty.every((v) => v === "") && /entity's name/.test(t) && /Choose the period/.test(t) && /currency/.test(t) && companies === 0 ? true : { empty, t, companies };
  });
  await check("the card: entity, 'Year' ending 30 June 2026 shows 'Year ended 30 June 2026 · 1 Jul 2025 – 30 Jun 2026', currency TZS", async () => {
    await setByLabel("Entity name", "Kilima Invented Traders Ltd");
    await page.click('[data-testid="confirm-period-year"]');
    await sleep(200);
    await setByLabel("Ends on", "2026-06-30");
    if (!(await chooseCurrency("Trial balance currency", "TZS"))) return "the currency could not be chosen";
    await sleep(300);
    const d = await page.evaluate(() => document.querySelector('[data-testid="confirm-period-derived"]')?.textContent ?? "");
    await widths("18-first-upload-confirm");
    return /Year ended 30 June 2026/.test(d) && /1 Jul 2025 – 30 Jun 2026/.test(d) ? true : d;
  });
  let resultUrl = null;
  await check("'Start trial balance check' saves the entity, the dated period and the file, runs the server's check, and opens THAT upload's result", async () => {
    await page.click('[data-testid="first-upload-start"]');
    await page.waitFor(() => /\/trial-balance\/review\?upload=/.test(location.pathname + location.search) || !!document.querySelector('[data-testid="first-upload-failure"]'), [], { timeout: 180000, label: "the result or a refusal" });
    const failure = await page.evaluate(() => document.querySelector('[data-testid="first-upload-failure"]')?.textContent ?? null);
    if (failure) return { failure };
    resultUrl = await page.evaluate(() => location.pathname + location.search);
    await page.waitForSelector('[data-testid="trial-balance-current-task"]', { timeout: 60000 });
    await widths("19-first-upload-result");
    const co = (await ownerBApi.from("companies").select("id, name")).data ?? [];
    B = co[0]?.id ?? null;
    const period = (await admin.from("fiscal_periods").select("reporting_start, reporting_end, reporting_currency").eq("company_id", B)).data ?? [];
    const ups = (await admin.from("trial_balance_uploads").select("id, file_path, period_year, period_id, status").eq("company_id", B)).data ?? [];
    const draft = (await admin.from("trial_balance_drafts").select("state, committed_upload_id").eq("owner_ref", U.ownerB.id)).data ?? [];
    return co.length === 1 && co[0].name === "Kilima Invented Traders Ltd" && resultUrl === `/workspace/${B}/2026/trial-balance/review?upload=${ups[0]?.id}`
      && period.length === 1 && period[0].reporting_start === "2025-07-01" && period[0].reporting_end === "2026-06-30" && period[0].reporting_currency === "TZS"
      && ups.length === 1 && ups[0].file_path.startsWith(`workspaces/${B}/`) && ups[0].period_year === 2026 && !!ups[0].period_id
      && draft.length === 1 && draft[0].state === "committed" && draft[0].committed_upload_id === ups[0].id ? true : { co, resultUrl, period, ups, draft };
  });
  await check("refresh keeps the exact upload; Back returns to focused upload, then the prior home continues to the same entity and period", async () => {
    await page.evaluate(() => location.reload()); // a refresh, not a new history entry
    await sleep(1500);
    await page.waitForSelector('[data-testid="trial-balance-current-task"]', { timeout: 60000 });
    const afterRefresh = await page.evaluate(() => location.pathname + location.search);
    await page.evaluate(() => history.back());
    await page.waitFor(() => location.pathname === "/upload", [], { timeout: 30000, label: "back to the focused upload page" });
    await page.waitForSelector('[data-testid="first-upload-input"]', { timeout: 30000 });
    const afterFirstBack = await page.evaluate(() => location.pathname);
    await page.evaluate(() => history.back());
    await page.waitFor((b) => location.pathname.startsWith(`/workspace/${b}/2026`) && !location.search.includes("upload="), [B], { timeout: 45000, label: "back to the same entity and period" });
    const afterBack = await page.evaluate(() => location.pathname);
    return afterRefresh === resultUrl && afterFirstBack === "/upload" ? true : { resultUrl, afterRefresh, afterFirstBack, afterBack };
  });

  startGroup("Purchase required: the draft is kept and the customer continues after choosing a plan (Phase 2 P2-4)");
  // A new account with NO plan. Nothing here charges or grants anything through payments: the plan is recorded the way
  // an operator records one (the same helper the journey uses for every account), standing in for a completed purchase.
  await signOut(); await signIn(U.noPlan);
  const noPlanApi = await asUser(U.noPlan);
  await check("no plan: the upload is offered with the plan stated up front; the file is stored as a draft", async () => {
    await go("/dashboard", "Companies & engagements");
    await page.click('[data-testid="portfolio-upload-link"]');
    await page.waitForSelector('[data-testid="first-upload-needs-plan"]', { timeout: 30000 });
    await page.setFiles('[data-testid="first-upload-input"]', [tbCurrent]);
    await page.waitForSelector('[data-testid="first-upload-confirm"]', { timeout: 60000 });
    await widths("20-no-plan-draft");
    const d = (await admin.from("trial_balance_drafts").select("state").eq("owner_ref", U.noPlan.id)).data ?? [];
    return d.length === 1 && d[0].state === "reserved" ? true : d;
  });
  await check("'Start' explains that a plan is needed and offers 'Choose a plan'; nothing is created, nothing is processed", async () => {
    await setByLabel("Entity name", "Pwani Invented Supplies Ltd");
    await page.click('[data-testid="confirm-period-year"]'); await sleep(200);
    await setByLabel("Ends on", "2026-06-30");
    if (!(await chooseCurrency("Trial balance currency", "TZS"))) return "the currency could not be chosen";
    await sleep(300);
    await page.click('[data-testid="first-upload-start"]');
    await page.waitForSelector('[data-testid="first-upload-failure"]', { timeout: 60000 });
    const t = await page.evaluate(() => document.querySelector('[data-testid="first-upload-failure"]').textContent);
    const plan = await page.evaluate(() => !!document.querySelector('[data-testid="first-upload-choose-plan"]'));
    const companies = ((await noPlanApi.from("companies").select("id")).data ?? []).length;
    const ups = ((await admin.from("trial_balance_uploads").select("id").eq("user_id", U.noPlan.id)).data ?? []).length;
    return /needs a plan/.test(t) && plan && companies === 0 && ups === 0 ? true : { t, plan, companies, ups };
  });
  await check("after a plan exists, the home offers 'Continue saved upload' for the same draft, with the card as it was; the check completes", async () => {
    await grantPlan(U.noPlan.id);
    await go("/dashboard", "Companies & engagements");
    await page.click('[data-testid="portfolio-upload-link"]');
    await page.waitForSelector('[data-testid="first-upload-continue-draft"]', { timeout: 30000 });
    await page.click('[data-testid="first-upload-continue-draft"]');
    await page.waitForSelector('[data-testid="first-upload-confirm"]', { timeout: 30000 });
    const kept = await page.evaluate(() => [document.querySelector('[data-testid="confirm-entity"]')?.value, document.querySelector('[data-testid="confirm-currency"]')?.dataset.value]);
    await page.click('[data-testid="first-upload-start"]');
    await page.waitFor(() => /\/trial-balance\/review\?upload=/.test(location.pathname + location.search) || !!document.querySelector('[data-testid="first-upload-failure"]'), [], { timeout: 180000, label: "the result or a refusal" });
    const failure = await page.evaluate(() => document.querySelector('[data-testid="first-upload-failure"]')?.textContent ?? null);
    const drafts = (await admin.from("trial_balance_drafts").select("state").eq("owner_ref", U.noPlan.id)).data ?? [];
    const co = (await noPlanApi.from("companies").select("name")).data ?? [];
    await widths("21-no-plan-continued");
    return !failure && kept[0] === "Pwani Invented Supplies Ltd" && kept[1] === "TZS" && drafts.length === 1 && drafts[0].state === "committed"
      && co.length === 1 && co[0].name === "Pwani Invented Supplies Ltd" ? true : { failure, kept, drafts, co };
  });

  startGroup("Currency: read before processing; a refused currency is corrected through the one server operation (invented data)");
  await signOut(); await signIn(U.ownerC);
  const ownerCApi = await asUser(U.ownerC);
  let C = null, periodC = null, upC = null;
  const fillCard = async (currency) => {
    await setByLabel("Entity name", "Mlima Invented Foods Ltd");
    await page.click('[data-testid="confirm-period-year"]'); await sleep(200);
    await setByLabel("Ends on", "2026-06-30");
    const ok = await chooseCurrency("Trial balance currency", currency);
    await sleep(500);
    return ok;
  };
  const chooseFirstFile = async (file) => {
    if (await page.evaluate(() => !!document.querySelector('[data-testid="first-upload-change-file"]'))) { await page.click('[data-testid="first-upload-change-file"]'); await sleep(300); }
    await page.setFiles('[data-testid="first-upload-input"]', [file]);
    await page.waitForSelector('[data-testid="first-upload-confirm"]', { timeout: 60000 });
  };
  /** Waits until `cond` (evaluated in the page) has held continuously for `holdMs`; throws after `timeout`. */
  const waitSteady = async (cond, holdMs, timeout) => {
    const end = Date.now() + timeout; let since = null;
    while (Date.now() < end) {
      if (await page.evaluate(cond)) { since ??= Date.now(); if (Date.now() - since >= holdMs) return; } else since = null;
      await sleep(100);
    }
    throw new Error(`condition did not hold steadily for ${holdMs} ms within ${timeout} ms`);
  };
  const text = (id) => page.evaluate((i) => document.querySelector(`[data-testid="${i}"]`)?.textContent ?? null, id);
  const reviewC = () => `/workspace/${C}/2026/trial-balance/review`;
  const reloadCard = async () => { await go(reviewC(), ""); await page.waitForSelector('[data-testid="trial-balance-current-task"]', { timeout: 60000 }); await sleep(1200); };
  const latestUpload = async () => ((await admin.from("trial_balance_uploads").select("id, file_path, file_size, source_file_hash, processing_attempt, processing_result, status, uploaded_at")
    .eq("company_id", C).order("uploaded_at", { ascending: false }).limit(1)).data ?? [])[0];
  const BUCKET = "trial-balance-files";
  const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
  /** What a currency correction must never change: the upload rows, the stored source bytes, every certification. */
  const integrity = async () => {
    const ups = (await admin.from("trial_balance_uploads").select("id, file_path, file_size, source_file_hash, processing_attempt, processing_result").eq("company_id", C).order("id")).data ?? [];
    const bytes = [];
    for (const u of ups) { const d = await admin.storage.from(BUCKET).download(u.file_path); bytes.push(d.data ? sha(Buffer.from(await d.data.arrayBuffer())) : `missing:${d.error?.message}`); }
    const certs = (await admin.from("tb_certifications").select("*").in("upload_id", ups.map((u) => u.id)).order("id")).data ?? [];
    const runs = (await admin.from("engine_runs").select("id").eq("company_id", C)).data ?? [];
    return { ups: sha(JSON.stringify(ups)), bytes, certs: sha(JSON.stringify(certs)), certCount: certs.length, runs: runs.length };
  };

  await check("first upload: the file's TZS labels are shown against the chosen USD before anything runs; 'Start' lists the conflict and creates nothing", async () => {
    await go("/dashboard", "Companies & engagements");
    await page.click('[data-testid="portfolio-upload-link"]');
    await page.waitForSelector('[data-testid="first-upload-input"]', { timeout: 30000 });
    await chooseFirstFile(tbLabelledTzs);
    if (!(await fillCard("USD"))) return "the currency could not be chosen";
    await page.waitForSelector('[data-testid="first-upload-file-currency"][data-kind="conflict"]', { timeout: 30000 });
    const note = await text("first-upload-file-currency");
    await page.click('[data-testid="first-upload-start"]');
    await page.waitForSelector('[data-testid="first-upload-problems"]', { timeout: 10000 });
    const problems = await text("first-upload-problems");
    await widths("22-currency-precheck-conflict");
    const companies = ((await ownerCApi.from("companies").select("id")).data ?? []).length;
    return /labels its amounts in TZS/.test(note) && /not USD/.test(note) && /labelled TZS/.test(problems) && companies === 0 ? true : { note, problems, companies };
  });
  await check("'Use TZS' is an explicit choice: the currency becomes TZS only on that click, and the labels then match", async () => {
    const before = await page.evaluate(() => document.querySelector('[data-testid="confirm-currency"]')?.dataset.value);
    await page.click('[data-testid="first-upload-use-file-currency"]');
    await page.waitForSelector('[data-testid="first-upload-file-currency"][data-kind="match"]', { timeout: 10000 });
    const after = await page.evaluate(() => document.querySelector('[data-testid="confirm-currency"]')?.dataset.value);
    return before === "USD" && after === "TZS" ? true : { before, after };
  });
  await check("mixed labels (TZS and USD) are refused before anything runs: no currency choice can fix the file", async () => {
    await chooseFirstFile(tbMixed);
    if (!(await fillCard("TZS"))) return "the currency could not be chosen";
    await page.waitForSelector('[data-testid="first-upload-file-currency"][data-kind="mixed"]', { timeout: 30000 });
    const note = await text("first-upload-file-currency");
    await page.click('[data-testid="first-upload-start"]');
    await page.waitForSelector('[data-testid="first-upload-problems"]', { timeout: 10000 });
    const problems = await text("first-upload-problems");
    await widths("23-currency-precheck-mixed");
    const use = await page.evaluate(() => !!document.querySelector('[data-testid="first-upload-use-file-currency"]'));
    const companies = ((await ownerCApi.from("companies").select("id")).data ?? []).length;
    return /more than one currency/.test(note) && /more than one currency/.test(problems) && !use && companies === 0 ? true : { note, problems, use, companies };
  });
  await check("set-up: an unlabelled file that does not balance, in USD; its check is refused (nothing accepted)", async () => {
    await chooseFirstFile(tbUnbalanced);
    if (!(await fillCard("USD"))) return "the currency could not be chosen";
    await page.click('[data-testid="first-upload-start"]');
    await page.waitFor(() => /\/trial-balance\/review\?upload=/.test(location.pathname + location.search) || !!document.querySelector('[data-testid="first-upload-failure"]'), [], { timeout: 180000, label: "the result or a refusal" });
    const failure = await text("first-upload-failure");
    if (failure) return { failure };
    await page.waitForSelector('[data-testid="trial-balance-current-task"]', { timeout: 60000 });
    C = ((await ownerCApi.from("companies").select("id")).data ?? [])[0]?.id ?? null;
    const p = (await admin.from("fiscal_periods").select("id, reporting_currency").eq("company_id", C)).data ?? [];
    periodC = p[0]?.id ?? null;
    const ups = (await admin.from("trial_balance_uploads").select("id").eq("company_id", C)).data ?? [];
    const certs = (await admin.from("tb_certifications").select("is_blocking").in("upload_id", ups.map((u) => u.id))).data ?? [];
    return p.length === 1 && p[0].reporting_currency === "USD" && certs.length > 0 && certs.every((c) => c.is_blocking === true) ? true : { p, certs };
  });
  await check("Replace with a mixed-label file is refused before upload, next to Replace; the current trial balance is unchanged", async () => {
    await page.setFiles('[data-testid="trial-balance-replace-input"]', [tbMixed]);
    await page.waitForSelector('[data-testid="trial-balance-replace-refusal"]', { timeout: 30000 });
    const t = await text("trial-balance-replace-refusal");
    const ups = (await admin.from("trial_balance_uploads").select("id").eq("company_id", C)).data ?? [];
    return /more than one currency/.test(t) && ups.length === 1 ? true : { t, ups };
  });
  await check("Replace with the TZS-labelled file is stated before anything runs, with the supported route; nothing changed yet", async () => {
    await page.setFiles('[data-testid="trial-balance-replace-input"]', [tbLabelledTzs]);
    await page.waitForSelector('[data-testid="replace-currency-confirm"]', { timeout: 30000 });
    const t = await text("replace-currency-confirm");
    await widths("24-currency-replace-confirm");
    const ups = (await admin.from("trial_balance_uploads").select("id").eq("company_id", C)).data ?? [];
    return /labels its amounts in TZS/.test(t) && /reports in USD/.test(t) && ups.length === 1 ? true : { t, ups };
  });
  await check("the original dead end: the check is refused for the currency, and no pre-existing path can change the period's currency", async () => {
    await page.click('[data-testid="replace-currency-anyway"]');
    await page.waitForSelector('[data-testid="currency-correction-offer"]', { timeout: 180000 });
    // The page refreshes the card while the replacement's check finishes (run 39267740177 read it mid-refresh: offer and
    // the card's own action briefly absent, both present in the screenshot taken just after). Read only once the server's
    // result is final AND the offer and the card's action have both been on screen continuously for a full second.
    for (let i = 0; i < 90; i++) { const u = await latestUpload(); if (u?.processing_result?.ingestion && u.status !== "processing") break; await sleep(1000); }
    await waitSteady(() => !!document.querySelector('[data-testid="currency-correction-offer"]') && !!document.querySelector('[data-testid="trial-balance-primary-action"]'), 1000, 60000);
    upC = (await latestUpload())?.id;
    const codes = ((await latestUpload())?.processing_result?.ingestion?.issues ?? []).map((x) => x.code);
    // The paths that existed before this repair: a direct change of the period (the processing lock and the fence refuse it).
    const direct = await ownerCApi.from("fiscal_periods").update({ reporting_currency: "TZS" }).eq("id", periodC).select("id");
    const still = (await admin.from("fiscal_periods").select("reporting_currency").eq("id", periodC)).data?.[0]?.reporting_currency;
    const offer = await text("currency-correction-offer");
    const emphasis = await page.evaluate(() => document.querySelector('[data-testid="trial-balance-primary-action"]')?.dataset.actionEmphasis ?? null);
    await widths("25-currency-correction-offer");
    return codes.includes("CURRENCY_MISMATCH") && (!!direct.error || (direct.data ?? []).length === 0) && still === "USD"
      && /labelled TZS; the period reports in USD/.test(offer) && (emphasis === null || emphasis === "secondary") ? true : { codes, direct: direct.error?.message ?? direct.data, still, offer, emphasis };
  });
  await check("downstream record: with management inputs recorded on this trial balance, the card names them and offers no correction", async () => {
    const ins = await admin.from("management_inputs").insert({ company_id: C, upload_id: upC, period_year: 2026, created_by: U.ownerC.id }).select("id");
    if (ins.error) return `insert: ${ins.error.message}`;
    await reloadCard();
    await page.waitForSelector('[data-testid="currency-correction-blocked"]', { timeout: 30000 });
    const t = await text("currency-correction-blocked"), route = await text("currency-correction-route");
    const control = await page.evaluate(() => !!document.querySelector('[data-testid="currency-correction-start"]'));
    await widths("26-currency-blocked-downstream");
    await admin.from("management_inputs").delete().eq("id", ins.data[0].id);
    return /management inputs/.test(t) && /Replace the file with one whose amounts are in USD/.test(route) && !control ? true : { t, route, control };
  });
  await check("locked period: the card says it is locked and offers no correction; the server refuses the operation", async () => {
    const lock = await admin.from("fiscal_periods").update({ status: "locked" }).eq("id", periodC).select("id");
    if (lock.error) return `lock: ${lock.error.message}`;
    await reloadCard();
    await page.waitForSelector('[data-testid="currency-correction-blocked"]', { timeout: 30000 });
    const t = await text("currency-correction-blocked");
    const control = await page.evaluate(() => !!document.querySelector('[data-testid="currency-correction-start"]'));
    const api = await ownerCApi.rpc("correct_period_currency", { p_period_id: periodC, p_new_currency: "TZS", p_expected_currency: "USD", p_reason: "locked check", p_request_id: crypto.randomUUID() });
    await widths("27-currency-blocked-locked");
    await admin.from("fiscal_periods").update({ status: "open" }).eq("id", periodC);
    return /locked/.test(t) && !control && api.data?.outcome === "not_eligible" && api.data?.block?.code === "PERIOD_LOCKED" ? true : { t, control, api: api.data ?? api.error };
  });
  await check("unauthorised: a workspace member without prepare_close (viewer) and another workspace's owner can neither read nor correct it", async () => {
    const m = await admin.from("firm_members").insert({ company_id: C, user_id: U.noPlan.id, role: "viewer", accepted_at: new Date().toISOString() });
    if (m.error) return `viewer: ${m.error.message}`;
    const viewer = await asUser(U.noPlan), other = await asUser(U.ownerB);
    const args = { p_period_id: periodC, p_new_currency: "TZS", p_expected_currency: "USD", p_reason: "not allowed", p_request_id: crypto.randomUUID() };
    const out = [];
    for (const c of [viewer, other]) {
      out.push((await c.rpc("get_period_currency_correction", { p_period_id: periodC })).data?.outcome, (await c.rpc("correct_period_currency", args)).data?.outcome);
    }
    const still = (await admin.from("fiscal_periods").select("reporting_currency").eq("id", periodC)).data?.[0]?.reporting_currency;
    return out.every((o) => o === "not_found") && still === "USD" ? true : { out, still };
  });
  let before = null;
  await check("correction with a reason, three quick clicks, the re-check request failing on the network: one correction, recorded; the card shows the saved currency and 'Re-check now'", async () => {
    await reloadCard();
    await page.waitForSelector('[data-testid="currency-correction-offer"]', { timeout: 30000 });
    before = await integrity();
    // Fail exactly the first re-check request at the network (CDP Fetch), as a dropped connection would.
    let failed = 0;
    const onPaused = (msg) => {
      if (msg.sessionId !== page.sessionId || msg.method !== "Fetch.requestPaused") return;
      const id = msg.params.requestId;
      if (failed === 0 && msg.params.request.method === "POST") { failed++; void page.send("Fetch.failRequest", { requestId: id, errorReason: "ConnectionFailed" }); }
      else void page.send("Fetch.continueRequest", { requestId: id });
    };
    browser.listeners.add(onPaused);
    await page.send("Fetch.enable", { patterns: [{ urlPattern: "*/rest/v1/rpc/tbu_request_reprocess*" }] });
    try {
      await page.click('[data-testid="currency-correction-start"]');
      await page.waitForSelector('[data-testid="currency-correction-reason"]', { timeout: 10000 });
      // The reason is picked explicitly (none is pre-selected); "Other" with the person's own words.
      await page.click('[data-testid="currency-correction-preset-other"]');
      await page.fill('[data-testid="currency-correction-reason"]', "The invented ledger is kept in TZS; USD was chosen by mistake.");
      await sleep(200);
      await page.evaluate(() => { const b = document.querySelector('[data-testid="currency-correction-confirm"]'); b.click(); b.click(); b.click(); });
      await page.waitFor(() => !!document.querySelector('[data-testid="currency-correction-recheck-failed"], [data-testid="currency-correction-done"]'), [], { timeout: 60000, label: "the correction answer" });
    } finally {
      await page.send("Fetch.disable"); browser.listeners.delete(onPaused);
    }
    const shown = await text("currency-correction-recheck-failed");
    await widths("28-currency-recheck-failed");
    const p = (await admin.from("fiscal_periods").select("reporting_currency").eq("id", periodC)).data ?? [];
    const ev = (await admin.from("fiscal_period_events").select("detail, actor_user_id, actor_member_id, occurred_at").eq("period_id", periodC).eq("action", "currency_corrected")).data ?? [];
    return failed === 1 && /now reports in TZS \(saved\)/.test(shown ?? "") && p[0]?.reporting_currency === "TZS" && ev.length === 1 && ev[0].detail.from === "USD" && ev[0].detail.to === "TZS"
      && /kept in TZS/.test(ev[0].detail.reason) && ev[0].actor_user_id === U.ownerC.id && !!ev[0].actor_member_id && !!ev[0].occurred_at ? true : { failed, shown, p, ev };
  });
  await check("the correction changed no amount, source file, upload row or certification, and created no processing record", async () => {
    const after = await integrity();
    return JSON.stringify(after) === JSON.stringify(before) && before.bytes.every((b) => /^[0-9a-f]{64}$/.test(b)) ? true : { before, after };
  });
  await check("reload after the correction: the card reads the saved TZS and the recorded re-check, and offers 'Re-check now'", async () => {
    await reloadCard();
    await page.waitForSelector('[data-testid="currency-correction-recheck-needed"]', { timeout: 30000 });
    const t = await text("currency-correction-recheck-needed");
    await widths("29-currency-reload-recheck-needed");
    return /now reports in TZS/.test(t) && /checked against USD/.test(t) ? true : t;
  });
  await check("'Re-check now' retries through the normal path as a new attempt; the result is no longer refused for the currency; nothing else changed", async () => {
    await page.click('[data-testid="currency-correction-recheck"]');
    await page.waitForSelector('[data-testid="currency-correction-done"]', { timeout: 60000 });
    let last = null;
    const done = (u) => { const codes = (u?.processing_result?.ingestion?.issues ?? []).map((x) => x.code); return !!u && u.processing_attempt >= 2 && u.processing_result?.ingestion?.currency === "TZS" && !codes.includes("CURRENCY_MISMATCH"); };
    for (let i = 0; i < 90 && !done(last); i++) { last = await latestUpload(); if (!done(last)) await sleep(2000); }
    await reloadCard();
    const panel = await page.evaluate(() => !!document.querySelector('[data-testid="currency-correction"]'));
    await widths("30-currency-rechecked");
    const after = await integrity();
    const u = ((await admin.from("trial_balance_uploads").select("id, file_path, file_size, source_file_hash").eq("id", upC)).data ?? [])[0];
    const b0 = ((await admin.from("trial_balance_uploads").select("id").eq("company_id", C)).data ?? []).length;
    // Same source bytes; earlier certifications kept (one more, from the re-check); exactly the re-check's processing records.
    return done(last) && !panel && JSON.stringify(after.bytes) === JSON.stringify(before.bytes) && after.certCount > before.certCount && after.runs > before.runs && !!u && b0 === 2
      ? true : { attempt: last?.processing_attempt, currency: last?.processing_result?.ingestion?.currency, codes: (last?.processing_result?.ingestion?.issues ?? []).map((x) => x.code), panel, before, after };
  });
  await check("accepted certification (another workspace, accepted in TZS, awaiting review counts): Replace with a USD-labelled file is refused with the reason; no 'Replace anyway'", async () => {
    await signOut(); await signIn(U.ownerB);
    const ups = (await admin.from("trial_balance_uploads").select("id").eq("company_id", B)).data ?? [];
    const certs = (await admin.from("tb_certifications").select("is_blocking, requires_review").in("upload_id", ups.map((u) => u.id))).data ?? [];
    await go(`/workspace/${B}/2026/trial-balance/review`, "");
    await page.waitForSelector('[data-testid="trial-balance-current-task"]', { timeout: 60000 }); await sleep(1000);
    await page.setFiles('[data-testid="trial-balance-replace-input"]', [tbLabelledUsd]);
    await page.waitForSelector('[data-testid="trial-balance-replace-refusal"]', { timeout: 30000 });
    const t = await text("trial-balance-replace-refusal");
    const anyway = await page.evaluate(() => !!document.querySelector('[data-testid="replace-currency-anyway"]'));
    await widths("31-currency-blocked-accepted");
    return certs.some((c) => c.is_blocking === false) && /labelled USD/.test(t) && /already accepted in TZS/.test(t) && !anyway ? true : { certs, t, anyway };
  });

  startGroup("Trial Balance workflow: decisions, investigation, portfolio, focused upload (invented data)");
  await signOut(); await signIn(U.ownerT);
  const ownerTApi = await asUser(U.ownerT);
  let K = null;
  const tText = (id) => page.evaluate((i) => document.querySelector(`[data-testid="${i}"]`)?.textContent ?? null, id);
  const kUpload = async (year) => ((await admin.from("trial_balance_uploads").select("id, status, processing_attempt").eq("company_id", K).eq("period_year", year)
    .order("uploaded_at", { ascending: false }).limit(1)).data ?? [])[0] ?? null;
  const certCount = async (uploadId) => ((await admin.from("tb_certifications").select("id").eq("upload_id", uploadId)).data ?? []).length;
  /** Waits until the upload has one more certification than `before` and is no longer being checked. */
  const settledAfter = async (year, before, label) => {
    for (let i = 0; i < 120; i++) {
      const u = await kUpload(year);
      if (u && !["pending", "processing", "queued", "validating"].includes(u.status) && (await certCount(u.id)) > before) return u;
      await sleep(1500);
    }
    throw new Error(`${label}: the new check did not finish`);
  };
  const authoritativeK = async (year) => { const { data } = await ownerTApi.rpc("get_authoritative_certification", { p_company_id: K, p_period_year: year }); return (Array.isArray(data) ? data[0] : data)?.id ?? null; };
  const reviewK = (year) => `/workspace/${K}/${year}/trial-balance/review`;
  const recheckK = async (uploadId) => {
    const op = uuid();
    const { data: src } = await ownerTApi.from("trial_balance_uploads").select("source_file_hash").eq("id", uploadId).single();
    const accepted = await rpc(ownerTApi, "tbu_request_reprocess", { p_upload_id: uploadId, p_operation_id: op, p_expected_source_hash: src?.source_file_hash ?? null });
    if (accepted?.outcome !== "accepted" && accepted?.outcome !== "replayed") throw new Error(`re-check refused: ${JSON.stringify(accepted)}`);
    const { error } = await ownerTApi.functions.invoke("process-trial-balance", { body: { uploadId, clientRequestId: op } });
    if (error) throw new Error(`process-trial-balance: ${error.message}`);
  };
  const decisionCount = async (uploadId, code) => ((await admin.from("tb_finding_decisions").select("id").eq("upload_id", uploadId).eq("code", code)).data ?? []).length;
  /** Records one decision through the control and waits for it in the database (the "Recorded" note is transient). */
  const decide = async (uploadId, code, steps) => {
    const n0 = await decisionCount(uploadId, code);
    await page.click(`[data-testid="decision-open-${code}"]`);
    await page.waitForSelector(`[data-testid="decision-form-${code}"]`, { timeout: 10000 });
    await steps();
    await page.click('[data-testid="decision-record"]');
    for (let i = 0; i < 80; i++) {
      if ((await decisionCount(uploadId, code)) > n0) return;
      const refused = await tText("decision-error");
      if (refused) throw new Error(`the decision was refused: ${refused}`);
      await sleep(750);
    }
    throw new Error(`${code}: the decision was not recorded`);
  };
  const citedCodes = async (certId) => (certId ? ((await admin.from("tb_certification_findings").select("finding").eq("certification_id", certId)).data ?? []).map((r) => r.finding) : [])
    .filter((f) => f.decision).map((f) => f.code).sort().join();
  const openSettings = async () => {
    await page.evaluate(() => { const d = document.querySelector('[data-testid="engagement-settings"]'); if (d && !d.open) d.open = true; });
    await sleep(200);
  };
  const fillFirstCard = async (entity, ends) => {
    if (entity.existing) {
      await page.click('[data-testid="confirm-entity-existing"]'); await sleep(200);
      await setByLabel("Existing entity", entity.existing);
    } else await setByLabel("Entity name", entity.name);
    await page.click('[data-testid="confirm-period-year"]'); await sleep(200);
    await setByLabel("Ends on", ends);
    const ok = await chooseCurrency("Trial balance currency", "TZS");
    await sleep(400);
    return ok;
  };
  const startFirstCheck = async () => {
    await page.click('[data-testid="first-upload-start"]');
    await page.waitFor(() => /\/trial-balance\/review\?upload=/.test(location.pathname + location.search) || !!document.querySelector('[data-testid="first-upload-failure"]'), [], { timeout: 180000, label: "the result or a refusal" });
    return tText("first-upload-failure");
  };

  await check("a file whose title names the entity differently and carries a cash-in-transit balance: the entity decision is REQUIRED, the clearing balance is an optional review note; each finding listed once; nothing authoritative; the engagement and its settings are stated in the rail, not in the task", async () => {
    await go("/dashboard", "Companies & engagements");
    await page.click('[data-testid="portfolio-upload-link"]');
    await page.waitForSelector('[data-testid="first-upload-input"]', { timeout: 30000 });
    await page.setFiles('[data-testid="first-upload-input"]', [tbKilimo]);
    await page.waitForSelector('[data-testid="first-upload-confirm"]', { timeout: 60000 });
    if (!(await fillFirstCard({ name: "Kilimo Invented Holdings Ltd" }, "2026-06-30"))) return "the currency could not be chosen";
    const failure = await startFirstCheck();
    if (failure) return { failure };
    K = ((await ownerTApi.from("companies").select("id")).data ?? [])[0]?.id ?? null;
    // Reporting is enabled for this company, as the financial-statements group does for its own: the handoff is offered.
    { const { error } = await admin.rpc("fs_set_company_rollout", { p_company_id: K, p_enabled: true, p_reason: "Local end-to-end journey", p_operator_label: "e2e" }); if (error) return { rollout: error.message }; }
    await page.waitForSelector('[data-testid="decision-open-ENTITY_NAME_DIFFERS"]', { timeout: 120000 });
    const entity = await page.evaluate(() => document.querySelectorAll('[data-code="ENTITY_NAME_DIFFERS"]').length);
    const clearing = await page.evaluate(() => document.querySelectorAll('[data-code="CLEARING_ACCOUNT_BALANCE"]').length);
    const reqEntity = await tText("decision-requirement-ENTITY_NAME_DIFFERS");
    const reqClearing = await tText("decision-requirement-CLEARING_ACCOUNT_BALANCE");
    const rail = { entity: await tText("engagement-context-entity"), period: await tText("engagement-context-period"), settings: await page.evaluate(() => !!document.querySelector('[data-testid="engagement-settings"]')) };
    const settingsInTask = await page.evaluate(() => !!document.querySelector('main a[href="/settings"]'));
    await widths("30-tb-findings-required-vs-review");
    return K && entity === 1 && clearing === 1 && /^Needed before/.test(reqEntity ?? "") && /^Optional/.test(reqClearing ?? "")
      && rail.entity === "Kilimo Invented Holdings Ltd" && /2026/.test(rail.period ?? "") && rail.settings && !settingsInTask && (await authoritativeK(2026)) === null
      ? true : { K, entity, clearing, reqEntity, reqClearing, rail, settingsInTask };
  });
  await check("same entity: nothing pre-selected; recorded only with its confirmation and a reason; the evaluation is invalidated at once and the file is checked again", async () => {
    const up = await kUpload(2026); const before = await certCount(up.id);
    const lastCert = ((await admin.from("tb_certifications").select("id").eq("upload_id", up.id).order("sequence_no", { ascending: false }).limit(1)).data ?? [])[0]?.id;
    let preselected = null, disabledBefore = null;
    await decide(up.id, "ENTITY_NAME_DIFFERS", async () => {
      preselected = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="decision-choice-"]')].some((r) => r.checked));
      disabledBefore = await page.evaluate(() => document.querySelector('[data-testid="decision-record"]').disabled);
      await page.click('[data-testid="decision-choice-same_entity"]');
      await page.click('[data-testid="decision-confirm"]');
      await setByLabel("Reason", "The trading name of the same company (engagement letter)");
      await widths("31-tb-decision-entity");
    });
    const inv = (await admin.from("tb_certification_invalidations").select("reason").eq("certification_id", lastCert)).data ?? [];
    const d = (await admin.from("tb_finding_decisions").select("code, action, revision").eq("upload_id", up.id)).data ?? [];
    await settledAfter(2026, before, "after the entity decision");
    return preselected === false && disabledBefore === true && inv[0]?.reason === "finding_decision"
      && d.length === 1 && d[0].action === "same_entity" ? true : { preselected, disabledBefore, inv, d };
  });
  await check("accounts classified: the re-check is ACCEPTED with the cash-in-transit balance left as a review note (no explanation needed); the statements handoff is offered", async () => {
    const up = await kUpload(2026);
    const decisions = [...reviewDecisions(),
      { account_code: "10990", account_name: "Cash in transit", proposal_type: "NONE", decision_action: "USER_MANUAL_CLASSIFICATION", statement: "balance_sheet", classification: "current_assets", normal_balance: "debit" },
      { account_code: "20990", account_name: "Invented accrued charges", proposal_type: "NONE", decision_action: "USER_MANUAL_CLASSIFICATION", statement: "balance_sheet", classification: "current_liabilities", normal_balance: "credit" }];
    await rpc(ownerTApi, "resolve_account_review_batch", { p_company_id: K, p_upload_id: up.id, p_client_request_id: uuid(), p_decisions: decisions });
    const before = await certCount(up.id);
    await recheckK(up.id);
    await settledAfter(2026, before, "after classification");
    const cert = await authoritativeK(2026);
    await go(reviewK(2026), "ready for statement preparation", 120000);
    await page.waitForSelector('[data-testid="decision-open-CLEARING_ACCOUNT_BALANCE"]', { timeout: 30000 });
    const reqClearing = await tText("decision-requirement-CLEARING_ACCOUNT_BALANCE");
    const handoff = await page.evaluate(() => document.querySelector('[data-testid="statements-handoff"] a')?.getAttribute("href") ?? null);
    await widths("32-tb-accepted-review-note");
    return cert && (await citedCodes(cert)) === "ENTITY_NAME_DIFFERS" && /^Optional/.test(reqClearing ?? "") && handoff === `/workspace/${K}/2026/statements`
      ? true : { cert, cited: await citedCodes(cert), reqClearing, handoff };
  });
  await check("the optional explanation: evidence reference labelled as a recorded reference, not a matched bank transaction; Reconcile offered; the re-check stays accepted and cites both decisions", async () => {
    const up = await kUpload(2026); const before = await certCount(up.id);
    let reconcileLink = null, hint = null;
    await decide(up.id, "CLEARING_ACCOUNT_BALANCE", async () => {
      await page.click('[data-testid="decision-nature-in_transit"]');
      await setByLabel("Explanation", "Deposit of 30 June banked after hours; cleared on 1 July");
      await page.click('[data-testid="decision-evidence-reconciliation"]');
      reconcileLink = await page.evaluate(() => !![...document.querySelectorAll('a')].find((a) => /\/reconcile$/.test(a.getAttribute("href") ?? "")));
      await setByLabel("Reference", "June bank reconciliation, deposit line 4");
      hint = await tText("decision-reference-hint");
      await setByLabel("Reason", "Timing of the period-end deposit");
      await widths("33-tb-clearing-explanation");
    });
    await settledAfter(2026, before, "after the clearing explanation");
    const cert = await authoritativeK(2026);
    await go(reviewK(2026), "ready for statement preparation", 120000);
    await page.waitForSelector('[data-testid="decision-current-CLEARING_ACCOUNT_BALANCE"]', { timeout: 30000 });
    const decided = await tText("decision-current-CLEARING_ACCOUNT_BALANCE");
    return reconcileLink === true && /not matched to a bank transaction/.test(hint ?? "") && /not a matched bank transaction/.test(decided ?? "")
      && cert && (await citedCodes(cert)) === "CLEARING_ACCOUNT_BALANCE,ENTITY_NAME_DIFFERS" ? true : { reconcileLink, hint, decided, cert, cited: await citedCodes(cert) };
  });
  await check("engagement settings in the rail: requiring an explanation for clearing balances needs a reason, removes the result's authority at once, and the re-check is accepted on the recorded explanation", async () => {
    await openSettings();
    const before = await tText("clearing-policy-mode");
    await page.click('[data-testid="clearing-policy-change"]');
    await page.waitForSelector('[data-testid="clearing-policy-reason"]', { timeout: 10000 });
    const disabled = await page.evaluate(() => document.querySelector('[data-testid="clearing-policy-save"]').disabled);
    await setByLabel("Reason", "Engagement letter requires evidence for clearing balances");
    await page.click('[data-testid="clearing-policy-save"]');
    await page.waitFor(() => /explanation with evidence is required/.test(document.querySelector('[data-testid="clearing-policy-mode"]')?.textContent ?? ""), [], { timeout: 30000, label: "the policy saved" });
    await widths("34-engagement-settings-rail");
    const lost = await authoritativeK(2026);
    const up = await kUpload(2026); const n = await certCount(up.id);
    await recheckK(up.id);
    await settledAfter(2026, n, "after the policy change");
    const restored = await authoritativeK(2026);
    return /Review note/.test(before ?? "") && disabled === true && lost === null && restored && (await citedCodes(restored)) === "CLEARING_ACCOUNT_BALANCE,ENTITY_NAME_DIFFERS"
      ? true : { before, disabled, lost, restored };
  });
  await check("renaming the entity removes the result's authority at once, and the re-check asks for the entity decision AGAIN (a decision about the old name is not carried); deciding again restores it", async () => {
    const { error } = await ownerTApi.from("companies").update({ name: "Kilimo Invented Holdings Limited" }).eq("id", K);
    if (error) return { error: error.message };
    const after = await authoritativeK(2026);
    const up = await kUpload(2026); let n = await certCount(up.id);
    await recheckK(up.id);
    await settledAfter(2026, n, "after the rename");
    const pending = await authoritativeK(2026);
    await go(reviewK(2026), "");
    await page.waitForSelector('[data-testid="decision-open-ENTITY_NAME_DIFFERS"]', { timeout: 60000 });
    const req = await tText("decision-requirement-ENTITY_NAME_DIFFERS");
    n = await certCount(up.id);
    await decide(up.id, "ENTITY_NAME_DIFFERS", async () => {
      await page.click('[data-testid="decision-choice-same_entity"]');
      await page.click('[data-testid="decision-confirm"]');
      await setByLabel("Reason", "Same company after the change of name");
    });
    await settledAfter(2026, n, "after deciding again");
    const restored = await authoritativeK(2026);
    return after === null && pending === null && /^Needed before/.test(req ?? "") && restored ? true : { after, pending, req, restored };
  });
  await check("a corrected replacement file: no decision is carried to it (entity and — under the policy — the clearing balance are required again); the earlier upload and its decisions stay in the upload history", async () => {
    const prior = await kUpload(2026);
    const priorDecisions = await decisionCount(prior.id, "ENTITY_NAME_DIFFERS");
    await go(reviewK(2026), "");
    await page.waitForSelector('[data-testid="trial-balance-current-task"]', { timeout: 60000 }); await sleep(800);
    await page.setFiles('[data-testid="trial-balance-replace-input"]', [tbKilimoReplacement]);
    let next = null;
    for (let i = 0; i < 120 && !next; i++) { const u = await kUpload(2026); if (u && u.id !== prior.id) next = u; else await sleep(1000); }
    if (!next) return "the replacement was not created";
    await settledAfter(2026, 0, "the replacement's first check");
    await go(reviewK(2026), "");
    await page.waitForSelector('[data-testid="decision-open-ENTITY_NAME_DIFFERS"]', { timeout: 120000 });
    const reqE = await tText("decision-requirement-ENTITY_NAME_DIFFERS"), reqC = await tText("decision-requirement-CLEARING_ACCOUNT_BALANCE");
    const carried = (await decisionCount(next.id, "ENTITY_NAME_DIFFERS")) + (await decisionCount(next.id, "CLEARING_ACCOUNT_BALANCE"));
    const history = await tText("upload-history");
    await widths("35-tb-replacement-history");
    const kept = await decisionCount(prior.id, "ENTITY_NAME_DIFFERS");
    // Decide both so the period is accepted again (the engagements list below expects it ready).
    let n = await certCount(next.id);
    await decide(next.id, "ENTITY_NAME_DIFFERS", async () => {
      await page.click('[data-testid="decision-choice-same_entity"]');
      await page.click('[data-testid="decision-confirm"]');
      await setByLabel("Reason", "Same company; corrected export");
    });
    await settledAfter(2026, n, "after the replacement's entity decision");
    await go(reviewK(2026), "");
    await page.waitForSelector('[data-testid="decision-open-CLEARING_ACCOUNT_BALANCE"]', { timeout: 60000 });
    n = await certCount(next.id);
    await decide(next.id, "CLEARING_ACCOUNT_BALANCE", async () => {
      await page.click('[data-testid="decision-nature-in_transit"]');
      await setByLabel("Explanation", "Deposit of 30 June banked after hours; cleared on 1 July");
      await page.click('[data-testid="decision-evidence-document"]');
      await setByLabel("Reference", "July bank statement, line 2");
      await setByLabel("Reason", "Timing of the period-end deposit");
    });
    await settledAfter(2026, n, "after the replacement's clearing explanation");
    return /^Needed before/.test(reqE ?? "") && /^Needed before/.test(reqC ?? "") && carried === 0 && /Upload history\s*·\s*2/.test(history ?? "")
      && kept === priorDecisions && priorDecisions >= 1 && (await authoritativeK(2026)) ? true : { reqE, reqC, carried, history, kept, priorDecisions };
  });
  await check("the financial-statements handoff: from the accepted trial balance, 'Continue to financial statements' opens this engagement's statements", async () => {
    await go(reviewK(2026), "ready for statement preparation", 120000);
    await page.click('[data-testid="statements-handoff"] a');
    await page.waitFor((k) => location.pathname === `/workspace/${k}/2026/statements`, [K], { timeout: 30000, label: "the statements page" });
    await sleep(1500);
    const heading = await page.evaluate(() => document.querySelector("main h1, main h2")?.textContent ?? null);
    await widths("36-fs-handoff");
    return heading ? true : { heading };
  });
  await check("the focused upload page (/upload): an out-of-balance file for another year is blocked, and 'Look for likely causes' names the row equal to the difference, the possible cause and every row read — leads, never a plug", async () => {
    // (With one engagement the home opens it directly; the link from the engagements list is checked once there are two.)
    await go("/upload", "");
    await page.waitForSelector('[data-testid="first-upload-input"]', { timeout: 30000 });
    await widths("38-upload-page");
    await page.setFiles('[data-testid="first-upload-input"]', [tbKilimoImbalanced]);
    await page.waitForSelector('[data-testid="first-upload-confirm"]', { timeout: 60000 });
    if (!(await fillFirstCard({ existing: K }, "2025-06-30"))) return "the currency could not be chosen";
    const failure = await startFirstCheck();
    if (failure) return { failure };
    await page.waitForSelector('[data-testid="investigation-run"]', { timeout: 120000 });
    await page.click('[data-testid="investigation-run"]');
    await page.waitForSelector('[data-testid="investigation-leads"], [data-testid="investigation-no-leads"]', { timeout: 120000 });
    const leads = await tText("investigation-leads");
    const statement = await tText("investigation-statement");
    const cause = await page.evaluate(() => document.querySelector('[data-testid="investigation-cause"]')?.dataset.cause ?? null);
    const totals = await tText("investigation-totals");
    await page.waitForSelector('[data-testid="investigation-rows-count"]', { timeout: 30000 });
    const deposit = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="investigation-row-"][data-included="true"]')].find((r) => /11990/.test(r.textContent ?? ""))?.textContent ?? null);
    await page.click('[data-testid="investigation-filter-excluded"]');
    await page.waitFor(() => [...document.querySelectorAll('[data-testid^="investigation-row-"][data-included]')].every((r) => r.dataset.included === "false"), [], { timeout: 30000, label: "excluded rows only" });
    await widths("37-tb-investigation");
    const inv = (await admin.from("tb_investigations").select("status").eq("company_id", K)).data ?? [];
    return /120\.00/.test(leads ?? "") && /not conclusions/.test(statement ?? "") && !/plug|suspense entry/i.test(`${leads}${statement}`)
      && cause === "no_printed_totals" && /Rows read as accounts/.test(totals ?? "") && /120\.00/.test(deposit ?? "")
      && inv.length === 1 && inv[0].status === "completed" ? true : { leads, statement, cause, totals, deposit, inv };
  });
  await check("the engagements list: both periods with their status in words, exact count, a literal search and a status filter, all from the server; uploading is linked to /upload", async () => {
    await go("/dashboard", "");
    await page.waitForSelector('[data-testid="portfolio-count"]', { timeout: 30000 });
    const uploadLink = await page.evaluate(() => document.querySelector('[data-testid="portfolio-upload-link"]')?.getAttribute("href") ?? null);
    await page.waitFor(() => /of 2 engagement/.test(document.querySelector('[data-testid="portfolio-count"]')?.textContent ?? ""), [], { timeout: 30000, label: "two engagements" });
    const statuses = await page.evaluate(() => [...document.querySelectorAll('[data-testid="portfolio-table"] [data-testid="portfolio-status"]')].map((e) => e.dataset.status).sort());
    await page.click({ text: "Filters" });
    await page.waitForSelector('[data-testid="portfolio-filter-status"]');
    await setByLabel("Status", "blocked");
    await page.waitFor(() => /of 1 engagement/.test(document.querySelector('[data-testid="portfolio-count"]')?.textContent ?? ""), [], { timeout: 30000, label: "one blocked" });
    await setByLabel("Status", "");
    await setByLabel("Search entity or identifier", "Nothing_like_this%");
    await page.waitFor(() => /No engagements match/.test(document.querySelector('[data-testid="portfolio-count"]')?.textContent ?? ""), [], { timeout: 30000, label: "no match" });
    await widths("39-portfolio");
    return JSON.stringify(statuses) === JSON.stringify(["blocked", "ready"]) && uploadLink === "/upload" ? true : { statuses, uploadLink };
  });
  await check("saved uploads: a file stored but not started is listed on /upload and removed only after an explicit confirmation", async () => {
    await go("/upload", "");
    await page.waitForSelector('[data-testid="first-upload-input"]', { timeout: 30000 });
    await page.setFiles('[data-testid="first-upload-input"]', [tbOtherEntity]);
    await page.waitForSelector('[data-testid="first-upload-confirm"]', { timeout: 60000 });
    await go("/upload", "");
    await page.waitForSelector('[data-testid="saved-drafts"]', { timeout: 30000 });
    const rowId = await page.evaluate(() => [...document.querySelectorAll('[data-testid^="saved-draft-"]')].map((e) => e.dataset.testid).find((t) => /^saved-draft-[0-9a-f-]{36}$/.test(t))?.replace("saved-draft-", "") ?? null);
    if (!rowId) return "no saved upload listed";
    await page.click(`[data-testid="saved-draft-remove-${rowId}"]`);
    const stillThere = (await ownerTApi.rpc("list_trial_balance_drafts")).data?.some((d) => d.draft_id === rowId);
    await page.click(`[data-testid="saved-draft-confirm-${rowId}"]`);
    await page.waitFor((rid) => !document.querySelector(`[data-testid="saved-draft-${rid}"]`), [rowId], { timeout: 30000, label: "the row removed" });
    const gone = !((await ownerTApi.rpc("list_trial_balance_drafts")).data ?? []).some((d) => d.draft_id === rowId);
    return stillThere === true && gone ? true : { stillThere, gone };
  });
  await check("a file recorded as another entity's is BLOCKED with its recovery (remove it here; find the right engagement), never accepted", async () => {
    await go("/upload", "");
    await page.waitForSelector('[data-testid="first-upload-input"]', { timeout: 30000 });
    await page.setFiles('[data-testid="first-upload-input"]', [tbOtherEntity]);
    await page.waitForSelector('[data-testid="first-upload-confirm"]', { timeout: 60000 });
    if (!(await fillFirstCard({ existing: K }, "2027-06-30"))) return "the currency could not be chosen";
    const failure = await startFirstCheck();
    if (failure) return { failure };
    await page.waitForSelector('[data-testid="decision-open-ENTITY_NAME_DIFFERS"]', { timeout: 120000 });
    const up = await kUpload(2027); const before = await certCount(up.id);
    await decide(up.id, "ENTITY_NAME_DIFFERS", async () => {
      await page.click('[data-testid="decision-choice-different_entity"]');
      await page.click('[data-testid="decision-confirm"]');
      await setByLabel("Reason", "This file is the sister company's trial balance");
    });
    await settledAfter(2027, before, "after the wrong-entity decision");
    await go(reviewK(2027), "");
    await page.waitForSelector('[data-testid="wrong-entity-recovery"]', { timeout: 60000 });
    const recovery = await tText("wrong-entity-recovery");
    await widths("40-tb-wrong-entity");
    return /right engagement/.test(recovery ?? "") && (await authoritativeK(2027)) === null && (await kUpload(2027)).status === "blocked" ? true : { recovery };
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
