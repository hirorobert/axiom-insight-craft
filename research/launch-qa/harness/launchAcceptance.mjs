#!/usr/bin/env node
// Launch-acceptance QA — EXECUTABLE runner (BLACK, independent). Bootstraps the repository's disposable LOCAL Supabase stack
// exactly as scripts/e2e/localStackJourney.mjs documents, builds the production app pointed ONLY at that stack, serves it on
// loopback, and drives the nine scenarios in real headless Chrome as synthetic users. Machine-readable:
//   - any FAILED mandatory scenario → non-zero exit;
//   - a scenario that did not execute is NOT_RUN/BLOCKED and can never yield an overall PASS;
//   - results are written to <outDir>/launch-acceptance.json and screenshots alongside.
//
// PREREQUISITES (the Linux CI runner / a Linux host): `supabase start` has run; Chrome/Chromium present; deps installed
// (`@supabase/supabase-js`, `vite` — already devDependencies). Credentials are generated per run and never printed.
//   RUN:  node research/launch-qa/harness/launchAcceptance.mjs [outDir]
//   ENV (names only): CHROME_PATH (optional), LAUNCH_QA_CANDIDATE_SHA (recorded into the report), SUPABASE_* are read via
//         `supabase status -o json` (never from this file).
// ISOLATION: assertLocalStack() (reused read-only from scripts/e2e) refuses anything but a local stack; the bundle is
// verified to name only the local origin; service-role stays server-side (never reaches browser code, screenshots or logs).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SCENARIOS } from "./scenarios.mjs";
import { evaluateOverall, MANDATORY_SCENARIO_IDS } from "./overall.mjs";
import { boundUploadId, bindCommittedUpload } from "./evidenceRules.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const OUT = path.resolve(process.argv[2] ?? path.join(REPO, "research/launch-qa/acceptance-evidence"));
// APPLICATION SHA (the candidate code under test) and HARNESS SHA (this QA's commit) are recorded SEPARATELY.
const CANDIDATE_SHA = process.env.LAUNCH_QA_CANDIDATE_SHA ?? "UNIDENTIFIED";
let HARNESS_SHA = "unknown";
try { HARNESS_SHA = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim(); } catch { /* not a git checkout */ }
const PREVIEW_PORT = Number(process.env.LAUNCH_QA_PREVIEW_PORT ?? 4174); // 4174, not the drafts journey's 4173
// Actual application-source identity: the app is BUILT from this checkout (HARNESS_SHA). We record the declared candidate
// (CANDIDATE_SHA) AND prove the harness added nothing to the application source — the only diff from the candidate is under
// research/launch-qa/** — so "the app under test is the candidate" is verified, not asserted.
let APP_SOURCE_ONLY_QA = null;
try {
  if (CANDIDATE_SHA !== "UNIDENTIFIED") {
    const diff = execFileSync("git", ["diff", "--name-only", `${CANDIDATE_SHA}..HEAD`], { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean);
    APP_SOURCE_ONLY_QA = diff.every((f) => f.startsWith("research/launch-qa/"));
  }
} catch { /* not comparable */ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(OUT, "files"), { recursive: true });

function finish(results, meta, note) {
  const o = evaluateOverall(results, MANDATORY_SCENARIO_IDS);
  const report = {
    applicationSha: CANDIDATE_SHA, harnessSha: HARNESS_SHA, applicationSourceOnlyQaChanges: APP_SOURCE_ONLY_QA,
    ...meta, note, results,
    overall: { pass: o.overallPass, exitCode: o.exitCode, reasons: o.reasons },
    summary: { total: results.length, pass: results.filter((r) => r.status === "PASS").length, fail: o.failed.length, blocked: o.blocked.length, notRun: o.notRun.length, missing: o.missing, duplicates: o.duplicates, extra: o.extra },
  };
  fs.writeFileSync(path.join(OUT, "launch-acceptance.json"), JSON.stringify(report, null, 2));
  for (const r of results) console.log(`  [${r.status}] ${r.id} ${r.name}${r.problems?.length ? `\n        - ${r.problems.join("\n        - ")}` : ""}`);
  console.log(`\napplication ${CANDIDATE_SHA} (source-only-qa=${APP_SOURCE_ONLY_QA}) · harness ${HARNESS_SHA.slice(0, 12)}`);
  // Overall PASS requires all nine mandatory ids present exactly once, each executed and PASS (overall.mjs).
  console.log(o.overallPass ? "OVERALL: PASS (all nine mandatory scenarios executed and PASS)" : `OVERALL: NOT PASS — ${o.reasons.join("; ")}`);
  process.exit(o.exitCode); // 0=overall PASS · 1=a FAIL · 4=not executed / missing / duplicate / extra
}

// ── Bootstrap the disposable local stack (fails CLOSED to BLOCKED if a prerequisite is missing — never a false run). ──
let supabaseStatus;
try { supabaseStatus = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); }
catch (e) {
  finish(SCENARIOS.map((s) => ({ id: s.id, name: s.name, status: "BLOCKED", problems: ["`supabase start` + CLI not available on this host (no local stack)"] })), { env: "none" }, `bootstrap blocked: ${String(e.message).split("\n")[0]}`);
}

async function boot() {
  const { createClient } = await import("@supabase/supabase-js");
  const vite = await import("vite");
  const { assertLocalStack, verifyLocalBundle } = await import("../../../scripts/e2e/localStackFixtures.mjs");
  const { Browser } = await import("../../../scripts/browser-acceptance/cdp.mjs");

  const apiUrl = supabaseStatus.API_URL;
  const anonKey = supabaseStatus.ANON_KEY ?? supabaseStatus.PUBLISHABLE_KEY;
  const serviceKey = supabaseStatus.SERVICE_ROLE_KEY ?? supabaseStatus.SECRET_KEY;
  const { origin: apiOrigin } = assertLocalStack({ apiUrl, anonKey, serviceRoleKey: serviceKey }); // refuses non-local
  const admin = createClient(apiUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const emptyEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), "laq-no-env-"));
  const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "laq-dist-"));
  process.env.VITE_SUPABASE_URL = apiUrl; process.env.VITE_SUPABASE_PUBLISHABLE_KEY = anonKey; process.env.VITE_SUPABASE_PROJECT_ID = "local";
  await vite.build({ root: REPO, configFile: path.join(REPO, "vite.config.ts"), mode: "e2e", envDir: emptyEnvDir, logLevel: "error", build: { outDir: distDir, emptyOutDir: true } });
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
  const bundleProblems = verifyLocalBundle(walk(distDir).filter((f) => /\.(js|html|css)$/.test(f)).map((f) => fs.readFileSync(f, "utf8")), apiOrigin);
  if (bundleProblems.length) throw new Error(`bundle not isolated to local: ${bundleProblems.join(", ")}`); // never drive a bundle that could reach production
  const preview = await vite.preview({ root: REPO, configFile: path.join(REPO, "vite.config.ts"), envDir: emptyEnvDir, logLevel: "error", build: { outDir: distDir }, preview: { port: PREVIEW_PORT, strictPort: true, host: "127.0.0.1" } });
  const APP = `http://127.0.0.1:${PREVIEW_PORT}`;

  // Synthetic users (generated passwords, never printed); grant the owner/ownerB a plan the way an operator records it.
  const runId = Date.now().toString(36);
  const mk = (who) => ({ email: `${who}.${runId}@laq-local.test`, password: `Laq!${crypto.randomBytes(12).toString("base64url")}` });
  const users = { owner: mk("owner"), ownerB: mk("ownerb"), preparer: mk("preparer"), partner: mk("partner") };
  for (const u of Object.values(users)) { const { data, error } = await admin.auth.admin.createUser({ email: u.email, password: u.password, email_confirm: true }); if (error) throw new Error(`user: ${error.message}`); u.id = data.user.id; }
  const grantPlan = async (userId) => {
    const prod = (await admin.from("commercial_products").select("id").eq("code", "CFOCLOSE").single()).data;
    const plan = (await admin.from("commercial_plans").select("id").eq("product_id", prod.id).eq("code", "PRACTICE").single()).data;
    const bc = await admin.from("billing_customers").insert({ owner_user_id: userId, product_id: prod.id }).select("id").single();
    await admin.from("commercial_licences").insert({ billing_customer_id: bc.data.id, plan_id: plan.id, status: "ACTIVE", source: "ADMIN_GRANT", effective_start: new Date(Date.now() - 86400000).toISOString(), additional_seats: 4 });
  };
  await grantPlan(users.owner.id); await grantPlan(users.ownerB.id); // preparer intentionally NOT entitled (scenario D)

  const browser = await Browser.launch({ executablePath: process.env.CHROME_PATH });
  const env = buildEnv({ APP, admin, users, browser, createClient, apiUrl, anonKey });
  // [NORMAL seam, evidence #144 — coordinated] hooks supplied by the existing isolated facilities, from a NORMAL-owned module
  // (research/launch-qa/ci/launchQaHooks.mjs). Absent ⇒ unchanged behaviour (the dependent scenarios report BLOCKED).
  if (process.env.LAUNCH_QA_HOOKS) Object.assign(env, await (await import(pathToFileURL(path.resolve(REPO, process.env.LAUNCH_QA_HOOKS)).href)).default(Object.assign(env, { apiUrl, anonKey, outDir: OUT })));
  const cleanup = async () => { try { await browser.close(); } catch {} try { await preview.close?.(); } catch {} };
  return { env, meta: { env: "local-supabase", apiOrigin, app: APP }, cleanup };
}

// ── env: the grounded helpers the scenarios call. Core journeys (A/B/C/H/I) are implemented against the REAL selectors; the
//    hooks NORMAL owns are left undefined so those scenarios return a precise BLOCKED rather than a fabricated result. ──
function buildEnv({ APP, admin, users, browser, createClient, apiUrl, anonKey }) {
  const shot = (page, name) => page.screenshot(path.join(OUT, `${name}.png`)).catch(() => {});
  const writeFile = (name, content) => { const f = path.join(OUT, "files", name); fs.writeFileSync(f, content); return f; };
  const store = {};
  const env = {
    shot,
    APP, admin, users, sleep, lastWorkspace: null,
    // NORMAL-owned hooks (undefined ⇒ the dependent scenario returns BLOCKED with a precise reason):
    mockPurchase: undefined, overLimitFixture: undefined, sameNameRepairApplied: false, axe: undefined,
    record: (k, v) => { store[k] = v; }, writeFile,
    // sha256 of a file's bytes = the upload's source_file_hash (as the client declares it). Used to BIND assertions to the
    // EXACT upload a scenario created, never "latest".
    sha256File: (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"),
    // Write a DISTINCT, identifiable balanced CSV per scenario (a unique tag account pair keeps Σdr=Σcr and the hash unique).
    taggedCsv(tag, name) {
      const rows = ["Account code,Account name,Debit,Credit",
        "4000,Revenue — sales,,60000000", "5000,Cost of goods sold,32000000,", "1000,Cash at bank,28000000,",
        `9000,Tag ${tag} debit,100,`, `9001,Tag ${tag} credit,,100`];
      // debits 32,000,000+28,000,000+100 = 60,000,100 ; credits 60,000,000+100 = 60,000,100 (balanced)
      return env.writeFile(name, rows.join("\n") + "\n");
    },
    async uploadByHash(companyId, sourceHash) {
      // Bind to the scenario's OWN file (source_file_hash) — never "latest". boundUploadId requires exactly one match.
      const { data } = await admin.from("trial_balance_uploads").select("id, period_year, period_id, status, file_path, source_file_hash, lifecycle_state").eq("company_id", companyId).eq("source_file_hash", sourceHash);
      const id = boundUploadId(data ?? [], sourceHash);
      return id ? (data ?? []).find((r) => r.id === id) : null;
    },
    async openPage() { const ctx = await browser.newContext(); const p = await ctx.newPage(); await p.setViewport(1280, 900); env.lastPage = p; return p; },
    async go(page, route, text, timeout = 45000) { await page.goto(`${APP}${route}`); if (text) await page.waitForText(text, { timeout }); await sleep(300); },
    // The REAL way home (NORMAL, product contract at f57b944): /dashboard auto-resumes a user with exactly one open
    // engagement into that workspace (resolveReturningUserRoute "resume"); the workspace logo ("CFOClose home") is the
    // explicit way back to the hub (state forceHub), where the uploader lives. Follow that path, never a test-only route.
    async openHome(page) {
      await env.go(page, "/dashboard");
      await page.waitFor(() => !!document.querySelector('[data-testid="first-upload-input"], [data-testid="first-upload-dropzone"]') || /^\/workspace\//.test(location.pathname), [], { label: "home or resumed workspace", timeout: 30000 });
      if (await page.evaluate(() => /^\/workspace\//.test(location.pathname))) {
        await page.waitForSelector('header a[aria-label="CFOClose home"]', { timeout: 30000 });
        await page.click('header a[aria-label="CFOClose home"]');
      }
      await page.waitForSelector('[data-testid="first-upload-input"], [data-testid="first-upload-dropzone"]', { timeout: 30000 });
    },
    async signIn(page, u) {
      await env.go(page, "/auth", "Sign in to your CFOClose account");
      await page.fill("#email", u.email); await page.fill("#password", u.password); await page.press("Enter");
      await page.waitFor(() => !location.pathname.startsWith("/auth"), [], { label: "signed in", timeout: 30000 });
      env.currentUser = u;
    },
    // EXACT binding (NORMAL): user → draft of this file created since `since` → its committed commit → that commit's upload.
    async bindUpload(u, since, sourceHash, expect = {}) {
      const drafts = (await admin.from("trial_balance_drafts").select("id, content_sha256, created_at").eq("owner_ref", u.id).gte("created_at", since)).data ?? [];
      const ids = drafts.map((d) => d.id);
      const commits = ids.length ? ((await admin.from("trial_balance_draft_commits").select("id, draft_id, state, upload_id, company_id, target_company_ref, period_year, period_id").in("draft_id", ids)).data ?? []) : [];
      const mine = new Set(drafts.filter((d) => d.content_sha256 === sourceHash).map((d) => d.id));
      const named = commits.filter((c) => mine.has(c.draft_id) && c.state === "committed" && c.upload_id).map((c) => c.upload_id);
      const upload = named.length === 1 ? (await admin.from("trial_balance_uploads").select("id, company_id, period_year, period_id, status, lifecycle_state, file_path, source_file_hash, processing_result").eq("id", named[0]).maybeSingle()).data : null;
      return { ...bindCommittedUpload({ drafts, commits, upload }, { sourceHash, ...expect }), upload };
    },
    setByLabel: (page, label, value) => page.evaluate((lab, val) => {
      const l = [...document.querySelectorAll("label")].find((x) => x.textContent.trim().toLowerCase().startsWith(lab.toLowerCase()));
      const el = l && (l.control ?? document.getElementById(l.htmlFor)); if (!el) return false;
      if (el.type === "checkbox") { if (el.checked !== !!val) el.click(); return true; }
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set; setter.call(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true;
    }, label, value),
    // FirstUpload's entity picker is a NATIVE <select> (FirstUpload.tsx, confirm-entity-select): choose the option whose
    // text is the entity's name, the way a user's choice reaches React (value setter + change). Refuses loudly if absent.
    async chooseOption(page, selector, optionText) {
      const ok = await page.evaluate((sel, txt) => {
        const el = document.querySelector(sel); if (!el || el.tagName !== "SELECT") return false;
        const opt = [...el.options].find((o) => o.textContent.trim() === txt); if (!opt) return false;
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, opt.value);
        el.dispatchEvent(new Event("change", { bubbles: true })); return el.value === opt.value;
      }, selector, optionText);
      if (!ok) throw new Error(`could not choose "${optionText}" in ${selector}`);
      await sleep(250);
    },
    // What the confirm card itself says is still missing before the check can start (empty when ready).
    async confirmBlockers(page) {
      return page.evaluate(() => {
        const card = document.querySelector('[data-testid="first-upload-confirm"]'); if (!card) return [];
        const p = [...card.querySelectorAll("p")].find((x) => /before the check can start/i.test(x.textContent));
        const list = p?.nextElementSibling; return list ? [...list.querySelectorAll("li")].map((li) => li.textContent.trim()).filter(Boolean) : (p ? [p.textContent.trim()] : []);
      }).catch(() => []);
    },
    async pickRadix(page, trigger, optionText) { await page.click(trigger); await page.waitForSelector("[role=option]"); await page.click({ text: optionText, within: "[role=listbox]" }); await sleep(250); },
    // Phase-2 FIRST-UPLOAD into a NEW or EXISTING entity (candidate f57b944). Drops an IDENTIFIABLE file, confirms the card,
    // "Start trial balance check", and BINDS the result to the exact upload (by source_file_hash) — never "latest". The home
    // for a user who already has an entity shows the compact uploader (P2-4), so we wait for the dropzone/input, not the
    // heading. Returns { companyId, periodYear, uploadId, sourceHash, failure, selectedFileOk }.
    async firstUploadInto(page, { mode = "new", entityName, existingEntityName, endsOn = "2026-06-30", currency = "TZS", year, file }) {
      await env.openHome(page);
      const since = new Date(Date.now() - 2000).toISOString();
      await page.setFiles('[data-testid="first-upload-input"]', [file]);
      await page.waitForSelector('[data-testid="first-upload-confirm"]', { timeout: 60000 });
      // The browser actually SELECTED this file: the file card names it.
      const selectedName = await page.evaluate(() => document.querySelector('[data-testid="first-upload-file-card"]')?.textContent ?? "").catch(() => "");
      const base = String(file).split(/[\\/]/).pop();
      const selectedFileOk = selectedName.includes(base.replace(/\.csv$/, "")) || selectedName.includes(base);
      if (mode === "existing") {
        await page.click('[data-testid="confirm-entity-existing"]').catch(() => {});
        if (existingEntityName) await env.chooseOption(page, '[data-testid="confirm-entity-select"]', existingEntityName);
      } else {
        await env.setByLabel(page, "Entity name", entityName);
      }
      // The period is the "Year" preset (a radio) and its "Ends on" date; the year comes from the date, not a picker.
      await page.click('[data-testid="confirm-period-year"]');
      await sleep(200);
      await env.setByLabel(page, "Ends on", endsOn);
      await env.setByLabel(page, "Trial balance currency", currency);
      await sleep(300);
      const blockers = await env.confirmBlockers(page);
      if (blockers.length) throw new Error(`the confirm card is not ready to start: ${blockers.join("; ")}`);
      await page.click('[data-testid="first-upload-start"]');
      await page.waitForSelector('[data-testid="first-upload-checked"], [data-testid="first-upload-open-result"], [data-testid="first-upload-failure"]', { timeout: 180000 });
      const failure = await page.evaluate(() => document.querySelector('[data-testid="first-upload-failure"]')?.textContent ?? null);
      // What the page itself states after the check (a blocked check is shown as problems on the checked result).
      const shownProblems = await page.evaluate(() => [...document.querySelectorAll('[data-testid="first-upload-problems"], [data-testid="first-upload-checked"], [data-testid="first-upload-failure"]')].map((e) => e.textContent).join(" | ")).catch(() => "");
      const sourceHash = env.sha256File(file);
      let companyId = null, periodYear = year ?? null;
      const opened = await page.evaluate(() => !!document.querySelector('[data-testid="first-upload-open-result"]')).catch(() => false);
      if (opened) {
        await page.click('[data-testid="first-upload-open-result"]');
        const url = await page.waitForUrl(/\/workspace\/[0-9a-f-]{36}\/\d{4}/, { timeout: 45000 }).catch(() => "");
        const m = String(url).match(/\/workspace\/([0-9a-f-]{36})\/(\d{4})/);
        if (m) { companyId = m[1]; periodYear = Number(m[2]); }
      }
      // Fall back to resolving the company from server truth for the existing mode / when the result page wasn't opened.
      if (!companyId && mode === "existing") companyId = (await env.ownerCompanyByName(existingEntityName))?.id ?? null;
      // EXACT binding through the user's own draft → commit → upload (never by contents alone, never "latest").
      const bind = await env.bindUpload(env.currentUser, since, sourceHash, { companyId: mode === "existing" ? companyId : null, periodYear: year ?? null });
      const bound = bind.uploadId ? bind.upload : null;
      if (bind.companyId && companyId && bind.companyId !== companyId) bind.problems.push(`the result page opened entity ${companyId}, but the commit bound entity ${bind.companyId}`);
      return { companyId: bind.companyId ?? companyId, periodYear: bound?.period_year ?? bind.periodYear ?? periodYear, uploadId: bind.problems.length ? null : bind.uploadId, bindProblems: bind.problems, binding: { draftId: bind.draftId ?? null, commitId: bind.commitId ?? null, periodId: bind.periodId ?? null }, sourceHash, failure, shownProblems, selectedFileOk, bound, committedUpload: bind.upload ?? null };
    },
    async createWorkspace(page, args) {
      const r = await env.firstUploadInto(page, { mode: "new", ...args });
      if (r.companyId) env.lastWorkspace = { companyId: r.companyId, periodYear: r.periodYear, entityName: args.entityName };
      return r;
    },
    async ownerCompanyByName(name) { const { data } = await admin.from("companies").select("id, name").eq("name", name).eq("user_id", env.currentUser?.id ?? "").maybeSingle(); return data ?? null; },
    async establishPeriod() { return true; }, // the first-upload confirmation card sets the period; no separate intake needed
    async openUploader(page, companyId, year) {
      for (let i = 0; i < 3; i++) {
        await env.go(page, `/workspace/${companyId}/${year}/trial-balance/review`);
        const where = await page.waitFor(() => (document.querySelector('[data-testid="trial-balance-file-input"]') ? "uploader"
          : document.querySelector('[data-testid="launchpad-heading"]') ? "launchpad"
          : document.querySelector('[data-testid="data-choice-heading"]') ? "choice" : null), [], { label: "uploader or launchpad", timeout: 45000 }).catch(() => null);
        if (where === "uploader") return true;
        if (where === "launchpad") { await page.click('[data-testid="service-FINANCIAL_STATEMENTS"]').catch(() => {}); await page.click('[data-testid="primary-cta"]').catch(() => {}); }
        else if (where === "choice") { await page.click('[data-testid="primary-cta"]').catch(() => {}); }
        await sleep(1200);
      }
      return false;
    },
    async uploadTb(page, companyId, year, file) {
      if (!(await env.openUploader(page, companyId, year))) return null;
      await page.setFiles('[data-testid="trial-balance-file-input"]', [file]);
      await page.click('[data-testid="trial-balance-upload-primary"]');
      await sleep(1500);
      const { data } = await admin.from("trial_balance_uploads").select("id").eq("company_id", companyId).eq("period_year", year).order("uploaded_at", { ascending: false }).limit(1).maybeSingle();
      return data?.id ?? null;
    },
    async uploadRaw(page, companyId, year, file) {
      if (!(await env.openUploader(page, companyId, year))) return { accepted: false };
      await page.setFiles('[data-testid="trial-balance-file-input"]', [file]);
      await page.click('[data-testid="trial-balance-upload-primary"]').catch(() => {});
      await sleep(1500);
      const accepted = await page.evaluate(() => !document.querySelector('[role="alert"], [data-sonner-toast]'));
      return { accepted };
    },
    async settle(companyId, year) {
      for (let i = 0; i < 60; i++) {
        const { data } = await admin.from("trial_balance_uploads").select("id, status, processing_result").eq("company_id", companyId).eq("period_year", year).order("uploaded_at", { ascending: false }).limit(1).maybeSingle();
        if (data && !["pending", "processing", "queued", "validating"].includes(data.status)) return data;
        await sleep(2000);
      }
      return null;
    },
    // Settle the EXACT upload by its id (never "latest") — the only safe wait once binding is per-upload.
    async settleUpload(uploadId) {
      for (let i = 0; i < 60; i++) {
        const { data } = await admin.from("trial_balance_uploads").select("id, status, processing_result").eq("id", uploadId).maybeSingle();
        if (data && !["pending", "processing", "queued", "validating"].includes(data.status)) return data;
        await sleep(2000);
      }
      return null;
    },
    // First-upload REFUSAL probe (F): drop a file on the home and observe the refusal WITHOUT a confirm card / entity. Returns
    // the error/failure text and whether a confirm card appeared, plus whether any upload was created for this file's hash.
    async firstUploadRefusal(page, file) {
      await env.go(page, "/dashboard");
      await page.waitForSelector('[data-testid="first-upload-input"], [data-testid="first-upload-dropzone"]', { timeout: 30000 }).catch(() => {});
      await page.setFiles('[data-testid="first-upload-input"]', [file]).catch(() => {});
      await page.waitFor(() => !!document.querySelector('[data-testid="first-upload-error"], [data-testid="first-upload-confirm"], [data-testid="first-upload-limits"]'), [], { label: "upload error or confirm", timeout: 60000 }).catch(() => {});
      const obs = await page.evaluate(() => ({
        error: document.querySelector('[data-testid="first-upload-error"]')?.textContent ?? null,
        limits: document.querySelector('[data-testid="first-upload-limits"]')?.textContent ?? null,
        confirm: !!document.querySelector('[data-testid="first-upload-confirm"]'),
      })).catch(() => ({ error: null, confirm: false, limits: null }));
      const sourceHash = env.sha256File(file);
      const anyUpload = ((await admin.from("trial_balance_uploads").select("id").eq("source_file_hash", sourceHash)).data ?? []).length;
      return { ...obs, sourceHash, uploadsForFile: anyUpload };
    },
    // Observe the current page against the real routes: whether we are on this company's workspace route, on the sign-in
    // page, and whether the company's own content is rendered. (Replaces the next-action/workspace-shell heuristic the
    // review page does not use.)
    async observeWorkspacePage(page, companyId) {
      const url = await page.url().catch(() => "");
      const onAuth = /\/auth(\b|\/|$)/.test(url) || await page.evaluate(() => !!document.querySelector('#email, [data-testid="auth-email"]')).catch(() => false);
      const onWorkspace = new RegExp(`/workspace/${companyId}(/|$)`).test(url);
      const rendersCompany = await page.evaluate((id) => document.body.innerText.includes(id), companyId).catch(() => false);
      return { url, onAuth, onWorkspace, rendersCompany };
    },
    async readsAsOtherUser(u, companyId) {
      const c = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
      await c.auth.signInWithPassword({ email: u.email, password: u.password });
      const { data } = await c.from("trial_balance_uploads").select("id").eq("company_id", companyId);
      return (data ?? []).length > 0; // true ⇒ leakage
    },
    // Review accounts through the REAL RPC as an AUTHENTICATED member (auth.uid()); service-role cannot (no uid). Used by G
    // to record decisions for both same-name accounts so their mappings exist before checking they are distinct.
    async reviewAccounts(u, companyId, uploadId, decisions) {
      const c = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error: se } = await c.auth.signInWithPassword({ email: u.email, password: u.password });
      if (se) return { error: `sign-in: ${se.message}` };
      const { data, error } = await c.rpc("resolve_account_review_batch", { p_company_id: companyId, p_upload_id: uploadId, p_client_request_id: uuid(), p_decisions: decisions });
      return error ? { error: error.message } : { data };
    },
    // Drive FirstUpload to the "active trial balance exists → Replace" state for an EXISTING entity; returns whether the
    // explicit Replace affordance is offered (replacement is never automatic). Grounded in FirstUpload.tsx testids.
    async beginReplace(page, { existingEntityName, endsOn = "2026-06-30", currency = "TZS", file }) {
      await env.openHome(page); // an entity-owner's home shows the COMPACT uploader (P2-4), not the "Check your trial balance" heading
      await page.setFiles('[data-testid="first-upload-input"]', [file]);
      await page.waitForSelector('[data-testid="first-upload-confirm"]', { timeout: 60000 });
      await page.click('[data-testid="confirm-entity-existing"]').catch(() => {});
      await env.chooseOption(page, '[data-testid="confirm-entity-select"]', existingEntityName);
      await page.click('[data-testid="confirm-period-year"]'); await sleep(200);
      await env.setByLabel(page, "Ends on", endsOn); await env.setByLabel(page, "Trial balance currency", currency); await sleep(300);
      await page.click('[data-testid="first-upload-start"]').catch(() => {});
      await page.waitForSelector('[data-testid="first-upload-replace"], [data-testid="first-upload-failure"]', { timeout: 60000 }).catch(() => {});
      return page.evaluate(() => !!document.querySelector('[data-testid="first-upload-replace"]')).catch(() => false);
    },
    // Click the explicit Replace and wait for the outcome. A stale captured version is refused (the current TB is kept).
    async clickReplace(page) {
      await page.click('[data-testid="first-upload-replace"]');
      // The FIRST attempt's refusal is still on screen when Replace is clicked: wait until the card has left that state
      // (the Replace control is gone — the replacement attempt is running), so its OWN outcome is read, never the old one.
      const left = await page.waitFor(() => !document.querySelector('[data-testid="first-upload-replace"]'), [], { label: "replace started", timeout: 30000 }).then(() => true, () => false);
      if (!left) return { checked: false, failure: "the Replace control did not start a replacement (the card stayed on the refusal)" };
      await page.waitFor(() => !!document.querySelector('[data-testid="first-upload-checked"], [data-testid="first-upload-open-result"], [data-testid="first-upload-failure"], [data-testid="first-upload-replace"]'), [], { label: "replace outcome", timeout: 120000 });
      return page.evaluate(() => ({ checked: !!document.querySelector('[data-testid="first-upload-checked"], [data-testid="first-upload-open-result"]'), failure: document.querySelector('[data-testid="first-upload-failure"]')?.textContent ?? null })).catch(() => ({ checked: false, failure: null }));
    },
    async activeUpload(companyId, year) {
      const { data } = await admin.from("trial_balance_uploads").select("id, version, lifecycle_state, superseded_by_upload_id")
        .eq("company_id", companyId).eq("period_year", year).in("lifecycle_state", ["active_unprocessed", "active_processing", "active_processed", "blocked"]);
      return (data ?? [])[0] ?? null;
    },
    async uploadRow(id) { const { data } = await admin.from("trial_balance_uploads").select("id, lifecycle_state, superseded_by_upload_id, version").eq("id", id).maybeSingle(); return data ?? null; },
    // RULING I-2 observation: the review panel's own state, and for each of the two review actions what it DECLARES
    // (data-action-emphasis) and whether it IS visually emphasised — its computed background stands out from what it sits
    // on by a contrast ratio of at least 1.5 (an outline button on a card does not; a filled button does).
    async observeReviewHierarchy(page) {
      return page.evaluate(() => {
        const rgb = (c) => { const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c ?? ""); return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null; };
        const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
        const under = (el) => { for (let p = el.parentElement; p; p = p.parentElement) { const c = rgb(getComputedStyle(p).backgroundColor); if (c && c.a > 0.5) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
        const read = (el) => {
          if (!el) return { present: false };
          const box = el.getBoundingClientRect(), bg = rgb(getComputedStyle(el).backgroundColor), base = under(el);
          const l1 = bg && bg.a > 0.5 ? lum(bg) : lum(base), l2 = lum(base);
          const contrast = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
          return { present: box.width > 0 && box.height > 0, emphasis: el.getAttribute("data-action-emphasis"), filled: contrast >= 1.5, contrast: Math.round(contrast * 100) / 100,
                   disabled: !!el.disabled, busy: el.getAttribute("aria-busy") === "true", label: el.textContent.trim().slice(0, 60) };
        };
        const st = document.querySelector('[data-testid="account-review-submission"]');
        return { state: st?.getAttribute("data-state") ?? null, statusText: st?.textContent?.trim() ?? null,
                 card: read(document.querySelector('[data-testid="trial-balance-primary-action"]')), save: read(document.querySelector('[data-testid="account-review-save"]')),
                 alert: !!document.querySelector('[data-testid="account-review-save-failed"]') };
      }).catch(() => ({ state: null, card: { present: false }, save: { present: false }, alert: false }));
    },
    // How many decision batches were recorded for an upload (one per accepted submission).
    async reviewBatches(uploadId) {
      const rows = (await admin.from("account_review_decisions").select("batch_id").eq("upload_id", uploadId)).data ?? [];
      return new Set(rows.map((r) => r.batch_id)).size;
    },
    // RULING I-1 observation: the hub's "Choose an engagement" state — its heading, every peer Resume (accessible name,
    // visibility, whether styled as THE primary), any other primary on the screen, and the real Tab sequence.
    async observeChooser(page) {
      const snap = await page.evaluate(() => {
        const vis = (el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
        const isPrimary = (el) => /(^|\s)bg-primary(\s|$)/.test(el.className);
        const card = document.querySelector('[data-testid="account-next-action"]');
        const peers = [...document.querySelectorAll('[data-testid^="resume-"]')].map((b) => ({ testid: b.getAttribute("data-testid"), name: (b.getAttribute("aria-label") || b.textContent).trim(), visible: vis(b), primary: isPrimary(b) }));
        const others = [...document.querySelectorAll("button, a[href], [role=button]")]
          .filter((el) => vis(el) && !el.closest("header, nav") && !el.matches('[data-testid^="resume-"]') && isPrimary(el)).map((el) => el.textContent.trim().slice(0, 40));
        return { kind: card?.getAttribute("data-kind") ?? null, title: card?.querySelector("h2")?.textContent?.trim() ?? "", peers, others };
      });
      const stops = await env.observeTabWalk(page, 200);
      return { kind: snap.kind, title: snap.title, peers: snap.peers, otherPrimaries: snap.others.length, otherPrimaryLabels: snap.others, tabLabels: stops.map((s) => s.label) };
    },
    // Activate one peer and observe where it lands: that engagement's workspace, or a confirmation in between.
    async activateChooserPeer(page, peer) {
      const m = /^Resume\s+(.+)\s+FY(\d{4})$/.exec(peer.name);
      const co = m ? ((await admin.from("companies").select("id").eq("name", m[1]).eq("user_id", env.currentUser?.id ?? "").maybeSingle()).data ?? null) : null;
      const expectedPath = co ? `/workspace/${co.id}/${m[2]}` : null;
      await page.click(`[data-testid="${peer.testid}"]`);
      await page.waitFor(() => /^\/workspace\//.test(location.pathname) || !!document.querySelector("[role=dialog], [role=alertdialog]"), [], { label: "chooser navigation", timeout: 30000 }).catch(() => {});
      const landedPath = await page.evaluate(() => location.pathname).catch(() => null);
      const dialog = await page.evaluate(() => !!document.querySelector("[role=dialog], [role=alertdialog]")).catch(() => false);
      return { name: peer.name, expectedPath, landedPath, dialog };
    },
    // Persisted processing facts for ONE upload (read-only, service role): the upload row, how many certifications exist for
    // it (a refused file must have none), its current engine run (never left running) and that run's dependency snapshot
    // (a refusal happens before any is taken).
    async processingFacts(uploadId) {
      const u = (await admin.from("trial_balance_uploads").select("id, company_id, period_year, period_id, status, lifecycle_state, version, file_path, source_file_hash, current_engine_run_id, processing_attempt, processing_result, superseded_by_upload_id").eq("id", uploadId).maybeSingle()).data ?? null;
      const certifications = (await admin.from("tb_certifications").select("id", { count: "exact", head: true }).eq("upload_id", uploadId)).count ?? null;
      const run = u?.current_engine_run_id ? ((await admin.from("engine_runs").select("id, status, error_code").eq("id", u.current_engine_run_id).maybeSingle()).data ?? null) : null;
      const dependencies = run ? ((await admin.from("engine_run_dependencies").select("engine_run_id", { count: "exact", head: true }).eq("engine_run_id", run.id)).count ?? null) : 0;
      return { upload: u, certifications, run, dependencies };
    },
    // A check request exactly as the browser sends it (processingInvoke: { uploadId, clientRequestId }), as the user.
    async invokeCheck(u, uploadId, clientRequestId) {
      const c = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data: s, error } = await c.auth.signInWithPassword({ email: u.email, password: u.password });
      if (error) return { status: null, body: { error: error.message } };
      const res = await fetch(`${apiUrl}/functions/v1/process-trial-balance`, { method: "POST",
        headers: { Authorization: `Bearer ${s.session.access_token}`, apikey: anonKey, "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId, clientRequestId }) });
      let body = null; try { body = await res.json(); } catch { /* no body */ }
      return { status: res.status, body };
    },
    // The trial-balance page for one entity/period as the user sees it: its text, and whether Replace is offered.
    async observeTrialBalancePage(page, companyId, year, shotName) {
      await env.go(page, `/workspace/${companyId}/${year}/trial-balance/review`);
      await page.waitFor(() => /Trial balance checks|Blocked|Needs review|Reviewed/i.test(document.body.innerText), [], { label: "trial-balance page", timeout: 30000 }).catch(() => {});
      await sleep(1500);
      const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ")).catch(() => "");
      // Replace is offered either as the card's primary action (a blocked result: "Replace with corrected Trial Balance",
      // CurrentTrialBalanceCard trial-balance-primary-action) or, otherwise, in Manage Trial Balance (replace-trial-balance).
      const replaceOffered = await page.evaluate(() => [...document.querySelectorAll('[data-testid="trial-balance-primary-action"], [data-testid="replace-trial-balance"]')]
        .some((b) => /replace/i.test(b.textContent) && !b.disabled && b.getBoundingClientRect().width > 0)).catch(() => false);
      if (shotName) await shot(page, shotName);
      return { text, replaceOffered, url: await page.url().catch(() => null) };
    },
    // Replace the period's trial balance through the page's own Replace (PrepareWorkspace handleReplacePicked: the picked
    // file is checked, uploaded, then retire_trial_balance_upload swaps it in). Waits for server truth, not the screen.
    async replaceOnTrialBalancePage(page, companyId, year, file) {
      const before = await env.activeUpload(companyId, year);
      const view = await env.observeTrialBalancePage(page, companyId, year);
      if (!before || !view.replaceOffered) return { offered: view.replaceOffered, oldId: before?.id ?? null };
      await page.setFiles('input[type="file"].hidden', [file]);
      for (let i = 0; i < 60; i++) {
        const old = await env.uploadRow(before.id);
        const act = await env.activeUpload(companyId, year);
        if (old?.lifecycle_state === "superseded" && act && act.id !== before.id) {
          const settled = await env.settleUpload(act.id);
          return { offered: true, oldId: before.id, newId: act.id, old, settled, facts: await env.processingFacts(act.id) };
        }
        await sleep(2000);
      }
      return { offered: true, oldId: before.id, timedOut: true, old: await env.uploadRow(before.id) };
    },
    // Server truth: is there an authoritative certification for this period? (as the owner, like the repository journey).
    async isCertified(companyId, periodYear, u = users.owner) {
      const c = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
      await c.auth.signInWithPassword({ email: u.email, password: u.password });
      const { data } = await c.rpc("get_authoritative_certification", { p_company_id: companyId, p_period_year: periodYear });
      return Array.isArray(data) ? data.length > 0 : !!data;
    },
    async observeViewport(page, route, vw) { await env.go(page, route); await page.setViewport(vw, 800); await sleep(500); await shot(page, `H-${vw}`); return { layoutWidth: await page.evaluate(() => document.documentElement.scrollWidth) }; },
    async observeFocusSequence(page) {
      return page.evaluate(() => {
        const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0; };
        return [...document.querySelectorAll("a[href],button,input,select,textarea,[tabindex]")]
          // Only KEYBOARD-REACHABLE elements belong in the Tab order. tabindex<0 (e.g. a hidden toast region's <ol>) is
          // programmatically focusable but NOT tabbable — it is not a keyboard-reachability defect, so exclude it.
          .filter((el) => { const ti = el.getAttribute("tabindex"); return ti === null || Number(ti) >= 0; })
          .filter((el) => vis(el) || el.tagName === "A" || el.tagName === "BUTTON" || el.tagName === "INPUT")
          .map((el, i) => ({ label: el.getAttribute("aria-label") || el.textContent.trim().slice(0, 40) || el.getAttribute("title") || el.id, role: el.tagName.toLowerCase(), visible: vis(el), tabindex: el.hasAttribute("tabindex") ? Number(el.getAttribute("tabindex")) : undefined, interactive: true, domOrder: i }));
      }).catch(() => []);
    },
    // The REAL keyboard sequence (NORMAL): press Tab and record what actually received focus, until it cycles or 80 stops.
    async observeTabWalk(page, max = 80) {
      await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
      const stops = [];
      for (let i = 0; i < max; i++) {
        await page.press("Tab");
        const s = await page.evaluate(() => {
          const el = document.activeElement; if (!el || el === document.body) return null;
          const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
          const by = el.getAttribute("aria-labelledby");
          const name = el.getAttribute("aria-label") || (by ? by.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? "").join(" ").trim() : "")
            || (el.labels && el.labels[0]?.textContent?.trim()) || el.getAttribute("title") || el.getAttribute("alt") || el.textContent.trim().slice(0, 60) || (el.getAttribute("placeholder") ?? "");
          if (!el.dataset.laqIdx) el.dataset.laqIdx = String([...document.querySelectorAll("*")].indexOf(el));
          return { key: el.dataset.laqIdx, label: name, role: el.getAttribute("role") || el.tagName.toLowerCase(), visible: cs.visibility !== "hidden" && cs.display !== "none" && r.width > 0 && r.height > 0 && Number(cs.opacity) > 0,
                   tabindex: el.hasAttribute("tabindex") ? Number(el.getAttribute("tabindex")) : undefined, domIndex: Number(el.dataset.laqIdx) };
        }).catch(() => null);
        if (!s) break;
        if (stops.length && stops[0].key === s.key) break; // cycled
        stops.push(s);
      }
      return stops;
    },
    // Elements taken out of the Tab order (tabindex<0), with what decides whether that is acceptable.
    async observeProgrammaticFocusTargets(page) {
      return page.evaluate(() => [...document.querySelectorAll('[tabindex]')].filter((el) => Number(el.getAttribute("tabindex")) < 0).map((el) => {
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        const role = el.getAttribute("role") || el.tagName.toLowerCase();
        const interactive = /^(a|button|input|select|textarea)$/i.test(el.tagName) || /^(button|link|menuitem|tab|option|radio|checkbox|switch|textbox|combobox)$/.test(el.getAttribute("role") ?? "");
        const region = el.closest("[aria-live], [role=status], [role=log], [role=alert], [role=region], section[aria-label]");
        const name = el.getAttribute("aria-label") || region?.getAttribute("aria-label") || "";
        return { label: name || el.textContent.trim().slice(0, 40), role, interactive, visible: cs.visibility !== "hidden" && cs.display !== "none" && r.width > 0 && r.height > 0,
                 compositeItem: !!el.closest("[role=listbox], [role=menu], [role=menubar], [role=tablist], [role=radiogroup], [role=grid], [role=tree], [role=toolbar]"),
                 liveRegion: !!(el.closest("[aria-live]") || el.matches("[aria-live]")), named: name.trim() !== "" };
      })).catch(() => []);
    },
    async observeFields(page) {
      return page.evaluate(() => [...document.querySelectorAll("input,select,textarea")].map((el) => {
        const name = el.getAttribute("aria-label") || (el.labels && el.labels[0]?.textContent?.trim()) || el.getAttribute("placeholder") || "";
        const descId = el.getAttribute("aria-describedby") || el.getAttribute("aria-errormessage");
        const errorShown = !!(el.getAttribute("aria-invalid") === "true");
        return { label: name || el.id, hasAccessibleName: name.trim() !== "", errorShown, errorAssociated: !!(descId && document.getElementById(descId.split(" ")[0])) };
      })).catch(() => []);
    },
    async observeProcessingAnnouncement(page) { return page.evaluate(() => ({ processing: /process|checking|uploading/i.test(document.body.innerText), hasAriaLive: !!document.querySelector("[aria-live]"), hasStatusRole: !!document.querySelector('[role="status"]') })).catch(() => ({ processing: false })); },
    async captureCopy(page) { return page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim().slice(0, 4000)).catch(() => ""); },
    async captureErrorState(page) { return page.evaluate(() => { const a = document.querySelector('[role="alert"], [data-sonner-toast]'); return a ? { phase: "error", errorMessage: a.textContent.trim(), nextAction: a.querySelector("a,button") ? "retry" : "" } : { phase: "ready" }; }).catch(() => ({ phase: "ready" })); },
    // Clarity of the CURRENT page, grounded in the real controls. On the first-upload home the actionable control is
    // first-upload-choose/start (not a `next-action` test id); the saved state is the draft note (reserved/committed) or,
    // on a fresh home, nothing-yet (a valid, clear state).
    async captureClarityState(page, name = "page") {
      return page.evaluate((stateName) => {
        const txt = (sel) => document.querySelector(sel)?.textContent?.trim() ?? "";
        const na = document.querySelector('[data-testid="first-upload-start"], [data-testid="first-upload-choose"], [data-testid="first-upload-resume"], [data-testid="next-action"], [data-testid="first-upload-open-result"]');
        const draftNote = txt('[data-testid="first-upload-draft-note"]');
        const body = document.body.innerText;
        const saved = draftNote ? "saved" : (/committed|final and sealed/i.test(body) ? "committed" : (/not been saved|no file yet|upload your trial balance/i.test(body) ? "nothing" : "nothing"));
        // Every VISIBLE, enabled button or link on the page (not the first few — those are the header/nav), and which of
        // them is styled as THE primary action (shadcn's default Button variant is bg-primary, whether a <button> or a
        // <Button asChild><Link>) — background only, never text-primary/border-primary.
        const visible = (el) => { const r = el.getBoundingClientRect(), cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
        const ctas = [...document.querySelectorAll("button, a[href], [role=button]")].filter((el) => visible(el) && !el.disabled && !el.closest("header, nav"))
          .map((el) => ({ label: el.textContent.trim().slice(0, 40), primary: /(^|\s)bg-primary(\s|$)/.test(el.className) || el.getAttribute("data-primary") === "1" || el.getAttribute("data-testid") === "first-upload-start" }));
        const primaryLabel = ctas.find((c) => c.primary)?.label ?? "";
        return { name: stateName, whatHappened: document.querySelector("h1,h2")?.textContent?.trim() ?? "", whatNext: ((na?.innerText ?? na?.textContent ?? "").trim() || primaryLabel), saved, draftNote, copy: body.replace(/\s+/g, " ").trim().slice(0, 2000), ctas };
      }, name).catch(() => null);
    },
    // Unimplemented-here journey affordances (NORMAL confirms the real controls): return null ⇒ scenario BLOCKED precisely.
    async replaceUpload() { return null; },
    async staleReplace() { return null; },
    async reachPurchaseRequired() { return false; },
    async entitlementSnapshot() { return {}; },
    async draftStillPresent() { return true; },
  };
  return env;
}

// ── Run ──
try {
  const { env, meta, cleanup } = await boot();
  const results = [];
  for (const s of SCENARIOS) {
    let r;
    try { r = await s.run(env); }
    catch (e) { r = { status: "FAIL", problems: [`threw: ${String(e?.stack ?? e?.message ?? e)}`], evidence: {} }; } // FULL error text, untruncated
    results.push({ id: s.id, name: s.name, ...r });
    // On any non-clean outcome capture first-failure evidence: screenshot + URL + full assertions + relevant ids. No creds.
    if (r.status === "FAIL" || r.status === "ERROR") {
      try {
        const page = env.lastPage;
        let url = null, domText = null;
        if (page) { await page.screenshot(path.join(OUT, `${s.id}-FAIL.png`)).catch(() => {}); url = await page.url().catch(() => null); domText = await page.bodyText?.().catch(() => null) ?? await page.evaluate(() => document.body.innerText.slice(0, 4000)).catch(() => null); }
        const ev = r.evidence || {};
        const ids = { uploadId: ev.uploadId ?? null, companyId: ev.companyId ?? null, sourceHash: ev.sourceHash ?? null };
        fs.writeFileSync(path.join(OUT, `${s.id}-FAIL.json`), JSON.stringify({ id: s.id, status: r.status, url, failedAssertions: r.problems, ids, evidence: ev }, null, 2));
        if (domText) fs.writeFileSync(path.join(OUT, `${s.id}-FAIL.dom.txt`), String(domText));
      } catch { /* evidence best-effort */ }
    }
  }
  await cleanup();
  finish(results, meta);
} catch (e) {
  finish(SCENARIOS.map((s) => ({ id: s.id, name: s.name, status: "BLOCKED", problems: [`bootstrap/run error: ${String(e?.message ?? e).split("\n")[0]}`] })), { env: "error" }, "runner could not establish the stack");
}
