#!/usr/bin/env node
// Online payment, end to end, in the REAL application on a LOCAL Supabase stack — after `supabase start` (CI job
// real-app-e2e). The payment Edge Functions are served from this repository with `supabase functions serve` and a
// generated env file; the two providers are a loopback MOCK (scripts/e2e/mockPaymentProviders.mjs) implementing only the
// documented requests the adapters make. Evidence classification: LOCAL application + database + Edge Functions, MOCK
// providers. No provider was contacted and no money moved.
//
//   operator    the first commercial administrator (operator bootstrap row), then everything else through /commercial/admin:
//               online payment opened in SANDBOX_ONLY, the USD price approved, a TZS price added and approved
//   public      self-service purchase is the only purchase path. In SANDBOX_ONLY an approved price is shown as unavailable
//               online, with Contact support (never a checkout link or manual activation); in CUSTOMER_PAYMENTS_ENABLED it
//               shows "by card" and "Choose <plan>", and a sandbox route is then not offered (the platform matrix). While
//               payment is closed the server itself refuses: no route, the attempt refused, no intent, no licence
//   card        sign in → /billing/checkout → card → the mock hosted page → Pay → signed order.paid → status page: payment
//               "Test payment received", no plan activated, references; in sandbox the licence is SANDBOX (it never grants
//               access: DEFECT-SANDBOX-LICENCE-PRODUCTION-LEAK-001) and the account has no plan
//   webhooks    a replay is DUPLICATE; a bad signature and a stale timestamp are refused (401) and recorded; an unknown
//               checkout is REFERENCE_MISMATCH; 5 concurrent deliveries leave one licence and one payment event
//   mobile      (NOT LAUNCHED — owner decision; exercised only against the loopback mock, which is the one configuration
//               the server accepts for it) mobile money → phone → status page → signed payment.completed → received
//   delayed     a correctly signed notification 20 minutes old recovers a paid order through the provider, exactly once
//   refunds     a partial then a full refund are recorded as changes (20,000 then 29,000); a redelivery records nothing
//   expiry      a card checkout left unpaid expires at the provider → status page: no payment taken → a new payment starts
//   leaving     (20261119100000) Back from the provider page → /plans names the checkout; Resume (the button) reopens the
//               SAME session; closing the tab and reopening /plans still names it; Choose another plan states the
//               consequence, waits out a moments-old provider answer (RETRY_LATER), then closes CFOClose's record only
//               (CANCELLED, audited; the provider session stays open) → another plan starts; an ended session on the order
//               page or the plans link returns there after signing in; a review case is never offered for closing and is
//               recovered by the next checkout once the provider expired it; an unreachable status service is stated
//   refund      the provider refunds → recorded for review, customer sees "refunded", the administrator records a decision
//   manual      manual activation from the screen; a manual grant over a paid term is refused
//   isolation   another account opening the order sees "Order not found"; its API read returns found:false
//   widths      checkout, status, orders and administrator pages at 1280 and 375 px
//   fresh       a new account sees no company, engagement, demonstration data or privilege; one next step (choose a plan);
//               one signed-in frame; keyboard, back, refresh, a failed plan read, return from plan selection; the server
//               refuses create_entity without a plan, another account's company and the administrator screen; after a
//               manual activation the home offers "Add a company" and the form creates one (1280 and 375 px)
//
//   node scripts/e2e/paymentJourney.mjs <evidence-dir>
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { Browser } from "../browser-acceptance/cdp.mjs";
import { layoutProblems } from "../browser-acceptance/checks.mjs";
import { assertLocalStack, verifyLocalBundle } from "./localStackFixtures.mjs";
import { startMockProviders } from "./mockPaymentProviders.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = path.resolve(process.argv[2] ?? path.join(REPO, "payment-evidence"));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

// ── Mock providers and the payment functions' configuration (test values generated for this run, never printed) ─────
const MOCK_PORT = 9911;
const APP_PORT = 4176;
const APP = `http://127.0.0.1:${APP_PORT}`;
const ORG = crypto.randomUUID();
const PRODUCTS = { SOLO: crypto.randomUUID(), PRACTICE: crypto.randomUUID(), FIRM: crypto.randomUUID() };
const polar = { accessToken: `polar_oat_e2e_${crypto.randomBytes(8).toString("hex")}`, webhookSecret: `whsec_${crypto.randomBytes(32).toString("base64")}` };
const snippe = { apiKey: `snp_e2e_${crypto.randomBytes(8).toString("hex")}`, webhookSecret: `whsec_${crypto.randomBytes(24).toString("hex")}` };
const mock = await startMockProviders({ port: MOCK_PORT, polar, snippe, webhookBase: `${apiUrl}/functions/v1`, organizationId: ORG });
const envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-payments-env-")), "functions.env");
fs.writeFileSync(envFile, [
  `SAFF_PAYMENT_REDIRECT_URL=${APP}/billing/payment/return`,
  "POLAR_ENVIRONMENT=sandbox", `POLAR_ACCESS_TOKEN=${polar.accessToken}`, `POLAR_WEBHOOK_SECRET=${polar.webhookSecret}`,
  `POLAR_ORGANIZATION_ID=${ORG}`, `POLAR_PRODUCT_IDS=${JSON.stringify(PRODUCTS)}`, `POLAR_API_BASE_URL=http://host.docker.internal:${MOCK_PORT}`,
  "SNIPPE_ENVIRONMENT=sandbox", `SNIPPE_API_KEY=${snippe.apiKey}`, `SNIPPE_WEBHOOK_SECRET=${snippe.webhookSecret}`,
  `SNIPPE_API_BASE_URL=http://host.docker.internal:${MOCK_PORT}`, "",
].join("\n"));
const serve = spawn("supabase", ["functions", "serve", "--env-file", envFile], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
const serveLog = fs.createWriteStream(path.join(OUT, "functions-serve.log"));
serve.stdout.pipe(serveLog); serve.stderr.pipe(serveLog);

// ── The production build of the app, pointed only at the local stack ────────────────────────────────────────────────
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
const distDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-pay-dist-"));
const emptyEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-no-env-"));
process.env.VITE_SUPABASE_URL = apiUrl;
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = anonKey;
process.env.VITE_SUPABASE_PROJECT_ID = "local";
const vite = await import("vite");
await vite.build({ root: REPO, configFile: path.join(REPO, "vite.config.ts"), mode: "e2e", envDir: emptyEnvDir, logLevel: "error", build: { outDir: distDir, emptyOutDir: true } });
const bundleProblems = verifyLocalBundle(walk(distDir).filter((f) => /\.(js|html|css)$/.test(f)).map((f) => fs.readFileSync(f, "utf8")), apiOrigin);
if (bundleProblems.length) throw new Error(`bundle verification failed: ${bundleProblems.join(", ")}`);
const preview = await vite.preview({ root: REPO, configFile: path.join(REPO, "vite.config.ts"), envDir: emptyEnvDir, logLevel: "error", build: { outDir: distDir }, preview: { port: APP_PORT, strictPort: true, host: "127.0.0.1" } });

// ── Accounts (generated test passwords, never printed) ───────────────────────────────────────────────────────────────
const run = Date.now().toString(36);
const mk = (who) => ({ email: `${who}.${run}@e2e-local.test`, password: `E2e!${crypto.randomBytes(12).toString("base64url")}` });
const U = { admin: mk("commercial-admin"), card: mk("buyer-card"), mobile: mk("buyer-mobile"), other: mk("buyer-other"), manual: mk("buyer-manual"), fresh: mk("fresh"), owner: mk("company-owner"), late: mk("buyer-late"), leaver: mk("buyer-leaver") };
for (const u of Object.values(U)) {
  const { data, error } = await admin.auth.admin.createUser({ email: u.email, password: u.password, email_confirm: true });
  if (error) throw new Error(`creating a test user failed: ${error.message}`);
  u.id = data.user.id;
}
// The operator bootstrap of the first commercial administrator (COMMERCIAL_ADMIN_GUIDE §5) — the only direct write.
{ const { error } = await admin.from("commercial_admins").insert({ user_id: U.admin.id, active: true }); if (error) throw new Error(`admin bootstrap: ${error.message}`); }
const apiAs = async (u) => {
  const c = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email: u.email, password: u.password });
  if (error) throw new Error(`api sign-in failed: ${error.message}`);
  return c;
};
/** Manual activation by agreement — the same RPCs /commercial/admin → Accounts → "Activate the plan" calls. */
const activatePlan = async (u, plan, reason) => {
  const ops = await apiAs(U.admin);
  let acct = (await ops.rpc("admin_find_billing_account", { p_email: u.email })).data;
  if (!acct?.billing_customer_id) {
    const { error } = await ops.rpc("admin_ensure_billing_customer", { p_owner_user_id: u.id, p_reason: reason });
    if (error) throw new Error(`ensure billing customer: ${error.message}`);
    acct = (await ops.rpc("admin_find_billing_account", { p_email: u.email })).data;
  }
  const start = new Date(); const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 12);
  const { error } = await ops.rpc("admin_grant_commercial_licence", { p_billing_customer_id: acct.billing_customer_id, p_plan_code: plan, p_effective_start: start.toISOString(), p_effective_end: end.toISOString(), p_reason: reason });
  if (error) throw new Error(`grant: ${error.message}`);
};
const intentsOf = async (u) => {
  const bc = (await admin.from("billing_customers").select("id").eq("owner_user_id", u.id).maybeSingle()).data;
  if (!bc) return [];
  return (await admin.from("payment_checkout_intents").select("id, saff_reference, status, provider, provider_checkout_ref, created_at").eq("billing_customer_id", bc.id).order("created_at")).data ?? [];
};
const licencesOf = async (u) => {
  const bc = (await admin.from("billing_customers").select("id").eq("owner_user_id", u.id).maybeSingle()).data;
  if (!bc) return [];
  return (await admin.from("commercial_licences").select("id, status, source, effective_start, effective_end, plan_id").eq("billing_customer_id", bc.id)).data ?? [];
};
/**
 * The server's own answer while online payment is closed for `u`. The real commercial-create-checkout offers no available
 * route (GET), refuses a card attempt (POST), and writes no checkout intent and no licence. A page that only hides the
 * button is not enough; this proves the refusal is enforced by the server.
 */
const serverRefusesCheckout = async (u, plan) => {
  const api = await apiAs(u);
  const { data: { session } } = await api.auth.getSession();
  const headers = { Authorization: `Bearer ${session.access_token}`, apikey: anonKey };
  const [intentsBefore, licencesBefore] = [(await intentsOf(u)).length, (await licencesOf(u)).length];
  const get = await fetch(`${apiUrl}/functions/v1/commercial-create-checkout?planCode=${plan}`, { headers });
  const options = (await get.json().catch(() => null))?.options ?? null;
  const post = await fetch(`${apiUrl}/functions/v1/commercial-create-checkout`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ planCode: plan, billingInterval: "ANNUAL", paymentRoute: "CARD" }) });
  const postBody = await post.json().catch(() => null);
  const [intentsAfter, licencesAfter] = [(await intentsOf(u)).length, (await licencesOf(u)).length];
  const ok = get.ok && Array.isArray(options) && options.length > 0 && options.every((o) => o.available === false)
    && post.status >= 400 && !postBody?.checkoutUrl && intentsAfter === intentsBefore && licencesAfter === licencesBefore;
  return ok ? true : { get: get.status, options, post: post.status, postBody, intentsBefore, intentsAfter, licencesBefore, licencesAfter };
};

// ── Wait until the served functions answer with the payment configuration loaded ─────────────────────────────────────
async function waitForFunctions() {
  // Configured = the Polar webhook endpoint has an adapter: an unsigned POST is refused with 401 (unconfigured: 503).
  // (Checkout options name no provider while payments are disabled — the resolver withholds every offer then.)
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${apiUrl}/functions/v1/commercial-webhook-polar`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (r.status === 401) return true;
    } catch { /* not up yet */ }
    await sleep(2000);
  }
  return false;
}

// ── Browser helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
const browser = await Browser.launch();
const shot = (name) => page.screenshot(path.join(OUT, `${name}.png`));
const go = async (route, text, timeout = 45000) => { await page.goto(`${APP}${route}`); if (text) await page.waitForText(text, { timeout }); await sleep(400); };
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
const setInput = (selector, value) => page.evaluate((sel, val) => {
  const el = document.querySelector(sel);
  if (!el) return false;
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, val);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}, selector, value);
let signedInContext = null;
async function signInAs(u) {
  signedInContext = await browser.newContext();
  page = await signedInContext.newPage();
  await page.setViewport(1280, 900);
  await go("/auth", "Sign in to your CFOClose account");
  await page.fill("#email", u.email);
  await page.fill("#password", u.password);
  await page.press("Enter");
  await page.waitFor(() => !location.pathname.startsWith("/auth"), [], { label: "left sign-in", timeout: 30000 });
}
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
const adminTab = async (label) => { await page.click({ text: label, within: '[role="tablist"]' }); await sleep(500); };
const acceptConfirms = () => page.evaluate(() => { window.confirm = () => true; return true; });

async function main() {
  startGroup("Setup (local stack, served payment functions, mock providers)");
  await check("the payment functions are served from this repository with the generated configuration (Polar and Snippe, sandbox)", async () => (await waitForFunctions()) || "functions did not load the payment configuration");

  startGroup("Fresh account: nothing appears without an authorised creation, invitation or membership");
  // Another account's company (the role NBAA plays on the hosted project) — created for that account only.
  // Created by that account itself, through the authorised path (an activated plan, then create_entity).
  await activatePlan(U.owner, "SOLO", "fresh-account journey: another account's company");
  const otherCo = await (async () => {
    const api = await apiAs(U.owner);
    const { data, error } = await api.rpc("create_entity", { p_request_id: crypto.randomUUID(), p_name: `Owner Co ${run}`, p_fiscal_year_end: "2025-12-31", p_currency: "USD", p_reporting_framework: null });
    if (error || (data?.outcome !== "created" && data?.outcome !== "already_created")) throw new Error(`the other account's company was not created: ${error?.message ?? JSON.stringify(data)}`);
    return { id: data.company_id };
  })();
  await signInAs(U.fresh);
  await check("a genuinely fresh account sees no company, engagement, demonstration data or plan — one next step (choose a plan before company creation)", async () => {
    await go("/dashboard", "Companies & engagements");
    await page.waitForSelector('[data-testid="account-next-action"][data-kind="choose_plan"]');
    const t = await page.bodyText();
    const needsPlan = await page.evaluate(() => document.querySelector('[data-testid="account-next-action"]')?.getAttribute("data-kind") === "choose_plan");
    const viewPlans = await page.evaluate(() => document.querySelector('[data-testid="next-action-primary"]')?.getAttribute("href") === "/plans");
    const primaries = await page.evaluate(() => document.querySelectorAll('[data-testid="next-action-primary"]').length);
    const disabled = await page.evaluate(() => [...document.querySelectorAll('[data-testid="portfolio-toolbar"] button[disabled], [data-testid="account-next-action"] button[disabled]')].map((b) => b.innerText.trim()));
    const api = await apiAs(U.fresh);
    const companies = (await api.from("companies").select("id")).data ?? [];
    const noPlanCount = (t.match(/No active plan/g) ?? []).length;
    return needsPlan && viewPlans && primaries === 1 && disabled.length === 0 && companies.length === 0 && noPlanCount <= 1
      && !t.includes(`Owner Co ${run}`) && !/demonstration|Your engagements\s*\n\s*\d+ open/i.test(t)
      ? true : { needsPlan, viewPlans, primaries, disabled, companies: companies.length, noPlanCount, text: t.slice(0, 600) };
  });
  await check("one signed-in frame: settings, plans, orders, profile and sign out are reachable through the header menus; no public Sign in", async () => {
    const seen = {};
    for (const route of ["/dashboard", "/plans", "/billing/orders", "/settings/billing"]) {
      await go(route);
      await page.waitForSelector('[data-testid="account-shell"]');
      // Management pages intentionally trap focus above the account shell. Prove their own exit and navigation,
      // then exercise the header after returning to work; never click through an inert modal backdrop.
      if (route !== "/dashboard") {
        await page.waitForSelector('[aria-label="Close practice settings"]');
        const destinations = await page.evaluate(() => [...document.querySelectorAll('nav[aria-label="Practice settings"] a')].map((a) => a.getAttribute("href")));
        if (!["/settings?section=profile", "/plans", "/settings/billing"].every((href) => destinations.includes(href))) return { route, destinations };
        await page.click('[aria-label="Close practice settings"]');
        await page.waitFor(() => !document.querySelector('[role="dialog"]'), [], { label: "management closed to the account" });
      }
      await page.click('[aria-label="Settings menu"]');
      // Radix installs keyboard dismissal and moves focus after mounting the portal. Wait for that
      // user-visible readiness before Escape; reading the menu DOM alone can precede its effects.
      await page.waitFor(() => {
        const menu = document.querySelector('[role="menu"][data-state="open"]');
        return !!menu && menu.contains(document.activeElement);
      }, [], { label: "settings menu keyboard focus", timeout: 10000 });
      const settings = await page.evaluate(() => [...document.querySelectorAll('[role="menu"] a')].map((e) => e.getAttribute("href")));
      await page.press("Escape");
      await page.waitFor(() => !document.querySelector('[role="menu"][data-state="open"]')
        && document.activeElement === document.querySelector('[aria-label="Settings menu"]'), [], { label: "settings menu closed and focus returned", timeout: 10000 });
      await page.click('[aria-label="Account menu"]');
      await page.waitFor(() => {
        const menu = document.querySelector('[role="menu"][data-state="open"]');
        return !!menu && menu.contains(document.activeElement);
      }, [], { label: "account menu keyboard focus", timeout: 10000 });
      const account = await page.evaluate(() => ({ profile: !!document.querySelector('[role="menu"] a[href="/settings?section=profile"]'), signOut: !!document.querySelector('[data-testid="account-sign-out"]') }));
      await page.press("Escape");
      await page.waitFor(() => !document.querySelector('[role="menu"][data-state="open"]')
        && document.activeElement === document.querySelector('[aria-label="Account menu"]'), [], { label: "account menu closed and focus returned", timeout: 10000 });
      const signIn = await page.evaluate(() => [...document.querySelectorAll("a")].some((a) => a.innerText.trim() === "Sign in"));
      seen[route] = { settings, account, signIn };
    }
    return Object.values(seen).every((s) => ["/settings", "/plans", "/settings/billing"].every((href) => s.settings.includes(href)) && s.account.profile && s.account.signOut && !s.signIn) ? true : seen;
  });
  await check("management: header opens one window; unsaved profile edits survive Keep editing, Escape requests discard, close restores the origin and keyboard focus", async () => {
    await go("/dashboard", "Companies & engagements");
    await page.click('[aria-label="Settings menu"]');
    await page.click('[role="menu"] a[href="/settings"]');
    await page.waitForSelector('[role="dialog"] #displayName');
    await page.fill('#displayName', "Unsubmitted browser fixture");
    await page.click('[aria-label="Close practice settings"]');
    await page.waitForText("You have unsaved changes");
    await page.click({ text: "Keep editing" });
    const kept = await page.evaluate(() => document.getElementById("displayName")?.value === "Unsubmitted browser fixture");
    await page.press("Escape");
    await page.waitForText("You have unsaved changes");
    await page.click({ text: "Discard changes" });
    await page.waitFor(() => location.pathname === "/dashboard" && !document.querySelector('[role="dialog"]')
      && document.activeElement === document.querySelector('[aria-label="Settings menu"]'), [], { label: "management origin and focus restored" });
    return kept ? true : "Keep editing lost the unsaved profile name";
  });
  await check("keyboard: Tab reaches the skip link first and the primary plan action; Enter opens plans", async () => {
    await go("/dashboard", "Companies & engagements");
    await page.waitForSelector('[data-testid="next-action-primary"]');
    await page.press("Tab");
    const first = await page.evaluate(() => document.activeElement?.innerText?.trim());
    let reached = false;
    for (let i = 0; i < 25 && !reached; i++) {
      await page.press("Tab");
      const id = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
      if (id === "next-action-primary") reached = true;
    }
    if (!reached) return { first, reached };
    await page.evaluate(() => document.querySelector('[data-testid="next-action-primary"]').focus());
    await page.press("Enter");
    await page.waitFor(() => location.pathname === "/plans", [], { label: "plans opened by keyboard" });
    return first === "Skip to content" ? true : { first };
  });
  await check("home at 1280 and 375 px (fresh account): no sideways scrolling", async () => {
    await go("/dashboard", "Companies & engagements");
    return widths("00-fresh-home");
  });
  await go("/dashboard", "Companies & engagements");
  await page.click('[data-testid="next-action-primary"]');
  await page.waitFor(() => location.pathname === "/plans", [], { label: "plans from the next step" });
  await check("plans (online payment closed, no approved price): 'Proposed', payment shown as unavailable with Contact support — no checkout link, no manual activation, no TZS, no mobile money", async () => {
    await page.waitForText("Choose your plan");
    await page.waitForText("Online payment is temporarily unavailable");
    const t = await page.bodyText();
    // Self-service purchase is the only purchase path for Solo, Practice and Firm (owner direction, 19aaa75): while it is
    // closed nothing on the page starts a checkout or a manual activation request for them. Enterprise is never sold online
    // and keeps its enquiry ("Discuss Enterprise"). The server's refusal is proven separately below.
    const links = await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")));
    const selfServeActivation = links.filter((h) => /service=plan_activation/.test(h) && !/[?&]plan=ENTERPRISE(&|$)/.test(h));
    const noCheckout = !links.some((h) => h.includes("/billing/checkout")) && selfServeActivation.length === 0;
    const enterpriseEnquiry = links.some((h) => /service=plan_activation/.test(h) && /[?&]plan=ENTERPRISE(&|$)/.test(h));
    return /Proposed: USD 490\s+per year/.test(t) && t.includes("Contact support") && noCheckout && enterpriseEnquiry
      && !/Choose Solo|Request activation|TZS|mobile money/i.test(t) ? true : { noCheckout, enterpriseEnquiry, links: links.filter((h) => /checkout|contact/.test(h)), text: t.slice(0, 800) };
  });
  await check("payments closed: the server itself refuses the purchase (no route offered, the attempt refused, no intent, no licence)", () => serverRefusesCheckout(U.fresh, "SOLO"));
  await check("back navigation and refresh return to the same home and the same next step", async () => {
    await page.evaluate(() => history.back());
    await page.waitFor(() => location.pathname === "/dashboard", [], { label: "back to home" });
    await page.waitForSelector('[data-testid="account-next-action"][data-kind="choose_plan"]');
    await page.evaluate(() => location.reload());
    await page.waitForSelector('[data-testid="account-next-action"][data-kind="choose_plan"]');
    return true;
  });
  await check("a failed plan read is a retriable step (never 'no plan'); Try again recovers once the request succeeds", async () => {
    await page.send("Network.setBlockedURLs", { urls: ["*get_my_billing_summary*"] });
    await go("/dashboard", "We couldn’t confirm your plan");
    const failedKind = await page.evaluate(() => document.querySelector('[data-testid="account-next-action"]')?.getAttribute("data-kind"));
    await page.send("Network.setBlockedURLs", { urls: [] });
    await page.click('[data-testid="next-action-primary"]');
    await page.waitForSelector('[data-testid="account-next-action"][data-kind="choose_plan"]');
    return failedKind === "retry" ? true : { failedKind };
  });
  await check("return from plan selection: signed out on /billing/checkout?plan=PRACTICE → Sign in → back on that checkout, in the account frame; payment unavailable, Try again and Contact support", async () => {
    page = await (await browser.newContext()).newPage(); await page.setViewport(1280, 900);
    await go("/billing/checkout?plan=PRACTICE", "Sign in");
    await page.click('[data-testid="checkout-sign-in"]');
    await page.waitForText("Sign in to your CFOClose account");
    await page.fill("#email", U.fresh.email);
    await page.fill("#password", U.fresh.password);
    await page.press("Enter");
    await page.waitFor(() => location.pathname === "/billing/checkout" && location.search.includes("PRACTICE"), [], { label: "returned to the chosen plan", timeout: 30000 });
    await page.waitForText("Online payment is temporarily unavailable for this plan.");
    const shell = await page.evaluate(() => !!document.querySelector('[data-testid="account-shell"]'));
    const actions = await page.evaluate(() => ({ retry: !!document.querySelector('[data-testid="checkout-retry"]'),
      support: !!document.querySelector('[data-testid="checkout-contact-support"]'), pay: !!document.querySelector('[data-testid="checkout-continue"]') }));
    const t = await page.bodyText();
    return shell && actions.retry && actions.support && !actions.pay && t.includes("Practice plan")
      && !/Continue to Polar|Request activation|mobile money/i.test(t) ? true : { shell, actions, text: t.slice(0, 600) };
  });
  await check("changing the interface grants nothing: create_entity without a plan, another account's company and the administrator screen are all refused by the server", async () => {
    const api = await apiAs(U.fresh);
    const created = await api.rpc("create_entity", { p_request_id: crypto.randomUUID(), p_name: "Forged Co", p_fiscal_year_end: "2025-12-31", p_currency: "USD", p_reporting_framework: null });
    const outcome = created.error ? `error:${created.error.code}` : created.data?.outcome;
    const theirs = (await api.from("companies").select("id").eq("id", otherCo.id)).data ?? [];
    const caps = await api.rpc("get_my_workspace_capabilities", { p_company_id: otherCo.id });
    const mine = (await api.from("companies").select("id")).data ?? [];
    await go("/commercial/admin");
    await page.waitForSelector('[data-testid="admin-forbidden"]');
    const capAccess = caps.error ? false : caps.data?.access === true;
    return outcome !== "created" && outcome !== "already_created" && theirs.length === 0 && !capAccess && mine.length === 0
      ? true : { outcome, theirs: theirs.length, caps: caps.data ?? caps.error?.code, mine: mine.length };
  });
  await check("with a plan granted by an administrator: Add company opens focused setup; creating one opens its workspace", async () => {
    await activatePlan(U.fresh, "SOLO", "fresh-account journey: manual activation");
    await go("/dashboard", "Companies & engagements");
    await page.waitForSelector('[data-testid="add-company"]');
    await page.click('[data-testid="add-company"]');
    await page.waitForSelector('[data-testid="company-setup-page"]');
    await page.fill("#fr-org", `Fresh Co ${run}`);
    // The searchable currency selector (an ARIA combobox): type the code, then Enter on the highlighted match.
    await page.evaluate(() => { const el = document.getElementById("fr-currency"); el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "USD"); el.dispatchEvent(new Event("input", { bubbles: true })); });
    await sleep(150);
    await page.evaluate(() => document.getElementById("fr-currency").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    await page.waitFor(() => document.getElementById("fr-currency")?.dataset.value === "USD", [], { label: "USD chosen", timeout: 5000 });
    await page.click('form[aria-label="Add an entity"] button[type="submit"]');
    await page.waitFor(() => location.pathname.startsWith("/workspace/"), [], { label: "opened the new workspace", timeout: 30000 });
    const api = await apiAs(U.fresh);
    const mine = (await api.from("companies").select("id, name")).data ?? [];
    return mine.length === 1 && mine[0].name === `Fresh Co ${run}` ? true : mine;
  });
  await check("signed-in plans and orders at 1280 and 375 px: no sideways scrolling", async () => {
    await go("/plans", "Choose your plan");
    const plans = await widths("00-fresh-plans");
    await go("/billing/orders", "Orders & receipts");
    const orders = await widths("00-fresh-orders");
    return plans === true && orders === true ? true : { plans, orders };
  });

  startGroup("Administrator: online payment opened in sandbox; prices approved — all from /commercial/admin");
  await signInAs(U.admin);
  await check("a commercial administrator opens /commercial/admin (genuine signed-in session)", async () => { await go("/commercial/admin", "Commercial administration"); return true; });
  await check("Online payment: PAYMENTS_DISABLED → SANDBOX_ONLY, typed confirmation and a recorded reason", async () => {
    await adminTab("Online payment");
    // The state shows as its label with the raw state in brackets (f9a801f, provider diagnostics).
    await page.waitForText("Payments disabled (PAYMENTS_DISABLED)");
    await setByLabel("New state", "SANDBOX_ONLY");
    await setByLabel("Type the state to confirm", "SANDBOX_ONLY");
    await setByLabel("Reason (recorded)", "Payment journey test (sandbox)");
    await page.click({ text: "Change state" });
    await page.waitForText("Online payment state is now SANDBOX_ONLY");
    const s = (await admin.from("commercial_platform_state").select("state").eq("id", true).single()).data.state;
    const audit = (await admin.from("commercial_catalog_audit_events").select("action").eq("action", "PLATFORM_STATE_TRANSITIONED").eq("actor_user_id", U.admin.id)).data ?? [];
    return s === "SANDBOX_ONLY" && audit.length === 1 ? true : { s, audit: audit.length };
  });
  await check("Prices: the USD Solo annual price approved; a TZS Solo price added, then approved — each audited with its reason", async () => {
    await adminTab("Prices");
    await page.waitForText("CFOCLOSE_SOLO_GLOBAL_USD_ANNUAL");
    await setByLabel("Reason (recorded)", "Approved for the payment journey test");
    await acceptConfirms();
    await page.evaluate(() => { const row = document.querySelector('li[data-offer-code="CFOCLOSE_SOLO_GLOBAL_USD_ANNUAL"]'); [...row.querySelectorAll("button")].find((b) => b.textContent === "Approve").click(); });
    await page.waitForText("Price saved.");
    await setByLabel("Market", "TZ");
    await sleep(200);
    await setByLabel("Amount per year", "1250000");
    await page.click({ text: "Save (not yet approved)" });
    await page.waitForText("CFOCLOSE_SOLO_TZ_TZS_ANNUAL");
    await acceptConfirms();
    await page.evaluate(() => { const row = document.querySelector('li[data-offer-code="CFOCLOSE_SOLO_TZ_TZS_ANNUAL"]'); [...row.querySelectorAll("button")].find((b) => b.textContent === "Approve").click(); });
    await sleep(1500);
    const offers = (await admin.from("commercial_offers").select("offer_code, is_purchasable, amount_minor, currency_code").in("offer_code", ["CFOCLOSE_SOLO_GLOBAL_USD_ANNUAL", "CFOCLOSE_SOLO_TZ_TZS_ANNUAL"])).data;
    const audit = (await admin.from("commercial_catalog_audit_events").select("action").eq("actor_user_id", U.admin.id).in("action", ["OFFER_UPDATED", "OFFER_CREATED"])).data ?? [];
    return offers.length === 2 && offers.every((o) => o.is_purchasable) && audit.length >= 3 ? true : { offers, audit: audit.length };
  });
  await check("administrator pages at 1280 and 375 px", async () => { await adminTab("Payments needing attention"); return widths("20-admin-payments"); });

  startGroup("Public plans follow the server");
  await check("in SANDBOX_ONLY sandbox payments are never advertised: the approved Solo price is shown as unavailable online, with Contact support and no checkout link", async () => {
    page = await (await browser.newContext()).newPage(); await page.setViewport(1280, 900);
    await go("/", "Choose your capacity.");
    await page.waitForText("Online payment is temporarily unavailable", { timeout: 30000 });
    const t = await page.bodyText();
    // The landing's capacity table (CapacityPlans): one row per plan, keyed by the plan's name.
    const plans = await page.evaluate(() => {
      const row = document.querySelector('[data-testid="plan-Solo"]');
      const action = document.querySelector('[data-testid="plan-action-Solo"]');
      return { mode: row?.getAttribute("data-mode"), checkoutLinks: [...document.querySelectorAll("a[href]")].filter((a) => a.getAttribute("href").includes("/billing/checkout")).length,
        support: action?.textContent?.trim() === "Contact support", note: !!document.querySelector('[data-testid="plans-unavailable-note"]') };
    });
    // Approved but checkout closed to customers: the server's amount (no "Proposed"), shown as unavailable online, and no
    // checkout link or manual-activation route anywhere on the page.
    const solo = t.includes("USD 490 per year") && !t.includes("Proposed: USD 490 per year");
    return solo && plans.mode === "unavailable" && plans.checkoutLinks === 0 && plans.support && plans.note
      && !/Choose Solo|Request activation|by card|TZS|mobile money/.test(t) ? true : { plans, text: t.slice(0, 1200) };
  });

  startGroup("Card payment (Polar, mock hosted page)");
  await signInAs(U.card);
  await check("checkout shows the plan, both routes at the server's prices, test mode, and where the term starts", async () => {
    await go("/billing/checkout?plan=SOLO", "Solo plan · 12 months");
    await page.waitForText("Card · USD 490");
    const t = await page.bodyText();
    return t.includes("Mobile money · TZS 1,250,000") && t.includes("no real money is charged") && t.includes("starts as soon as the payment is verified") ? true : t.slice(0, 800);
  });
  await check("checkout at 1280 and 375 px", async () => widths("21-checkout"));
  let cardRef = null; let cardCheckout = null;
  await check("card → the provider's hosted page; nothing is recorded as paid before the provider confirms", async () => {
    await page.click('[data-testid="route-CARD"] input');
    await page.waitForText("Sales tax may apply");
    await page.click('[data-testid="checkout-continue"]');
    await page.waitForUrl(/127\.0\.0\.1:9911\/pay\//, { timeout: 30000 });
    const [i] = await intentsOf(U.card);
    cardRef = i?.saff_reference; cardCheckout = i?.provider_checkout_ref;
    const c = mock.checkouts.get(cardCheckout);
    const lic = await licencesOf(U.card);
    return i?.status === "PENDING" && i.provider === "POLAR" && c?.amount === 49000 && c?.currency === "usd" && c?.taxBehavior === "exclusive" && c?.discounts === false && lic.length === 0 ? true : { i, c, lic: lic.length };
  });
  await check("Pay → signed order.paid → the status page says TEST payment received and no plan activated; the licence is SANDBOX and the account has no plan", async () => {
    await shot("22-mock-provider-page");
    await page.click('[data-testid="mock-pay"]');
    await page.waitForUrl(/\/billing\/payment\/return\?ref=/, { timeout: 30000 });
    await page.waitForText("Test payment received", { timeout: 60000 });
    await page.waitForText("No plan was activated");
    const lic = await licencesOf(U.card);
    const t = await page.bodyText();
    const summary = (await (await apiAs(U.card)).rpc("get_my_billing_summary")).data;
    return lic.length === 1 && lic[0].source === "POLAR_VERIFIED_PAYMENT" && lic[0].status === "SANDBOX" && summary?.licence_status == null
      && t.includes(cardRef) && !/plan is active|Start a trial balance review/.test(t) ? true : { lic, summary, t: t.slice(0, 600) };
  });
  await check("status page at 1280 and 375 px", async () => widths("23-status-received"));
  await check("the orders page lists the test order as a test payment with no access (never as an active term)", async () => {
    await go("/billing/orders", "Orders & receipts");
    await page.waitForText("Test payment · no access");
    await widths("24-orders");
    return (await page.bodyText()).includes(cardRef) ? true : "order not listed";
  });

  startGroup("Webhook authenticity, duplicates and concurrency (through the real functions)");
  const firstPaid = mock.deliveries.find((d) => d.provider === "POLAR" && JSON.parse(d.body).type === "order.paid");
  await check("the original delivery was settled (200 PROCESSED) and recorded with a receipt first", async () => {
    const pe = (await admin.from("payment_webhook_processing_events").select("processing_result, signature_valid").eq("provider", "POLAR")).data ?? [];
    return firstPaid?.status === 200 && firstPaid.response?.outcome === "PROCESSED" && pe.some((r) => r.processing_result === "PROCESSED" && r.signature_valid) ? true : { firstPaid: firstPaid?.response, pe };
  });
  await check("a replay of the same delivery (same webhook-id) answers 200 DUPLICATE and changes nothing", async () => {
    const before = (await licencesOf(U.card)).length;
    const r = await mock.deliver("POLAR", JSON.parse(firstPaid.body), { id: firstPaid.id });
    return r.status === 200 && r.response?.outcome === "DUPLICATE" && (await licencesOf(U.card)).length === before ? true : r.response;
  });
  await check("a delivery signed with another key is refused (401 INVALID_SIGNATURE) and recorded", async () => {
    const r = await mock.deliver("POLAR", JSON.parse(firstPaid.body), { tamper: true });
    const pe = (await admin.from("payment_webhook_processing_events").select("processing_result, signature_valid").eq("processing_result", "INVALID_SIGNATURE")).data ?? [];
    return r.status === 401 && pe.length >= 1 && pe.every((x) => x.signature_valid === false) ? true : { r: r.response, pe };
  });
  await check("a correctly signed capture replayed 10 minutes later is never believed: no new licence or event (DUPLICATE or throttled reconciliation)", async () => {
    const intent = (await intentsOf(U.card))[0];
    const before = { lic: (await licencesOf(U.card)).length, ev: ((await admin.from("payment_events").select("id").eq("checkout_intent_id", intent.id)).data ?? []).length };
    const r = await mock.deliver("POLAR", JSON.parse(firstPaid.body), { timestamp: Math.floor(Date.now() / 1000) - 600 });
    const after = { lic: (await licencesOf(U.card)).length, ev: ((await admin.from("payment_events").select("id").eq("checkout_intent_id", intent.id)).data ?? []).length };
    const stale = (await admin.from("payment_webhook_processing_events").select("id").eq("processing_result", "STALE_TIMESTAMP")).data ?? [];
    return [200, 202].includes(r.status) && ["DUPLICATE", "RECONCILIATION_THROTTLED"].includes(r.response?.outcome) && JSON.stringify(before) === JSON.stringify(after) && stale.length >= 1
      ? true : { r: r.response, before, after };
  });
  await check("a delivery naming a checkout this system never created is REFERENCE_MISMATCH (200, nothing written)", async () => {
    const body = JSON.parse(firstPaid.body); body.data.checkout_id = crypto.randomUUID();
    const r = await mock.deliver("POLAR", body);
    return r.status === 200 && r.response?.outcome === "REFERENCE_MISMATCH" ? true : r.response;
  });
  await check("5 concurrent deliveries (distinct ids) of the paid order leave exactly one licence and one payment event", async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => mock.deliver("POLAR", JSON.parse(firstPaid.body))));
    const intent = (await intentsOf(U.card))[0];
    const events = (await admin.from("payment_events").select("id").eq("checkout_intent_id", intent.id).eq("event_type", "PAYMENT_CONFIRMED")).data ?? [];
    return rs.every((r) => r.status === 200) && (await licencesOf(U.card)).length === 1 && events.length === 1 ? true : { st: rs.map((r) => r.response?.outcome), events: events.length };
  });

  startGroup("Mobile money (Snippe, mock)");
  await signInAs(U.mobile);
  let mmRef = null;
  await check("mobile money → a payment prompt is requested for exactly the TZS offer; the status page says to approve it on the phone", async () => {
    await go("/billing/checkout?plan=SOLO", "Mobile money · TZS 1,250,000");
    await page.click('[data-testid="route-MOBILE_MONEY"] input');
    await page.waitForSelector('[data-testid="checkout-phone"]');
    await setInput('[data-testid="checkout-phone"]', "0712 345 678");
    await page.click('[data-testid="checkout-continue"]');
    await page.waitForUrl(/\/billing\/payment\/return\?ref=/, { timeout: 30000 });
    await page.waitForText("Approve the payment on your phone");
    const [i] = await intentsOf(U.mobile);
    mmRef = i?.provider_checkout_ref;
    const pm = mock.payments.get(mmRef);
    return i?.provider === "SNIPPE" && pm?.amount === 1250000 && pm?.currency === "TZS" && pm?.phone === "255712345678" && pm?.metadata?.saff_reference === i.saff_reference ? true : { i, pm };
  });
  await check("mobile-money status page at 1280 and 375 px", async () => widths("25-status-mobile-pending"));
  await check("the customer approves → signed payment.completed → TEST payment received; the licence is SANDBOX (no access)", async () => {
    const r = await mock.completeSnippe(mmRef);
    await page.waitForText("Test payment received", { timeout: 60000 });
    const lic = await licencesOf(U.mobile);
    return r.status === 200 && lic.length === 1 && lic[0].source === "SNIPPE_VERIFIED_PAYMENT" && lic[0].status === "SANDBOX" ? true : { r: r.response, lic };
  });
  // The Snippe webhook endpoint, attacked the same way as Polar's (signing key used as-is, hex HMAC over
  // "<X-Webhook-Timestamp>.<raw body>"; deduplicated by event id; every delivery read back from the provider).
  const snippePaid = mock.deliveries.find((d) => d.provider === "SNIPPE" && JSON.parse(d.body).type === "payment.completed");
  const mmEvents = async () => {
    const [i] = await intentsOf(U.mobile);
    return ((await admin.from("payment_events").select("id").eq("checkout_intent_id", i.id)).data ?? []).length;
  };
  await check("Snippe: a replay of the same event id answers 200 DUPLICATE and changes nothing", async () => {
    const before = { lic: (await licencesOf(U.mobile)).length, ev: await mmEvents() };
    const r = await mock.deliver("SNIPPE", JSON.parse(snippePaid.body));
    return r.status === 200 && r.response?.outcome === "DUPLICATE" && (await licencesOf(U.mobile)).length === before.lic && await mmEvents() === before.ev ? true : r.response;
  });
  await check("Snippe: a delivery signed with another key is refused (401 INVALID_SIGNATURE) and recorded; nothing changes", async () => {
    const before = await mmEvents();
    const r = await mock.deliver("SNIPPE", JSON.parse(snippePaid.body), { tamper: true });
    const pe = (await admin.from("payment_webhook_processing_events").select("signature_valid").eq("provider", "SNIPPE").eq("processing_result", "INVALID_SIGNATURE")).data ?? [];
    return r.status === 401 && pe.length >= 1 && pe.every((x) => x.signature_valid === false) && await mmEvents() === before ? true : { r: r.response, pe };
  });
  await check("Snippe: a correctly signed capture replayed 10 minutes later is never believed (DUPLICATE or throttled reconciliation); nothing changes", async () => {
    const before = { lic: (await licencesOf(U.mobile)).length, ev: await mmEvents() };
    const body = JSON.parse(snippePaid.body); body.id = `evt_${crypto.randomUUID().slice(0, 12)}`;
    const r = await mock.deliver("SNIPPE", body, { timestamp: Math.floor(Date.now() / 1000) - 600 });
    const stale = (await admin.from("payment_webhook_processing_events").select("id").eq("provider", "SNIPPE").eq("processing_result", "STALE_TIMESTAMP")).data ?? [];
    return [200, 202].includes(r.status) && ["DUPLICATE", "RECONCILIATION_THROTTLED"].includes(r.response?.outcome) && stale.length >= 1
      && (await licencesOf(U.mobile)).length === before.lic && await mmEvents() === before.ev ? true : { r: r.response, before };
  });
  await check("Snippe: a signed delivery naming a payment this system never created is REFERENCE_MISMATCH (200, nothing written)", async () => {
    const body = JSON.parse(snippePaid.body); body.id = `evt_${crypto.randomUUID().slice(0, 12)}`; body.data.reference = `pi_${crypto.randomBytes(6).toString("hex")}`;
    const r = await mock.deliver("SNIPPE", body);
    return r.status === 200 && r.response?.outcome === "REFERENCE_MISMATCH" ? true : r.response;
  });
  await check("Snippe: 5 concurrent deliveries (distinct event ids) of the completed payment leave exactly one licence and one payment event", async () => {
    const rs = await Promise.all(Array.from({ length: 5 }, () => { const b = JSON.parse(snippePaid.body); b.id = `evt_${crypto.randomUUID().slice(0, 12)}`; return mock.deliver("SNIPPE", b); }));
    const [i] = await intentsOf(U.mobile);
    const confirmed = (await admin.from("payment_events").select("id").eq("checkout_intent_id", i.id).eq("event_type", "PAYMENT_CONFIRMED")).data ?? [];
    return rs.every((r) => r.status === 200) && (await licencesOf(U.mobile)).length === 1 && confirmed.length === 1 ? true : { st: rs.map((r) => r.response?.outcome), confirmed: confirmed.length };
  });

  startGroup("An unpaid checkout that expires");
  await signInAs(U.other);
  let otherRef = null;
  await check("a card checkout left unpaid, then expired at the provider: the status page says no payment was taken", async () => {
    await go("/billing/checkout?plan=SOLO", "Card · USD 490");
    await page.click('[data-testid="route-CARD"] input');
    await page.click('[data-testid="checkout-continue"]');
    await page.waitForUrl(/127\.0\.0\.1:9911\/pay\//, { timeout: 30000 });
    const [i] = await intentsOf(U.other);
    otherRef = i.saff_reference;
    const r = await mock.expirePolar(i.provider_checkout_ref);
    await go(`/billing/payment/return?ref=${otherRef}`, "The payment request expired", 60000);
    const after = (await intentsOf(U.other))[0];
    return r.status === 200 && after.status === "EXPIRED" && (await licencesOf(U.other)).length === 0 ? true : { r: r.response, after };
  });
  await check("'Start a new payment' opens checkout again and a new attempt starts (the expired one never blocks it)", async () => {
    await page.click('[data-testid="next-try-again"]');
    await page.waitForText("Card · USD 490");
    await page.click('[data-testid="route-CARD"] input');
    await page.click('[data-testid="checkout-continue"]');
    await page.waitForUrl(/127\.0\.0\.1:9911\/pay\//, { timeout: 30000 });
    const all = await intentsOf(U.other);
    return all.length === 2 && all[1].status === "PENDING" ? true : all;
  });
  await check("a legitimately DELAYED notification (correctly signed, 20 minutes old) recovers a paid order through the provider: one licence, one payment event", async () => {
    const pending = (await intentsOf(U.other))[1];
    mock.markPaidSilently(pending.provider_checkout_ref);
    const c = mock.checkouts.get(pending.provider_checkout_ref);
    const r = await mock.deliver("POLAR", { type: "order.paid", data: mock.orderFor(c) }, { timestamp: Math.floor(Date.now() / 1000) - 1200 });
    const again = await mock.deliver("POLAR", { type: "order.paid", data: mock.orderFor(c) }, { timestamp: Math.floor(Date.now() / 1000) - 1200 });
    const lic = (await licencesOf(U.other)).filter((l) => l.source === "POLAR_VERIFIED_PAYMENT");
    const ev = (await admin.from("payment_events").select("id").eq("checkout_intent_id", pending.id).eq("event_type", "PAYMENT_CONFIRMED")).data ?? [];
    const st = (await intentsOf(U.other))[1].status;
    return r.status === 200 && r.response?.outcome === "PROCESSED" && r.response?.reconciled === true && [200, 202].includes(again.status)
      && lic.length === 1 && ev.length === 1 && st === "SUCCEEDED" ? true : { r: r.response, again: again.response, lic: lic.length, ev: ev.length, st };
  });
  await check("another account opening the paid order sees 'Order not found'; its API read returns found:false", async () => {
    await go(`/billing/payment/return?ref=${cardRef}`, "Order not found");
    const api = await apiAs(U.other);
    const { data } = await api.rpc("get_checkout_status", { p_saff_reference: cardRef });
    return data?.found === false ? true : data;
  });

  startGroup("Leaving the provider's page without paying (20261119100000)");
  // This journey switches between Solo and Practice. Approve Practice through the same operator UI;
  // an unavailable offer must never be treated as a checkout-recovery failure.
  await signInAs(U.admin);
  await check("approve the Practice USD annual offer for the two-plan abandonment journey", async () => {
    await go("/commercial/admin");
    await adminTab("Prices");
    await page.waitForText("CFOCLOSE_PRACTICE_GLOBAL_USD_ANNUAL");
    await setByLabel("Reason (recorded)", "Approved for the two-plan abandonment journey");
    await acceptConfirms();
    await page.evaluate(() => {
      const row = document.querySelector('li[data-offer-code="CFOCLOSE_PRACTICE_GLOBAL_USD_ANNUAL"]');
      [...row.querySelectorAll("button")].find((b) => b.textContent === "Approve").click();
    });
    await page.waitForText("Price saved.");
    const { data, error } = await admin.from("commercial_offers").select("is_purchasable, amount_minor")
      .eq("offer_code", "CFOCLOSE_PRACTICE_GLOBAL_USD_ANNUAL").single();
    return !error && data?.is_purchasable && Number(data.amount_minor) === 99000 ? true : { data, error };
  });
  await signInAs(U.leaver);
  let leftRef = null; let leftSession = null;
  const banner = () => page.evaluate(() => {
    const b = document.querySelector('[data-testid="unfinished-checkout"]');
    return { text: b?.innerText ?? "", ref: b?.getAttribute("data-ref") ?? null, resume: !!document.querySelector('[data-testid="unfinished-resume"]'),
      choose: !!document.querySelector('[data-testid="unfinished-choose-another"]'), spinner: /Waiting for payment confirmation/.test(document.body.innerText) };
  });
  await check("Back: card → the provider's page → its Back link lands on /plans naming the unfinished checkout (recorded state only: 'No payment has been recorded'), Resume and Choose another plan — never a spinner", async () => {
    await go("/billing/checkout?plan=PRACTICE", "Card, on Polar\'s secure page");
    await page.waitForSelector('[data-testid="checkout-continue"]:not([disabled])');
    await page.click('[data-testid="checkout-continue"]');
    await page.waitForUrl(/127\.0\.0\.1:9911\/pay\//, { timeout: 30000 });
    const [i] = await intentsOf(U.leaver);
    leftRef = i?.saff_reference; leftSession = i?.provider_checkout_ref;
    await page.click('[data-testid="mock-back"]');
    await page.waitFor(() => location.pathname === "/plans" && location.search.includes("unfinished="), [], { label: "back on the plans page" });
    await page.waitForSelector('[data-testid="unfinished-checkout"]', { timeout: 30000 });
    const b = await banner();
    return i?.status === "PENDING" && b.ref === leftRef && /Practice checkout isn't finished/.test(b.text) && /No payment has been recorded/.test(b.text)
      && b.resume && b.choose && !b.spinner ? true : { i, b };
  });
  await check("plans page with the unfinished checkout at 1280 and 375 px", async () => widths("28-plans-unfinished"));
  await check("Resume (the button): asks the provider at that moment and opens the SAME provider session; its Back link returns to the banner", async () => {
    await page.click('[data-testid="unfinished-resume"]');
    await page.waitForUrl(new RegExp(`127\\.0\\.0\\.1:9911/pay/${leftSession}`), { timeout: 30000 });
    const sessions = (await intentsOf(U.leaver)).length;
    await page.click('[data-testid="mock-back"]');
    await page.waitForSelector('[data-testid="unfinished-checkout"]', { timeout: 30000 });
    return sessions === 1 ? true : { sessions };
  });
  await check("close: the tab is closed and the plans page opened again WITHOUT the link — the account's own open checkout is still named", async () => {
    // Same browser profile (the signed-in session survives), the old tab closed.
    const old = page;
    page = await signedInContext.newPage();
    await page.setViewport(1280, 900);
    await browser.send("Target.closeTarget", { targetId: old.targetId });
    await go("/plans", "Choose your plan");
    await page.waitForSelector('[data-testid="unfinished-checkout"]', { timeout: 30000 });
    const b = await banner();
    return b.ref === leftRef ? true : b;
  });
  await check("Choose another plan: the consequence is stated before anything changes; Keep it changes nothing", async () => {
    await page.click('[data-testid="unfinished-choose-another"]');
    await page.waitForSelector('[data-testid="unfinished-confirm"]');
    const text = await page.evaluate(() => document.querySelector('[data-testid="unfinished-confirm"]').innerText);
    await widths("29-leave-confirm");
    await page.click('[data-testid="unfinished-keep"]');
    const [i] = await intentsOf(U.leaver);
    return /payment page itself stays open until it expires/.test(text) && /never applied twice/.test(text) && i.status === "PENDING" ? true : { text, st: i.status };
  });
  await check("…Close this checkout: the provider was asked moments ago (Resume), so the page waits visibly (RETRY_LATER) and asks afresh — then CFOClose's record is CANCELLED and audited once, and the Polar session is NOT cancelled", async () => {
    await page.click('[data-testid="unfinished-choose-another"]');
    await page.click('[data-testid="unfinished-confirm-close"]');
    const waited = await page.waitForSelector('[data-testid="unfinished-waiting"]', { timeout: 15000 }).then(() => true, () => false);
    // Never Resume and a close at once: while the close waits, Resume is disabled.
    const resumeOff = waited && await page.evaluate(() => document.querySelector('[data-testid="unfinished-resume"]')?.disabled === true);
    if (waited) await shot("30-leave-waiting-1280");
    await page.waitForSelector('[data-testid="unfinished-checkout-left"]', { timeout: 150000 });
    await widths("31-plans-left");
    const [i] = await intentsOf(U.leaver);
    const row = (await admin.from("payment_checkout_intents").select("status, metadata").eq("id", i.id).single()).data;
    const audit = (await admin.from("billing_audit_events").select("id").eq("action", "CHECKOUT_ABANDONED_BY_CUSTOMER").eq("actor_user_id", U.leaver.id)).data ?? [];
    const providerSession = mock.checkouts.get(leftSession)?.status;
    return waited && resumeOff && row?.status === "CANCELLED" && row.metadata?.cancel_reason === "CUSTOMER_ABANDONED_UNPAID" && audit.length === 1 && providerSession === "open"
      ? true : { waited, resumeOff, row, audit: audit.length, providerSession };
  });
  await check("…then another plan's payment starts at once (no waiting for the old session to expire)", async () => {
    await go("/billing/checkout?plan=SOLO", "Card · USD 490");
    await page.click('[data-testid="route-CARD"] input');
    await page.click('[data-testid="checkout-continue"]');
    await page.waitForUrl(/127\.0\.0\.1:9911\/pay\//, { timeout: 30000 });
    const all = await intentsOf(U.leaver);
    return all.length === 2 && all[0].status === "CANCELLED" && all[1].status === "PENDING" ? true : all.map((x) => x.status);
  });
  await check("sign-in expiry on the order page: the session ends → 'Sign in' → after signing in, back on exactly that order", async () => {
    const pendingRef = (await intentsOf(U.leaver))[1].saff_reference;
    await go(`/billing/payment/return?ref=${pendingRef}`);
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("sb-")) localStorage.removeItem(k); });
    await go(`/billing/payment/return?ref=${pendingRef}`);
    await page.waitForSelector('[data-testid="payment-sign-in"]', { timeout: 30000 });
    await widths("33-status-sign-in");
    await page.click('[data-testid="payment-sign-in-link"]');
    await page.waitForText("Sign in to your CFOClose account");
    await page.fill("#email", U.leaver.email);
    await page.fill("#password", U.leaver.password);
    await page.press("Enter");
    await page.waitFor((r) => location.pathname === "/billing/payment/return" && location.search.includes(r), [pendingRef], { label: "back on the order", timeout: 30000 });
    return true;
  });
  await check("sign-in expiry on the plans link: signed out on /plans?unfinished=… → 'Sign in' → after signing in, back on that link with the checkout named", async () => {
    const pendingRef = (await intentsOf(U.leaver))[1].saff_reference;
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith("sb-")) localStorage.removeItem(k); });
    await go(`/plans?unfinished=${pendingRef}`);
    await page.waitForSelector('[data-testid="unfinished-sign-in"]', { timeout: 30000 });
    await widths("32-plans-signed-out-unfinished");
    await page.click('[data-testid="unfinished-sign-in-link"]');
    await page.waitForText("Sign in to your CFOClose account");
    await page.fill("#email", U.leaver.email);
    await page.fill("#password", U.leaver.password);
    await page.press("Enter");
    await page.waitFor((r) => location.pathname === "/plans" && location.search.includes(r), [pendingRef], { label: "back on the plans link", timeout: 30000 });
    await page.waitForSelector('[data-testid="unfinished-checkout"]', { timeout: 30000 });
    return (await banner()).ref === pendingRef ? true : await banner();
  });
  await check("a review case (MANUAL_REVIEW, provider result uncertain) is never offered for closing; once the provider has expired the session (no webhook), the next checkout re-verifies it, closes it and starts", async () => {
    const [, pending] = await intentsOf(U.leaver);
    // Test setup: the outcome the real path writes when the provider created the session but CFOClose could not record it.
    const meta = (await admin.from("payment_checkout_intents").select("metadata").eq("id", pending.id).single()).data?.metadata ?? {};
    await admin.from("payment_checkout_intents").update({ status: "MANUAL_REVIEW",
      metadata: { ...meta, uncertain_reason: "PROVIDER_RESULT_PERSISTENCE_UNCERTAIN", uncertain_at: new Date().toISOString() } }).eq("id", pending.id);
    await go(`/plans?unfinished=${pending.saff_reference}`);
    await page.waitForSelector('[data-testid="unfinished-checkout-review"]', { timeout: 30000 });
    await widths("34-plans-review-case");
    const offered = await page.evaluate(() => !!document.querySelector('[data-testid="unfinished-choose-another"]'));
    // The provider expires the session; its notification never arrives.
    mock.checkouts.get(pending.provider_checkout_ref).status = "expired";
    await sleep(61_000); // the review page's own read may hold the verification claim
    await go("/billing/checkout?plan=PRACTICE", "Card, on Polar\'s secure page");
    await page.waitForSelector('[data-testid="checkout-continue"]:not([disabled])');
    await page.click('[data-testid="checkout-continue"]');
    await page.waitForUrl(/127\.0\.0\.1:9911\/pay\//, { timeout: 30000 });
    const all = await intentsOf(U.leaver);
    return !offered && all.length === 3 && all[1].status === "EXPIRED" && all[2].status === "PENDING" ? true : { offered, all: all.map((x) => x.status) };
  });
  await check("the status page never spins forever: with the status service unreachable it says so, with Try again and Back to plans", async () => {
    await page.send("Network.setBlockedURLs", { urls: ["*commercial-payment-status*"] });
    try {
      await go(`/billing/payment/return?ref=${leftRef}`);
      await page.waitForSelector('[data-testid="payment-unreachable"]', { timeout: 30000 });
      await widths("35-status-unreachable");
      const t = await page.bodyText();
      return /Do not pay again/.test(t) && /Back to plans/.test(t) ? true : t.slice(0, 600);
    } finally { await page.send("Network.setBlockedURLs", { urls: [] }); }
  });

  startGroup("An older Polar session paid after CFOClose closed its intent and a replacement started (real functions, mock Polar)");
  // Neither provider can cancel a checkout on request (Polar's checkout update has no expiry or status field), so the old
  // mock session stays payable — exactly as at Polar. Before 20261102100000 its payment was answered DUPLICATE and recorded
  // nowhere. Now: the money is recorded once, with an OPEN recovery case; the replacement grants the one term.
  const lateApi = await apiAs(U.late);
  const createCheckout = async () => {
    const { data: { session } } = await lateApi.auth.getSession();
    const res = await fetch(`${apiUrl}/functions/v1/commercial-create-checkout`, { method: "POST", headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json", apikey: anonKey },
      body: JSON.stringify({ planCode: "SOLO", billingInterval: "ANNUAL", paymentRoute: "CARD" }) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  let oldIntent = null, replacement = null;
  await check("a card checkout is created (the mock Polar session is open), then passes CFOClose's local expiry; a new attempt is refused (409 OPEN_CHECKOUT_UNFINISHED, 20261105100000) and writes nothing: the old intent stays PENDING with its session", async () => {
    const first = await createCheckout();
    [oldIntent] = await intentsOf(U.late);
    // Time travel for the test only: CFOClose's own one-hour expiry passes while the provider session stays open.
    await admin.from("payment_checkout_intents").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", oldIntent.id);
    const blocked = await createCheckout();
    const after = await intentsOf(U.late);
    return first.status === 200 && oldIntent?.provider === "POLAR" && !!mock.checkouts.get(oldIntent.provider_checkout_ref)
      && blocked.status === 409 && blocked.body?.error === "OPEN_CHECKOUT_UNFINISHED" && blocked.body?.previousSaffReference === oldIntent.saff_reference
      && after.length === 1 && after[0].status === "PENDING" && after[0].provider_checkout_ref === oldIntent.provider_checkout_ref
      ? true : { first, blocked, after: after.map((i) => i.status) };
  });
  await check("the one remaining way such an intent closes while its session stays payable: the provider result is recorded as uncertain (MANUAL_REVIEW), then the administrator resolves it as uncharged", async () => {
    // Test setup: the mock cannot drop its own response, so record the outcome the real path writes when Polar created the
    // session but CFOClose could not record the result (mark_checkout_attempt_uncertain: status MANUAL_REVIEW + reason).
    const meta = (await admin.from("payment_checkout_intents").select("metadata").eq("id", oldIntent.id).single()).data?.metadata ?? {};
    await admin.from("payment_checkout_intents").update({ status: "MANUAL_REVIEW",
      metadata: { ...meta, uncertain_reason: "PROVIDER_RESULT_PERSISTENCE_UNCERTAIN", uncertain_at: new Date().toISOString() } }).eq("id", oldIntent.id);
    const ops = await apiAs(U.admin);
    const { error } = await ops.rpc("admin_resolve_manual_review_intent", { p_checkout_intent_id: oldIntent.id, p_resolution: "CONFIRMED_UNCHARGED_CANCEL", p_reason: "no payment seen when reviewed" });
    const closed = (await intentsOf(U.late))[0].status;
    return !error && closed === "CANCELLED" && !!mock.checkouts.get(oldIntent.provider_checkout_ref) ? true : { error: error?.message, closed };
  });
  await check("a replacement checkout then starts; the old session is still payable at the provider", async () => {
    const r = await createCheckout();
    replacement = (await intentsOf(U.late))[1];
    const old = mock.checkouts.get(oldIntent.provider_checkout_ref);
    return r.status === 200 && replacement?.status === "PENDING" && old && old.status !== "succeeded" && old.status !== "expired" ? true : { r, replacement };
  });
  let oldDelivery = null;
  await check("the customer pays the OLD session: the real webhook records the charge once as a recovery case (PLACEMENT_REVIEW, never DUPLICATE); no licence is granted for it", async () => {
    const res = await fetch(`http://127.0.0.1:9911/pay/${oldIntent.provider_checkout_ref}`, { method: "POST", redirect: "manual" });
    oldDelivery = mock.deliveries.filter((d) => d.provider === "POLAR" && JSON.parse(d.body).type === "order.paid").pop();
    const cases = (await admin.from("payment_recovery_cases").select("id, status, reason, checkout_intent_id, newer_attempt_id").eq("checkout_intent_id", oldIntent.id)).data ?? [];
    const events = (await admin.from("payment_events").select("id, event_type, licence_id").eq("checkout_intent_id", oldIntent.id)).data ?? [];
    return [303, 302].includes(res.status) && oldDelivery?.status === 200 && oldDelivery.response?.outcome === "PLACEMENT_REVIEW"
      && cases.length === 1 && cases[0].status === "OPEN" && cases[0].reason === "PAYMENT_AFTER_REPLACEMENT_STARTED" && cases[0].newer_attempt_id === replacement.id
      && events.length === 1 && events[0].event_type === "PAYMENT_CONFIRMED" && events[0].licence_id === null && (await licencesOf(U.late)).length === 0
      ? true : { res: res.status, delivery: oldDelivery?.response, cases, events };
  });
  await check("the replacement is paid: exactly one term; a redelivery of the old payment (same id, then a new id) changes nothing", async () => {
    await fetch(`http://127.0.0.1:9911/pay/${replacement.provider_checkout_ref}`, { method: "POST", redirect: "manual" });
    const again = await mock.deliver("POLAR", JSON.parse(oldDelivery.body), { id: oldDelivery.id });
    const again2 = await mock.deliver("POLAR", JSON.parse(oldDelivery.body));
    const cases = (await admin.from("payment_recovery_cases").select("id").eq("checkout_intent_id", oldIntent.id)).data ?? [];
    const lic = await licencesOf(U.late);
    return again.status === 200 && again2.status === 200 && ["DUPLICATE", "PLACEMENT_REVIEW"].includes(again2.response?.outcome) && cases.length === 1 && lic.length === 1 ? true : { again: again.response, again2: again2.response, cases, lic };
  });
  await check("the administrator sees the open case and closes it as a test payment (sandbox: no money moved); it is resolved once, audited", async () => {
    const ops = await apiAs(U.admin);
    const list = (await ops.rpc("admin_list_payment_recovery_cases")).data ?? [];
    const c = list.find((x) => x.checkout_intent_id === oldIntent.id);
    const { data, error } = await ops.rpc("admin_resolve_payment_recovery", { p_case_id: c?.id, p_resolution: "TEST_PAYMENT_CLOSED", p_reason: "sandbox test of a replaced checkout" });
    const twice = await ops.rpc("admin_resolve_payment_recovery", { p_case_id: c?.id, p_resolution: "TEST_PAYMENT_CLOSED", p_reason: "again" });
    const audit = (await admin.from("billing_audit_events").select("action").eq("action", "PAYMENT_RECOVERY_RESOLVED")).data ?? [];
    return c?.status === "OPEN" && !error && data?.resolved === true && /RECOVERY_CASE_ALREADY_RESOLVED/.test(twice.error?.message ?? "") && audit.length >= 1 ? true : { c, error: error?.message, twice: twice.error?.message };
  });

  startGroup("Refund, reviewed by the administrator");
  await check("a partial refund then the rest → two reversals recorded as changes (20,000 then 29,000); the licence is unchanged; the customer sees 'refunded'", async () => {
    const licBefore = JSON.stringify(await licencesOf(U.card));
    const r1 = await mock.refundPolar(cardCheckout, 20000);
    const r2 = await mock.refundPolar(cardCheckout, 49000);
    const r3 = await mock.refundPolar(cardCheckout, 49000);   // a redelivery of the full refund records nothing new
    const rv = ((await admin.from("payment_events").select("event_type, amount_minor, recorded_at").eq("event_type", "REFUND").order("recorded_at")).data ?? []).map((x) => Number(x.amount_minor));
    await signInAs(U.card);
    await go(`/billing/payment/return?ref=${cardRef}`, "Payment refunded", 60000);
    return r1.status === 200 && r2.status === 200 && r3.status === 200 && JSON.stringify(rv) === JSON.stringify([20000, 29000]) && JSON.stringify(await licencesOf(U.card)) === licBefore
      ? true : { r1: r1.response, r2: r2.response, r3: r3.response, rv };
  });
  await check("the administrator sees the refunds and records a decision once, with a reason", async () => {
    await signInAs(U.admin);
    await go("/commercial/admin", "Refunds and disputes");
    await page.waitForText("REFUND");
    await page.evaluate(() => {
      const li = [...document.querySelectorAll("li")].find((x) => x.textContent.includes("REFUND"));
      const input = li.querySelector("input");
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Customer refunded within 14 days; licence kept by agreement");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await sleep(300);
    await page.click({ text: "Keep the licence" });
    await page.waitForText("Decision recorded.");
    const a = (await admin.from("billing_audit_events").select("action").eq("action", "REVERSAL_REVIEWED")).data ?? [];
    return a.length === 1 ? true : a;
  });

  startGroup("Manual activation from the screen");
  await check("Accounts: find by email, manual activation of Practice for 12 months, audited as the administrator", async () => {
    await adminTab("Accounts and manual activation");
    await setInput('[data-testid="admin-find-email"]', U.manual.email);
    await page.click('[data-testid="admin-find"]');
    await page.waitForSelector('[data-testid="admin-account"]');
    await setByLabel("Plan", "PRACTICE");
    await setInput('[data-testid="admin-reason"]', "Activation agreed by email (payment journey test)");
    await page.click('[data-testid="admin-activate"]');
    await page.waitForText("PRACTICE activated from");
    const lic = await licencesOf(U.manual);
    const audit = (await admin.from("billing_audit_events").select("actor_user_id").eq("action", "LICENCE_GRANTED").eq("actor_user_id", U.admin.id)).data ?? [];
    return lic.some((l) => l.source === "MANUAL_ADMIN_GRANT") && audit.length >= 1 ? true : { lic, audit: audit.length };
  });
  await check("a test payment is not a paid term: manual activation of the same account applies, and the SANDBOX licence stays SANDBOX (the paid-term guard is proven with production payments in the database proofs)", async () => {
    const sandboxBefore = (await licencesOf(U.card)).filter((l) => l.status === "SANDBOX");
    await setInput('[data-testid="admin-find-email"]', U.card.email);
    await page.click('[data-testid="admin-find"]');
    await page.waitForText(U.card.email);
    await setInput('[data-testid="admin-reason"]', "Activation by agreement after a test payment");
    await page.click('[data-testid="admin-activate"]');
    await page.waitForText("activated from");
    const after = await licencesOf(U.card);
    const summary = (await (await apiAs(U.card)).rpc("get_my_billing_summary")).data;
    return after.some((l) => l.source === "MANUAL_ADMIN_GRANT" && l.status === "ACTIVE") && JSON.stringify(after.filter((l) => l.status === "SANDBOX")) === JSON.stringify(sandboxBefore)
      && summary?.licence_status === "ACTIVE" ? true : { after, summary };
  });
  await check("administrator accounts page at 1280 and 375 px", async () => widths("26-admin-accounts"));

  startGroup("Public plans when online payment is open to customers");
  await check("CUSTOMER_PAYMENTS_ENABLED: the landing shows the approved USD price and 'Choose Solo', no mobile money; Firm stays proposed", async () => {
    const ops = await apiAs(U.admin);
    { const { error } = await ops.rpc("admin_transition_platform_state", { p_new_state: "CUSTOMER_PAYMENTS_ENABLED", p_reason: "payment journey: public view" }); if (error) return error.message; }
    page = await (await browser.newContext()).newPage(); await page.setViewport(1280, 900);
    await go("/", "Choose your capacity.");
    await page.waitForText("USD 490 per year by card", { timeout: 30000 });
    const t = await page.bodyText();
    await page.evaluate(() => document.getElementById("plans")?.scrollIntoView());
    await widths("27-landing-plans-online");
    // Polar card payments only: the approved TZS price is never shown (mobile money is not launched).
    return !/TZS|mobile money/.test(t) && t.includes("Choose Solo") && t.includes("Proposed: USD 2,990 per year") ? true : t.slice(0, 1200);
  });
  await check("…and a sandbox route is then not offered at checkout (the platform matrix): the page shows payment unavailable, and the server refuses the attempt", async () => {
    await signInAs(U.mobile);
    await go("/billing/checkout?plan=SOLO", "Online payment is temporarily unavailable for this plan.");
    const pay = await page.evaluate(() => !!document.querySelector('[data-testid="checkout-continue"]'));
    const server = await serverRefusesCheckout(U.mobile, "SOLO");
    const ops = await apiAs(U.admin);
    { const { error } = await ops.rpc("admin_transition_platform_state", { p_new_state: "PAYMENTS_DISABLED", p_reason: "payment journey: closed again" }); if (error) return error.message; }
    return !pay && server === true ? true : { pay, server };
  });

  const failed = results.filter((r) => !r.ok);
  const evidence = { classification: "LOCAL application, database and Edge Functions; MOCK payment providers (no provider contacted, no money moved)",
    passed: results.length - failed.length, failed: failed.length, results, deliveries: mock.deliveries.map((d) => ({ provider: d.provider, status: d.status, outcome: d.response?.outcome ?? d.response?.error })) };
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(evidence, null, 2));
  log(`\nassertions: ${results.length}   passed: ${results.length - failed.length}   failed: ${failed.length}`);
  return failed.length === 0 ? 0 : 1;
}

let code = 1;
try { code = await main(); } catch (e) { log(`FATAL: ${e?.stack ?? e}`); code = 1; }
finally {
  try { await browser.close(); } catch { /* */ }
  try { await new Promise((r) => preview.httpServer.close(() => r())); } catch { /* */ }
  try { await mock.close(); } catch { /* */ }
  try { serve.kill("SIGINT"); } catch { /* */ }
}
process.exit(code);
