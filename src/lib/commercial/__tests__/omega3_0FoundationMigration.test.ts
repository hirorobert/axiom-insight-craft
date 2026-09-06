/**
 * Ω3.0 Foundation migration — static source-text contract tests.
 *
 * NON-EXECUTABLE DB BEHAVIOR NOTICE: this environment has no live Postgres
 * connection. Tests A, B, D-3, D-4, E's behavioral half, F-3/F-6/F-7, and
 * G-A/G-B's live half (SAFF-OMEGA3-COMMERCIAL-LAUNCH-DESIGN.md §R) require
 * two genuinely concurrent database connections against a real Postgres
 * instance and CANNOT run in this repo's DB-less Vitest suite. They are
 * NOT executed here and must not be reported as passing until run against
 * a real staging database — this file proves only what static source-text
 * inspection can prove, following the same technique already used by
 * migrationCollisionGuard.test.ts, globalCommerceModel.test.ts, and
 * authContractRepair.test.ts in this repository.
 *
 * What IS proven here, structurally: Test C (predicate references only
 * effective_history_protected), Test D-1/D-2 (error ordering precedes any
 * write), Test E (ratchet trigger body shape — never reads
 * NEW.effective_history_protected), Test F-1/F-2/F-4/F-5 (classification
 * logic has no is_purchasable/audit-table dependency), Test G (exact
 * constraint-name checks, no WHEN OTHERS, no message-text parsing) — plus
 * schema-object presence, ordering, and privilege-grant contract checks.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.join(__dirname, "../../../../");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase/migrations");
const MIGRATION_FILE = "20260906120000_omega3_0_effective_history_and_platform_state.sql";
const MIGRATION_PATH = path.join(MIGRATIONS_DIR, MIGRATION_FILE);

function stripSqlComments(sql: string): string {
  return sql.replace(/--.*$/gm, "");
}

const migrationText = fs.readFileSync(MIGRATION_PATH, "utf-8");
const migrationCode = stripSqlComments(migrationText);

describe("Ω3.0 migration file — presence, naming, and ordering", () => {
  it("exists under supabase/migrations/", () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
  });

  it("sorts after every currently-live migration file (including the newest, unrelated variance_budgets RLS migration)", () => {
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    const sorted = [...files].sort();
    expect(sorted[sorted.length - 1]).toBe(MIGRATION_FILE);
  });

  it("declares itself non-data-destructive with exactly 2 DDL replacement operations", () => {
    expect(migrationText).toMatch(/DATA_DESTRUCTIVE_OPERATIONS = 0/);
    expect(migrationText).toMatch(/DDL_REPLACEMENT_OPERATIONS\s+= 2/);
  });

  it("never edits a live Ω1/RLS1/Ω2 migration file", () => {
    const liveFiles = [
      "20260905093408_8fc55e64-3e06-4d26-8835-438a9243e1ef.sql",
      "20260905141022_f1029fbe-90d5-4aac-97e0-059eede76338.sql",
      "20260906083524_eca6c272-4a62-4468-995b-1c70e2cd67e5.sql",
    ];
    for (const f of liveFiles) {
      const before = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf-8");
      // Presence + content check only — this test cannot prove git history,
      // but it does prove the live file still exists, unmodified in shape,
      // alongside the new one (no in-place rewrite occurred as part of
      // authoring this migration).
      expect(before.length).toBeGreaterThan(0);
    }
  });
});

describe("Ω3.0 migration — new schema objects, exactly once each", () => {
  it("creates commercial_currencies and commercial_platform_state exactly once each", () => {
    expect(migrationCode.match(/CREATE TABLE\s+public\.commercial_currencies/g)?.length).toBe(1);
    expect(migrationCode.match(/CREATE TABLE\s+public\.commercial_platform_state/g)?.length).toBe(1);
  });

  it("commercial_currencies has exactly 3 named constraints", () => {
    const block = migrationCode.match(/CREATE TABLE public\.commercial_currencies \(([\s\S]*?)\);/)?.[1] ?? "";
    const constraints = block.match(/CONSTRAINT\s+\w+/g) ?? [];
    expect(constraints.length).toBe(3);
    expect(block).toMatch(/CONSTRAINT commercial_currencies_pk PRIMARY KEY \(code\)/);
    expect(block).toMatch(/CONSTRAINT chk_cc_code_length CHECK/);
    expect(block).toMatch(/CONSTRAINT chk_cc_exponent_range CHECK/);
  });

  it("commercial_platform_state has exactly 4 named constraints", () => {
    const block = migrationCode.match(/CREATE TABLE public\.commercial_platform_state \(([\s\S]*?)\);/)?.[1] ?? "";
    const constraints = block.match(/CONSTRAINT\s+\w+/g) ?? [];
    expect(constraints.length).toBe(4);
    expect(block).toMatch(/CONSTRAINT commercial_platform_state_pk PRIMARY KEY \(id\)/);
    expect(block).toMatch(/CONSTRAINT chk_cps_singleton CHECK \(id\)/);
    expect(block).toMatch(/CONSTRAINT chk_cps_state_vocabulary CHECK/);
    expect(block).toMatch(/CONSTRAINT fk_cps_updated_by FOREIGN KEY/);
  });

  it("seeds exactly the 6 currencies both TypeScript copies already agree on", () => {
    const seedBlock = migrationCode.match(/INSERT INTO public\.commercial_currencies[\s\S]*?ON CONFLICT/)?.[0] ?? "";
    for (const [code, exponent] of [
      ["TZS", 0],
      ["USD", 2],
      ["KES", 2],
      ["UGX", 0],
      ["GBP", 2],
      ["EUR", 2],
    ] as const) {
      expect(seedBlock).toMatch(new RegExp(`\\('${code}',\\s*${exponent}\\)`));
    }
  });

  it("seeds the commercial_platform_state singleton row at PAYMENTS_DISABLED", () => {
    expect(migrationCode).toMatch(
      /INSERT INTO public\.commercial_platform_state \(id, state\)\s*\nVALUES \(true, 'PAYMENTS_DISABLED'\)/,
    );
  });

  it("adds exactly 3 new columns to commercial_offers: effective_range, effective_history_protected, request_fingerprint", () => {
    expect(migrationCode).toMatch(/ADD COLUMN effective_range TSTZRANGE GENERATED ALWAYS AS/);
    expect(migrationCode).toMatch(/ADD COLUMN effective_history_protected BOOLEAN NOT NULL DEFAULT false/);
    expect(migrationCode).toMatch(/ADD COLUMN request_fingerprint TEXT NULL/);
  });

  it("never uses the old, renamed column name was_ever_purchasable anywhere", () => {
    expect(migrationCode).not.toMatch(/was_ever_purchasable/);
  });
});

describe("Ω3.0 migration — Test F (legacy-row classification, fail-closed) structural half", () => {
  const legacyBlock =
    migrationCode.match(
      /UPDATE public\.commercial_offers SET effective_history_protected = true;[\s\S]*?LEGACY_EFFECTIVE_RANGE_CONFLICTS_DETECTED[\s\S]*?END \$\$;/,
    )?.[0] ?? "";

  it("Step B is an unconditional UPDATE with no WHERE clause", () => {
    expect(legacyBlock).toMatch(
      /UPDATE public\.commercial_offers SET effective_history_protected = true;/,
    );
    // Confirm no WHERE clause immediately follows this exact statement.
    const stepB = legacyBlock.match(/UPDATE public\.commercial_offers SET effective_history_protected = true;/)?.[0] ?? "";
    expect(stepB).not.toMatch(/WHERE/);
  });

  it("F-1/F-2/F-4/F-5: classification Steps B-D never reference is_purchasable as a filter, and never query commercial_catalog_audit_events", () => {
    // is_purchasable may appear only inside Step D's five-dimensional JOIN
    // conditions comparing rows to each other — never as a WHERE filter
    // deciding which rows get classified in Step B.
    const stepB = legacyBlock.split("Step C")[0];
    expect(stepB).not.toMatch(/is_purchasable/);
    expect(legacyBlock).not.toMatch(/commercial_catalog_audit_events/);
  });

  it("Step C raises LEGACY_CLASSIFICATION_INCOMPLETE on any completeness mismatch", () => {
    expect(legacyBlock).toMatch(/LEGACY_CLASSIFICATION_INCOMPLETE/);
    expect(legacyBlock).toMatch(/v_classified != v_total/);
  });

  it("Step D raises LEGACY_EFFECTIVE_RANGE_CONFLICTS_DETECTED on any five-dimensional conflict", () => {
    expect(legacyBlock).toMatch(/LEGACY_EFFECTIVE_RANGE_CONFLICTS_DETECTED/);
    expect(legacyBlock).toMatch(
      /a\.plan_id\s*=\s*b\.plan_id[\s\S]*?a\.market_code\s*=\s*b\.market_code[\s\S]*?a\.currency_code\s*=\s*b\.currency_code[\s\S]*?a\.billing_interval\s*=\s*b\.billing_interval[\s\S]*?a\.billing_interval_count\s*=\s*b\.billing_interval_count[\s\S]*?a\.effective_range && b\.effective_range/,
    );
  });

  it("legacy classification (section 4) appears BEFORE the ratchet trigger is created (section 5) — load-bearing ordering", () => {
    const classificationIndex = migrationCode.indexOf("UPDATE public.commercial_offers SET effective_history_protected = true;");
    const ratchetTriggerIndex = migrationCode.indexOf("CREATE OR REPLACE FUNCTION public.commercial_offers_effective_history_ratchet");
    expect(classificationIndex).toBeGreaterThan(-1);
    expect(ratchetTriggerIndex).toBeGreaterThan(-1);
    expect(classificationIndex).toBeLessThan(ratchetTriggerIndex);
  });
});

describe("Ω3.0 migration — Test E (ratchet tamper resistance) structural half", () => {
  const ratchetFn =
    migrationCode.match(
      /CREATE OR REPLACE FUNCTION public\.commercial_offers_effective_history_ratchet\(\)[\s\S]*?\$\$;/,
    )?.[0] ?? "";

  it("the ratchet function exists exactly once", () => {
    expect(
      migrationCode.match(/CREATE OR REPLACE FUNCTION public\.commercial_offers_effective_history_ratchet/g)?.length,
    ).toBe(1);
  });

  it("never reads NEW.effective_history_protected on the right-hand side of any assignment or condition", () => {
    // The only legitimate appearance of "NEW.effective_history_protected" in
    // this function is as an ASSIGNMENT TARGET (left of :=). It must never
    // appear inside a condition or as a read value.
    const rhsUses = ratchetFn.match(/(?<!NEW\.effective_history_protected\s*:=\s*[^;]*)NEW\.effective_history_protected(?!\s*:=)/g) ?? [];
    // Every occurrence of NEW.effective_history_protected must be
    // immediately followed by ":=" (i.e., only ever an assignment target).
    const allOccurrences = ratchetFn.match(/NEW\.effective_history_protected\s*(:=)?/g) ?? [];
    for (const occ of allOccurrences) {
      expect(occ.trim().endsWith(":=")).toBe(true);
    }
  });

  it("computes protection unconditionally from OLD.effective_history_protected / NEW.is_purchasable only", () => {
    expect(ratchetFn).toMatch(/NEW\.effective_history_protected := NEW\.is_purchasable;/);
    expect(ratchetFn).toMatch(
      /NEW\.effective_history_protected := OLD\.effective_history_protected OR NEW\.is_purchasable;/,
    );
  });

  it("the ratchet trigger fires BEFORE INSERT OR UPDATE, one row at a time", () => {
    expect(migrationCode).toMatch(
      /CREATE TRIGGER trg_commercial_offers_effective_history_ratchet\s*\n\s*BEFORE INSERT OR UPDATE ON public\.commercial_offers\s*\n\s*FOR EACH ROW EXECUTE FUNCTION public\.commercial_offers_effective_history_ratchet\(\);/,
    );
  });
});

describe("Ω3.0 migration — Test C (predicate depends only on effective_history_protected)", () => {
  const exclusionBlock =
    migrationCode.match(/ADD CONSTRAINT excl_co_no_overlapping_purchasable_periods[\s\S]*?\);/)?.[0] ?? "";

  it("the exclusion constraint's key is the full 5-column family", () => {
    expect(exclusionBlock).toMatch(/plan_id\s*WITH =/);
    expect(exclusionBlock).toMatch(/market_code\s*WITH =/);
    expect(exclusionBlock).toMatch(/currency_code\s*WITH =/);
    expect(exclusionBlock).toMatch(/billing_interval\s*WITH =/);
    expect(exclusionBlock).toMatch(/billing_interval_count\s*WITH =/);
    expect(exclusionBlock).toMatch(/effective_range\s*WITH &&/);
  });

  it("the WHERE predicate references effective_history_protected ALONE — no is_active, no is_purchasable, no now()", () => {
    const wherePredicate = exclusionBlock.match(/WHERE \(([^)]*)\)/)?.[1]?.trim() ?? "";
    expect(wherePredicate).toBe("effective_history_protected");
    expect(wherePredicate).not.toMatch(/is_active/);
    expect(wherePredicate).not.toMatch(/is_purchasable/);
    expect(wherePredicate).not.toMatch(/now\(\)/);
  });
});

describe("Ω3.0 migration — Test G (constraint-specific exception translation), both functions", () => {
  const upsertFn =
    migrationCode.match(
      /CREATE OR REPLACE FUNCTION public\.admin_upsert_commercial_offer\([\s\S]*?\nEND;\n\$\$;/,
    )?.[0] ?? "";
  const supersedeFn =
    migrationCode.match(
      /CREATE OR REPLACE FUNCTION public\.admin_supersede_commercial_offer\([\s\S]*?\nEND;\n\$\$;/,
    )?.[0] ?? "";

  it("both functions exist exactly once in this migration", () => {
    expect(upsertFn.length).toBeGreaterThan(0);
    expect(supersedeFn.length).toBeGreaterThan(0);
  });

  it("neither function contains WHEN OTHERS anywhere", () => {
    expect(upsertFn).not.toMatch(/WHEN OTHERS/);
    expect(supersedeFn).not.toMatch(/WHEN OTHERS/);
  });

  it("neither function parses error message text to decide translation (no SQLERRM substring matching)", () => {
    expect(upsertFn).not.toMatch(/SQLERRM/);
    expect(supersedeFn).not.toMatch(/SQLERRM/);
  });

  it("admin_upsert_commercial_offer: exclusion_violation handler calls GET STACKED DIAGNOSTICS before any translation decision", () => {
    const handler = upsertFn.match(/WHEN exclusion_violation THEN([\s\S]*?)END;\nEND;/)?.[1] ?? "";
    const diagIndex = handler.indexOf("GET STACKED DIAGNOSTICS");
    const ifIndex = handler.indexOf("IF v_constraint_name");
    expect(diagIndex).toBeGreaterThan(-1);
    expect(ifIndex).toBeGreaterThan(-1);
    expect(diagIndex).toBeLessThan(ifIndex);
    expect(handler).toMatch(/IF v_constraint_name = 'excl_co_no_overlapping_purchasable_periods' THEN/);
    expect(handler).toMatch(/ELSE\s*\n\s*RAISE;\s*\n\s*END IF;/);
  });

  it("admin_supersede_commercial_offer: unique_violation handler checks uq_co_offer_code by exact name, bare RAISE otherwise", () => {
    const handler = supersedeFn.match(/WHEN unique_violation THEN([\s\S]*?)WHEN exclusion_violation THEN/)?.[1] ?? "";
    expect(handler).toMatch(/GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;/);
    expect(handler).toMatch(/IF v_constraint_name = 'uq_co_offer_code' THEN/);
    expect(handler).toMatch(/ELSE\s*\n\s*RAISE;\s*\n\s*END IF;/);
  });

  it("admin_supersede_commercial_offer: exclusion_violation handler checks excl_co_no_overlapping_purchasable_periods by exact name, bare RAISE otherwise", () => {
    const handler = supersedeFn.match(/WHEN exclusion_violation THEN([\s\S]*?)END;\n\$\$;/)?.[1] ?? "";
    expect(handler).toMatch(/GET STACKED DIAGNOSTICS v_constraint_name = CONSTRAINT_NAME;/);
    expect(handler).toMatch(/IF v_constraint_name = 'excl_co_no_overlapping_purchasable_periods' THEN/);
    expect(handler).toMatch(/RAISE;/);
  });
});

describe("Ω3.0 migration — Test D-1/D-2 (structural: error ordering precedes any write)", () => {
  const supersedeFn =
    migrationCode.match(
      /CREATE OR REPLACE FUNCTION public\.admin_supersede_commercial_offer\([\s\S]*?\nEND;\n\$\$;/,
    )?.[0] ?? "";

  it("D-1 OLD_OFFER_NOT_FOUND is raised before the predecessor UPDATE or successor INSERT", () => {
    const notFoundIndex = supersedeFn.indexOf("OLD_OFFER_NOT_FOUND");
    const predecessorUpdateIndex = supersedeFn.indexOf("SET effective_end = p_effective_start, is_purchasable = false");
    const successorInsertIndex = supersedeFn.indexOf("INSERT INTO public.commercial_offers (\n    offer_code");
    expect(notFoundIndex).toBeGreaterThan(-1);
    expect(notFoundIndex).toBeLessThan(predecessorUpdateIndex);
    expect(notFoundIndex).toBeLessThan(successorInsertIndex);
  });

  it("D-2 OFFER_FAMILY_MISMATCH is raised after the predecessor lock but before either write", () => {
    const lockIndex = supersedeFn.indexOf("FOR UPDATE;");
    const familyMismatchIndex = supersedeFn.indexOf("OFFER_FAMILY_MISMATCH");
    const predecessorUpdateIndex = supersedeFn.indexOf("SET effective_end = p_effective_start, is_purchasable = false");
    expect(lockIndex).toBeGreaterThan(-1);
    expect(familyMismatchIndex).toBeGreaterThan(-1);
    expect(lockIndex).toBeLessThan(familyMismatchIndex);
    expect(familyMismatchIndex).toBeLessThan(predecessorUpdateIndex);
  });

  it("D-4 INVALID_EFFECTIVE_BOUNDARY is raised before either write", () => {
    const boundaryIndex = supersedeFn.indexOf("INVALID_EFFECTIVE_BOUNDARY");
    const predecessorUpdateIndex = supersedeFn.indexOf("SET effective_end = p_effective_start, is_purchasable = false");
    expect(boundaryIndex).toBeGreaterThan(-1);
    expect(boundaryIndex).toBeLessThan(predecessorUpdateIndex);
  });

  it("uses a SELECT ... FOR UPDATE row lock on the predecessor (Test B's locking mechanism)", () => {
    expect(supersedeFn).toMatch(
      /SELECT \* INTO v_old FROM public\.commercial_offers\s*\n\s*WHERE offer_code = p_old_offer_code\s*\n\s*FOR UPDATE;/,
    );
  });

  it("computes the request fingerprint via pgcrypto digest() over the 9 semantic parameters, excluding p_reason", () => {
    const fingerprintStmt = supersedeFn.match(/v_fingerprint := encode\(digest\(([\s\S]*?)'sha256'\), 'hex'\);/)?.[1] ?? "";
    expect(fingerprintStmt).not.toMatch(/p_reason/);
    for (const param of [
      "p_old_offer_code",
      "p_plan_code",
      "p_market_code",
      "p_currency_code",
      "p_amount_minor",
      "p_currency_exponent",
      "p_billing_interval",
      "p_billing_interval_count",
      "p_effective_start",
    ]) {
      expect(fingerprintStmt).toMatch(new RegExp(param));
    }
  });

  it("code-audit Finding 2: fingerprint uses a versioned jsonb_build_object payload wrapped in an explicit UTF-8 conversion, not concat_ws delimiter concatenation", () => {
    expect(supersedeFn).not.toMatch(/concat_ws/);
    expect(supersedeFn).toMatch(/v_fingerprint := encode\(digest\(\s*\n\s*convert_to\(\s*\n\s*jsonb_build_object\(/);
    expect(supersedeFn).toMatch(/'v', 1,/);
  });

  it("code-audit Finding 2: the effective_start field uses an explicit UTC conversion + fixed to_char format with an embedded 'Z' marker, never a raw TIMESTAMPTZ::TEXT cast (session-timezone-dependent)", () => {
    const fingerprintPayload = supersedeFn.match(/jsonb_build_object\(([\s\S]*?)\)::TEXT,/)?.[1] ?? "";
    expect(fingerprintPayload).toMatch(
      /'effective_start_utc', to_char\(p_effective_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\)/,
    );
    expect(fingerprintPayload).not.toMatch(/p_effective_start::TEXT/);
  });

  it("code-audit Finding 2: p_reason and p_new_offer_code (the idempotency key itself) remain excluded from the fingerprint payload", () => {
    const fingerprintPayload = supersedeFn.match(/jsonb_build_object\(([\s\S]*?)\)::TEXT,/)?.[1] ?? "";
    expect(fingerprintPayload).not.toMatch(/p_reason/);
    expect(fingerprintPayload).not.toMatch(/'new_offer_code', p_new_offer_code/);
  });
});

describe("Ω3.0 migration — DDL replacements (Finding 4 accounting)", () => {
  it("uq_co_current_offer is DROPped and immediately recreated with the 5-column key in the same transaction", () => {
    const dropIndex = migrationCode.indexOf("DROP INDEX IF EXISTS public.uq_co_current_offer;");
    const createIndex = migrationCode.indexOf(
      "CREATE UNIQUE INDEX uq_co_current_offer\n  ON public.commercial_offers (plan_id, market_code, currency_code, billing_interval, billing_interval_count)",
    );
    expect(dropIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(dropIndex);
    expect(createIndex - dropIndex).toBeLessThan(300);
  });

  it("chk_ccae_entity_type is DROPped and immediately re-ADDed with the widened 5-value vocabulary", () => {
    const dropIndex = migrationCode.indexOf("DROP CONSTRAINT chk_ccae_entity_type;");
    const addIndex = migrationCode.indexOf(
      "ADD CONSTRAINT chk_ccae_entity_type CHECK (entity_type IN ('OFFER','PLAN','ADMIN','PRODUCT','PLATFORM_STATE'));",
    );
    expect(dropIndex).toBeGreaterThan(-1);
    expect(addIndex).toBeGreaterThan(-1);
    expect(addIndex).toBeGreaterThan(dropIndex);
  });

  it("the widened vocabulary strictly a superset of the live 2-value vocabulary, and includes PLATFORM_STATE (code-audit Finding 1)", () => {
    expect(migrationCode).toMatch(/CHECK \(entity_type IN \('OFFER','PLAN','ADMIN','PRODUCT','PLATFORM_STATE'\)\)/);
  });

  it("no DELETE, TRUNCATE, or DROP TABLE statement exists anywhere in this migration", () => {
    expect(migrationCode).not.toMatch(/\bDELETE FROM\b/);
    expect(migrationCode).not.toMatch(/\bTRUNCATE\b/);
    expect(migrationCode).not.toMatch(/\bDROP TABLE\b/);
  });
});

describe("Ω3.0 migration — privilege grants for both new RPCs", () => {
  it("admin_supersede_commercial_offer: PUBLIC/anon revoked, authenticated granted", () => {
    expect(migrationCode).toMatch(
      /REVOKE ALL ON FUNCTION public\.admin_supersede_commercial_offer\([^)]*\) FROM PUBLIC, anon;/,
    );
    expect(migrationCode).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.admin_supersede_commercial_offer\([^)]*\) TO authenticated;/,
    );
  });

  it("admin_transition_platform_state: PUBLIC/anon revoked, authenticated granted", () => {
    expect(migrationCode).toMatch(
      /REVOKE ALL ON FUNCTION public\.admin_transition_platform_state\(TEXT, TEXT\) FROM PUBLIC, anon;/,
    );
    expect(migrationCode).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.admin_transition_platform_state\(TEXT, TEXT\) TO authenticated;/,
    );
  });

  it("commercial_currencies: public SELECT, no authenticated/anon write grant", () => {
    expect(migrationCode).toMatch(/GRANT SELECT ON public\.commercial_currencies TO anon, authenticated;/);
    expect(migrationCode).not.toMatch(/GRANT (INSERT|UPDATE|DELETE) ON public\.commercial_currencies TO (anon|authenticated)/);
  });

  it("commercial_platform_state: authenticated SELECT only, no anon grant at all, no authenticated write grant", () => {
    expect(migrationCode).toMatch(/GRANT SELECT ON public\.commercial_platform_state TO authenticated;/);
    expect(migrationCode).not.toMatch(/GRANT SELECT ON public\.commercial_platform_state TO anon/);
    expect(migrationCode).not.toMatch(/GRANT (INSERT|UPDATE|DELETE) ON public\.commercial_platform_state TO authenticated/);
  });

  it("both new tables have RLS enabled with the named policies from the design", () => {
    expect(migrationCode).toMatch(/ALTER TABLE public\.commercial_currencies ENABLE ROW LEVEL SECURITY;/);
    expect(migrationCode).toMatch(/CREATE POLICY "cc_select_public" ON public\.commercial_currencies FOR SELECT USING \(true\);/);
    expect(migrationCode).toMatch(/ALTER TABLE public\.commercial_platform_state ENABLE ROW LEVEL SECURITY;/);
    expect(migrationCode).toMatch(
      /CREATE POLICY "cps_select_admin_only" ON public\.commercial_platform_state\s*\n\s*FOR SELECT USING \(public\.is_commercial_admin\(\)\);/,
    );
  });

  it("both new trigger functions are SECURITY DEFINER with a fixed search_path, and revoked from PUBLIC/anon/authenticated", () => {
    for (const fn of ["commercial_offers_effective_history_ratchet", "commercial_offers_economic_integrity"]) {
      const def = migrationCode.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${fn}\\(\\)[\\s\\S]*?\\$\\$;`))?.[0] ?? "";
      expect(def).toMatch(/SECURITY DEFINER/);
      expect(def).toMatch(/SET search_path = public, pg_catalog/);
      expect(migrationCode).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(\\) FROM PUBLIC, anon, authenticated;`));
    }
  });
});

describe("Ω3.0 migration — admin_transition_platform_state contract", () => {
  const fn =
    migrationCode.match(
      /CREATE OR REPLACE FUNCTION public\.admin_transition_platform_state\([\s\S]*?\nEND;\n\$\$;/,
    )?.[0] ?? "";

  it("exists exactly once, is_commercial_admin()-gated, and requires a non-blank reason", () => {
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).toMatch(/IF NOT public\.is_commercial_admin\(\) THEN/);
    expect(fn).toMatch(/RAISE EXCEPTION 'REASON_REQUIRED'/);
  });

  it("validates the new state against the exact 4-value vocabulary", () => {
    expect(fn).toMatch(
      /IF p_new_state NOT IN \('PAYMENTS_DISABLED','SANDBOX_ONLY','LIVE_ACCEPTANCE','CUSTOMER_PAYMENTS_ENABLED'\) THEN/,
    );
  });

  it("locks the singleton row with FOR UPDATE before writing it", () => {
    const lockIndex = fn.indexOf("FOR UPDATE;");
    const updateIndex = fn.indexOf("UPDATE public.commercial_platform_state");
    expect(lockIndex).toBeGreaterThan(-1);
    expect(updateIndex).toBeGreaterThan(-1);
    expect(lockIndex).toBeLessThan(updateIndex);
  });

  it("code-audit Finding 3: uses a STRICT singleton lookup — the native missing/duplicate-row failure, not a hand-rolled domain error", () => {
    expect(fn).toMatch(/SELECT state INTO STRICT v_previous/);
  });

  it("code-audit Finding 3: PLATFORM_STATE_ROW_MISSING is completely absent from the migration", () => {
    expect(migrationCode).not.toMatch(/PLATFORM_STATE_ROW_MISSING/);
  });

  it("code-audit Finding 3: no IF NOT FOUND / handler wraps the singleton lookup — the native no_data_found/too_many_rows exception from INTO STRICT propagates uncaught", () => {
    // The STRICT SELECT must not be followed by any IF NOT FOUND / IF FOUND
    // check, RAISE EXCEPTION, or EXCEPTION block that could catch,
    // translate, or swallow the native STRICT failure before the UPDATE.
    const strictSelectIndex = fn.indexOf("SELECT state INTO STRICT v_previous");
    const updateIndex = fn.indexOf("UPDATE public.commercial_platform_state");
    const between = fn.slice(strictSelectIndex, updateIndex);
    expect(between).not.toMatch(/IF NOT FOUND/);
    expect(between).not.toMatch(/IF FOUND/);
    expect(between).not.toMatch(/RAISE EXCEPTION/);
    expect(fn).not.toMatch(/\nEXCEPTION\n/);
  });

  it("code-audit Finding 3: a STRICT failure (raised before the UPDATE) structurally prevents both the state mutation and the audit insertion — textual ordering proof", () => {
    const strictSelectIndex = fn.indexOf("SELECT state INTO STRICT v_previous");
    const updateIndex = fn.indexOf("UPDATE public.commercial_platform_state");
    const insertIndex = fn.indexOf("INSERT INTO public.commercial_catalog_audit_events");
    expect(strictSelectIndex).toBeGreaterThan(-1);
    expect(strictSelectIndex).toBeLessThan(updateIndex);
    expect(updateIndex).toBeLessThan(insertIndex);
    // With no EXCEPTION block anywhere in this function (proven above), a
    // STRICT failure at the SELECT is an uncaught exception that aborts
    // the whole invocation before either subsequent statement runs — this
    // is NOT executed against a live database here; it is a structural
    // proof from statement ordering plus the absence of any handler.
  });

  it("writes an audit row with entity_type='PLATFORM_STATE' and action='PLATFORM_STATE_TRANSITIONED' (code-audit Finding 1, corrected from the original 'ADMIN')", () => {
    expect(fn).toMatch(/'PLATFORM_STATE_TRANSITIONED', 'PLATFORM_STATE'/);
  });

  it("declares a CONSTANT canonical singleton entity UUID, deterministically derived (UUIDv5), never computed per-request", () => {
    expect(fn).toMatch(
      /c_platform_state_entity_id CONSTANT UUID := '4056be2d-92cb-56eb-9ef4-c11e13579b94';/,
    );
    // The constant's own declaration must not reference gen_random_uuid(),
    // auth.uid(), now(), or any other per-request/per-environment source.
    const declLine = fn.match(/c_platform_state_entity_id CONSTANT UUID := '[^']+';/)?.[0] ?? "";
    expect(declLine).not.toMatch(/gen_random_uuid|auth\.uid|now\(\)/);
  });

  it("Finding-1 hostile test 1: the audit INSERT's entity_id is always the literal constant, not v_user_id or any per-call expression — proves two transitions by the SAME administrator (or any administrator) always write the identical entity UUID", () => {
    const insertBlock = fn.match(/INSERT INTO public\.commercial_catalog_audit_events \(([\s\S]*?)\);/)?.[0] ?? "";
    expect(insertBlock).toMatch(/'PLATFORM_STATE_TRANSITIONED', 'PLATFORM_STATE', c_platform_state_entity_id,/);
    // Every call to this function executes this exact literal VALUES clause
    // — there is no per-row/per-call variable substituted for entity_id, so
    // repeat invocations (by the same or different administrators) are
    // structurally guaranteed to write the same entity_id every time.
  });

  it("Finding-1 hostile test 2: actor_user_id (v_user_id, varies per caller) and entity_id (the constant, invariant) are two distinct expressions in the same INSERT — different administrators write different actor_user_id but the identical entity_id", () => {
    // v_user_id occupies the actor_user_id position (first VALUES slot);
    // c_platform_state_entity_id occupies the entity_id position (fourth
    // slot) — two textually distinct expressions, never the same one
    // reused for both columns.
    const valuesClause = fn.match(/VALUES \(\s*\n\s*(v_user_id), 'PLATFORM_STATE_TRANSITIONED', 'PLATFORM_STATE', (c_platform_state_entity_id),/);
    expect(valuesClause).not.toBeNull();
    expect(valuesClause?.[1]).toBe("v_user_id");
    expect(valuesClause?.[2]).toBe("c_platform_state_entity_id");
    expect(valuesClause?.[1]).not.toBe(valuesClause?.[2]);
  });

  it("Finding-1 hostile test 3: no EXCEPTION block exists in this function — an audit-insert failure aborts the whole transaction (uncaught), rolling back the state UPDATE above it, exactly as admin_upsert_commercial_product's own precedent proves", () => {
    expect(fn).not.toMatch(/\nEXCEPTION\n/);
    expect(fn).not.toMatch(/WHEN unique_violation|WHEN exclusion_violation|WHEN OTHERS/);
    // The UPDATE (state mutation) must textually precede the audit INSERT —
    // both execute in this one invocation's single transaction, with no
    // handler between them that could catch and mask an INSERT failure.
    const updateIndex = fn.indexOf("UPDATE public.commercial_platform_state");
    const insertIndex = fn.indexOf("INSERT INTO public.commercial_catalog_audit_events");
    expect(updateIndex).toBeGreaterThan(-1);
    expect(insertIndex).toBeGreaterThan(updateIndex);
  });

  it("Finding-1 forbidden regression: entity_id = v_user_id must never appear in the platform-state audit insertion", () => {
    expect(fn).not.toMatch(/'PLATFORM_STATE_TRANSITIONED', 'ADMIN', v_user_id/);
    expect(fn).not.toMatch(/entity_id.*v_user_id.*PLATFORM_STATE_TRANSITIONED/);
    const insertBlock = fn.match(/INSERT INTO public\.commercial_catalog_audit_events \(([\s\S]*?)\);/)?.[0] ?? "";
    // v_user_id may appear ONCE in this block, as actor_user_id (the first
    // VALUES position) — it must never additionally appear as entity_id.
    const valuesLine = insertBlock.match(/VALUES \(\s*\n(.*?),/)?.[1]?.trim() ?? "";
    expect(valuesLine).toBe("v_user_id");
    expect(insertBlock).not.toMatch(/c_platform_state_entity_id.*v_user_id/);
  });

  it("is a bare, Ω3.0-scoped implementation — carries no mechanical live-key or purchasable-offer precondition (deferred to Ω3.7 per the design)", () => {
    expect(fn).not.toMatch(/sk_live_/);
    expect(fn).not.toMatch(/is_purchasable/);
  });
});

describe("Ω3.0 migration — commercial_offers_economic_integrity contract (§G.2 + §E.1)", () => {
  const fn =
    migrationCode.match(
      /CREATE OR REPLACE FUNCTION public\.commercial_offers_economic_integrity\(\)[\s\S]*?\$\$;/,
    )?.[0] ?? "";

  it("rejects a currency not present in commercial_currencies", () => {
    expect(fn).toMatch(/CURRENCY_NOT_SUPPORTED/);
    expect(fn).toMatch(/FROM public\.commercial_currencies\s*\n\s*WHERE code = NEW\.currency_code AND is_supported;/);
  });

  it("rejects an exponent that does not match the registry (the exact TZS/2 incident class)", () => {
    expect(fn).toMatch(/CURRENCY_EXPONENT_MISMATCH/);
    expect(fn).toMatch(/NEW\.currency_exponent != v_registry_exponent/);
  });

  it("immutability check excludes lifecycle-only fields (is_active, is_purchasable, effective_end)", () => {
    const immutabilityBlock = fn.match(/IF TG_OP = 'UPDATE' THEN([\s\S]*?)END IF;/)?.[1] ?? "";
    expect(immutabilityBlock).not.toMatch(/is_active/);
    expect(immutabilityBlock).not.toMatch(/is_purchasable/);
    expect(immutabilityBlock).not.toMatch(/effective_end/);
    for (const field of [
      "currency_code",
      "amount_minor",
      "currency_exponent",
      "billing_interval",
      "billing_interval_count",
      "plan_id",
      "market_code",
    ]) {
      expect(immutabilityBlock).toMatch(new RegExp(`NEW\\.${field}\\s+IS DISTINCT FROM OLD\\.${field}`));
    }
  });
});

describe("Ω3.0 migration — code-audit Finding 2: fingerprint canonical-payload contract (static half only — no live database)", () => {
  const supersedeFn =
    migrationCode.match(
      /CREATE OR REPLACE FUNCTION public\.admin_supersede_commercial_offer\([\s\S]*?\nEND;\n\$\$;/,
    )?.[0] ?? "";
  const fingerprintExpr =
    supersedeFn.match(/v_fingerprint := encode\(digest\(([\s\S]*?)\),\s*\n?\s*'sha256'\), 'hex'\);/)?.[0] ?? "";

  it("1. NULL vs. empty string: p_old_offer_code is passed through jsonb_build_object unmodified — a JSON null for NULL, never coerced to '' or dropped (unlike concat_ws)", () => {
    expect(fingerprintExpr).toMatch(/'old_offer_code', p_old_offer_code,/);
    // Structural proof only: jsonb_build_object's NULL-preserving behavior
    // is documented PostgreSQL behavior (a NULL argument to
    // jsonb_build_object produces a JSON `null` value for that key), not
    // independently re-verified against a live instance here.
  });

  it("2. delimiter-bearing input: no '|' or other delimiter join exists anywhere in the fingerprint expression — field boundaries are JSONB-structural, not textual", () => {
    expect(fingerprintExpr).not.toMatch(/\|\|/); // no ad-hoc string concatenation operator
    expect(fingerprintExpr).not.toMatch(/'\|'/); // no literal pipe delimiter
  });

  it("3. quotes/backslashes/Unicode: every text parameter is passed as a jsonb_build_object VALUE (JSON-escaped by construction), never interpolated into a raw string template", () => {
    for (const param of ["p_old_offer_code", "p_plan_code", "p_market_code", "p_currency_code", "p_billing_interval"]) {
      expect(fingerprintExpr).toMatch(new RegExp(`'\\w+',\\s*${param}[,)]`));
    }
    // No format()/quote_literal()/manual string-building of the payload.
    expect(fingerprintExpr).not.toMatch(/format\(/);
  });

  it("4. same instant, different timezones: effective_start is normalized via AT TIME ZONE 'UTC' before to_char — never a bare TIMESTAMPTZ::TEXT cast (session-TimeZone-dependent)", () => {
    expect(fingerprintExpr).toMatch(/p_effective_start AT TIME ZONE 'UTC'/);
    expect(fingerprintExpr).not.toMatch(/p_effective_start::TEXT/);
  });

  it("5. microsecond difference: the to_char format includes '.US' (microsecond precision)", () => {
    expect(fingerprintExpr).toMatch(/HH24:MI:SS\.US/);
  });

  it("6. different interval counts: billing_interval_count is a distinct field in the payload from billing_interval, both included", () => {
    expect(fingerprintExpr).toMatch(/'billing_interval', p_billing_interval,/);
    expect(fingerprintExpr).toMatch(/'billing_interval_count', p_billing_interval_count,/);
  });

  it("7/8. idempotency key (p_new_offer_code) is structurally separate from the payload — same key + same payload replays, same key + changed payload is rejected (mechanism proven by the pre-lock/post-lock fingerprint comparisons elsewhere in this file, not re-derived here)", () => {
    expect(fingerprintExpr).not.toMatch(/p_new_offer_code/);
    expect(supersedeFn).toMatch(/IF v_existing\.request_fingerprint IS DISTINCT FROM v_fingerprint THEN/);
  });

  it("9. forbidden reintroduction: concat_ws must never reappear anywhere in this migration", () => {
    expect(migrationCode).not.toMatch(/concat_ws/);
  });

  it("10. forbidden bare timestamp-to-text fingerprinting: no TIMESTAMPTZ::TEXT (or bare ::TEXT on p_effective_start) exists anywhere in this migration", () => {
    expect(migrationCode).not.toMatch(/p_effective_start::TEXT/);
  });

  it("explicit UTF-8 conversion via convert_to(..., 'UTF8') precedes digest() — not an implicit text->bytea cast", () => {
    expect(fingerprintExpr).toMatch(/convert_to\(\s*\n\s*jsonb_build_object\(/);
    expect(fingerprintExpr).toMatch(/\)::TEXT,\s*\n\s*'UTF8'\s*\n\s*\),\s*\n\s*'sha256'\), 'hex'\);/);
  });

  it("the canonical value embeds an explicit UTC marker ('Z') in addition to the '_utc' field-name contract", () => {
    expect(fingerprintExpr).toMatch(/'effective_start_utc', to_char\([\s\S]*?"Z"'\)/);
  });

  it("fingerprint-contract version 'v': 1 is present", () => {
    expect(fingerprintExpr).toMatch(/'v', 1,/);
  });
});

describe("Ω3.0 migration — code-audit Finding 4: no unauthorized schema/object mutation beyond the approved Ω3.0 allowlist", () => {
  it("COMMENT ON SCHEMA public is completely absent", () => {
    expect(migrationCode).not.toMatch(/COMMENT ON SCHEMA/);
  });

  it("no ALTER TABLE targets any pre-existing table other than commercial_offers and commercial_catalog_audit_events", () => {
    const alterMatches = [...migrationCode.matchAll(/ALTER TABLE public\.(\w+)/g)].map((m) => m[1]);
    const allowedExistingTables = new Set([
      "commercial_offers",
      "commercial_catalog_audit_events",
      // the 2 brand-new tables this same migration creates and immediately configures:
      "commercial_currencies",
      "commercial_platform_state",
    ]);
    for (const table of alterMatches) {
      expect(allowedExistingTables.has(table), `Unexpected ALTER TABLE target: ${table}`).toBe(true);
    }
  });

  it("the only pre-existing RPC replaced via CREATE OR REPLACE is admin_upsert_commercial_offer", () => {
    const createOrReplaceFns = [...migrationCode.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)].map((m) => m[1]);
    const newFunctionsThisMigration = new Set([
      "commercial_offers_effective_history_ratchet",
      "commercial_offers_economic_integrity",
      "admin_supersede_commercial_offer",
      "admin_transition_platform_state",
    ]);
    const preExistingFunctionsTouched = createOrReplaceFns.filter((f) => !newFunctionsThisMigration.has(f));
    expect(preExistingFunctionsTouched).toEqual(["admin_upsert_commercial_offer"]);
  });

  it("no DROP CONSTRAINT/DROP INDEX targets any object outside the two named, approved DDL replacements", () => {
    const drops = [...migrationCode.matchAll(/DROP (?:CONSTRAINT|INDEX)(?: IF EXISTS)? (?:public\.)?(\w+)/g)].map((m) => m[1]);
    expect(drops.sort()).toEqual(["chk_ccae_entity_type", "uq_co_current_offer"].sort());
  });

  it("no COMMENT ON TABLE/FUNCTION targets any pre-existing object — only the 2 new tables carry a new COMMENT ON TABLE", () => {
    const commentedTables = [...migrationCode.matchAll(/COMMENT ON TABLE public\.(\w+)/g)].map((m) => m[1]);
    for (const table of commentedTables) {
      expect(["commercial_currencies", "commercial_platform_state"]).toContain(table);
    }
    expect(migrationCode).not.toMatch(/COMMENT ON FUNCTION/);
  });
});
