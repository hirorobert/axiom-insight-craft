/**
 * CF-03 (independent readiness assessment, 2026-11-01): tax_computations, tax_payments, capital_allowances and
 * management_inputs were writable from the browser by any accepted member (membership-only RLS write policies plus
 * INSERT/UPDATE/DELETE grants to `authenticated`), and shipped — withheld, unrouted — panels performed those writes.
 *
 * Two halves of the repair, both asserted here:
 *   1. the database: 20261212100000_legacy_financial_write_revocation.sql drops every client write policy on the four
 *      tables and revokes the client write privileges, keeping SELECT and service_role (the engine) untouched;
 *   2. the browser: no file under src/ (components, jurisdiction packs, hooks, pages, lib — everything the bundle ships)
 *      calls insert / update / upsert / delete on any of the four tables. The database refuses such a write anyway once
 *      the migration is applied; this keeps the source honest in the meantime and stops a write path being re-added.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const SRC = join(ROOT, "src");
const MIGRATIONS = join(ROOT, "supabase/migrations");
const MIGRATION = "20261212100000_legacy_financial_write_revocation.sql";
const TABLES = ["tax_computations", "tax_payments", "capital_allowances", "management_inputs"] as const;
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
};
const rel = (p: string) => relative(ROOT, p).replace(/\\/g, "/");

/** Every `.from("<table>")` chain in `src` with the statement that follows it (up to the terminating `;`). */
function fromChains(src: string, table: string): string[] {
  const re = new RegExp(`\\.from\\((["'])${table}\\1\\)`, "g");
  const out: string[] = [];
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const end = src.indexOf(";", m.index);
    out.push(src.slice(m.index, end === -1 ? src.length : end));
  }
  return out;
}

describe("CF-03 browser boundary: nothing in src/ writes the four legacy tax tables", () => {
  const files = walk(SRC);
  it("scans the whole bundle source, including the withheld jurisdiction-pack panels", () => {
    expect(files.length).toBeGreaterThan(100);
    for (const f of ["src/jurisdiction-packs/tz/AddBacksWorkpaper.tsx", "src/jurisdiction-packs/tz/PaymentLedgerPanel.tsx",
      "src/jurisdiction-packs/tz/KingaFindingsPanel.tsx", "src/jurisdiction-packs/tz/CapitalAllowancesRegister.tsx",
      "src/jurisdiction-packs/tz/KingaTaxPanel.tsx"]) expect(files.map(rel), f).toContain(f);
  });

  it("no .from(<table>) chain continues into insert / update / upsert / delete", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = read(f);
      for (const table of TABLES) {
        for (const chain of fromChains(src, table)) {
          if (/\.(insert|update|upsert|delete)\s*\(/.test(chain)) offenders.push(`${rel(f)} -> ${table}: ${chain.split("\n")[0].trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the tables are still READ from the browser (the revocation removes writes, not visibility)", () => {
    const readers = files.filter((f) => TABLES.some((t) => fromChains(read(f), t).some((c) => /\.select\s*\(/.test(c))));
    expect(readers.length).toBeGreaterThan(3);
  });

  it.each([
    ["src/jurisdiction-packs/tz/AddBacksWorkpaper.tsx", "tax_computations"],
    ["src/jurisdiction-packs/tz/PaymentLedgerPanel.tsx", "tax_payments"],
    ["src/jurisdiction-packs/tz/KingaFindingsPanel.tsx", "tax_payments"],
    ["src/jurisdiction-packs/tz/CapitalAllowancesRegister.tsx", "capital_allowances"],
    ["src/jurisdiction-packs/tz/KingaTaxPanel.tsx", "management_inputs"],
  ])("%s says the figures are recorded by the engine instead of offering a form that writes %s", (file, table) => {
    const src = read(join(ROOT, file));
    expect(src).toMatch(/recorded by the engine/i);
    expect(src).toContain(MIGRATION);
    expect(src).not.toMatch(new RegExp(`\\.from\\(["']${table}["']\\)[\\s\\S]{0,300}?\\.(insert|update|upsert)\\(`));
  });
});

describe("CF-03 database boundary: 20261212100000 retires every client write path on the four tables", () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const sql = read(join(MIGRATIONS, MIGRATION));

  it("preserves the exact tail: source access, CF-03, QuickBooks storage and readiness, the stack migrations, the financial-table revocation, transfers/post-closing and the compiler identity that carries them, then the first-period review read model and the contra-account designation", () => {
    expect(files.slice(-15)).toEqual(["20261211100000_source_access_authority_repairs.sql", MIGRATION, "20261213100000_qbo_connector_storage.sql", "20261214100000_qbo_readiness_controls.sql", "20261215100000_api_cache_control_headers.sql", "20261216100000_ready_for_reporting_pilot.sql", "20261217100000_first_period_governed_review.sql", "20261218100000_issued_comparative_schedules.sql", "20261219100000_rfr_prior_pack_basis.sql", "20261220100000_statement_compiler_casting_declaration.sql", "20261221100000_financial_table_member_write_revocation.sql", "20261222100000_fs_cash_transfers_and_post_closing.sql", "20261222200000_statement_compiler_transfers_post_closing.sql", "20261223100000_first_period_review_page_read_model.sql", "20261224100000_contra_account_designation.sql"]);
  });

  it("drops exactly the eleven client write policies the chain created (every INSERT/UPDATE/DELETE policy on these tables)", () => {
    const dropped = [...sql.matchAll(/DROP POLICY IF EXISTS "([^"]+)"\s+ON public\.(\w+);/g)].map((m) => `${m[2]}.${m[1]}`).sort();
    expect(dropped).toEqual([
      "capital_allowances.ca_delete", "capital_allowances.ca_insert", "capital_allowances.ca_update",
      "management_inputs.mi_insert", "management_inputs.mi_update",
      "tax_computations.tc_delete", "tax_computations.tc_insert", "tax_computations.tc_update",
      "tax_payments.tax_payments_delete", "tax_payments.tax_payments_insert", "tax_payments.tax_payments_update",
    ]);
    // Those are indeed every non-SELECT, non-service_role policy the authored chain creates on the four tables.
    const created = new Set<string>();
    for (const f of files.filter((f) => f !== MIGRATION)) {
      const text = read(join(MIGRATIONS, f));
      for (const m of text.matchAll(/CREATE POLICY\s+"?([\w]+)"?\s+ON\s+public\.(tax_computations|tax_payments|capital_allowances|management_inputs)\s+(?:AS\s+\w+\s+)?FOR\s+(\w+)\s+TO\s+(\w+)/gi)) {
        if (m[3].toUpperCase() !== "SELECT" && m[4] !== "service_role") created.add(`${m[2]}.${m[1]}`);
      }
    }
    expect([...created].sort()).toEqual(dropped);
  });

  it("revokes INSERT, UPDATE, DELETE and TRUNCATE from PUBLIC, anon and authenticated on all four tables, at table and column level", () => {
    for (const t of TABLES) {
      expect(sql).toMatch(new RegExp(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public\\.${t}\\s+FROM PUBLIC, anon, authenticated;`));
    }
    expect(sql).toMatch(/REVOKE INSERT \(%1\$I\), UPDATE \(%1\$I\) ON TABLE %2\$s FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/has_any_column_privilege\(v_role, v_table, 'INSERT'\)/);
  });

  it("keeps SELECT and the service role: no GRANT, no SELECT-policy change, and SELECT asserted in the postcondition", () => {
    expect(sql).not.toMatch(/\bGRANT\b/);
    expect(sql).not.toMatch(/(DROP|CREATE|ALTER) POLICY[^;]*(tc_select|tax_payments_select|ca_select|mi_select|tc_service_all)/);
    expect(sql).toMatch(/has_table_privilege\('authenticated', v_table, 'SELECT'\)/);
    expect(sql).toMatch(/roles <> ARRAY\['service_role'\]::name\[\]/);
  });

  it("changes no row and is not transaction-wrapped: no DML, no BEGIN/COMMIT, and a preflight that refuses a second application", () => {
    expect(sql).not.toMatch(/\b(INSERT INTO|DELETE FROM|UPDATE\s+public\.)/);
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT);/m);
    expect(sql).toMatch(/PREFLIGHT_REFUSED: browser writes to the legacy tax tables are already retired/);
    expect(sql).toMatch(/POSTCONDITION_FAILED: a client write policy remains/);
  });

  it("leaves statement_sign_offs to its own reviewed candidate (named, not applied here)", () => {
    expect(sql).not.toMatch(/ON public\.statement_sign_offs/);
    expect(sql).toContain("docs/fin-integrity/candidate-migration/20261103100000_signoff_authorization_hardening.sql");
  });
});
