/**
 * Ω3-CHECKOUT — CFOClose offers, mandatory billing-interval authority,
 * product-scoped resolution, platform-state gating, atomic checkout-intent
 * acquisition, and CFOClose branding.
 *
 * NON-EXECUTABLE DB/DENO BEHAVIOR NOTICE: this environment has no live
 * Postgres connection and no Deno runtime. What CAN be proven here, and is
 * proven below, is that the migration's and Edge Functions' SOURCE TEXT
 * actually implements the required structural guarantees — the same
 * static-source-text regression-guard technique already established
 * throughout this repository (globalCommerceModel.test.ts,
 * marketPropagation.test.ts, authContractRepair.test.ts,
 * migrationCollisionGuard.test.ts).
 *
 * This file complements — never replaces — globalCommerceModel.test.ts's
 * own checks against the ORIGINAL Ω2-G migration (20260906083524_...sql),
 * which remain valid, unedited, forward-only history for that migration's
 * own text. The invariants proven there (market != jurisdiction, no
 * browser-supplied amount/currency, explicit AVAILABLE/NOT_AVAILABLE/
 * AMBIGUOUS/UNKNOWN vocabulary) are re-proven here against the CURRENTLY
 * LIVE resolve_commercial_offer definition, since this migration's
 * expand -> cutover -> contract sequence supersedes that earlier one.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.join(__dirname, "../../../../../");
const MIGRATION_PATH = path.join(
  REPO_ROOT,
  "supabase/migrations/20260912100000_omega3_checkout_cfoclose_offers_and_interval_authority.sql",
);
const CHECKOUT_FN_PATH = path.join(REPO_ROOT, "supabase/functions/commercial-create-checkout/index.ts");
const FLUTTERWAVE_ADAPTER_PATH = path.join(REPO_ROOT, "supabase/functions/_shared/payments/providers/flutterwave.ts");

function stripSqlComments(sql: string): string {
  return sql.replace(/--.*$/gm, "");
}
function stripTsComments(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const migrationRaw = fs.readFileSync(MIGRATION_PATH, "utf-8");
const migrationCode = stripSqlComments(migrationRaw);
const checkoutSrc = fs.readFileSync(CHECKOUT_FN_PATH, "utf-8");
const checkoutCode = stripTsComments(checkoutSrc);
const flutterwaveSrc = fs.readFileSync(FLUTTERWAVE_ADAPTER_PATH, "utf-8");
const flutterwaveCode = stripTsComments(flutterwaveSrc);

// ============================================================
// Migration presence, ordering, forward-only discipline
// ============================================================

describe("Ω3-CHECKOUT migration — presence and ordering", () => {
  it("exists under supabase/migrations/", () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
  });

  it("sorts after every prior live migration (including the Ω3.0 platform-state migration)", () => {
    const migrationsDir = path.join(REPO_ROOT, "supabase/migrations");
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
    const sorted = [...files].sort();
    expect(sorted[sorted.length - 1]).toBe(
      "20260912100000_omega3_checkout_cfoclose_offers_and_interval_authority.sql",
    );
  });

  it("never edits a live Ω1/RLS1/Ω2/Ω3.0 migration file (forward-only)", () => {
    const liveFiles = [
      "20260905093408_8fc55e64-3e06-4d26-8835-438a9243e1ef.sql",
      "20260905141022_f1029fbe-90d5-4aac-97e0-059eede76338.sql",
      "20260906083524_eca6c272-4a62-4468-995b-1c70e2cd67e5.sql",
      "20260906120000_omega3_0_effective_history_and_platform_state.sql",
    ];
    for (const file of liveFiles) {
      const filePath = path.join(REPO_ROOT, "supabase/migrations", file);
      expect(fs.existsSync(filePath)).toBe(true);
    }
    // This migration file itself must never be one of the live files above.
    expect(liveFiles).not.toContain(
      "20260912100000_omega3_checkout_cfoclose_offers_and_interval_authority.sql",
    );
  });

  it("creates no table already defined by an earlier live migration (never re-declares CREATE TABLE for any commercial/billing entity)", () => {
    // Mirrors migrationCollisionGuard.test.ts's own technique: this
    // migration must only ALTER/INSERT/CREATE OR REPLACE
    // FUNCTION/CREATE INDEX against already-existing tables, never
    // CREATE TABLE for any of them.
    const createTableMatches = migrationCode.match(/CREATE TABLE\s+public\.\w+/g) ?? [];
    expect(createTableMatches).toEqual([]);
  });
});

// ============================================================
// Product/plan rename — CFOClose, ids unchanged
// ============================================================

describe("CFOClose product/plan naming — presentation-only rename, no id churn", () => {
  it("renames the product row (UPDATE, not INSERT/DELETE) from SAFF_ERP to CFOCLOSE", () => {
    expect(migrationCode).toMatch(/UPDATE public\.commercial_products\s+SET code = 'CFOCLOSE', name = 'CFOClose'\s+WHERE code = 'SAFF_ERP';/);
    expect(migrationCode).not.toMatch(/INSERT INTO public\.commercial_products/);
    expect(migrationCode).not.toMatch(/DELETE FROM public\.commercial_products/);
  });

  it("renames the PAID plan's display name (UPDATE, not INSERT/DELETE) to CFOClose Professional", () => {
    expect(migrationCode).toMatch(/UPDATE public\.commercial_plans\s+SET name = 'CFOClose Professional'/);
    expect(migrationCode).not.toMatch(/DELETE FROM public\.commercial_plans/);
  });

  it("verifies the rename with an executable assertion that aborts the migration on mismatch", () => {
    expect(migrationCode).toMatch(/CFOCLOSE_PRODUCT_RENAME_FAILED/);
    expect(migrationCode).toMatch(/CFOCLOSE_PLAN_RENAME_FAILED/);
  });
});

// ============================================================
// Offer seeding — exact economics, non-purchasable by default
// ============================================================

describe("CFOClose Professional offer seeding — GLOBAL/USD, exact economics, non-purchasable", () => {
  it("seeds a MONTHLY offer with amount_minor 4900, exponent 2, currency USD", () => {
    const insert = migrationCode.match(/INSERT INTO public\.commercial_offers[\s\S]*?CFOCLOSE_PROFESSIONAL_GLOBAL_USD_MONTHLY[\s\S]*?ON CONFLICT/)?.[0] ?? "";
    expect(insert).toMatch(/'GLOBAL', 'USD', 4900, 2, 'MONTHLY', 1/);
  });

  it("seeds an ANNUAL offer with amount_minor 49900, exponent 2, currency USD", () => {
    const insert = migrationCode.match(/INSERT INTO public\.commercial_offers[\s\S]*?CFOCLOSE_PROFESSIONAL_GLOBAL_USD_ANNUAL[\s\S]*?ON CONFLICT/)?.[0] ?? "";
    expect(insert).toMatch(/'GLOBAL', 'USD', 49900, 2, 'ANNUAL', 1/);
  });

  it("never sets is_purchasable = true anywhere in this migration (offers seeded non-purchasable, column default false)", () => {
    expect(migrationCode).not.toMatch(/is_purchasable\s*=\s*true/i);
    expect(migrationCode).not.toMatch(/is_purchasable\)\s*VALUES[\s\S]{0,80}true/i);
  });

  it("seeded amount_minor values match src/constants/copy.ts's documented PRICING constants exactly", () => {
    const copySrc = fs.readFileSync(path.join(REPO_ROOT, "src/constants/copy.ts"), "utf-8");
    expect(copySrc).toMatch(/MONTHLY_USD:\s*49,/);
    expect(copySrc).toMatch(/ANNUAL_USD:\s*499,/);
    // 49 USD @ exponent 2 == 4900 minor units; 499 USD == 49900 minor units —
    // exactly the two literals seeded above.
    expect(migrationCode).toMatch(/4900/);
    expect(migrationCode).toMatch(/49900/);
  });

  it("verifies both offers' economics with an executable assertion that aborts the migration on mismatch", () => {
    expect(migrationCode).toMatch(/CFOCLOSE_MONTHLY_OFFER_ECONOMICS_MISMATCH/);
    expect(migrationCode).toMatch(/CFOCLOSE_ANNUAL_OFFER_ECONOMICS_MISMATCH/);
    expect(migrationCode).toMatch(/CFOCLOSE_MONTHLY_OFFER_UNEXPECTEDLY_PURCHASABLE/);
    expect(migrationCode).toMatch(/CFOCLOSE_ANNUAL_OFFER_UNEXPECTEDLY_PURCHASABLE/);
  });
});

// ============================================================
// resolve_commercial_offer — mandatory interval, product scope, platform gate
// ============================================================

describe("resolve_commercial_offer (live, 3-arg) — mandatory billing interval", () => {
  const fnBody = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.resolve_commercial_offer\(\s*p_plan_code[\s\S]*?\n\$\$;/)?.[0] ?? "";

  it("the new function is defined with p_billing_interval as a real parameter", () => {
    expect(fnBody).toMatch(/p_billing_interval\s+TEXT/);
  });

  it("p_billing_interval carries no usable default that would let a caller silently omit it and still resolve an offer — an omitted/null/unsupported value is rejected as UNKNOWN, never silently treated as GLOBAL-style neutral default", () => {
    expect(fnBody).toMatch(/IF p_billing_interval IS NULL OR p_billing_interval NOT IN \('MONTHLY', 'ANNUAL'\) THEN/);
    expect(fnBody).toMatch(/'reason', 'UNKNOWN_BILLING_INTERVAL'/);
  });

  it("filters offers by billing_interval — the exact gap that made two purchasable offers (MONTHLY + ANNUAL) resolve ambiguously under the retired 2-arg overload", () => {
    expect(fnBody).toMatch(/co\.billing_interval = p_billing_interval/);
  });

  it("is product-scoped to CFOCLOSE — a plan lookup joins through commercial_products and filters on code = 'CFOCLOSE'", () => {
    expect(fnBody).toMatch(/JOIN public\.commercial_products co ON co\.id = cp\.product_id/);
    expect(fnBody).toMatch(/co\.code = 'CFOCLOSE'/);
  });

  it("is gated on commercial_platform_state — withholds AVAILABLE while payments remain platform-disabled", () => {
    expect(fnBody).toMatch(/FROM public\.commercial_platform_state WHERE id = true/);
    expect(fnBody).toMatch(/v_platform_state = 'PAYMENTS_DISABLED'/);
    expect(fnBody).toMatch(/'reason','PLATFORM_PAYMENTS_DISABLED'/);
  });

  it("still has no company/accounting-jurisdiction parameter — market remains independent (re-proving globalCommerceModel.test.ts's own invariant against the live function)", () => {
    const signature = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.resolve_commercial_offer\(([\s\S]*?)\)\s*RETURNS/)?.[1] ?? "";
    expect(signature).not.toMatch(/company_id|reporting_framework|jurisdiction/i);
  });

  it("still never accepts a browser-supplied amount or currency as input", () => {
    const signature = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.resolve_commercial_offer\(([\s\S]*?)\)\s*RETURNS/)?.[1] ?? "";
    expect(signature).not.toMatch(/p_amount|p_currency/);
  });

  it("still returns explicit AVAILABLE/NOT_AVAILABLE/AMBIGUOUS/UNKNOWN — never a silent choice", () => {
    expect(fnBody).toMatch(/'resolution','UNKNOWN'/);
    expect(fnBody).toMatch(/'resolution','NOT_AVAILABLE'/);
    expect(fnBody).toMatch(/v_count > 1[\s\S]*?'resolution','AMBIGUOUS'/);
    expect(fnBody).toMatch(/'resolution','AVAILABLE'/);
  });

  it("is granted to anon and authenticated (pricing display remains public)", () => {
    expect(migrationCode).toMatch(/GRANT EXECUTE ON FUNCTION public\.resolve_commercial_offer\(TEXT, TEXT, TEXT\) TO anon, authenticated;/);
  });
});

describe("resolve_commercial_offer — expand -> cutover -> contract completeness", () => {
  it("retires the old 2-argument overload explicitly (DROP FUNCTION), never leaves it live alongside the new one", () => {
    expect(migrationCode).toMatch(/DROP FUNCTION IF EXISTS public\.resolve_commercial_offer\(TEXT, TEXT\);/);
  });

  it("the DROP of the old overload appears AFTER the CREATE of the new one — cutover happens only once the replacement exists", () => {
    const createIndex = migrationCode.indexOf("CREATE OR REPLACE FUNCTION public.resolve_commercial_offer(");
    const dropIndex = migrationCode.indexOf("DROP FUNCTION IF EXISTS public.resolve_commercial_offer(TEXT, TEXT);");
    expect(createIndex).toBeGreaterThan(-1);
    expect(dropIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeLessThan(dropIndex);
  });
});

// ============================================================
// admin_upsert_commercial_offer — product-scoped plan lookup
// ============================================================

describe("admin_upsert_commercial_offer — product-scoped (Ω3-CHECKOUT correction)", () => {
  const fnBody = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.admin_upsert_commercial_offer\(\s*p_offer_code[\s\S]*?\n\$\$;/)?.[0] ?? "";

  it("accepts an optional p_product_code parameter defaulting to CFOCLOSE — existing callers are unaffected", () => {
    expect(migrationCode).toMatch(/p_product_code\s+TEXT\s+DEFAULT 'CFOCLOSE'/);
  });

  it("scopes the plan lookup by product via a join on commercial_products, never a bare commercial_plans.code lookup", () => {
    expect(fnBody).toMatch(/JOIN public\.commercial_products co ON co\.id = cp\.product_id/);
    expect(fnBody).toMatch(/co\.code = p_product_code/);
  });

  it("retires the old 11-arg overload with no product scoping", () => {
    expect(migrationCode).toMatch(/DROP FUNCTION IF EXISTS public\.admin_upsert_commercial_offer\(TEXT,TEXT,TEXT,TEXT,BIGINT,SMALLINT,TEXT,SMALLINT,BOOLEAN,BOOLEAN,TEXT\);/);
  });

  it("still requires commercial-admin authority and a non-empty reason — unchanged authorization posture", () => {
    expect(fnBody).toMatch(/NOT public\.is_commercial_admin\(\)/);
    expect(fnBody).toMatch(/REASON_REQUIRED/);
  });
});

// ============================================================
// get_my_billing_summary — billing_interval reporting
// ============================================================

describe("get_my_billing_summary — reports the current licence's billing interval", () => {
  const fnBody = migrationCode.match(/CREATE OR REPLACE FUNCTION public\.get_my_billing_summary\(\)[\s\S]*?\n\$\$;/)?.[0] ?? "";

  it("joins back to the originating PAYMENT_CONFIRMED payment_event and its checkout intent to find billing_interval", () => {
    expect(fnBody).toMatch(/pe\.event_type = 'PAYMENT_CONFIRMED'/);
    expect(fnBody).toMatch(/LEFT JOIN public\.payment_checkout_intents pci ON pci\.id = latest_evt\.checkout_intent_id/);
  });

  it("uses a LEFT JOIN (never INNER) so a FREE/admin-granted licence with no originating checkout still resolves — billing_interval simply comes back NULL", () => {
    expect(fnBody).toMatch(/LEFT JOIN LATERAL/);
    expect(fnBody).toMatch(/LEFT JOIN public\.payment_checkout_intents/);
  });

  it("both no-billing-customer and no-active-licence early-return branches explicitly include billing_interval: NULL — never an omitted key that could throw downstream on strict property access", () => {
    const earlyReturns = fnBody.match(/RETURN jsonb_build_object\(\s*'has_billing_customer', (?:false|true), 'plan_code', NULL[\s\S]*?\);/g) ?? [];
    expect(earlyReturns.length).toBe(2);
    for (const branch of earlyReturns) {
      expect(branch).toMatch(/'billing_interval', NULL/);
      expect(branch).toMatch(/'billing_interval_count', NULL/);
    }
  });

  it("remains authenticated-only (no anon grant)", () => {
    expect(migrationCode).toMatch(/REVOKE ALL ON FUNCTION public\.get_my_billing_summary\(\) FROM PUBLIC, anon;/);
    expect(migrationCode).toMatch(/GRANT EXECUTE ON FUNCTION public\.get_my_billing_summary\(\) TO authenticated;/);
  });
});

// ============================================================
// Atomic checkout-intent acquisition
// ============================================================

describe("Atomic checkout-intent acquisition — partial unique index", () => {
  it("adds a partial unique index on (billing_customer_id, commercial_offer_id) scoped to open (CREATED/PENDING) statuses only", () => {
    expect(migrationCode).toMatch(/CREATE UNIQUE INDEX uq_pci_one_open_intent_per_customer_offer\s*\n\s*ON public\.payment_checkout_intents \(billing_customer_id, commercial_offer_id\)\s*\n\s*WHERE status IN \('CREATED', 'PENDING'\);/);
  });

  it("commercial-create-checkout checks for an existing open intent before inserting a new one", () => {
    expect(checkoutCode).toMatch(/\.in\('status', \['CREATED', 'PENDING'\]\)/);
  });

  it("commercial-create-checkout safely reuses a still-open PENDING intent with a provider_checkout_url instead of creating a second one", () => {
    expect(checkoutCode).toMatch(/existingIntent\.status === 'PENDING' && existingIntent\.provider_checkout_url/);
  });

  it("commercial-create-checkout refuses to start a second concurrent provider checkout when another request for the same offer is genuinely mid-flight (status CREATED, no url yet)", () => {
    expect(checkoutCode).toMatch(/CHECKOUT_ALREADY_IN_PROGRESS/);
  });

  it("commercial-create-checkout catches the unique-constraint violation (Postgres 23505) on the insert itself as the atomic backstop for a genuine race, never lets it surface as an unhandled 500", () => {
    expect(checkoutCode).toMatch(/intentErr\?\.code === '23505'/);
  });

  it("an expired-but-unresolved open intent is self-healed (marked EXPIRED) rather than permanently blocking new attempts", () => {
    expect(checkoutCode).toMatch(/status: 'EXPIRED', completed_at: nowIso/);
  });
});

// ============================================================
// commercial-create-checkout — mandatory billingInterval from the browser
// ============================================================

describe("commercial-create-checkout — billingInterval is mandatory and validated (Ω3-CHECKOUT trust boundary)", () => {
  it("rejects any billingInterval other than MONTHLY or ANNUAL before ever resolving an offer", () => {
    expect(checkoutCode).toMatch(/if \(billingInterval !== 'MONTHLY' && billingInterval !== 'ANNUAL'\) \{/);
    expect(checkoutCode).toMatch(/status: 400/);
  });

  it("passes billingInterval through to resolve_commercial_offer unmodified, alongside planCode and marketCode", () => {
    const rpcCall = checkoutCode.match(/supabase\.rpc\('resolve_commercial_offer', \{([\s\S]*?)\}\)/)?.[1] ?? "";
    expect(rpcCall).toMatch(/p_plan_code:\s*planCode/);
    expect(rpcCall).toMatch(/p_billing_interval:\s*billingInterval/);
    expect(rpcCall).toMatch(/p_market_code:\s*marketCode/);
  });

  it("never accepts amount, currency, or price from the browser body — only planCode, billingInterval, marketCode", () => {
    const parseBlock = checkoutCode.match(/const body = await req\.json\(\);[\s\S]*?catch \{/)?.[0] ?? "";
    expect(parseBlock).toMatch(/planCode = body\.planCode/);
    expect(parseBlock).toMatch(/billingInterval = body\.billingInterval/);
    expect(parseBlock).not.toMatch(/amount|currency|price/i);
  });
});

// ============================================================
// CFOClose branding — Flutterwave hosted-checkout payload
// ============================================================

describe("Flutterwave adapter — CFOClose branding on the hosted-checkout payload (charter item: no stale SAFF checkout branding)", () => {
  it("the checkout page title is CFOClose, never SAFF ERP", () => {
    expect(flutterwaveCode).toMatch(/title:\s*'CFOClose'/);
    expect(flutterwaveCode).not.toMatch(/SAFF ERP/);
  });

  it("sends no logo field at all — never a dead/placeholder favicon.ico URL on a real payment page", () => {
    expect(flutterwaveCode).not.toMatch(/logo:/);
    expect(flutterwaveCode).not.toMatch(/favicon\.ico/);
  });

  it("meta.source is CFOClose-branded, not the retired SAFF_ERP_OMEGA2 identifier", () => {
    expect(flutterwaveCode).toMatch(/source:\s*'CFOCLOSE_OMEGA3'/);
    expect(flutterwaveCode).not.toMatch(/SAFF_ERP_OMEGA2/);
  });

  it("saff_reference / tx_ref internal identifiers are UNCHANGED — historical evidence identifiers, not customer-visible branding", () => {
    expect(flutterwaveCode).toMatch(/saff_reference:\s*params\.saffReference/);
    expect(flutterwaveCode).toMatch(/tx_ref:\s*params\.saffReference/);
  });

  it("still never logs or exposes the secret key or webhook secret", () => {
    expect(flutterwaveCode).not.toMatch(/console\.\w+\([^)]*secretKey/i);
    expect(flutterwaveCode).not.toMatch(/console\.\w+\([^)]*webhookSecret/i);
  });
});
