/**
 * Ω2-G Test Matrix — Global Commerce Model
 *
 * NON-EXECUTABLE DB BEHAVIOR NOTICE: this environment has no live Postgres
 * connection (same limitation as every other RLS/RPC guarantee in this
 * repository). The offer resolver, checkout-intent snapshot behavior, and
 * commit-time licence closeout all live in SQL and cannot be exercised by
 * a unit test without a real database. What CAN be proven here, and is
 * proven below, is that the migration's SOURCE TEXT actually implements
 * the required structural guarantees — the same static-source-text
 * regression-guard technique already used by featureRegistry.test.ts and
 * rlsRecursionGuard.test.ts in this repository.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const MIGRATION_PATH = path.join(
  __dirname,
  "../../../../../supabase/migrations/20260905200000_omega2_commercial_payments.sql",
);

function stripSqlComments(sql: string): string {
  return sql.replace(/--.*$/gm, "");
}

const sql = fs.readFileSync(MIGRATION_PATH, "utf-8");
const code = stripSqlComments(sql);

describe("PLAN != PRICE — commercial_plans owns no price/currency authority", () => {
  it("does not add price_amount_minor, currency_code, or is_purchasable to commercial_plans", () => {
    const alterPlansBlock = code.match(/ALTER TABLE public\.commercial_plans[\s\S]*?;/g) ?? [];
    for (const block of alterPlansBlock) {
      expect(block).not.toMatch(/price_amount_minor/);
      expect(block).not.toMatch(/ADD COLUMN[^;]*currency_code/);
      expect(block).not.toMatch(/ADD COLUMN[^;]*is_purchasable/);
    }
  });

  it("commercial_offers is the only table defining amount_minor as a pricing authority column", () => {
    expect(code).toMatch(/CREATE TABLE public\.commercial_offers[\s\S]*?amount_minor\s+BIGINT\s+NOT NULL/);
  });
});

describe("COMMERCIAL OFFER AUTHORITY — offer table structure", () => {
  it("commercial_offers has market_code, currency_code, amount_minor, currency_exponent, billing_interval", () => {
    const offerTable = code.match(/CREATE TABLE public\.commercial_offers \(([\s\S]*?)\);/)?.[1] ?? "";
    for (const column of [
      "offer_code", "plan_id", "market_code", "currency_code", "amount_minor",
      "currency_exponent", "billing_interval", "billing_interval_count",
      "effective_start", "effective_end", "is_active", "is_purchasable",
    ]) {
      expect(offerTable).toMatch(new RegExp(column));
    }
  });

  it("prevents duplicate authoritative offers via a DB constraint, not application discipline alone", () => {
    expect(code).toMatch(/CREATE UNIQUE INDEX uq_co_current_offer[\s\S]*?ON public\.commercial_offers/);
  });

  it("offers are public catalogue data (no invented prices, but real ones are not private)", () => {
    expect(code).toMatch(/CREATE POLICY "co_select_public" ON public\.commercial_offers/);
  });
});

describe("MARKET != JURISDICTION — minimal, durable, closed market vocabulary", () => {
  it("market_code is constrained to a small explicit set, not free text", () => {
    expect(code).toMatch(/chk_co_market_code CHECK \(market_code IN \('GLOBAL','TZ','MU','GB','EU'\)\)/);
  });

  it("resolve_commercial_offer has no company/accounting-jurisdiction parameter — market is independent", () => {
    const fn = code.match(/CREATE OR REPLACE FUNCTION public\.resolve_commercial_offer\(([\s\S]*?)\)\s*RETURNS/)?.[1] ?? "";
    expect(fn).not.toMatch(/company_id|reporting_framework|jurisdiction/i);
  });

  it("resolve_commercial_offer never accepts a browser-supplied amount or currency as input", () => {
    const fn = code.match(/CREATE OR REPLACE FUNCTION public\.resolve_commercial_offer\(([\s\S]*?)\)\s*RETURNS/)?.[1] ?? "";
    expect(fn).not.toMatch(/p_amount|p_currency/);
  });
});

describe("OFFER RESOLVER — explicit AVAILABLE/NOT_AVAILABLE/AMBIGUOUS/UNKNOWN, never a silent choice", () => {
  const resolverBody = code.match(/CREATE OR REPLACE FUNCTION public\.resolve_commercial_offer[\s\S]*?\n\$\$;/)?.[0] ?? "";

  it("returns UNKNOWN for an unrecognised market or plan code", () => {
    expect(resolverBody).toMatch(/'resolution','UNKNOWN'/);
  });
  it("returns NOT_AVAILABLE when zero purchasable offers match", () => {
    expect(resolverBody).toMatch(/'resolution','NOT_AVAILABLE'/);
  });
  it("returns AMBIGUOUS rather than picking arbitrarily when more than one offer matches", () => {
    expect(resolverBody).toMatch(/v_count > 1[\s\S]*?'resolution','AMBIGUOUS'/);
  });
  it("returns AVAILABLE with the resolved offer's own facts only on an unambiguous match", () => {
    expect(resolverBody).toMatch(/'resolution','AVAILABLE'/);
  });
  it("falls back to GLOBAL only after the requested market has zero matches, and marks the fallback explicitly", () => {
    expect(resolverBody).toMatch(/v_used_market := 'GLOBAL'/);
    expect(resolverBody).toMatch(/'fallback_to_global'/);
  });
});

describe("CURRENCY OFFER_SCOPED — no automatic FX conversion as commercial authority", () => {
  it("the migration contains no currency conversion / exchange-rate logic", () => {
    expect(code).not.toMatch(/exchange_rate|fx_rate|convert_currency|CONVERT\(/i);
  });
});

describe("CHECKOUT ECONOMIC SNAPSHOT — immutable at creation, never re-derived from a mutable offer", () => {
  it("payment_checkout_intents snapshots offer_id, plan_id, market_code, amount, currency, exponent, and billing interval", () => {
    const intentTable = code.match(/CREATE TABLE public\.payment_checkout_intents \(([\s\S]*?)\);/)?.[1] ?? "";
    for (const column of [
      "commercial_offer_id", "plan_id", "market_code", "expected_amount_minor",
      "currency_code", "currency_exponent", "billing_interval", "billing_interval_count",
    ]) {
      expect(intentTable).toMatch(new RegExp(column));
    }
  });

  it("commit_verified_commercial_payment validates against the INTENT's own snapshot, never re-reading commercial_offers", () => {
    const commitFn = code.match(/CREATE OR REPLACE FUNCTION public\.commit_verified_commercial_payment[\s\S]*?\n\$\$;/)?.[0] ?? "";
    expect(commitFn).not.toMatch(/FROM public\.commercial_offers/);
    expect(commitFn).toMatch(/v_intent\.expected_amount_minor/);
    expect(commitFn).toMatch(/v_intent\.currency_code/);
  });
});

describe("BLOCKER DEFECT REPAIRS — money/licence/audit authority", () => {
  it("billing_audit_events is written with the real Ω1 columns (action/previous_state/new_state/reason), not the nonexistent (event_type/metadata) pair", () => {
    const auditInserts = code.match(/INSERT INTO public\.billing_audit_events \(([\s\S]*?)\)/g) ?? [];
    expect(auditInserts.length).toBeGreaterThan(0);
    for (const insert of auditInserts) {
      expect(insert).toMatch(/\baction\b/);
      expect(insert).not.toMatch(/event_type/);
      expect(insert).not.toMatch(/\bmetadata\b/);
    }
  });

  it("commercial_licences INSERT always supplies a non-null source value", () => {
    const licenceInsert = code.match(/INSERT INTO public\.commercial_licences \(([\s\S]*?)\)\s*\n\s*VALUES \(([\s\S]*?)\)/)?.[0] ?? "";
    expect(licenceInsert).toMatch(/\bsource\b/);
    expect(licenceInsert).toMatch(/_VERIFIED_PAYMENT/);
  });

  it("commit_verified_commercial_payment closes out any existing ACTIVE/GRACE licence before inserting a new one, regardless of plan", () => {
    const commitFn = code.match(/CREATE OR REPLACE FUNCTION public\.commit_verified_commercial_payment[\s\S]*?\n\$\$;/)?.[0] ?? "";
    // The closeout lookup must not filter by plan_id — the pre-Ω2-G bug
    // only matched the SAME plan, missing the FREE-to-PAID upgrade path.
    const lookup = commitFn.match(/SELECT \* INTO v_current_lic FROM public\.commercial_licences\s+WHERE([\s\S]*?)LIMIT 1;/)?.[1] ?? "";
    expect(lookup).not.toMatch(/plan_id = v_intent\.plan_id/);
    expect(commitFn).toMatch(/UPDATE public\.commercial_licences\s+SET effective_end = v_period_start/);
  });
});

describe("get_checkout_status — field-name contract matches the client (status, not intent_status)", () => {
  it("returns a top-level 'status' key so PaymentReturn.tsx's data.status check actually works", () => {
    const fn = code.match(/CREATE OR REPLACE FUNCTION public\.get_checkout_status[\s\S]*?\n\$\$;/)?.[0] ?? "";
    expect(fn).toMatch(/'status',v_intent\.status/);
  });

  it("returns effective_start/effective_end so the return page can display a real licence period", () => {
    const fn = code.match(/CREATE OR REPLACE FUNCTION public\.get_checkout_status[\s\S]*?\n\$\$;/)?.[0] ?? "";
    expect(fn).toMatch(/'effective_end',v_billing\.effective_end/);
  });
});

describe("SETTLEMENT ORTHOGONAL — no settlement column anywhere in payment/licence/entitlement authority", () => {
  it("payment_events has no settlement-destination column", () => {
    const alterPaymentEvents = code.match(/ALTER TABLE public\.payment_events[\s\S]*?;/g) ?? [];
    for (const block of alterPaymentEvents) {
      expect(block).not.toMatch(/settlement/i);
    }
  });

  it("commercial_licences is never altered by this migration (no settlement column added there either)", () => {
    expect(code).not.toMatch(/ALTER TABLE public\.commercial_licences\s+ADD COLUMN/);
  });

  it("no personal account (Payoneer, CRDB, or otherwise) is referenced anywhere", () => {
    expect(code).not.toMatch(/payoneer|crdb/i);
  });
});

describe("GLOBAL — no Tanzania-default assumption baked into core commercial identity", () => {
  it("no column in this migration defaults currency to TZS", () => {
    expect(code).not.toMatch(/DEFAULT 'TZS'/);
  });

  it("payment_checkout_intents no longer defaults provider to FLUTTERWAVE or currency to TZS (both are resolved facts, not defaults)", () => {
    const intentTable = code.match(/CREATE TABLE public\.payment_checkout_intents \(([\s\S]*?)\);/)?.[1] ?? "";
    expect(intentTable).not.toMatch(/provider\s+TEXT\s+NOT NULL\s+DEFAULT 'FLUTTERWAVE'/);
    expect(intentTable).not.toMatch(/currency_code\s+TEXT\s+NOT NULL\s+DEFAULT 'TZS'/);
  });

  it("TZ and MU are both ordinary entries in the same market vocabulary — neither is privileged", () => {
    const marketList = code.match(/market_code IN \(([^)]+)\)/)?.[1] ?? "";
    expect(marketList).toContain("'TZ'");
    expect(marketList).toContain("'MU'");
    expect(marketList).toContain("'GLOBAL'");
  });

  it("GB and EU markets already exist in the vocabulary — a future UK/GBP offer needs zero schema change", () => {
    const marketList = code.match(/market_code IN \(([^)]+)\)/)?.[1] ?? "";
    expect(marketList).toContain("'GB'");
    expect(marketList).toContain("'EU'");
  });
});

describe("ADMIN OFFER MANAGEMENT — server-authoritative, admin-only, auditable", () => {
  it("admin_upsert_commercial_offer requires commercial-admin authority and a reason", () => {
    const fn = code.match(/CREATE OR REPLACE FUNCTION public\.admin_upsert_commercial_offer[\s\S]*?\n\$\$;/)?.[0] ?? "";
    expect(fn).toMatch(/is_commercial_admin\(\)/);
    expect(fn).toMatch(/REASON_REQUIRED/);
  });

  it("offer changes are recorded in an immutable catalog audit table", () => {
    expect(code).toMatch(/CREATE TABLE public\.commercial_catalog_audit_events/);
    expect(code).toMatch(/CREATE TRIGGER trg_ccae_immutable/);
  });

  it("admin_upsert_commercial_offer never grants accounting authority (no accounting table referenced)", () => {
    const fn = code.match(/CREATE OR REPLACE FUNCTION public\.admin_upsert_commercial_offer[\s\S]*?\n\$\$;/)?.[0] ?? "";
    expect(fn).not.toMatch(/tax_computations|account_mappings|trial_balance_uploads|engine_runs/);
  });
});

describe("STRIPE-READINESS — adding a provider needs no core table change", () => {
  it("no core table (offers, plans, checkout intents, payment_events, licences) references Flutterwave by name outside the provider CHECK enum", () => {
    const coreTables = code.match(/CREATE TABLE public\.(commercial_offers|payment_checkout_intents)[\s\S]*?\);/g) ?? [];
    for (const table of coreTables) {
      const nonEnumMentions = table.replace(/CONSTRAINT chk_\w+ CHECK \([^)]*\)/g, "");
      expect(nonEnumMentions).not.toMatch(/FLUTTERWAVE/);
    }
  });

  it("the provider CHECK enum already includes STRIPE, so routing a Stripe transaction needs no migration", () => {
    expect(code).toMatch(/provider IN \(\s*'FLUTTERWAVE','PESAPAL','SELCOM','DPO','STRIPE'\s*\)/);
  });
});
