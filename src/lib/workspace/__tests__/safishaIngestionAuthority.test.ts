/**
 * Static contract of 20261005100000_safisha_ingestion_authority.sql and safisha-ingest. Behaviour is proven by
 * scripts/db-proof/safishaIngestion.mjs (the real old and new handlers against disposable PostgreSQL without and with the
 * migration); this file keeps the contract visible in the fast suite.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const MIGRATION = read("supabase/migrations/20261005100000_safisha_ingestion_authority.sql");
const SQL = MIGRATION.replace(/--[^\n]*/g, "");
const INGEST = read("supabase/functions/safisha-ingest/index.ts");

describe("evidence ingestion authority migration", () => {
  it("row identity is (reconciliation, source, row hash, occurrence within the file), enforced for new rows only", () => {
    expect(SQL).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS safisha_transactions_source_row_identity\s+ON public\.safisha_transactions \(reconciliation_id, source_id, raw_row_hash, row_occurrence\)\s+WHERE row_occurrence IS NOT NULL;/);
    expect(SQL).toContain("row_number() OVER (PARTITION BY e->>'raw_row_hash' ORDER BY ord)::integer AS occurrence");
    expect(SQL).toContain("WHERE reconciliation_id = v_recon AND source_id = p_source_type GROUP BY raw_row_hash");
    expect(SQL).toContain("WHERE n.occurrence > COALESCE(p.n, 0)");
  });

  it("serializes per upload, authorizes the actor, and verifies the upload status by row count", () => {
    expect(SQL).toContain("PERFORM pg_advisory_xact_lock(hashtextextended('safisha_ingest_evidence:' || p_upload_id::text, 0));");
    expect(SQL).toContain("NOT public.workspace_capability_allowed(v_company, p_actor, 'prepare_close')");
    expect(SQL).toContain("ON CONFLICT (tb_upload_id) WHERE NOT sealed DO NOTHING;");
    expect(SQL).toMatch(/UPDATE public\.trial_balance_uploads SET safisha_status = 'processing' WHERE id = p_upload_id AND safisha_status IS NULL;\s+GET DIAGNOSTICS v_n = ROW_COUNT;\s+IF v_n <> 1 THEN/);
  });

  it("records the evidence file once per (source, file SHA-256)", () => {
    expect(SQL).toContain("f->>'source_type' = p_source_type AND f->>'sha256' = p_file_sha256");
  });

  it("client roles cannot insert evidence rows; the function is service-role only", () => {
    expect(SQL).toContain("IF current_user IN ('authenticated', 'anon') THEN\n    RAISE EXCEPTION 'EVIDENCE_SERVER_ONLY");
    expect(SQL).toMatch(/CREATE TRIGGER ab_transaction_authority BEFORE INSERT ON public\.safisha_transactions/);
    expect(SQL).toContain("REVOKE ALL ON FUNCTION public.safisha_ingest_evidence(uuid, uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;");
    expect(SQL).toContain("GRANT EXECUTE ON FUNCTION public.safisha_ingest_evidence(uuid, uuid, text, text, text, jsonb) TO service_role;");
  });

  it("is additive and forward-only: two nullable columns, nothing rewritten or removed", () => {
    expect(SQL).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|DROP\s+(TABLE|COLUMN|INDEX|FUNCTION|POLICY))\b/i);
    expect(SQL).not.toMatch(/UPDATE\s+public\.safisha_transactions/i);
    expect(SQL).toContain("ADD COLUMN IF NOT EXISTS row_occurrence integer");
    expect(SQL).toContain("ADD COLUMN IF NOT EXISTS source_file_sha256 text");
    expect(MIGRATION).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("is proven in CI", () => {
    expect(read(".github/workflows/ci.yml")).toContain("run: bun scripts/db-proof/safishaIngestion.mjs");
  });
});

describe("safisha-ingest", () => {
  it("writes only through the service-role function, with the JWT user as the actor, and has no fallback", () => {
    expect(INGEST).toContain('admin.rpc("safisha_ingest_evidence", {');
    expect(INGEST).toContain("p_actor:       user.id,");
    expect(INGEST).not.toMatch(/\.from\("safisha_(transactions|reconciliations)"\)/);
    expect(INGEST).not.toMatch(/\.from\("trial_balance_uploads"\)\s*\.update/);
    expect(INGEST).not.toContain("seenHashes");
  });
});
