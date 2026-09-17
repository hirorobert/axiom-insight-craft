/**
 * Flutterwave decommission — regression protection.
 *
 * Flutterwave is retired as an active payment provider. These tests are the
 * standing guard that it cannot silently come back: no adapter, no credential
 * read, no API host, no checkout creation, no webhook mutation path, and no
 * user-facing claim that online checkout works.
 *
 * SCOPE OF THE STATIC SCAN — and every exclusion, justified:
 *   INCLUDED: all active source under src/** and supabase/functions/**.
 *   EXCLUDED, deliberately:
 *     1. supabase/migrations/** and supabase/migrations_historical/** —
 *        immutable applied history. Rewriting an applied migration is
 *        forbidden, and their remaining references are (a) explanatory
 *        comments and (b) the provider CHECK enum, which MUST keep
 *        'FLUTTERWAVE' so historical payment rows stay readable.
 *     2. docs/** and *.md at the repository root — archived architecture,
 *        certification and audit records describing what was true at the
 *        time. Editing them would falsify the audit trail.
 *     3. scripts/db-contract-tests/** — assertions about the immutable
 *        migration text above; they describe historical schema, not
 *        behaviour that is still offered.
 *     4. This test file and the sibling __tests__ directory — the tests must
 *        name what they forbid, and provider-neutral fixtures may reference
 *        'FLUTTERWAVE' only as a historical enum value.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.join(__dirname, "../../../../../");
const ACTIVE_ROOTS = ["src", "supabase/functions"];
const EXCLUDED_DIR_SEGMENTS = ["__tests__", "node_modules", "dist"];
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".json"]);

function activeSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const next = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_SEGMENTS.includes(entry.name)) continue;
        walk(next);
      } else if (CODE_EXT.has(path.extname(entry.name))) {
        out.push(next);
      }
    }
  };
  for (const root of ACTIVE_ROOTS) walk(path.join(REPO_ROOT, root));
  return out;
}

const ACTIVE_FILES = activeSourceFiles();
const SCAN = /flutterwave|FLUTTERWAVE|api\.flutterwave\.com|checkout\.flutterwave\.com/;

/** Historical provider VALUES stay legal; active integration references do not. */
const HISTORICAL_VALUE_ONLY = /^(.*['"`])FLUTTERWAVE(['"`].*)$/;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^\s*\/\/.*$/gm, "");
}

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf-8");
}

describe("Flutterwave decommission — static active-source scan", () => {
  it("no active source file references a Flutterwave adapter, package, API host or credential", () => {
    const offenders: string[] = [];
    for (const abs of ACTIVE_FILES) {
      // Explanatory comments (including this decommission's own rationale)
      // are excluded: they document why the integration is gone, and cannot
      // execute. Only real code is scanned.
      const text = stripComments(fs.readFileSync(abs, "utf-8"));
      text.split("\n").forEach((line, i) => {
        if (!SCAN.test(line)) return;
        // A bare provider string literal (historical enum value) is allowed.
        if (HISTORICAL_VALUE_ONLY.test(line) && !/flutterwave\.com|import|require|SECRET|WEBHOOK_SECRET|ENVIRONMENT|Adapter/i.test(line)) return;
        offenders.push(`${path.relative(REPO_ROOT, abs)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the Flutterwave adapter source no longer exists", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "supabase/functions/_shared/payments/providers/flutterwave.ts"))).toBe(false);
  });

  it("no Flutterwave SDK or package is declared as a dependency", () => {
    const pkg = read("package.json");
    expect(pkg).not.toMatch(/flutterwave|flw-|rave-/i);
    const lock = read("package-lock.json");
    expect(lock).not.toMatch(/flutterwave/i);
  });
});

describe("Flutterwave decommission — no active checkout can be created", () => {
  const edgeRouting = read("supabase/functions/_shared/payments/routing.ts");
  const clientRouting = read("src/lib/commercial/payments/routing.ts");
  const checkout = read("supabase/functions/commercial-create-checkout/index.ts");

  it("no provider is configured server-side, so routing fails closed", () => {
    const body = edgeRouting.match(/export function getConfiguredProviders\(\)[\s\S]*?\n\}/)?.[0] ?? "";
    expect(body).toMatch(/return \[\];/);
    expect(edgeRouting).not.toMatch(/Deno\.env\.get\('FLUTTERWAVE/);
  });

  it("no provider capabilities are declared client-side", () => {
    expect(clientRouting).toMatch(/export const CONFIGURED_PROVIDERS: readonly PaymentProviderCapabilities\[\] = \[\];/);
    expect(clientRouting).not.toMatch(/FLUTTERWAVE_CAPABILITIES/);
  });

  it("checkout creation returns PAYMENT_PROVIDER_UNAVAILABLE before any provider call", () => {
    const selectIdx = checkout.indexOf("selectPaymentProvider(");
    const unavailableIdx = checkout.indexOf("PAYMENT_PROVIDER_UNAVAILABLE");
    const adapterIdx = checkout.indexOf("adapter.createCheckout(");
    expect(selectIdx).toBeGreaterThan(-1);
    expect(unavailableIdx).toBeGreaterThan(selectIdx);
    expect(unavailableIdx).toBeLessThan(adapterIdx);
    expect(checkout).not.toMatch(/getFlutterwaveAdapter/);
  });

  it("no client code holds or requests a provider credential", () => {
    for (const abs of ACTIVE_FILES.filter((f) => f.includes(`${path.sep}src${path.sep}`))) {
      const text = fs.readFileSync(abs, "utf-8");
      expect(text).not.toMatch(/FLW(SECK|PUBK)|FLUTTERWAVE_SECRET_KEY|FLUTTERWAVE_PUBLIC_KEY|FLUTTERWAVE_ENCRYPTION_KEY|FLUTTERWAVE_WEBHOOK/);
    }
  });
});

describe("Flutterwave decommission — no webhook can mutate billing state", () => {
  const webhook = read("supabase/functions/commercial-payment-webhook/index.ts");

  it("the webhook endpoint performs no database write and calls no commit function", () => {
    expect(webhook).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(|\.rpc\(/);
    expect(webhook).not.toMatch(/commit_verified_commercial_payment/);
    expect(webhook).not.toMatch(/createClient/);
  });

  it("the webhook endpoint returns 410 Gone and verifies no provider signature", () => {
    expect(webhook).toMatch(/status: 410/);
    expect(webhook).toMatch(/PAYMENT_WEBHOOK_DECOMMISSIONED/);
    expect(webhook).not.toMatch(/verifyWebhookAuthenticity|verif-hash/);
  });
});

describe("Flutterwave decommission — preserved provider-neutral business state", () => {
  it("the provider vocabulary still admits FLUTTERWAVE so historical rows remain readable", () => {
    const types = read("src/lib/commercial/payments/paymentTypes.ts");
    expect(types).toMatch(/'FLUTTERWAVE'/);
    const contracts = read("supabase/functions/_shared/payments/contracts.ts");
    expect(contracts).toMatch(/'FLUTTERWAVE'/);
  });

  it("no migration was added that deletes payment history or drops shared billing tables", () => {
    const migrationDir = path.join(REPO_ROOT, "supabase/migrations");
    for (const file of fs.readdirSync(migrationDir)) {
      const sql = fs.readFileSync(path.join(migrationDir, file), "utf-8");
      expect(sql).not.toMatch(/DROP TABLE\s+(IF EXISTS\s+)?public\.(payment_events|payment_checkout_intents|payment_webhook_receipts|commercial_licences|billing_customers)/i);
      expect(sql).not.toMatch(/DELETE FROM public\.payment_events/i);
    }
  });

  it("FREE-plan provisioning is untouched by this change set", () => {
    const files = fs.readdirSync(path.join(REPO_ROOT, "supabase/migrations"));
    const provisioning = files.filter((f) => fs.readFileSync(path.join(REPO_ROOT, "supabase/migrations", f), "utf-8")
      .includes("provision_billing_customer_for_company"));
    expect(provisioning.length).toBeGreaterThan(0);
  });
});

describe("Flutterwave decommission — honest user-facing copy", () => {
  const HONEST = "Online checkout is temporarily unavailable. Contact support for billing assistance.";

  it("the pricing page states checkout is unavailable without naming a retired provider", () => {
    const pricing = read("src/pages/Pricing.tsx");
    expect(pricing).toContain(HONEST);
    expect(pricing).not.toMatch(/flutterwave/i);
  });

  it("the upgrade button states checkout is unavailable and invents no contact details", () => {
    const button = read("src/components/commercial/CheckoutUpgradeButton.tsx");
    expect(button).toContain(HONEST);
    expect(button).not.toMatch(/flutterwave/i);
    // No fabricated email address or phone number anywhere in the copy.
    expect(button).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    expect(button).not.toMatch(/\+\d[\d\s-]{7,}/);
  });
});
