/**
 * Ω∞ A+ closure — CFOClose Ω3-CHECKOUT final closure hardening.
 *
 * Codex's independent re-audit of PR #15 @ b82f324b055e2ce52c6afffc834b87d93f9ea286
 * returned NO-GO on 4 BLOCKER + 4 HIGH findings. This file proves the
 * static-source-text half of every fix — the executable database contract
 * (concurrency, RLS/privilege enforcement, real migration apply) is proven
 * separately by the disposable-Postgres CI harness
 * (scripts/db-contract-tests/run.sh + .github/workflows/db-contract-tests.yml),
 * which this file's own header explicitly does NOT substitute for.
 *
 * NON-EXECUTABLE DB/DENO NOTICE: no live Postgres connection and no Deno
 * runtime exist in the Vitest/Node environment this file runs under —
 * exactly the same limitation as every other file in this suite testing
 * SQL migrations or Edge Functions. What CAN be proven here is that the
 * migration's and Edge Functions' SOURCE TEXT actually implements the
 * required structural guarantees.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.join(__dirname, "../../../../../");
const MIGRATION_PATH = path.join(REPO_ROOT, "supabase/migrations/20260913000000_omega4_checkout_acquisition_hardening.sql");
const CREATE_CHECKOUT_PATH = path.join(REPO_ROOT, "supabase/functions/commercial-create-checkout/index.ts");
const PAYMENT_STATUS_PATH = path.join(REPO_ROOT, "supabase/functions/commercial-payment-status/index.ts");
const WEBHOOK_PATH = path.join(REPO_ROOT, "supabase/functions/commercial-payment-webhook/index.ts");
const FLUTTERWAVE_PATH = path.join(REPO_ROOT, "supabase/functions/_shared/payments/providers/flutterwave.ts");
const ROUTING_PATH = path.join(REPO_ROOT, "supabase/functions/_shared/payments/routing.ts");
const PRICING_PATH = path.join(REPO_ROOT, "src/pages/Pricing.tsx");
const SETTINGS_PATH = path.join(REPO_ROOT, "src/pages/Settings.tsx");

function stripSqlComments(sql: string): string {
  return sql.replace(/--.*$/gm, "");
}
function stripTsComments(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const migrationRaw = fs.readFileSync(MIGRATION_PATH, "utf-8");
const migrationCode = stripSqlComments(migrationRaw);
const checkoutCode = stripTsComments(fs.readFileSync(CREATE_CHECKOUT_PATH, "utf-8"));
const paymentStatusCode = stripTsComments(fs.readFileSync(PAYMENT_STATUS_PATH, "utf-8"));
const webhookCode = stripTsComments(fs.readFileSync(WEBHOOK_PATH, "utf-8"));
const flutterwaveCode = stripTsComments(fs.readFileSync(FLUTTERWAVE_PATH, "utf-8"));
const routingCode = stripTsComments(fs.readFileSync(ROUTING_PATH, "utf-8"));
const pricingCode = stripTsComments(fs.readFileSync(PRICING_PATH, "utf-8"));
const settingsCode = stripTsComments(fs.readFileSync(SETTINGS_PATH, "utf-8"));

// ============================================================
// BLOCKER-2 — atomic customer + PRODUCT acquisition boundary
// ============================================================

describe("BLOCKER-2 — customer + product acquisition boundary (not customer + offer)", () => {
  it("payment_checkout_intents gains a snapshotted, FK-constrained product_id column", () => {
    expect(migrationCode).toMatch(/ADD COLUMN product_id UUID NULL/);
    expect(migrationCode).toMatch(/ADD CONSTRAINT fk_pci_product FOREIGN KEY \(product_id\) REFERENCES public\.commercial_products\(id\)/);
    expect(migrationCode).toMatch(/ALTER COLUMN product_id SET NOT NULL/);
  });

  it("the old (customer, offer) partial unique index is retired and replaced with (customer, product)", () => {
    expect(migrationCode).toMatch(/DROP INDEX IF EXISTS public\.uq_pci_one_open_intent_per_customer_offer;/);
    expect(migrationCode).toMatch(/CREATE UNIQUE INDEX uq_pci_one_open_intent_per_customer_product\s*\n\s*ON public\.payment_checkout_intents \(billing_customer_id, product_id\)\s*\n\s*WHERE status IN \('CREATING', 'PENDING', 'MANUAL_REVIEW'\);/);
  });

  it("a preflight duplicate check runs BEFORE the new index is created, with a named diagnostic", () => {
    const preflightIndex = migrationCode.indexOf("PRE_EXISTING_OPEN_INTENT_PRODUCT_DUPLICATES_FOUND");
    const indexCreateIndex = migrationCode.indexOf("CREATE UNIQUE INDEX uq_pci_one_open_intent_per_customer_product");
    expect(preflightIndex).toBeGreaterThan(-1);
    expect(preflightIndex).toBeLessThan(indexCreateIndex);
  });

  it("acquire_checkout_attempt is keyed on (billing_customer_id, product_id) for both its advisory lock and its existing-row lookup — not commercial_offer_id", () => {
    const fnBody = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.acquire_checkout_attempt\([\s\S]*?\n\$\$;/)?.[0] ?? "";
    expect(fnBody).toMatch(/pg_advisory_xact_lock\(hashtext\(p_billing_customer_id::text \|\| ':' \|\| p_product_id::text\)\)/);
    expect(fnBody).toMatch(/WHERE billing_customer_id = p_billing_customer_id\s*\n\s*AND product_id = p_product_id/);
  });

  it("a different billing_interval (different commercial_offer_id) under the same product returns an explicit conflict, both for CREATING and PENDING existing attempts", () => {
    const fnBody = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.acquire_checkout_attempt\([\s\S]*?\n\$\$;/)?.[0] ?? "";
    const conflictOccurrences = fnBody.match(/CONFLICT_DIFFERENT_INTERVAL/g) ?? [];
    expect(conflictOccurrences.length).toBeGreaterThanOrEqual(1);
    expect(fnBody).toMatch(/v_existing\.commercial_offer_id != p_commercial_offer_id/);
  });

  it("a MANUAL_REVIEW existing attempt is NEVER automatically superseded — it blocks a new attempt unconditionally, before any interval comparison", () => {
    const fnBody = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.acquire_checkout_attempt\([\s\S]*?\n\$\$;/)?.[0] ?? "";
    const manualReviewIndex = fnBody.indexOf("v_existing.status = 'MANUAL_REVIEW'");
    const intervalCompareIndex = fnBody.indexOf("v_existing.commercial_offer_id != p_commercial_offer_id");
    expect(manualReviewIndex).toBeGreaterThan(-1);
    expect(manualReviewIndex).toBeLessThan(intervalCompareIndex);
    expect(fnBody).toMatch(/RETURN jsonb_build_object\(\s*'action', 'MANUAL_REVIEW_BLOCKS_NEW_ATTEMPT'/);
  });

  it("a reusable PENDING attempt requires identical provider AND provider_environment, not merely an unexpired URL — a sandbox link can never be reused after a transition to production or vice versa", () => {
    const fnBody = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.acquire_checkout_attempt\([\s\S]*?\n\$\$;/)?.[0] ?? "";
    expect(fnBody).toMatch(/v_existing\.provider = p_provider\s*\n\s*AND v_existing\.provider_environment = p_provider_environment/);
  });

  it("acquire_checkout_attempt is service_role only — never callable by anon or authenticated directly", () => {
    expect(migrationCode).toMatch(/REVOKE ALL ON FUNCTION public\.acquire_checkout_attempt\([^)]*\) FROM PUBLIC, anon, authenticated;/);
    expect(migrationCode).toMatch(/GRANT EXECUTE ON FUNCTION public\.acquire_checkout_attempt\([^)]*\) TO service_role;/);
  });
});

// ============================================================
// BLOCKER-1 — provider-result persistence fails closed (token-fenced CAS)
// ============================================================

describe("BLOCKER-1 — provider-result persistence fails closed via token-fenced CAS", () => {
  it("persist_checkout_provider_result's UPDATE is conditioned on id, creation_token, AND status='CREATING' together — a stale token or already-transitioned row updates zero rows", () => {
    const fnBody = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.persist_checkout_provider_result\([\s\S]*?\n\$\$;/)?.[0] ?? "";
    expect(fnBody).toMatch(/WHERE id = p_checkout_intent_id\s*\n\s*AND creation_token = p_creation_token\s*\n\s*AND status = 'CREATING'/);
    expect(fnBody).toMatch(/IF NOT FOUND THEN[\s\S]*?RETURN jsonb_build_object\('persisted', false\);/);
  });

  it("persist_checkout_provider_result rejects a blank checkout URL outright, before attempting the CAS", () => {
    const fnBody = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.persist_checkout_provider_result\([\s\S]*?\n\$\$;/)?.[0] ?? "";
    expect(fnBody).toMatch(/PERSIST_CHECKOUT_PROVIDER_RESULT_BLANK_URL/);
  });

  it("commercial-create-checkout never returns a checkout URL to the browser unless persist_checkout_provider_result reported persisted:true", () => {
    expect(checkoutCode).toMatch(/const persisted = !persistErr && \(persistData as \{ persisted\?: boolean \} \| null\)\?\.persisted === true;/);
    const returnStatement = checkoutCode.match(/return jsonResponse\(\{\s*saffReference:\s*persistedIntent\.saff_reference,[\s\S]*?\}, 200\);/)?.[0] ?? "";
    expect(returnStatement).not.toBe("");
    const persistedCheckIndex = checkoutCode.indexOf("if (!persisted) {");
    const finalReturnIndex = checkoutCode.indexOf(returnStatement);
    expect(persistedCheckIndex).toBeGreaterThan(-1);
    expect(persistedCheckIndex).toBeLessThan(finalReturnIndex);
  });

  it("a persistence failure (CAS lost or RPC error) routes to MANUAL_REVIEW via mark_checkout_attempt_uncertain — never silently discarded, never retried automatically", () => {
    const failBlock = checkoutCode.match(/if \(!persisted\) \{([\s\S]*?)\n {2}\}/)?.[0] ?? "";
    expect(failBlock).toMatch(/mark_checkout_attempt_uncertain/);
  });

  it("the network call to the provider (adapter.createCheckout) happens strictly between acquire_checkout_attempt and persist_checkout_provider_result — never inside either RPC", () => {
    const acquireIndex = checkoutCode.indexOf("supabase.rpc('acquire_checkout_attempt'");
    const providerCallIndex = checkoutCode.indexOf("adapter.createCheckout(");
    const persistIndex = checkoutCode.indexOf("supabase.rpc('persist_checkout_provider_result'");
    expect(acquireIndex).toBeLessThan(providerCallIndex);
    expect(providerCallIndex).toBeLessThan(persistIndex);
  });

  it("mark_checkout_attempt_failed and mark_checkout_attempt_uncertain are BOTH token-fenced identically to persist_checkout_provider_result", () => {
    for (const fnName of ["mark_checkout_attempt_failed", "mark_checkout_attempt_uncertain"]) {
      const fnBody = migrationCode.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fnName}\\([\\s\\S]*?\\n\\$\\$;`))?.[0] ?? "";
      expect(fnBody, `${fnName} missing`).not.toBe("");
      expect(fnBody).toMatch(/AND creation_token = p_creation_token\s*\n\s*AND status = 'CREATING'/);
    }
  });
});

// ============================================================
// BLOCKER-3 — platform-state x provider-environment x acceptance matrix
// ============================================================

describe("BLOCKER-3 — platform-state x provider-environment x acceptance-identity matrix", () => {
  it("assert_platform_state_permits fails closed on a missing/blank/unrecognized environment — never a silent sandbox default", () => {
    const fnBody = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.assert_platform_state_permits\([\s\S]*?\n\$\$;/)?.[0] ?? "";
    expect(fnBody).toMatch(/IF p_provider_environment IS NULL OR p_provider_environment NOT IN \('sandbox', 'production'\) THEN/);
  });

  it("implements all four platform-state rows of the matrix", () => {
    const fnBody = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.assert_platform_state_permits\([\s\S]*?\n\$\$;/)?.[0] ?? "";
    expect(fnBody).toMatch(/v_state = 'PAYMENTS_DISABLED'/);
    expect(fnBody).toMatch(/v_state = 'SANDBOX_ONLY'/);
    expect(fnBody).toMatch(/v_state = 'LIVE_ACCEPTANCE'/);
    expect(fnBody).toMatch(/v_state = 'CUSTOMER_PAYMENTS_ENABLED'/);
  });

  it("PAYMENTS_DISABLED permits no environment at all", () => {
    const fnBody = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.assert_platform_state_permits\([\s\S]*?\n\$\$;/)?.[0] ?? "";
    const block = fnBody.match(/IF v_state = 'PAYMENTS_DISABLED' THEN([\s\S]*?)ELSIF/)?.[1] ?? "";
    expect(block).toMatch(/RAISE EXCEPTION/);
  });

  it("SANDBOX_ONLY permits only sandbox", () => {
    const fnBody = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.assert_platform_state_permits\([\s\S]*?\n\$\$;/)?.[0] ?? "";
    const block = fnBody.match(/ELSIF v_state = 'SANDBOX_ONLY' THEN([\s\S]*?)ELSIF/)?.[1] ?? "";
    expect(block).toMatch(/p_provider_environment != 'sandbox'/);
  });

  it("LIVE_ACCEPTANCE permits only production AND requires explicit allowlist membership — a browser-supplied field can never satisfy this", () => {
    const fnBody = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.assert_platform_state_permits\([\s\S]*?\n\$\$;/)?.[0] ?? "";
    const block = fnBody.match(/ELSIF v_state = 'LIVE_ACCEPTANCE' THEN([\s\S]*?)ELSIF/)?.[1] ?? "";
    expect(block).toMatch(/p_provider_environment != 'production'/);
    expect(block).toMatch(/commercial_live_acceptance_allowlist/);
    expect(block).toMatch(/a\.active/);
  });

  it("CUSTOMER_PAYMENTS_ENABLED permits only production, no acceptance-identity check required", () => {
    const fnBody = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.assert_platform_state_permits\([\s\S]*?\n\$\$;/)?.[0] ?? "";
    const block = fnBody.match(/ELSIF v_state = 'CUSTOMER_PAYMENTS_ENABLED' THEN([\s\S]*?)ELSE/)?.[1] ?? "";
    expect(block).toMatch(/p_provider_environment != 'production'/);
  });

  it("an unrecognized platform state also fails closed, not silently permits", () => {
    const fnBody = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.assert_platform_state_permits\([\s\S]*?\n\$\$;/)?.[0] ?? "";
    expect(fnBody).toMatch(/ELSE\s*\n\s*RAISE EXCEPTION 'PLATFORM_STATE_MATRIX_VIOLATION: unknown platform state/);
  });

  it("commercial_live_acceptance_allowlist is a dedicated table, distinct from commercial_admins, writable only by service_role", () => {
    expect(migrationCode).toMatch(/CREATE TABLE public\.commercial_live_acceptance_allowlist/);
    expect(migrationCode).toMatch(/REVOKE ALL ON public\.commercial_live_acceptance_allowlist FROM anon, authenticated;/);
    expect(migrationCode).toMatch(/GRANT ALL\s+ON public\.commercial_live_acceptance_allowlist TO service_role;/);
  });

  it("acquire_checkout_attempt calls assert_platform_state_permits BEFORE taking the advisory lock or reading any existing row — a disallowed combination never even reaches the acquisition logic", () => {
    const fnBody = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.acquire_checkout_attempt\([\s\S]*?\n\$\$;/)?.[0] ?? "";
    const assertIndex = fnBody.indexOf("assert_platform_state_permits");
    const lockIndex = fnBody.indexOf("pg_advisory_xact_lock");
    expect(assertIndex).toBeGreaterThan(-1);
    expect(assertIndex).toBeLessThan(lockIndex);
  });

  it("routing.ts resolves FLUTTERWAVE_ENVIRONMENT with no implicit default — missing/invalid returns null, never 'sandbox'", () => {
    expect(routingCode).toMatch(/function resolveFlutterwaveEnvironment\(\): 'sandbox' \| 'production' \| null/);
    expect(routingCode).not.toMatch(/=== 'production' \? 'production' : 'sandbox'/);
    const fnBody = routingCode.match(/function resolveFlutterwaveEnvironment\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fnBody).toMatch(/return null;/);
  });

  it("getConfiguredProviders excludes Flutterwave entirely when its environment cannot be resolved — never falls back to a guessed environment", () => {
    const fnBody = routingCode.match(/export function getConfiguredProviders\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fnBody).toMatch(/if \(flutterwave &&/);
  });

  it("getCapabilitiesForProvider resolves the environment of the ACTUAL provider a caller already knows about — never an arbitrary configured entry", () => {
    expect(routingCode).toMatch(/export function getCapabilitiesForProvider\(provider: PaymentProvider\)/);
  });

  it("the webhook and the payment-status recovery path both resolve environment via getCapabilitiesForProvider — neither imports a static FLUTTERWAVE_CAPABILITIES constant anymore", () => {
    expect(webhookCode).toMatch(/import \{ getCapabilitiesForProvider \} from '\.\.\/_shared\/payments\/routing\.ts';/);
    expect(webhookCode).not.toMatch(/FLUTTERWAVE_CAPABILITIES/);
    expect(paymentStatusCode).toMatch(/import \{ getCapabilitiesForProvider \} from '\.\.\/_shared\/payments\/routing\.ts';/);
    expect(paymentStatusCode).not.toMatch(/FLUTTERWAVE_CAPABILITIES/);
  });

  it("both the webhook and the payment-status recovery path fail closed (never commit) when getCapabilitiesForProvider returns null", () => {
    for (const code of [webhookCode, paymentStatusCode]) {
      expect(code).toMatch(/const capabilities = getCapabilitiesForProvider\(/);
      expect(code).toMatch(/if \(!capabilities\)/);
    }
  });
});

// ============================================================
// BLOCKER-4 — mandatory provider transaction ID + canonical idempotency
// ============================================================

describe("BLOCKER-4 — provider transaction ID is mandatory; webhook and status recovery converge on one idempotency identity", () => {
  it("validateVerifiedTransactionData requires a non-empty string/number provider id — never falls through to an empty synthetic id", () => {
    expect(flutterwaveCode).toMatch(/const rawId = data\.id;/);
    expect(flutterwaveCode).toMatch(/typeof rawId === 'string' \|\| typeof rawId === 'number'/);
    expect(flutterwaveCode).toMatch(/if \(!candidateId\) \{\s*\n\s*return \{ verified: false, reason: `PROVIDER_TRANSACTION_ID_MISSING/);
  });

  it("verifyTransactionByReference passes NO fallback transaction id — a missing data.id there is unconditionally a verification failure, not a guess", () => {
    const fnBody = flutterwaveCode.match(/async verifyTransactionByReference\([\s\S]*?\n {2}\}/)?.[0] ?? "";
    expect(fnBody).toMatch(/this\.validateVerifiedTransactionData\(data, expectedMinor, expectedCurrency, saffRef\);/);
    expect(fnBody).not.toMatch(/validateVerifiedTransactionData\([^)]*txId/);
  });

  it("commit_verified_commercial_payment rejects a blank/whitespace provider_transaction_id before any other check", () => {
    const fnBody = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.commit_verified_commercial_payment\([\s\S]*?\n\$\$;/)?.[0] ?? "";
    const blankCheckIndex = fnBody.indexOf("p_provider_transaction_id IS NULL OR trim(p_provider_transaction_id) = ''");
    const idempotencyCheckIndex = fnBody.indexOf("SELECT id INTO v_existing_evt FROM public.payment_events");
    expect(blankCheckIndex).toBeGreaterThan(-1);
    expect(blankCheckIndex).toBeLessThan(idempotencyCheckIndex);
  });

  it("idempotency is re-checked AFTER the customer-level advisory lock is acquired, not before", () => {
    const fnBody = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.commit_verified_commercial_payment\([\s\S]*?\n\$\$;/)?.[0] ?? "";
    const lockIndex = fnBody.indexOf("pg_advisory_xact_lock(hashtext(v_billing_customer_id::text))");
    const idempotencyCheckIndex = fnBody.indexOf("SELECT id INTO v_existing_evt FROM public.payment_events");
    expect(lockIndex).toBeGreaterThan(-1);
    expect(idempotencyCheckIndex).toBeGreaterThan(lockIndex);
  });

  it("commit_verified_commercial_payment now accepts PENDING or MANUAL_REVIEW as commit-eligible intent statuses", () => {
    const fnBody = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.commit_verified_commercial_payment\([\s\S]*?\n\$\$;/)?.[0] ?? "";
    expect(fnBody).toMatch(/IF v_intent\.status NOT IN \('PENDING','MANUAL_REVIEW'\) THEN/);
  });

  it("the webhook computes the idempotency key as exactly `${provider}:${providerTransactionId}:${intentId}` — no 'WEBHOOK:' literal prefix", () => {
    expect(webhookCode).toMatch(/const idempotencyKey = await sha256Hex\(\s*`\$\{tx\.provider\}:\$\{tx\.providerTransactionId\}:\$\{intent\.id\}`\s*\);/);
    expect(webhookCode).not.toMatch(/WEBHOOK:\$\{tx\.provider\}/);
  });

  it("commercial-payment-status's recovery path computes the IDENTICAL idempotency key text for the same underlying transaction — no 'STATUS_POLL:' literal prefix", () => {
    expect(paymentStatusCode).toMatch(/const idempotencyKey = await sha256Hex\(`\$\{tx\.provider\}:\$\{tx\.providerTransactionId\}:\$\{responseData\.intent_id\}`\);/);
    expect(paymentStatusCode).not.toMatch(/STATUS_POLL:\$\{tx\.provider\}/);
  });
});

// ============================================================
// HIGH-1 — GET is read-only; POST recovery is durably throttled
// ============================================================

describe("HIGH-1 — commercial-payment-status: GET read-only, POST durably throttled", () => {
  it("GET never calls the provider or a commit RPC — it returns immediately after the ownership-proving read", () => {
    const getBranch = paymentStatusCode.match(/if \(req\.method === 'GET'\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? "";
    expect(getBranch).not.toMatch(/verifyTransactionByReference|commit_verified_commercial_payment/);
  });

  it("POST claims a bounded verification attempt via claim_verification_attempt before ever calling the provider", () => {
    const claimIndex = paymentStatusCode.indexOf("serviceClient.rpc('claim_verification_attempt'");
    const providerCallIndex = paymentStatusCode.indexOf("adapter.verifyTransactionByReference(");
    expect(claimIndex).toBeGreaterThan(-1);
    expect(claimIndex).toBeLessThan(providerCallIndex);
  });

  it("a throttled claim returns 202 with a bounded Retry-After header — never an unbounded retry loop, never silently ignored", () => {
    const throttledBlock = paymentStatusCode.match(/const retryAfter = claim\.retry_after_seconds[\s\S]*?\n {4}\);/)?.[0] ?? "";
    expect(throttledBlock).toMatch(/202/);
    expect(throttledBlock).toMatch(/'Retry-After': String\(retryAfter\)/);
  });

  it("claim_verification_attempt itself is durable and row-locked — never relies on Edge Function process memory (no Map/setTimeout-based limiter)", () => {
    const fnBody = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.claim_verification_attempt\([\s\S]*?\n\$\$;/)?.[0] ?? "";
    expect(fnBody).toMatch(/FOR UPDATE OF ci/);
    expect(fnBody).toMatch(/verification_claimed_until/);
  });

  it("claim_verification_attempt proves ownership (owner_user_id match or commercial_admin) before ever claiming", () => {
    const fnBody = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.claim_verification_attempt\([\s\S]*?\n\$\$;/)?.[0] ?? "";
    expect(fnBody).toMatch(/v_intent\.owner_user_id != p_requesting_user_id AND NOT public\.is_commercial_admin\(\)/);
  });

  it("claim_verification_attempt only claims for PENDING or MANUAL_REVIEW intents — never CREATING (no provider checkout exists yet) or a terminal status", () => {
    const fnBody = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.claim_verification_attempt\([\s\S]*?\n\$\$;/)?.[0] ?? "";
    expect(fnBody).toMatch(/IF v_intent\.status NOT IN \('PENDING', 'MANUAL_REVIEW'\) THEN/);
  });

  it("the frontend's pollCheckoutStatus (display polling) uses GET; requestPaymentVerificationRecovery (bounded recovery) uses POST — two distinct functions, never conflated", () => {
    const rpcSrc = fs.readFileSync(path.join(REPO_ROOT, "src/lib/commercial/commercialRpc.ts"), "utf-8");
    expect(rpcSrc).toMatch(/export async function pollCheckoutStatus[\s\S]*?method: "GET",/);
    expect(rpcSrc).toMatch(/export async function requestPaymentVerificationRecovery[\s\S]*?method: "POST",/);
  });
});

// ============================================================
// HIGH-2 — offer-seed binding fully re-asserted
// ============================================================

describe("HIGH-2 — offer-seed binding re-asserted in full", () => {
  it("checks product, plan, market, currency, amount, exponent, interval, interval count, provider_restriction, active state, purchasable state, and effective-period validity — not economics alone", () => {
    for (const field of [
      "OFFER_SEED_BINDING_MISSING", "OFFER_SEED_BINDING_WRONG_PRODUCT", "OFFER_SEED_BINDING_WRONG_PLAN",
      "OFFER_SEED_BINDING_WRONG_MARKET", "OFFER_SEED_BINDING_WRONG_CURRENCY", "OFFER_SEED_BINDING_WRONG_AMOUNT",
      "OFFER_SEED_BINDING_WRONG_EXPONENT", "OFFER_SEED_BINDING_WRONG_INTERVAL", "OFFER_SEED_BINDING_WRONG_INTERVAL_COUNT",
      "OFFER_SEED_BINDING_UNEXPECTED_PROVIDER_RESTRICTION", "OFFER_SEED_BINDING_NOT_ACTIVE",
      "OFFER_SEED_BINDING_UNEXPECTEDLY_PURCHASABLE", "OFFER_SEED_BINDING_NOT_CURRENTLY_EFFECTIVE",
      "OFFER_SEED_BINDING_DUPLICATE_AUTHORITATIVE_FAMILY",
    ]) {
      expect(migrationCode, `missing diagnostic ${field}`).toMatch(new RegExp(field));
    }
  });

  it("checks BOTH the MONTHLY and ANNUAL offers by joining through plan_id and product_id, not offer_code alone", () => {
    const doBlock = migrationCode.match(/DO \$\$\s*\nDECLARE\s*\n\s*v_row RECORD;[\s\S]*?END \$\$;\s*$/)?.[0] ?? "";
    expect(doBlock).toMatch(/JOIN public\.commercial_plans cp ON cp\.id = co\.plan_id/);
    expect(doBlock).toMatch(/JOIN public\.commercial_products cprod ON cprod\.id = cp\.product_id/);
    expect(doBlock).toMatch(/CFOCLOSE_PROFESSIONAL_GLOBAL_USD_MONTHLY/);
    expect(doBlock).toMatch(/CFOCLOSE_PROFESSIONAL_GLOBAL_USD_ANNUAL/);
  });

  it("admin_upsert_commercial_offer refuses to silently repoint an existing offer_code's market or billing_interval", () => {
    const fnBody = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.admin_upsert_commercial_offer\([\s\S]*?\n\$\$;/)?.[0] ?? "";
    expect(fnBody).toMatch(/OFFER_CODE_MARKET_MISMATCH/);
    expect(fnBody).toMatch(/OFFER_CODE_INTERVAL_MISMATCH/);
  });
});

// ============================================================
// HIGH-3 — pricing parity fails closed until explicitly true
// ============================================================

describe("HIGH-3 — pricing parity fails closed (Pricing.tsx and Settings.tsx)", () => {
  for (const [name, code] of [["Pricing.tsx", pricingCode], ["Settings.tsx", settingsCode]] as const) {
    it(`${name}: CheckoutUpgradeButton is wrapped in a native hidden={...} guard, not a conditional-render fallback that could race with the resolution effect`, () => {
      expect(code).toMatch(/<div hidden=\{(pricingParityOk|renewalPricingParityOk) !== true\}>/);
    });

    it(`${name}: the parity comparison checks amount, currency, exponent, interval, interval count, AND market — not amount/currency alone`, () => {
      expect(code).toMatch(/currency_exponent === 2/);
      expect(code).toMatch(/billing_interval_count === 1/);
      expect(code).toMatch(/market_code === "GLOBAL"/);
    });

    it(`${name}: an incomplete resolved offer (missing exponent/interval/interval_count/market) resets parity to null, never treated as a pass`, () => {
      expect(code).toMatch(/data\.currency_exponent == null \|\| !data\.billing_interval \|\| data\.billing_interval_count == null \|\|\s*\n\s*data\.market_code == null/);
    });
  }
});
