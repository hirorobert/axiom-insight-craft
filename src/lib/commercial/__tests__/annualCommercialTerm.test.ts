/**
 * Static contract of the 12-month commercial term migration (20261001120000). The behaviour is proven on real
 * PostgreSQL by scripts/db-proof/annualTerm.mjs; this file keeps the contract visible in the fast suite.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../..");
const MIGRATION = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261001120000_annual_commercial_term.sql"), "utf8");
const SQL = MIGRATION.replace(/--[^\n]*/g, "");

describe("annual commercial term migration", () => {
  it("raises only controlled application errors: SQLSTATE PT422 with a fixed code, never internal wording", () => {
    const messages = [...SQL.matchAll(/RAISE EXCEPTION '([^']+)'/g)].map((m) => m[1]);
    expect(new Set(messages)).toEqual(new Set(["INVALID_OPEN_CHECKOUT_INTENTS", "UNRECONCILED_PROVIDER_CHECKOUTS", "ANNUAL_TERM_REQUIRED", "INVALID_COMMERCIAL_TERM", "CANCELLED_LICENCE_IMMUTABLE"]));
    expect([...SQL.matchAll(/ERRCODE = '([^']+)'/g)].map((m) => m[1]).every((c) => c === "PT422")).toBe(true);
    expect(SQL).not.toMatch(/iron dome/i);
  });

  it("introduces no renewal state (there is no automatic renewal system to represent)", () => {
    expect(SQL).not.toMatch(/renewal/i);
    expect(SQL).not.toMatch(/ADD COLUMN/i);
  });

  it("guards INSERT and UPDATE of exactly the term-defining columns, inside the CFOCLOSE product boundary", () => {
    expect(SQL).toContain("BEFORE INSERT OR UPDATE OF plan_id, billing_interval, billing_interval_count ON public.payment_checkout_intents");
    expect(SQL).toContain("BEFORE INSERT OR UPDATE OF plan_id, source, effective_start, effective_end ON public.commercial_licences");
    expect(SQL).toMatch(/p\.code = 'CFOCLOSE' AND cp\.code IN \('SOLO', 'PRACTICE', 'FIRM'\)/);
    expect(SQL).toContain("NEW.effective_end <> NEW.effective_start + interval '12 months'");
  });

  it("opens with the zero-state gate, never touches platform payment state, and rewrites no applied migration", () => {
    expect(SQL.indexOf("INVALID_OPEN_CHECKOUT_INTENTS")).toBeLessThan(SQL.indexOf("UPDATE public.commercial_offers"));
    // The gate counts every invalid shape in every status that is not terminal (the terminal set is named; any other
    // status — including one added later — counts as fulfillable). The committable set is derived and proven by
    // scripts/db-proof/annualTerm.mjs.
    expect(SQL).toContain("AND (i.billing_interval IS DISTINCT FROM 'ANNUAL' OR i.billing_interval_count IS DISTINCT FROM 1)");
    expect(SQL).toContain("AND i.status NOT IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED')");
    // Both zero-state conditions are enforced by the migration itself, before any mutation; reconciliation is an exact
    // predicate (never "some payment event exists").
    expect(SQL.indexOf("UNRECONCILED_PROVIDER_CHECKOUTS")).toBeLessThan(SQL.indexOf("UPDATE public.commercial_offers"));
    expect(SQL).toContain("e.verification_method IN ('PROVIDER_API_VERIFY', 'MANUAL_ADMIN')");
    expect(SQL).toContain("e.normalized_status IN ('CANCELLED', 'EXPIRED', 'REFUNDED')");
    expect(SQL).toContain("nullif(btrim(e.payload_hash), '') IS NOT NULL");
    expect(SQL).not.toMatch(/commercial_platform_state/);
    expect(SQL).not.toMatch(/\bDROP\b|DELETE FROM|TRUNCATE/i);
    expect(SQL).not.toMatch(/FUNCTION public\.commit_verified_commercial_payment/);
  });

  it("the preflight never advises fulfilling an invalid checkout, and mirrors the migration's two conditions", () => {
    const pre = fs.readFileSync(path.join(ROOT, "scripts/db-preflight/annualTermPreflight.sql"), "utf8");
    expect(pre).toMatch(/An invalid checkout is NEVER fulfilled/);
    expect(pre).not.toMatch(/commit it through the normal verified-payment path/i);
    expect(pre).toContain("invalid_fulfillable_intents");
    expect(pre).toContain("unreconciled_provider_checkouts");
  });

  it("admin_cancel_future_licence: commercial-admin boundary only, cancels nothing by itself, names no customer or licence", () => {
    expect(SQL).toContain("REVOKE ALL ON FUNCTION public.admin_cancel_future_licence(UUID, TEXT, UUID) FROM PUBLIC, anon, service_role;");
    expect(SQL).toContain("GRANT EXECUTE ON FUNCTION public.admin_cancel_future_licence(UUID, TEXT, UUID) TO authenticated;");
    expect(SQL).toContain("FROM public.commercial_admins WHERE user_id = v_actor AND active");
    expect(SQL).toMatch(/WHERE l\.id = p_licence_id\s+FOR UPDATE/);
    expect(SQL).toContain("v_lic.effective_start <= transaction_timestamp()");
    // The only call sites are its own definition and grants: the migration cancels no licence.
    expect(SQL.split("admin_cancel_future_licence(").length - 1).toBe(3);
    // No UUID literal (customer, licence or checkout identifier) anywhere in the migration.
    expect(MIGRATION).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("the downgrade-at-purchase prerequisite is registered before any checkout activation", () => {
    const claude = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
    expect(claude).toContain("**COMMERCIAL_DOWNGRADE_AT_RENEWAL_REQUIRED_BEFORE_CHECKOUT**");
    expect(claude).toMatch(/mandatory prerequisite before any\s+checkout activation/);
  });
});
