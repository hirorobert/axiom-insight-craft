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

/**
 * The ONLY code lines in active source that may contain the token. Each entry
 * is path-specific AND exact-line-specific (trimmed, whole line). Anything
 * else containing the token — an adapter, SDK import, API URL, secret,
 * checkout creation, verification, webhook mutation, or provider routing — is
 * an offender. Every entry must match exactly once (asserted below), so a
 * stale or widened entry cannot hide a new reference.
 *
 *   - PaymentProvider unions and SUPPORTED_PROVIDERS/provider-value lists keep
 *     'FLUTTERWAVE' as a legal VALUE so historical payment rows (whose
 *     provider column has an immutable CHECK enum) remain readable. They are
 *     type/value declarations only; routing is separately proven to return no
 *     configured provider (see the "no active checkout can be created" suite).
 */
const HISTORICAL_LITERAL_ALLOWLIST: readonly { readonly path: string; readonly line: string; readonly reason: string }[] = [
  { path: "src/lib/commercial/payments/paymentAuthority.ts", line: '"FLUTTERWAVE",', reason: "SUPPORTED_PROVIDERS historical value" },
  { path: "src/lib/commercial/payments/paymentTypes.ts", line: "'FLUTTERWAVE',", reason: "provider value list, mirrors the immutable DB CHECK enum" },
  { path: "src/lib/commercial/payments/routing.ts", line: 'export type PaymentProvider = "FLUTTERWAVE" | "PESAPAL" | "SELCOM" | "DPO" | "STRIPE";', reason: "PaymentProvider union" },
  { path: "supabase/functions/_shared/payments/contracts.ts", line: "export type PaymentProvider = 'FLUTTERWAVE' | 'PESAPAL' | 'SELCOM' | 'DPO' | 'STRIPE';", reason: "PaymentProvider union" },
];

/** Splits on LF or CRLF. A checkout with CRLF endings (Windows autocrlf) must scan identically to an LF one. */
function codeLines(source: string): string[] {
  return stripComments(source).split(/\r?\n/);
}

/** Pure scanner: returns the offending lines of one file. `relPath` uses forward slashes. */
function scanSource(relPath: string, source: string): string[] {
  const offenders: string[] = [];
  codeLines(source).forEach((line, i) => {
    if (!SCAN.test(line)) return;
    const allowed = HISTORICAL_LITERAL_ALLOWLIST.some((e) => e.path === relPath && e.line === line.trim());
    if (!allowed) offenders.push(`${relPath}:${i + 1}: ${line.trim()}`);
  });
  return offenders;
}

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
      // Explanatory comments document why the integration is gone and cannot
      // execute; only real code is scanned.
      const rel = path.relative(REPO_ROOT, abs).split(path.sep).join("/");
      offenders.push(...scanSource(rel, fs.readFileSync(abs, "utf-8")));
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the Flutterwave adapter source no longer exists", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "supabase/functions/_shared/payments/providers/flutterwave.ts"))).toBe(false);
  });

  it("no Flutterwave SDK or package is declared as a dependency", () => {
    const pkg = read("package.json");
    expect(pkg).not.toMatch(/flutterwave|flw-|rave-/i);
    const lock = read("bun.lock"); // the repository's only lockfile
    expect(lock).not.toMatch(/flutterwave/i);
  });
});

describe("Flutterwave decommission — the scanner itself", () => {
  const P = "src/lib/commercial/payments/routing.ts";
  const HIST = 'export type PaymentProvider = "FLUTTERWAVE" | "PESAPAL" | "SELCOM" | "DPO" | "STRIPE";';

  it("permits exactly the historical literals, under LF and CRLF alike", () => {
    expect(scanSource(P, HIST + "\n")).toEqual([]);
    expect(scanSource(P, HIST + "\r\n")).toEqual([]);
  });

  it("every allowlist entry matches exactly one line in its real file (no stale or widened entry)", () => {
    for (const e of HISTORICAL_LITERAL_ALLOWLIST) {
      const hits = codeLines(read(e.path)).filter((l) => l.trim() === e.line);
      expect(hits, `${e.path}: ${e.line}`).toHaveLength(1);
    }
  });

  it("the allowlist is path-specific: the same literal in any other file is an offender", () => {
    expect(scanSource("src/lib/other.ts", HIST)).toHaveLength(1);
    expect(scanSource("supabase/functions/commercial-create-checkout/index.ts", '  "FLUTTERWAVE",')).toHaveLength(1);
  });

  it("still rejects every executable or credential form, including inside an allowlisted file", () => {
    const bad = [
      "import { createFlutterwaveAdapter } from './providers/flutterwave';",
      "const url = 'https://api.flutterwave.com/v3/payments';",
      "const host = 'checkout.flutterwave.com';",
      "const key = Deno.env.get('FLUTTERWAVE_SECRET_KEY');",
      "const hash = Deno.env.get('FLUTTERWAVE_WEBHOOK_SECRET');",
      "  case 'FLUTTERWAVE': return adapter.createCheckout(params);",
      "  if (provider === 'FLUTTERWAVE') await verifyTransaction(ref);",
      "const flutterwaveAdapter = createAdapter();",
      "import Flutterwave from 'flutterwave-node-v3';",
      'export type PaymentProvider = "FLUTTERWAVE" | "PESAPAL" | "SELCOM" | "DPO" | "STRIPE"; // extra',
    ];
    for (const line of bad) {
      expect(scanSource(P, line), line).toHaveLength(1);
      expect(scanSource(P, line + "\r\n"), line).toHaveLength(1);
    }
  });

  it("ignores the token inside comments only", () => {
    expect(scanSource(P, "// FLUTTERWAVE was decommissioned\n/* flutterwave */\n")).toEqual([]);
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
  // The honest notice lives in the pricing catalogue (there is no checkout at all in this build).
  const HONEST = "NO_CHECKOUT_NOTICE";
  const NOTICE = /export const NO_CHECKOUT_NOTICE = "There is no online checkout. Plans are activated by our team: contact sales to request one.";/;
  it("the notice itself states there is no online checkout and names no provider", () => {
    const catalogue = read("src/lib/commercial/pricingCatalogue.ts");
    expect(catalogue).toMatch(NOTICE);
    expect(catalogue).not.toMatch(/flutterwave/i);
  });

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
