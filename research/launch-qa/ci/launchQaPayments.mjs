// Launch-acceptance QA — the isolated PAYMENT facility for scenario D (NORMAL, CI/integration; evidence branch #144 only).
// It reuses exactly what scripts/e2e/paymentJourney.mjs uses on the same local stack: the loopback MOCK providers
// (mockPaymentProviders.mjs), the payment functions served from this repository with generated SANDBOX configuration, and
// the administrator RPCs /commercial/admin calls (open SANDBOX_ONLY; approve the Solo USD annual price; manual activation
// by agreement). Nothing here touches a hosted project or a real provider; test values are generated and never printed.
//
// What it can and cannot establish (the product's own rules, unchanged):
//   * a sandbox card purchase through the mock hosted page records a SANDBOX licence with NO access — a test payment never
//     grants entitlement (so D can prove "no bypass");
//   * an AUTHORISED activation (manual activation by agreement, the existing administrator path) is how a non-entitled user
//     gains access in this isolated stack; a real paid route needs a production provider and is out of scope.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { startMockProviders } from "../../../scripts/e2e/mockPaymentProviders.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startPaymentsFacility({ apiUrl, anonKey, admin, appOrigin, outDir, mockPort = 9912 }) {
  const ORG = crypto.randomUUID();
  const PRODUCTS = { SOLO: crypto.randomUUID(), PRACTICE: crypto.randomUUID(), FIRM: crypto.randomUUID() };
  const polar = { accessToken: `polar_oat_e2e_${crypto.randomBytes(8).toString("hex")}`, webhookSecret: `whsec_${crypto.randomBytes(32).toString("base64")}` };
  const snippe = { apiKey: `snp_e2e_${crypto.randomBytes(8).toString("hex")}`, webhookSecret: `whsec_${crypto.randomBytes(24).toString("hex")}` };
  const mock = await startMockProviders({ port: mockPort, polar, snippe, webhookBase: `${apiUrl}/functions/v1`, organizationId: ORG });
  const envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "laq-payments-env-")), "functions.env");
  fs.writeFileSync(envFile, [
    `SAFF_PAYMENT_REDIRECT_URL=${appOrigin}/billing/payment/return`,
    "POLAR_ENVIRONMENT=sandbox", `POLAR_ACCESS_TOKEN=${polar.accessToken}`, `POLAR_WEBHOOK_SECRET=${polar.webhookSecret}`,
    `POLAR_ORGANIZATION_ID=${ORG}`, `POLAR_PRODUCT_IDS=${JSON.stringify(PRODUCTS)}`, `POLAR_API_BASE_URL=http://host.docker.internal:${mockPort}`,
    "SNIPPE_ENVIRONMENT=sandbox", `SNIPPE_API_KEY=${snippe.apiKey}`, `SNIPPE_WEBHOOK_SECRET=${snippe.webhookSecret}`,
    `SNIPPE_API_BASE_URL=http://host.docker.internal:${mockPort}`, "",
  ].join("\n"));
  const serve = spawn("supabase", ["functions", "serve", "--env-file", envFile], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  const serveLog = fs.createWriteStream(path.join(outDir, "payments-functions-serve.log"));
  serve.stdout.pipe(serveLog); serve.stderr.pipe(serveLog);
  const stop = () => { try { mock.close(); } catch { /* */ } try { serve.kill("SIGINT"); } catch { /* */ } };
  process.on("exit", stop);

  // Configured = the Polar webhook endpoint has an adapter: an unsigned POST is refused with 401 (unconfigured: 503).
  let ready = false;
  for (let i = 0; i < 90 && !ready; i++) {
    try { ready = (await fetch(`${apiUrl}/functions/v1/commercial-webhook-polar`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status === 401; } catch { /* not up */ }
    if (!ready) await sleep(2000);
  }
  if (!ready) { stop(); throw new Error("payment functions did not load the generated configuration"); }

  const apiAs = async (u) => {
    const c = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await c.auth.signInWithPassword({ email: u.email, password: u.password });
    if (error) throw new Error(`sign-in for the payment facility failed: ${error.message}`);
    return c;
  };
  // The operator bootstrap of a commercial administrator (COMMERCIAL_ADMIN_GUIDE §5), as paymentJourney does.
  const ops = { email: `ops.${Date.now().toString(36)}@laq-local.test`, password: `Laq!${crypto.randomBytes(12).toString("base64url")}` };
  { const { data, error } = await admin.auth.admin.createUser({ email: ops.email, password: ops.password, email_confirm: true }); if (error) throw new Error(`ops user: ${error.message}`); ops.id = data.user.id; }
  { const { error } = await admin.from("commercial_admins").insert({ user_id: ops.id, active: true }); if (error) throw new Error(`admin bootstrap: ${error.message}`); }
  const opsApi = await apiAs(ops);
  {
    const { error } = await opsApi.rpc("admin_transition_platform_state", { p_new_state: "SANDBOX_ONLY", p_reason: "launch-acceptance QA (isolated sandbox)" });
    if (error && !/already|same state/i.test(error.message)) throw new Error(`open sandbox payments: ${error.message}`);
    const offers = (await opsApi.rpc("admin_list_commercial_offers", { p_plan_code: "SOLO" })).data ?? [];
    const o = offers.find((x) => x.offer_code === "CFOCLOSE_SOLO_GLOBAL_USD_ANNUAL");
    if (!o) throw new Error("the Solo USD annual offer is not in the catalogue");
    if (!o.is_purchasable) {
      const { error: e2 } = await opsApi.rpc("admin_upsert_commercial_offer", { p_offer_code: o.offer_code, p_plan_code: o.plan_code, p_market_code: o.market_code,
        p_currency_code: o.currency_code, p_amount_minor: Number(o.amount_minor), p_currency_exponent: o.currency_exponent, p_billing_interval: o.billing_interval,
        p_billing_interval_count: o.billing_interval_count, p_is_active: true, p_is_purchasable: true, p_reason: "launch-acceptance QA (isolated sandbox)" });
      if (e2) throw new Error(`approve the Solo price: ${e2.message}`);
    }
  }

  const licencesOf = async (u) => {
    const bc = (await admin.from("billing_customers").select("id").eq("owner_user_id", u.id).maybeSingle()).data;
    if (!bc) return [];
    return ((await admin.from("commercial_licences").select("status, source").eq("billing_customer_id", bc.id)).data ?? []).map((l) => `${l.source}:${l.status}`).sort();
  };
  return {
    mock, mockPort,
    /** Access as the server states it for `u`, and the licences recorded for it. */
    async entitlementSnapshot(u) {
      const summary = (await (await apiAs(u)).rpc("get_my_billing_summary")).data;
      return { licenceStatus: summary?.licence_status ?? null, plan: summary?.plan_code ?? null, licences: await licencesOf(u) };
    },
    /** A sandbox card purchase through the real checkout page and the mock hosted page. Never grants access. */
    async sandboxCardPurchase(page, u) {
      await page.goto(`${appOrigin}/billing/checkout?plan=SOLO`);
      await page.waitForText("Solo plan · 12 months", { timeout: 45000 });
      await page.click('[data-testid="route-CARD"] input');
      await page.click('[data-testid="checkout-continue"]');
      await page.waitForUrl(new RegExp(`127\\.0\\.0\\.1:${mockPort}/pay/`), { timeout: 30000 });
      await page.click('[data-testid="mock-pay"]');
      await page.waitForUrl(/\/billing\/payment\/return\?ref=/, { timeout: 30000 });
      await page.waitForText("Test payment received", { timeout: 60000 });
      return { returned: await page.url(), licences: await licencesOf(u) };
    },
    /** The authorised path to access in this isolated stack: manual activation by agreement (/commercial/admin). */
    async activateByAgreement(u, plan = "SOLO", reason = "launch-acceptance QA: authorised activation") {
      let acct = (await opsApi.rpc("admin_find_billing_account", { p_email: u.email })).data;
      if (!acct?.billing_customer_id) {
        const { error } = await opsApi.rpc("admin_ensure_billing_customer", { p_owner_user_id: u.id, p_reason: reason });
        if (error) throw new Error(`ensure billing customer: ${error.message}`);
        acct = (await opsApi.rpc("admin_find_billing_account", { p_email: u.email })).data;
      }
      const start = new Date(); const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 12);
      const { error } = await opsApi.rpc("admin_grant_commercial_licence", { p_billing_customer_id: acct.billing_customer_id, p_plan_code: plan, p_effective_start: start.toISOString(), p_effective_end: end.toISOString(), p_reason: reason });
      if (error) throw new Error(`grant: ${error.message}`);
    },
    stop,
  };
}
