/**
 * Migration authority (P-06): supabase/migrations is the authored source; drizzle/migrations is Lovable's hosted apply
 * journal. scripts/ci/assertMigrationAuthority.mjs proves deterministic parity between them on every CI run. These
 * tests run it against the repository and against deliberately drifted copies.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM script without type declarations
import { checkMigrationAuthority, PINNED } from "../../../scripts/ci/assertMigrationAuthority.mjs";

type Result = { ok: boolean; errors: string[]; mirrored: { tag: string; source: string; how: string }[]; pending: string[]; knownDrift: string[]; resolved: string[] };
const ROOT = path.join(__dirname, "../../..");

function copyRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "migration-authority-"));
  for (const d of ["supabase/migrations", "drizzle/migrations", "drizzle/migrations/meta"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  for (const d of ["supabase/migrations", "drizzle/migrations", "drizzle/migrations/meta"]) {
    for (const f of fs.readdirSync(path.join(ROOT, d))) {
      const src = path.join(ROOT, d, f);
      if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(dir, d, f));
    }
  }
  return dir;
}

describe("migration authority parity", () => {
  it("the repository is in parity: every hosted journal entry mirrors one authored migration, in order, with no gap", () => {
    const r = checkMigrationAuthority(ROOT) as Result;
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.mirrored.length).toBe(13);
    // Authored here and not yet applied by the owner: listed, never an error.
    expect(r.pending).toEqual([
      "20260925100000_global_capabilities_entitlements_pricing.sql",
      "20260925110000_named_user_billing_suspension_and_invitation_lifecycle.sql",
      "20260925120000_reporting_pack_issuance_binding.sql",
      "20260925130000_solo_plan_no_free_plan_and_plan_feature_matrix.sql",
      "20260925140000_workspace_capability_authorization.sql",
      "20260925150000_can_user_act_on_workspace_minimum_grant.sql",
    ]);
  });
  it("the one historical divergence is RESOLVED forward (never allowlisted): no open drift remains", () => {
    const r = checkMigrationAuthority(ROOT) as Result;
    expect(r.knownDrift).toEqual([]);
    expect(r.resolved).toEqual([
      "0006_pr32_02_upload_lifecycle_retire_and_replace: REVOKE ALL ON FUNCTION public.can_user_act_on_workspace(uuid, uuid, text) FROM PUBLIC, anon -> resolved by 20260925150000_can_user_act_on_workspace_minimum_grant.sql",
    ]);
    expect(Object.keys(PINNED).sort()).toEqual(["0003_service_enquiry_intake_reconciliation_assert", "0006_pr32_02_upload_lifecycle_retire_and_replace"]);
  });
  it("fails when the resolving migration loses its corrective statement, or is missing", () => {
    const dir = copyRepo();
    try {
      const f = path.join(dir, "supabase/migrations/20260925150000_can_user_act_on_workspace_minimum_grant.sql");
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("FROM PUBLIC, anon, authenticated;\nGRANT EXECUTE ON FUNCTION public.can_user_act_on_workspace", "FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION public.can_user_act_on_workspace"));
      expect((checkMigrationAuthority(dir) as Result).errors.join("\n")).toMatch(/no longer contains the exact corrective statements/);
      fs.rmSync(f);
      expect((checkMigrationAuthority(dir) as Result).errors.join("\n")).toMatch(/resolving migration 20260925150000_can_user_act_on_workspace_minimum_grant.sql is missing/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("Lovable / Drizzle cannot reintroduce a conflicting permission: a journal entry granting the predicate to authenticated, or re-creating it without the revoke, fails", () => {
    const dir = copyRepo();
    try {
      // A new hosted journal entry that re-grants the predicate (any role but service_role) is refused wherever it appears.
      const src = path.join(dir, "supabase/migrations/20260926000000_regrant.sql");
      fs.writeFileSync(src, "GRANT EXECUTE ON FUNCTION public.can_user_act_on_workspace(uuid, uuid, text) TO authenticated;\n");
      const errs = (checkMigrationAuthority(dir) as Result).errors.join("\n");
      expect(errs).toMatch(/grants can_user_act_on_workspace to authenticated \(service_role only\)/);
      fs.rmSync(src);
      fs.writeFileSync(src, "CREATE OR REPLACE FUNCTION public.workspace_authority_basis(p_user_id uuid, p_company_id uuid, p_capability text) RETURNS text LANGUAGE sql AS $$ SELECT NULL::text $$;\n");
      expect((checkMigrationAuthority(dir) as Result).errors.join("\n")).toMatch(/re-creates workspace_authority_basis without revoking it/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("detects a hosted journal entry edited away from its source", () => {
    const dir = copyRepo();
    try {
      const f = path.join(dir, "drizzle/migrations/0005_pr32_01_discard_trial_balance_authority.sql");
      fs.writeFileSync(f, fs.readFileSync(f, "utf8") + "\nGRANT ALL ON public.trial_balance_uploads TO anon;\n");
      const r = checkMigrationAuthority(dir) as Result;
      expect(r.ok).toBe(false);
      expect(r.errors.join("\n")).toMatch(/0005_pr32_01_discard_trial_balance_authority matches no source migration/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("detects any further change to the pinned entry beyond its one registered difference", () => {
    const dir = copyRepo();
    try {
      const f = path.join(dir, "drizzle/migrations/0006_pr32_02_upload_lifecycle_retire_and_replace.sql");
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("FROM PUBLIC, anon;", "FROM PUBLIC;"));
      const r = checkMigrationAuthority(dir) as Result;
      expect(r.ok).toBe(false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("detects a source migration skipped by the hosted journal, a stray file and a broken journal", () => {
    const dir = copyRepo();
    try {
      // A source migration inserted between two mirrored ones, never applied to the hosted database.
      fs.writeFileSync(path.join(dir, "supabase/migrations/20260923125000_inserted.sql"), "SELECT 1;\n");
      fs.writeFileSync(path.join(dir, "drizzle/migrations/9999_stray.sql"), "SELECT 1;\n");
      const j = path.join(dir, "drizzle/migrations/meta/_journal.json");
      const journal = JSON.parse(fs.readFileSync(j, "utf8"));
      journal.entries[2].idx = 7;
      fs.writeFileSync(j, JSON.stringify(journal));
      const errs = (checkMigrationAuthority(dir) as Result).errors.join("\n");
      expect(errs).toMatch(/source 20260923125000_inserted\.sql was skipped by the hosted apply journal/);
      expect(errs).toMatch(/9999_stray\.sql is not in the journal/);
      expect(errs).toMatch(/has idx 7, expected 2/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it("runs in CI, and no workflow or package script runs drizzle-kit against a database", () => {
    const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toMatch(/node scripts\/ci\/assertMigrationAuthority\.mjs/);
    expect(ci).not.toMatch(/drizzle-kit\s+(push|migrate)/);
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    expect(Object.values(pkg.scripts ?? {}).join(" ")).not.toMatch(/drizzle-kit\s+(push|migrate)/);
  });
});
