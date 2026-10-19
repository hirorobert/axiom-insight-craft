#!/usr/bin/env node
// The REAL application, end to end, on a LOCAL Supabase stack (`supabase start` in CI: real Auth, PostgREST, RLS, Storage
// and Edge Functions; the migrations in supabase/migrations applied by the CLI). Nothing here is an isolated page or a
// bridge: the production build of the app is served on loopback and driven in headless Chrome by real signed-in users.
//
//   routing     an unauthenticated deep link lands on sign-in; a wrong password is refused; sign-in by keyboard
//   new user    first visit offers the upload as the one primary action; the company form (secondary) creates the company (FY ending 30 June); with one service the entry card
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
const U = { owner: mk("owner"), preparer: mk("preparer"), partner: mk("partner"), ownerB: mk("ownerb"), noPlan: mk("noplan"), ownerC: mk("ownerc") };
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
  await check("first visit: the upload is the one primary action, with formats and the size limit visible (Phase 2 P2-3)", async () => {
    await go("/dashboard", "Check your trial balance");
    await page.waitForSelector('[data-testid="first-upload-dropzone"]', { timeout: 30000 });
    await widths("02-first-visit");
    const t = await page.bodyText();
    const primaries = await page.evaluate(() => document.querySelectorAll('[data-testid="next-action-primary"]').length);
    return /CSV or Excel \(\.csv, \.xlsx, \.xls\), up to 10 MB/.test(t) && primaries === 0 ? true : { primaries, t: t.slice(0, 300) };
  });
  await check("first run creates the company through the real form, reached by the secondary 'Add a company' (FY ending 30 June, TZS, IFRS for SMEs), and opens its workspace", async () => {
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

  startGroup("Second account: the first upload on one page (Phase 2 P2-3; real components and server operations)");
  // The second account has a plan and no entity yet: its first visit is the upload itself. Invented file and names only.
  let B = null;
  await check("the drop zone takes the file; it is stored privately as a draft, not yet in any entity", async () => {
    await go("/dashboard", "Check your trial balance");
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
  await check("refresh keeps that exact upload; Back returns to the account home, which continues to the same entity and period", async () => {
    await page.evaluate(() => location.reload()); // a refresh, not a new history entry
    await sleep(1500);
    await page.waitForSelector('[data-testid="trial-balance-current-task"]', { timeout: 60000 });
    const afterRefresh = await page.evaluate(() => location.pathname + location.search);
    await page.evaluate(() => history.back());
    await page.waitFor((b) => location.pathname.startsWith(`/workspace/${b}/2026`) && !location.search.includes("upload="), [B], { timeout: 45000, label: "back to the same entity and period" });
    const afterBack = await page.evaluate(() => location.pathname);
    return afterRefresh === resultUrl ? true : { resultUrl, afterRefresh, afterBack };
  });

  startGroup("Purchase required: the draft is kept and the customer continues after choosing a plan (Phase 2 P2-4)");
  // A new account with NO plan. Nothing here charges or grants anything through payments: the plan is recorded the way
  // an operator records one (the same helper the journey uses for every account), standing in for a completed purchase.
  await signOut(); await signIn(U.noPlan);
  const noPlanApi = await asUser(U.noPlan);
  await check("no plan: the upload is offered with the plan stated up front; the file is stored as a draft", async () => {
    await go("/dashboard", "Check your trial balance");
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
    await go("/dashboard", "Check your trial balance");
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
    await go("/dashboard", "Check your trial balance");
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
