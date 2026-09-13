/**
 * Ω∞ Ω2 Commercial Market Propagation — focused tests.
 *
 * Root cause: CheckoutUpgradeButton never accepted or forwarded ANY market
 * code to resolve_commercial_offer (display) or createCheckoutIntent
 * (checkout) — both silently fell through to the resolver's own SQL
 * DEFAULT 'GLOBAL'. That is fail-closed and harmless by itself (a
 * TZ-only sandbox offer correctly resolves NOT_AVAILABLE under GLOBAL),
 * but there was no seam through which an explicit, caller-supplied market
 * could ever be threaded — and no guarantee display and checkout would
 * stay in lockstep if one ever were supplied.
 *
 * Fix (component-level, see CheckoutUpgradeButton.test.ts): an optional,
 * default-less `marketCode` prop is threaded, byte-identical, into BOTH
 * the resolve_commercial_offer call (display) and the createCheckoutIntent
 * call (checkout). This file proves the OTHER half of that invariant: the
 * server-side contract (commercial-create-checkout Edge Function and the
 * resolve_commercial_offer SQL function it calls) treats an omitted market
 * identically to the client's own omission — neutral GLOBAL, never TZ —
 * and never derives a market from anything the browser didn't explicitly
 * send.
 *
 * NON-EXECUTABLE DB/DENO NOTICE: no live Postgres or Deno runtime exists in
 * this environment. Both source files below are plain SQL/TypeScript with
 * no Deno-only syntax blocking static analysis, so the same static-
 * source-text regression-guard technique already used throughout this
 * repository (globalCommerceModel.test.ts, webhookEvidenceModel.test.ts)
 * is used here.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const MIGRATION_PATH = path.join(
  __dirname,
  "../../../../../supabase/migrations/20260906083524_eca6c272-4a62-4468-995b-1c70e2cd67e5.sql",
);
const CHECKOUT_FN_PATH = path.join(
  __dirname,
  "../../../../../supabase/functions/commercial-create-checkout/index.ts",
);

function stripSqlComments(sql: string): string {
  return sql.replace(/--.*$/gm, "");
}
function stripTsComments(ts: string): string {
  return ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const migrationSql = stripSqlComments(fs.readFileSync(MIGRATION_PATH, "utf-8"));
const checkoutSrc = stripTsComments(fs.readFileSync(CHECKOUT_FN_PATH, "utf-8"));

describe("resolve_commercial_offer — SQL default is neutral GLOBAL, never TZ", () => {
  it("p_market_code defaults to 'GLOBAL' at the SQL signature level", () => {
    const signature = migrationSql.match(/CREATE OR REPLACE FUNCTION public\.resolve_commercial_offer\(([\s\S]*?)\)\s*RETURNS/)?.[1] ?? "";
    expect(signature).toMatch(/p_market_code\s+TEXT\s+DEFAULT\s+'GLOBAL'/);
  });

  it("no branch of the resolver defaults an unspecified market to 'TZ' or any market other than GLOBAL", () => {
    expect(migrationSql).not.toMatch(/DEFAULT\s+'TZ'/);
    expect(migrationSql).not.toMatch(/p_market_code\s+TEXT\s+DEFAULT\s+'(MU|GB|EU)'/);
  });
});

describe("commercial-create-checkout — market is server-owned GLOBAL, never browser-supplied (Ω∞ A+ audit BLOCKER fix)", () => {
  it("marketCode is a hardcoded 'GLOBAL' constant — the request body's marketCode field, if a caller sends one, is never read at all", () => {
    // CORRECTED (Codex Ω∞ A+ audit, BLOCKER): the prior revision read an
    // OPTIONAL marketCode from the request body, defaulting to GLOBAL only
    // when omitted — meaning a direct API caller COULD request a different
    // market's offer/pricing than the UI ever displays. The Marshall Plan
    // requires server-owned GLOBAL, not merely a GLOBAL default: market is
    // now a hardcoded constant, and `body.marketCode` is never referenced
    // anywhere in this file.
    expect(checkoutSrc).toMatch(/const marketCode = 'GLOBAL';/);
    expect(checkoutSrc).not.toMatch(/body\.marketCode/);
  });

  it("never defaults an omitted market to TZ or any market other than GLOBAL", () => {
    expect(checkoutSrc).not.toMatch(/:\s*'TZ'/);
    expect(checkoutSrc).not.toMatch(/:\s*'(MU|GB|EU)'/);
  });

  it("passes the hardcoded GLOBAL constant to resolve_commercial_offer unmodified — no transformation, mapping, or override, and no path by which a caller-supplied value could reach it", () => {
    const rpcCall = checkoutSrc.match(/supabase\.rpc\('resolve_commercial_offer', \{([\s\S]*?)\}\)/)?.[1] ?? "";
    expect(rpcCall).toMatch(/p_plan_code:\s*planCode/);
    expect(rpcCall).toMatch(/p_market_code:\s*marketCode/);
  });

  it("never derives market from request headers, IP, or geolocation (e.g. a CDN country header) — only the explicit body field is read", () => {
    expect(checkoutSrc).not.toMatch(/cf-ipcountry|x-country|geoip|geolocation/i);
    expect(checkoutSrc).not.toMatch(/req\.headers\.get\(['"]accept-language['"]\)/i);
  });

  it("never reads accounting jurisdiction, company_id, or any accounting-domain table to infer a commercial market", () => {
    expect(checkoutSrc).not.toMatch(/jurisdiction|companies\b|company_id/i);
  });

  it("requires no commercial_admin authority for an ordinary customer checkout", () => {
    expect(checkoutSrc).not.toMatch(/commercial_admin|is_commercial_admin/i);
  });
});

describe("DISPLAY_MARKET == CHECKOUT_MARKET — both paths call the identical resolver with the identical inputs", () => {
  it("commercial-create-checkout resolves the offer via the SAME resolve_commercial_offer() RPC the client uses for display — not a second, divergent pricing path", () => {
    expect(checkoutSrc).toMatch(/\.rpc\('resolve_commercial_offer'/);
  });

  it("commercial-create-checkout never accepts a browser-supplied amount, currency, or price — the offer resolution is the sole source of checkout economics", () => {
    const parseBlock = checkoutSrc.match(/const body = await req\.json\(\);[\s\S]*?catch \{/)?.[0] ?? "";
    expect(parseBlock).toMatch(/planCode = body\.planCode/);
    expect(parseBlock).not.toMatch(/amount|currency|price/i);
  });
});
