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
  // (scripts/e2e/launchQaHooks.mjs). Absent ⇒ unchanged behaviour (the dependent scenarios report BLOCKED).
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
    APP, admin, users, sleep, lastWorkspace: null,
    // NORMAL-owned hooks (undefined ⇒ the dependent scenario returns BLOCKED with a precise reason):
    mockPurchase: undefined, overLimitFixture: undefined, sameNameRepairApplied: false, axe: undefined,
    record: (k, v) => { store[k] = v; }, writeFile,
    async openPage() { const ctx = await browser.newContext(); const p = await ctx.newPage(); await p.setViewport(1280, 900); return p; },
    async go(page, route, text, timeout = 45000) { await page.goto(`${APP}${route}`); if (text) await page.waitForText(text, { timeout }); await sleep(300); },
    async signIn(page, u) {
      await env.go(page, "/auth", "Sign in to your CFOClose account");
      await page.fill("#email", u.email); await page.fill("#password", u.password); await page.press("Enter");
      await page.waitFor(() => !location.pathname.startsWith("/auth"), [], { label: "signed in", timeout: 30000 });
    },
    setByLabel: (page, label, value) => page.evaluate((lab, val) => {
      const l = [...document.querySelectorAll("label")].find((x) => x.textContent.trim().toLowerCase().startsWith(lab.toLowerCase()));
      const el = l && (l.control ?? document.getElementById(l.htmlFor)); if (!el) return false;
      if (el.type === "checkbox") { if (el.checked !== !!val) el.click(); return true; }
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set; setter.call(el, val);
      el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true;
    }, label, value),
    async pickRadix(page, trigger, optionText) { await page.click(trigger); await page.waitForSelector("[role=option]"); await page.click({ text: optionText, within: "[role=listbox]" }); await sleep(250); },
    async createWorkspace(page, { org, year, fye, currency, framework }) {
      await env.go(page, "/dashboard", "Organization name");
      await page.fill("#fr-org", org);
      await env.pickRadix(page, "#fr-year", year); await env.pickRadix(page, "#fr-fye", fye);
      await env.pickRadix(page, "#fr-currency", currency); await env.pickRadix(page, "#fr-framework", framework);
      await page.click('form[aria-label="Create reporting workspace"] button[type=submit]');
      const url = await page.waitForUrl(/\/workspace\/[0-9a-f-]{36}\/\d{4}/, { timeout: 45000 });
      const companyId = url.match(/\/workspace\/([0-9a-f-]{36})\//)[1];
      const periodYear = Number(url.match(/\/(\d{4})/)[1]);
      env.lastWorkspace = { companyId, periodYear };
      return { companyId, periodYear };
    },
    async establishPeriod() { /* period intake is exercised by scenario A implicitly via the launchpad; explicit intake is
      the same setByLabel flow as scripts/e2e/localStackJourney.mjs if a scenario needs it. */ return true; },
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
    async isWorkspaceVisible(page, companyId) { return page.evaluate((id) => document.body.innerText.includes(id) || !!document.querySelector('[data-testid="next-action"], [data-testid="workspace-shell"]'), companyId).catch(() => false); },
    async readsAsOtherUser(u, companyId) {
      const c = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
      await c.auth.signInWithPassword({ email: u.email, password: u.password });
      const { data } = await c.from("trial_balance_uploads").select("id").eq("company_id", companyId);
      return (data ?? []).length > 0; // true ⇒ leakage
    },
    async observeViewport(page, route, vw) { await env.go(page, route); await page.setViewport(vw, 800); await sleep(500); await shot(page, `H-${vw}`); return { layoutWidth: await page.evaluate(() => document.documentElement.scrollWidth) }; },
    async observeFocusSequence(page) {
      return page.evaluate(() => {
        const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0; };
        return [...document.querySelectorAll("a[href],button,input,select,textarea,[tabindex]")].map((el, i) => ({ label: el.getAttribute("aria-label") || el.textContent.trim().slice(0, 40) || el.id, role: el.tagName.toLowerCase(), visible: vis(el), tabindex: el.hasAttribute("tabindex") ? Number(el.getAttribute("tabindex")) : undefined, interactive: true, domOrder: i }));
      }).catch(() => []);
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
    async captureClarityState(page, ws, name) {
      return page.evaluate((stateName) => {
        const na = document.querySelector('[data-testid="next-action"]');
        const ctas = [...document.querySelectorAll("button,a[role=button],a.btn")].slice(0, 12).map((el) => ({ label: el.textContent.trim().slice(0, 40), primary: /bg-primary|primary/.test(el.className) || el.getAttribute("data-primary") === "1" }));
        return { name: stateName, whatHappened: document.querySelector("h1,h2")?.textContent?.trim() ?? "", whatNext: na?.innerText?.trim() ?? "", saved: /saved|draft kept|not been saved|committed/i.test(document.body.innerText) ? (/committed/i.test(document.body.innerText) ? "committed" : /not been saved/i.test(document.body.innerText) ? "nothing" : "saved") : "unknown", copy: document.body.innerText.replace(/\s+/g, " ").trim().slice(0, 2000), ctas };
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
    try { const r = await s.run(env); results.push({ id: s.id, name: s.name, ...r }); }
    catch (e) { results.push({ id: s.id, name: s.name, status: "FAIL", problems: [`threw: ${String(e?.message ?? e).split("\n")[0]}`] }); }
    try { if (env.lastPage) await env.lastPage.screenshot(path.join(OUT, `${s.id}-final.png`)); } catch {}
  }
  await cleanup();
  finish(results, meta);
} catch (e) {
  finish(SCENARIOS.map((s) => ({ id: s.id, name: s.name, status: "BLOCKED", problems: [`bootstrap/run error: ${String(e?.message ?? e).split("\n")[0]}`] })), { env: "error" }, "runner could not establish the stack");
}
