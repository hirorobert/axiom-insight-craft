/**
 * Static contract of 20261002100000_refuse_withheld_service_grants.sql. The behaviour is proven on real PostgreSQL by
 * scripts/db-proof/serviceWithholding.mjs (every withheld service × with/without filing jurisdiction × every entry path →
 * exactly PT422 SERVICE_NOT_AVAILABLE with nothing written; authorization first; Financial statements still granted;
 * concurrency; history byte-identical; each RPC its previous definition plus ONE line); this file keeps the contract
 * visible in the fast suite.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CUSTOMER_HIDDEN_CAPABILITIES } from "../moduleAvailability";

const ROOT = path.resolve(__dirname, "../../../..");
const MIGRATION = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261002100000_refuse_withheld_service_grants.sql"), "utf8");
const SQL = MIGRATION.replace(/--[^\n]*/g, "");
const LIST = "ARRAY['TAX_COMPUTATION', 'COMPLIANCE_REVIEW', 'FILING_PREPARATION', 'MONITORING']";
/** The body of one CREATE OR REPLACE FUNCTION in the migration. */
const fn = (name: string) => {
  const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const end = SQL.indexOf("\n$", SQL.indexOf("AS $", start) + 5);
  return SQL.slice(start, end);
};

describe("one authoritative availability boundary", () => {
  it("the ONLY list of withheld services in the database is capability_customer_available()", () => {
    expect(SQL.split(LIST).length - 1).toBe(1);
    expect(fn("capability_customer_available")).toContain(LIST);
    expect(SQL).not.toMatch(/IN \('TAX_COMPUTATION', 'COMPLIANCE_REVIEW', 'FILING_PREPARATION', 'MONITORING'\)/);
    // FINANCIAL_STATEMENTS (Prepare and Reconcile) is never withheld.
    expect(fn("capability_customer_available")).not.toMatch(/FINANCIAL_STATEMENTS/);
  });

  it("the database list and the frontend boundary (moduleAvailability.ts) name exactly the same four services", () => {
    const sqlList = [...LIST.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
    expect([...CUSTOMER_HIDDEN_CAPABILITIES].sort()).toEqual(sqlList);
  });

  it("refusal is exactly PT422 SERVICE_NOT_AVAILABLE, raised in ONE place", () => {
    const assert = fn("assert_capability_available");
    expect([...assert.matchAll(/RAISE EXCEPTION '([^']+)'/g)].map((m) => m[1])).toEqual(["SERVICE_NOT_AVAILABLE"]);
    expect([...assert.matchAll(/ERRCODE = '([^']+)'/g)].map((m) => m[1])).toEqual(["PT422"]);
    expect(SQL.split("RAISE EXCEPTION 'SERVICE_NOT_AVAILABLE'").length - 1).toBe(1);
  });

  it("every entry calls the same helper: open_engagement_with_scope, grant_engagement_capability and the trigger backstop", () => {
    expect(fn("open_engagement_with_scope")).toContain("FOREACH v_cap IN ARRAY v_caps LOOP PERFORM public.assert_capability_available(v_cap); END LOOP;");
    expect(fn("grant_engagement_capability")).toContain("PERFORM public.assert_capability_available(p_capability);");
    expect(fn("refuse_withheld_service_grant")).toMatch(/IF NEW\.action = 'GRANT' THEN\s+PERFORM public\.assert_capability_available\(NEW\.capability\);/);
    expect(SQL).toMatch(/CREATE OR REPLACE TRIGGER trg_refuse_withheld_service_grant\s+BEFORE INSERT ON public\.engagement_mandate_events\s+FOR EACH ROW/);
    expect(SQL).not.toMatch(/BEFORE (INSERT OR )?UPDATE|BEFORE DELETE/);
  });
});

describe("ordering: authorization, then availability, then everything else", () => {
  it("open_engagement_with_scope: FORBIDDEN check → availability → lock, period, engagement, grants", () => {
    const body = fn("open_engagement_with_scope");
    const at = (s: string) => body.indexOf(s);
    const avail = at("PERFORM public.assert_capability_available(v_cap)");
    expect(at("FORBIDDEN: choosing services")).toBeLessThan(avail);
    for (const later of ["pg_advisory_xact_lock", "INSERT INTO public.fiscal_periods", "INSERT INTO public.engagements", "PERFORM public.grant_engagement_capability"]) {
      expect(avail, later).toBeLessThan(at(later));
    }
  });

  it("grant_engagement_capability: write authority → availability → jurisdiction, duplicate check, insert", () => {
    const body = fn("grant_engagement_capability");
    const at = (s: string) => body.indexOf(s);
    const avail = at("PERFORM public.assert_capability_available(p_capability)");
    expect(at("assert_engagement_write_authority")).toBeLessThan(avail);
    for (const later of ["capability_needs_jurisdiction", "JURISDICTION_REQUIRED", "already part of this engagement", "INSERT INTO public.engagement_mandate_events"]) {
      expect(avail, later).toBeLessThan(at(later));
    }
  });
});

describe("safety of the migration itself", () => {
  it("is forward-only and replay-safe: every top-level statement is CREATE OR REPLACE or REVOKE; nothing is dropped or rewritten", () => {
    const topLevel = SQL.replace(/\$(function)?\$[\s\S]*?\$(function)?\$/g, "");
    expect(topLevel).not.toMatch(/\b(DROP|DELETE|TRUNCATE|UPDATE|INSERT\s+INTO|ALTER\s+TABLE)\b/i);
    for (const stmt of topLevel.split(";").map((s) => s.trim()).filter(Boolean)) expect(stmt, stmt.slice(0, 60)).toMatch(/^(CREATE OR REPLACE (FUNCTION|TRIGGER)|REVOKE ALL ON FUNCTION)/);
  });

  it("the helpers and the trigger function are revoked from every client role and pin their search_path", () => {
    for (const name of ["capability_customer_available(TEXT)", "assert_capability_available(TEXT)", "refuse_withheld_service_grant()"]) {
      expect(SQL).toContain(`REVOKE ALL ON FUNCTION public.${name} FROM PUBLIC, anon, authenticated, service_role;`);
    }
    for (const name of ["capability_customer_available", "assert_capability_available", "refuse_withheld_service_grant"]) {
      expect(fn(name)).toMatch(/SET search_path = pg_catalog, public/);
    }
  });

  it("names no customer, engagement or record, and carries no internal engine wording", () => {
    expect(MIGRATION).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(SQL).not.toMatch(/iron dome|kinga|hesabu|safisha|maono/i);
  });

  it("is proven in CI on a throwaway database", () => {
    const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toMatch(/createdb withholding_proof\n\s+node scripts\/db-proof\/serviceWithholding\.mjs/);
  });
});
