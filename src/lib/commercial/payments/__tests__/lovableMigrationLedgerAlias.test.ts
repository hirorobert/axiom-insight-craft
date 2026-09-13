import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "../../../../../");
const aliasPath = path.join(
  ROOT,
  "supabase/migrations/20260913054040_56b232d3-6503-4586-8166-151c46a08f0e.sql",
);
const source = fs.readFileSync(aliasPath, "utf8");
const executable = source.replace(/--.*$/gm, "");

describe("Lovable Ω3.0 managed-version ledger alias", () => {
  it("preserves immutable provenance for both the original duplicate and canonical prerequisite", () => {
    expect(source).toContain(
      "f9b20aebec427be664e7249cf420b1ec0957f40d8ae98d6346b9ae20316ba11b",
    );
    expect(source).toContain(
      "3ad41a7cf2280843d49176b20976395b5cff5bdb10f6abe14b734431cb9f11c7",
    );
  });

  it("contains assertions only and no executable schema, privilege, or row mutation", () => {
    expect(executable).not.toMatch(
      /\b(?:CREATE|REPLACE|ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE|MERGE|GRANT|REVOKE|COMMENT)\b/i,
    );
    expect(executable).not.toMatch(/\bEXECUTE\b\s+(?:format\s*\(|[^;]+)/i);
    expect(executable).toMatch(/SET search_path TO public, pg_catalog;/);
    expect(executable).toMatch(/DO \$omega3_ledger_alias\$/);
  });

  it("fails closed over every canonical Ω3.0 structural boundary", () => {
    for (const required of [
      "commercial_currencies",
      "commercial_platform_state",
      "commercial_offers",
      "effective_range",
      "effective_history_protected",
      "request_fingerprint",
      "excl_co_no_overlapping_purchasable_periods",
      "chk_ccae_entity_type",
      "uq_co_current_offer",
      "trg_commercial_offers_effective_history_ratchet",
      "trg_commercial_offers_economic_integrity",
      "admin_supersede_commercial_offer",
      "admin_transition_platform_state",
      "cc_select_public",
      "cps_select_admin_only",
    ]) {
      expect(executable).toContain(required);
    }
  });

  it("asserts function hardening, currency authority, and the platform singleton without changing them", () => {
    expect(executable).toContain("p.prosecdef");
    expect(executable).toContain("search_path=public, pg_catalog");
    expect(executable).toContain("has_function_privilege('anon'");
    expect(executable).toContain("has_function_privilege('authenticated'");
    for (const currency of ["TZS", "USD", "KES", "GBP", "EUR"]) {
      expect(executable).toContain(`('${currency}',`);
    }
    expect(executable).toMatch(/WHERE id = true[\s\S]*state IN/);
    expect(executable).toMatch(/IF v_count <> 1 THEN/);
  });
});
