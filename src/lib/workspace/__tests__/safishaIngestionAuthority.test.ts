/**
 * Static contract of 20261005100000_safisha_ingestion_authority.sql and safisha-ingest. Behaviour is proven by
 * scripts/db-proof/safishaIngestion.mjs (the real old and new handlers against disposable PostgreSQL without and with the
 * migration); this file keeps the contract visible in the fast suite.
 */
import { parkedMigrationSql } from "../../../../scripts/db-proof/lib/parkedMigrations.mjs";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
// Parked: never applied to the hosted database; quarantined in supabase/migrations_historical/ (S1 record). The original
// SQL (notice stripped, SHA-256 verified) is what this static contract pins.
const MIGRATION = parkedMigrationSql(ROOT, "20261005100000_safisha_ingestion_authority.sql");
const SQL = MIGRATION.replace(/--[^\n]*/g, "");
const INGEST = read("supabase/functions/safisha-ingest/index.ts");

describe("evidence ingestion authority migration", () => {
  it("an ingestion is identified by the caller's key; replay or conflict; without a key nothing is inferred (a new ingestion)", () => {
    expect(SQL).toContain("CONSTRAINT safisha_ingestions_identity UNIQUE (reconciliation_id, ingestion_key)");
    expect(SQL).toContain("v_key     := COALESCE('client:' || p_ingestion_key, 'request:' || gen_random_uuid()::text);");
    expect(SQL).not.toContain("'file:' ||");
    expect(SQL).toContain("IF v_ing.file_sha256 = p_file_sha256 AND v_ing.mapping_sha256 = v_map_sha AND v_ing.source_id = p_source_type THEN");
    expect(SQL).toContain("USING ERRCODE = 'PT409'");
  });

  it("content alone never proves a duplicate: only a source transaction ID with equal economic fields does; overlap is stored and flagged", () => {
    expect(SQL).toContain("'duplicate_source_txn_id'");
    // The namespace: one source type AND one account.
    expect(SQL).toMatch(/AND t\.source_id = p_source_type AND t\.account_code = v_e->>'account_code'\s+AND t\.source_txn_id = v_txn_id AND t\.ingestion_id IS DISTINCT FROM v_ing\.id\s+AND t\.txn_date IS NOT DISTINCT FROM/);
    expect(SQL).toContain("WHERE t.ingestion_id = v_ing.id AND t.account_code = v_e->>'account_code' AND t.source_txn_id = v_txn_id");
  });

  it("an ambiguous overlap opens a pending investigate exception in the existing queue, linked from its occurrence", () => {
    expect(SQL).toMatch(/INSERT INTO public\.safisha_exceptions \(reconciliation_id, account_code, account_name, category, variance, age_days,\s+tb_txn_id, evidence_txn_id, description\)/);
    expect(SQL).toContain("CASE WHEN p_source_type = 'tb' THEN v_new END, CASE WHEN p_source_type <> 'tb' THEN v_new END,");
    expect(SQL).toContain("(overlap_reason IS NULL) = (review_exception_id IS NULL) AND (overlap_reason IS NULL) = (overlap_with_transaction_id IS NULL)");
    for (const reason of ["identical_content_other_file", "identical_content_legacy", "repeated_source_txn_id", "source_txn_id_mismatch"]) {
      expect(SQL).toContain(`'${reason}'`);
    }
    expect(SQL).toContain("CONSTRAINT safisha_source_occurrences_flag_only_on_stored CHECK (overlap_reason IS NULL OR disposition = 'stored')");
  });

  it("legacy rows are claimed only by source + content + file line, each at most once, and never rewritten", () => {
    expect(SQL).toMatch(/t\.ingestion_id IS NULL\s+AND t\.raw_row_hash = v_hash AND t\.raw_row_number = v_line/);
    expect(SQL).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS safisha_source_occurrences_legacy_claim\s+ON public\.safisha_source_occurrences \(transaction_id\) WHERE disposition = 'legacy_match';/);
    expect(SQL).not.toMatch(/UPDATE\s+public\.safisha_transactions/i);
  });

  it("one stored row per file line per ingestion; provenance is append-only and tenant-scoped", () => {
    expect(SQL).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS safisha_transactions_ingestion_line\s+ON public\.safisha_transactions \(ingestion_id, raw_row_number\) WHERE ingestion_id IS NOT NULL;/);
    expect(SQL).toContain("CONSTRAINT safisha_source_occurrences_line UNIQUE (ingestion_id, raw_row_number)");
    expect(SQL).toMatch(/CREATE TRIGGER safisha_ingestions_append_only BEFORE UPDATE OR DELETE ON public\.safisha_ingestions/);
    expect(SQL).toMatch(/CREATE TRIGGER safisha_source_occurrences_append_only BEFORE UPDATE OR DELETE ON public\.safisha_source_occurrences/);
    expect(SQL).toContain("USING (public.safisha_recon_visible(reconciliation_id));");
    expect(SQL).toContain("REVOKE ALL ON public.safisha_ingestions, public.safisha_source_occurrences FROM PUBLIC, anon, authenticated;");
  });

  it("serializes per upload, authorizes the actor, and verifies the upload status by row count", () => {
    expect(SQL).toContain("PERFORM pg_advisory_xact_lock(hashtextextended('safisha_ingest_evidence:' || p_upload_id::text, 0));");
    expect(SQL).toContain("NOT public.workspace_capability_allowed(v_company, p_actor, 'prepare_close')");
    expect(SQL).toContain("ON CONFLICT (tb_upload_id) WHERE NOT sealed DO NOTHING;");
    expect(SQL).toMatch(/UPDATE public\.trial_balance_uploads SET safisha_status = 'processing' WHERE id = p_upload_id AND safisha_status IS NULL;\s+GET DIAGNOSTICS v_n = ROW_COUNT;\s+IF v_n <> 1 THEN/);
  });

  it("client roles cannot insert evidence rows; the function is service-role only", () => {
    expect(SQL).toContain("IF current_user IN ('authenticated', 'anon') THEN\n    RAISE EXCEPTION 'EVIDENCE_SERVER_ONLY");
    expect(SQL).toMatch(/CREATE TRIGGER ab_transaction_authority BEFORE INSERT ON public\.safisha_transactions/);
    expect(SQL).toContain("REVOKE ALL ON FUNCTION public.safisha_ingest_evidence(uuid, uuid, text, text, text, jsonb, text, jsonb) FROM PUBLIC, anon, authenticated;");
    expect(SQL).toContain("GRANT EXECUTE ON FUNCTION public.safisha_ingest_evidence(uuid, uuid, text, text, text, jsonb, text, jsonb) TO service_role;");
  });

  it("is additive and forward-only: nothing rewritten or removed", () => {
    expect(SQL).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|DROP\s+(TABLE|COLUMN|INDEX|FUNCTION))\b/i);
    expect(SQL).toContain("ADD COLUMN IF NOT EXISTS ingestion_id uuid REFERENCES public.safisha_ingestions(id)");
    expect(SQL).toContain("ADD COLUMN IF NOT EXISTS source_txn_id text");
    expect(MIGRATION).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("is proven in CI", () => {
    expect(read(".github/workflows/ci.yml")).toContain("run: bun scripts/db-proof/safishaIngestion.mjs");
  });
});

describe("safisha-ingest", () => {
  it("writes only through the service-role function, with the JWT user as the actor, its mapping and optional ingestion key; no fallback", () => {
    expect(INGEST).toContain('admin.rpc("safisha_ingest_evidence", {');
    expect(INGEST).toContain("p_actor:       user.id,");
    expect(INGEST).toContain("p_mapping:     savedMapping,");
    expect(INGEST).toContain("p_ingestion_key: ingestionKey,");
    expect(INGEST).not.toMatch(/\.from\("safisha_(transactions|reconciliations)"\)/);
    expect(INGEST).not.toMatch(/\.from\("trial_balance_uploads"\)\s*\.update/);
    expect(INGEST).not.toContain("seenHashes");
  });
});
