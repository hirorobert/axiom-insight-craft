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
    expect(new Set(messages)).toEqual(new Set(["OPEN_MONTHLY_CHECKOUT_INTENTS", "ANNUAL_TERM_REQUIRED", "INVALID_COMMERCIAL_TERM"]));
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
    expect(SQL.indexOf("OPEN_MONTHLY_CHECKOUT_INTENTS")).toBeLessThan(SQL.indexOf("UPDATE public.commercial_offers"));
    expect(SQL).not.toMatch(/commercial_platform_state/);
    expect(SQL).not.toMatch(/\bDROP\b|DELETE FROM|TRUNCATE/i);
    expect(SQL).not.toMatch(/FUNCTION public\.commit_verified_commercial_payment/);
  });

  it("the downgrade-at-purchase prerequisite is registered before any checkout activation", () => {
    const claude = fs.readFileSync(path.join(ROOT, "CLAUDE.md"), "utf8");
    expect(claude).toContain("**COMMERCIAL_DOWNGRADE_AT_RENEWAL_REQUIRED_BEFORE_CHECKOUT**");
    expect(claude).toMatch(/mandatory prerequisite before any\s+checkout activation/);
  });
});
