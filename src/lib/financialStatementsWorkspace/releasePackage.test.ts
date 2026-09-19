// Guards the release package: the operator SQL and runbook exist, hold no secret,
// name only the audited operator functions, and the manifest (when present) matches
// the migration files it describes.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.join(__dirname, "../../../");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const lf = (s: string) => s.replace(/\r\n/g, "\n");
const SQL_DIR = "docs/release/sql";
const sqlFiles = fs.readdirSync(path.join(ROOT, SQL_DIR)).sort();

describe("release package", () => {
  it("ships preflight, postcondition and the three operator scripts", () => {
    expect(sqlFiles).toEqual(["01_preflight.sql", "02_postcondition.sql", "03_activate_company.sql", "04_deactivate_company.sql", "05_kill_switch.sql"]);
    for (const f of ["docs/release/FINANCIAL_STATEMENTS_ACTIVATION.md", "docs/release/FINANCIAL_STATEMENTS_RELEASE_PACKAGE.md", "scripts/release/verify-release-sql.mjs", "scripts/release/build-manifest.mjs"]) {
      expect(fs.existsSync(path.join(ROOT, f)), f).toBe(true);
    }
  });

  it("no release file contains a credential, a JWT, a connection string with a password, or a real project host", () => {
    const files = [...sqlFiles.map((f) => `${SQL_DIR}/${f}`), "docs/release/FINANCIAL_STATEMENTS_ACTIVATION.md", "docs/release/FINANCIAL_STATEMENTS_RELEASE_PACKAGE.md", "scripts/release/build-manifest.mjs", "scripts/release/verify-release-sql.mjs"];
    for (const f of files) {
      const text = read(f);
      expect(text, f).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
      expect(text, f).not.toMatch(/postgres(ql)?:\/\/[^\s:@]+:[^\s@]+@(?!localhost|127\.0\.0\.1)/);
      expect(text, f).not.toMatch(/\.supabase\.co/);
      expect(text, f).not.toMatch(/sb_secret_|service_role_key\s*[:=]\s*['"][A-Za-z0-9]/i);
    }
  });

  it("the production project reference never appears in product code, operator SQL or the two new migrations", () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel, out);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel);
      }
      return out;
    };
    const files = [...walk("src"), ...sqlFiles.map((f) => `${SQL_DIR}/${f}`), "supabase/migrations/20260920000000_financial_statements_rollout_control.sql", "supabase/migrations/20260920100000_financial_statements_persistence.sql"];
    expect(files.filter((f) => /bvyivmmfjejbmqoydezk/.test(read(f)))).toEqual([]);
  });

  it("operator scripts call only the audited service_role functions and demand a reason and operator", () => {
    expect(read(`${SQL_DIR}/03_activate_company.sql`)).toMatch(/fs_set_company_rollout\('<COMPANY_UUID>'::uuid, true, '<[^']+>', '<operator name>'\)/);
    expect(read(`${SQL_DIR}/04_deactivate_company.sql`)).toMatch(/fs_set_company_rollout\('<COMPANY_UUID>'::uuid, false/);
    expect(read(`${SQL_DIR}/05_kill_switch.sql`)).toMatch(/fs_set_kill_switch\(true/);
    for (const f of sqlFiles.slice(2)) expect(read(`${SQL_DIR}/${f}`), f).not.toMatch(/UPDATE\s+public\.financial|INSERT\s+INTO\s+public\.financial|DELETE\s+FROM|TRUNCATE|DROP\s/i);
  });

  it("preflight and postcondition change nothing", () => {
    for (const f of ["01_preflight.sql", "02_postcondition.sql"]) expect(read(`${SQL_DIR}/${f}`).replace(/--.*$/gm, ""), f).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|TRUNCATE\s|DROP\s|ALTER\s|CREATE\s|GRANT\s|REVOKE\s)/i);
  });

  it("the manifest, once generated, matches the migration files and declares nothing applied or enabled", () => {
    const p = path.join(ROOT, "docs/release/release-manifest.json");
    if (!fs.existsSync(p)) return;
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(Object.keys(m.migrations)).toEqual(["supabase/migrations/20260920000000_financial_statements_rollout_control.sql", "supabase/migrations/20260920100000_financial_statements_persistence.sql"]);
    for (const [file, hash] of Object.entries(m.migrations)) expect(createHash("sha256").update(lf(read(file))).digest("hex"), file).toBe(hash);
    expect(m.applied).toEqual({ productionMigration: false, productionFunctionsDeployed: false, productionFeatureEnabled: false });
    expect(Object.values(m.requiredGateState).filter((v) => typeof v === "boolean").every((v) => v === false)).toBe(true);
    expect(JSON.stringify(m)).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
  });
});
