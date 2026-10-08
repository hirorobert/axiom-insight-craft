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
    // 13 byte-equal mirrors + the eight reviewed release wrappers (0015, 0017–0022, 0024; rule 8) + 0023 by its canonical
    // source (rule canonical_equivalent). The prerequisite 20260915100000 is recorded as applied out of source order
    // (0016) — see releaseJournal.test.ts.
    // RELEASE_JOURNAL_ENTRIES=24: 0025 and 0026 are release_verbatim entries. 0027 (20261003100000, classification-save
    // digest fix) is a byte-equal mirror of its source.
    // 26: 0028 (20261006100000, S1) is a release_verbatim entry (hosted journal id 29).
    // 27: 0029 (20261007100000, H1) is a release_verbatim_final_lf_removed entry (rule 9; releaseJournal.test.ts).
    // 28: 0030 (20261008100000, S2) is the same kind.
    // 30: 0031 and 0032 (I1-A A1/A2) are release_verbatim entries in their registered identical form.
    // 37: 0033–0039 (the I1-B/I1-C/Close Review/sign-off milestone) are release_self_checking_wrapper entries — each the
    // registered wrapper of its source, byte for byte (hosted journal ids 34–40).
    expect(r.mirrored.length).toBe(37);
    expect(r.mirrored.find((m) => m.tag === "0023_security_fix_probe_and_xbrl_concept_map")).toEqual({
      tag: "0023_security_fix_probe_and_xbrl_concept_map", source: "20260927041019_security_fix_probe_and_xbrl_concept_map.sql", how: "canonical_equivalent",
    });
    // Authored here and not yet applied by the owner: listed, never an error. PR #34 100000–150000 are applied.
    // 20260926160000 applied by 0022; 20260927100000 by 0024; 20261001120000 by 0025; 20261002100000 by 0026.
    // 20261004100000 (reconciliation server authority) and 20261005100000 (evidence ingestion authority) are authored and
    // not yet applied.
    // S1 record: 20261006100000 applied as 0028. The parked 20261004100000 / 20261005100000 (never applied) are quarantined in
    // supabase/migrations_historical/, so nothing is pending and no source migration is skipped by the hosted journal.
    // H1 (20261007100000) is applied as 0029 and S2 (20261008100000) as 0030. Nothing is pending.
    // I1-A (20261009100000, currency registry and explicit reporting periods) is authored and pending hosted application.
    // I1-A (20261010100000, layout templates and confirmations) is authored and pending hosted application.
    // I1-A A1/A2 are applied (hosted 0031/0032, identical form).
    // I1-B (20261011100000, two years from one file, shared source) is authored and pending hosted application.
    // 20261011100000–20261017100000 are applied as 0033–0039 (self-checking wrappers). Nothing is pending.
    expect(r.pending).toEqual(["20261018100000_fs_statement_composition.sql", "20261019100000_fs_notes_and_schedules.sql", "20261020100000_fs_comparatives.sql", "20261021100000_fs_signoff_binding.sql", "20261022100000_fs_reporting_closure.sql"]);
    expect(r.mirrored.find((m) => m.tag === "0025_apply_20261001120000_annual_commercial_term")?.how).toBe("release_verbatim");
  });
  it("0023 is mapped to its canonical source only by exact SHA-256 of both files and a structural check — any mutation fails closed", () => {
    const H = "drizzle/migrations/0023_security_fix_probe_and_xbrl_concept_map.sql";
    const S = "supabase/migrations/20260927041019_security_fix_probe_and_xbrl_concept_map.sql";
    const run = (mutate: (dir: string) => void) => {
      const dir = copyRepo();
      try { mutate(dir); return (checkMigrationAuthority(dir) as Result).errors.join("\n"); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    };
    // The hosted entry gains a grant, or loses its probe statement: its content pin fails, and the structure is re-checked.
    const grant = run((d) => fs.appendFileSync(path.join(d, H), "\nGRANT ALL ON public.xbrl_concept_map TO anon;"));
    expect(grant).toMatch(/0023_security_fix_probe_and_xbrl_concept_map differs from its reviewed content \(SHA-256\)/);
    expect(grant).toMatch(/statement not in its canonical source and not a registered release-only statement: GRANT ALL ON public\.xbrl_concept_map TO anon/);
    expect(grant).toMatch(/changes data or grants privileges/);
    const noProbe = run((d) => fs.writeFileSync(path.join(d, H), fs.readFileSync(path.join(d, H), "utf8").replace("ALTER TABLE public._pr34_probe ENABLE ROW LEVEL SECURITY;", "")));
    expect(noProbe).toMatch(/the registered release-only statement is no longer present/);
    // The canonical source changes (any byte), or applies the release-only statement unguarded, or loses the policy.
    expect(run((d) => fs.appendFileSync(path.join(d, S), "\n-- edited"))).toMatch(/canonical source 20260927041019_security_fix_probe_and_xbrl_concept_map\.sql differs from the reviewed source/);
    const unguarded = run((d) => fs.writeFileSync(path.join(d, S), fs.readFileSync(path.join(d, S), "utf8").replace("IF to_regclass('public._pr34_probe') IS NOT NULL THEN", "IF true THEN")));
    expect(unguarded).toMatch(/must apply "ALTER TABLE public\._pr34_probe ENABLE ROW LEVEL SECURITY" only behind to_regclass\('public\._pr34_probe'\)/);
    const noPolicy = run((d) => fs.writeFileSync(path.join(d, S), fs.readFileSync(path.join(d, S), "utf8").replace("\n  USING (auth.uid() IS NOT NULL)\n", "\n  USING (true)\n")));
    expect(noPolicy).toMatch(/statement not in its canonical source[^\n]*CREATE POLICY xbrl_concept_map_read/);
  }, 60_000);
  it("the one historical divergence is RESOLVED forward (never allowlisted): no open drift remains", () => {
    const r = checkMigrationAuthority(ROOT) as Result;
    expect(r.knownDrift).toEqual([]);
    expect(r.resolved).toEqual([
      "0006_pr32_02_upload_lifecycle_retire_and_replace: REVOKE ALL ON FUNCTION public.can_user_act_on_workspace(uuid, uuid, text) FROM PUBLIC, anon -> resolved by 20260925150000_can_user_act_on_workspace_minimum_grant.sql",
    ]);
    expect(Object.keys(PINNED).sort()).toEqual(["0003_service_enquiry_intake_reconciliation_assert", "0006_pr32_02_upload_lifecycle_retire_and_replace", "0023_security_fix_probe_and_xbrl_concept_map"]);
  });
  it("fails when the resolving migration loses its corrective statement, or is missing", () => {
    const dir = copyRepo();
    try {
      const f = path.join(dir, "supabase/migrations/20260925150000_can_user_act_on_workspace_minimum_grant.sql");
      // Drop `authenticated` from the corrective REVOKE (the same clause whether or not the file is an atomic envelope).
      const original = fs.readFileSync(f, "utf8");
      const tampered = original.replace("public.can_user_act_on_workspace(uuid, uuid, text) FROM PUBLIC, anon, authenticated", "public.can_user_act_on_workspace(uuid, uuid, text) FROM PUBLIC, anon");
      expect(tampered).not.toBe(original);
      fs.writeFileSync(f, tampered);
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
