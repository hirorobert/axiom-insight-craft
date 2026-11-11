/**
 * Second-pass hostile validation 2026-11-11 (S2-S01, S2-S03, S2-S04): after CF-03 (20261212100000) the chain still let an
 * authenticated member write eighteen financial and evidence tables directly through PostgREST — some predicates accepted
 * an invitation that was never accepted — and three professional-input tables without capability or acceptance.
 *
 * The repair has three halves, all asserted here (the real-database half is scripts/db-proof/financialWriteBoundary.mjs):
 *   1. the database: 20261221100000_financial_table_member_write_revocation.sql drops every client write policy on the
 *      eighteen tables, revokes every write-class privilege (table and column level) and tightens the three input tables;
 *   2. the Edge Functions that wrote those tables with the CALLER's token now verify the caller (accepted, active named
 *      member + prepare_close) and write with the service role; the only caller-token writers left are registered below,
 *      and each is refused before it runs (restricted or withheld) or was already refused (no policy) on main;
 *   3. the browser: nothing under src/ writes the eighteen tables, and the two unrouted panels that signed off
 *      statements directly (PeriodCloseManager, the TZ pack's KingaTaxPanel) now only show status.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "../../..");
const MIGRATION = "20261221100000_financial_table_member_write_revocation.sql";
const read = (p: string) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const rel = (p: string) => relative(ROOT, p).replace(/\\/g, "/");
const walk = (dir: string, keep: (name: string) => boolean, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, keep, out);
    else if (keep(name)) out.push(p);
  }
  return out;
};

const SERVER_TABLES = [
  "period_closing_balances", "statement_sign_offs", "tax_losses", "account_pl_mapping",
  "variance_runs", "variance_analyses", "cashflow_forecasts", "maono_insights", "board_packs",
  "filing_obligations", "safisha_reconciliations", "safisha_transactions", "safisha_exceptions",
  "efdms_z_reports", "efdms_reconciliation", "efdms_records", "canonical_financial_records", "ingestion_batches",
] as const;

/** Every `.from("<table>")` write chain with the identifier of the client it was called on. */
function writeChains(src: string, table: string): { verb: string; client: string; line: number }[] {
  const re = new RegExp(`\\.from\\((["'\`])${table}\\1\\)`, "g");
  const out: { verb: string; client: string; line: number }[] = [];
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const end = src.indexOf(";", m.index);
    const chain = src.slice(m.index, end === -1 ? src.length : end);
    const verb = chain.match(/\.(insert|update|upsert|delete)\s*\(/)?.[1];
    if (!verb) continue;
    const client = src.slice(Math.max(0, m.index - 80), m.index).match(/([A-Za-z_$][\w$]*)\s*$/)?.[1] ?? "?";
    out.push({ verb, client, line: src.slice(0, m.index).split("\n").length });
  }
  return out;
}
const isServiceClient = (src: string, id: string) =>
  new RegExp(`const ${id}\\s*=\\s*createClient\\(\\s*Deno\\.env\\.get\\("SUPABASE_URL"\\)!?,\\s*Deno\\.env\\.get\\("SUPABASE_SERVICE_ROLE_KEY"\\)`).test(src);

describe("database: 20261221100000 retires every client write path on the eighteen tables", () => {
  const sql = read(`supabase/migrations/${MIGRATION}`);
  const files = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();

  it("follows the API cache-header hook directly; only the reviewed later pending migrations sort after it", () => {
    expect(files.slice(files.indexOf(MIGRATION) - 1)).toEqual(["20261215100000_api_cache_control_headers.sql", MIGRATION,
      "20261222100000_fs_cash_transfers_and_post_closing.sql", "20261222200000_statement_compiler_transfers_post_closing.sql",
      "20261223100000_first_period_governed_review_standalone.sql", "20261224100000_contra_account_designation.sql"]);
  });

  it("names exactly the eighteen server-written tables and the three professional-input tables", () => {
    const server = sql.match(/v_server CONSTANT TEXT\[\] := ARRAY\[([\s\S]*?)\];/)?.[1] ?? "";
    expect([...server.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort()).toEqual([...SERVER_TABLES].sort());
    expect(sql).toMatch(/v_input\s+CONSTANT TEXT\[\] := ARRAY\['variance_budgets', 'variance_materiality', 'variance_alerts'\];/);
  });

  it("drops exactly the client write policies the chain leaves on them (the proof checks pg_policies is then empty of them)", () => {
    const dropped = [...sql.matchAll(/DROP POLICY IF EXISTS "([^"]+)"\s+ON public\.(\w+);/g)].map((m) => `${m[2]}.${m[1]}`).sort();
    expect(dropped).toEqual([
      "account_pl_mapping.account_pl_mapping_delete", "account_pl_mapping.account_pl_mapping_update", "account_pl_mapping.account_pl_mapping_write",
      "board_packs.board_packs_insert",
      "canonical_financial_records.canonical_records_insert", "canonical_financial_records.canonical_records_insert_restrictive",
      "cashflow_forecasts.cashflow_insert",
      "efdms_reconciliation.efdms_recon_write",
      "efdms_records.Users can ingest EFDMS records for their companies", "efdms_records.efdms_company_ownership_insert",
      "efdms_z_reports.efdms_insert",
      "filing_obligations.filing_obligations_member_write",
      "ingestion_batches.ingestion_batches_insert", "ingestion_batches.ingestion_batches_insert_restrictive",
      "maono_insights.insights_insert",
      "period_closing_balances.pcb_insert", "period_closing_balances.pcb_update",
      "safisha_exceptions.safisha_exc_insert",
      "safisha_reconciliations.safisha_recon_insert", "safisha_reconciliations.safisha_recon_update",
      "safisha_transactions.safisha_txn_insert",
      "statement_sign_offs.sso_insert", "statement_sign_offs.sso_update_partner_owner", "statement_sign_offs.sso_update_preparer",
      "tax_losses.tl_insert", "tax_losses.tl_update",
      "variance_alerts.alerts_acknowledge",
      "variance_analyses.analyses_insert",
      "variance_budgets.budget_submit",
      "variance_runs.runs_insert",
    ]);
    // the two re-created input policies are capability-bound; nothing else is created
    expect([...sql.matchAll(/CREATE POLICY "(\w+)" ON public\.(\w+)/g)].map((m) => `${m[2]}.${m[1]}`).sort())
      .toEqual(["variance_alerts.alerts_acknowledge", "variance_budgets.budget_submit"]);
    expect(sql).toMatch(/"budget_submit" ON public\.variance_budgets FOR INSERT TO authenticated\s+WITH CHECK \(public\.workspace_capability_allowed\(company_id, auth\.uid\(\), 'prepare_close'\)/);
    expect(sql).toMatch(/WITH CHECK \(acknowledged_by = auth\.uid\(\)/);
  });

  it("revokes every write-class privilege from PUBLIC, anon and authenticated, table and column level, MAINTAIN where it exists", () => {
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public\.%I FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/REVOKE INSERT \(%1\$I\), UPDATE \(%1\$I\), REFERENCES \(%1\$I\) ON TABLE public\.%2\$I FROM PUBLIC, anon, authenticated/);
    expect(sql).toMatch(/v_maintain CONSTANT BOOLEAN := current_setting\('server_version_num'\)::int >= 170000/);
    expect(sql).toMatch(/IF v_maintain THEN\s+EXECUTE format\('REVOKE MAINTAIN ON TABLE/);
    // the only grant: the three acknowledgement columns of an alert
    expect([...sql.matchAll(/^\s*GRANT [^;]+;/gm)].map((m) => m[0].trim())).toEqual([
      "GRANT UPDATE (acknowledged_by, acknowledged_at, acknowledgment_note) ON TABLE public.variance_alerts TO authenticated;",
    ]);
  });

  it("is one statement that changes no row, bounds its lock waits, refuses a second application and checks its own result", () => {
    const body = sql.replace(/^--.*$/gm, "").trim();
    expect(body.startsWith("DO $migration$")).toBe(true);
    expect(body.endsWith("$migration$;")).toBe(true);
    expect(sql).toMatch(/SET LOCAL lock_timeout = '5s';/);
    expect(sql).not.toMatch(/\b(INSERT INTO|DELETE FROM|TRUNCATE\s+(TABLE\s+)?public)\b/);
    expect(sql).not.toMatch(/^\s*UPDATE\s+public\./m);
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT);/m);
    expect(sql).toMatch(/PREFLIGHT_REFUSED: client writes to these financial tables are already retired/);
    expect(sql).toMatch(/POSTCONDITION_FAILED: a client write policy remains on a server-written financial table/);
    expect(sql).toMatch(/POSTCONDITION_FAILED: what the engines recorded must remain readable/);
    // SELECT and the service role are untouched
    expect(sql).not.toMatch(/(DROP|ALTER) POLICY[^;]*_(select|read)"/);
    expect(sql).not.toMatch(/service_role\s*;/);
  });
});

describe("Edge Functions: no caller-token write to a revoked table except the registered, refused ones", () => {
  const functions = walk(join(ROOT, "supabase/functions"), (n) => n === "index.ts").filter((f) => !rel(f).includes("/_shared/"));
  const offenders = () => {
    const out: string[] = [];
    for (const f of functions) {
      const src = read(rel(f));
      for (const t of [...SERVER_TABLES, "variance_alerts"]) {
        for (const w of writeChains(src, t)) {
          if (t === "variance_alerts" && w.verb !== "insert") continue;
          if (!isServiceClient(src, w.client)) out.push(`${rel(f).split("/")[2]}: ${t} ${w.verb}`);
        }
      }
    }
    return out.sort();
  };

  it("lists exactly the registered caller-token writers", () => {
    expect(offenders()).toEqual([
      "maono-compute: variance_analyses insert",   // restricted: openDefectRefusal before any read or write
      "maono-compute: variance_runs insert",
      "maono-compute: variance_runs update",
      "maono-decide: maono_insights insert",       // withheld: openDefectRefusal before any read or write
      "maono-risk: variance_alerts insert",        // no client INSERT policy ever existed: refused on main, refused now
      "maono-root-cause: maono_insights insert",   // withheld
    ]);
  });

  it.each(["maono-compute", "maono-decide", "maono-root-cause"])("%s refuses before it creates any client", (fn) => {
    const src = read(`supabase/functions/${fn}/index.ts`);
    const refusal = src.indexOf(`openDefectRefusal("${fn}", corsHeaders)`);
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(src.indexOf("createClient(", src.indexOf("serve(")));
  });

  it.each([
    ["safisha-efdms-ingest", ["efdms_z_reports", "efdms_reconciliation"]],
    ["maono-cashflow", ["cashflow_forecasts"]],
    ["maono-risk", ["maono_insights"]],
    ["safisha-categorize", ["safisha_exceptions", "safisha_reconciliations"]],
    ["safisha-score", ["safisha_exceptions", "safisha_reconciliations"]],
  ] as const)("%s verifies an accepted member holding prepare_close, then writes with the service role", (fn, tables) => {
    const src = read(`supabase/functions/${fn}/index.ts`);
    expect(src).toMatch(/import \{ resolveFirmMemberActor \} from "\.\.\/_shared\/actor\.ts";/);
    expect(src).toMatch(/const admin = createClient\(Deno\.env\.get\("SUPABASE_URL"\)!, Deno\.env\.get\("SUPABASE_SERVICE_ROLE_KEY"\)!\);/);
    const actor = src.indexOf("await resolveFirmMemberActor(admin, user.id, companyId, corsHeaders)");
    const cap = src.indexOf('hasWorkspaceCapability((fn, args) => admin.rpc(fn, args), companyId, user.id, "prepare_close")');
    expect(actor).toBeGreaterThan(-1);
    expect(cap).toBeGreaterThan(actor);
    for (const t of tables) {
      const writes = writeChains(src, t);
      expect(writes.length, t).toBeGreaterThan(0);
      for (const w of writes) {
        expect(w.client, `${t} ${w.verb}`).toBe("admin");
        expect(src.split("\n").slice(0, w.line).join("\n").length, `${t} written after the authority check`).toBeGreaterThan(cap);
      }
    }
  });

  it("the converted functions take the actor from the verified JWT, never the request body", () => {
    for (const fn of ["safisha-efdms-ingest", "maono-cashflow", "maono-risk", "safisha-categorize", "safisha-score"]) {
      const src = read(`supabase/functions/${fn}/index.ts`);
      expect(src).toMatch(/await supabase\.auth\.getUser\(\)/);
      expect(src).not.toMatch(/firm_member_id\s*[:=]\s*body\.|firmMemberId\s*=\s*body\./);
    }
  });
});

describe("browser: nothing in src/ writes the eighteen tables; the unrouted sign-off panels only show status", () => {
  const files = walk(join(ROOT, "src"), (n) => /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) && !/\.d\.ts$/.test(n));

  it("scans the whole bundle source, including the jurisdiction pack and the unrouted panels", () => {
    expect(files.length).toBeGreaterThan(100);
    for (const f of ["src/components/PeriodCloseManager.tsx", "src/jurisdiction-packs/tz/KingaTaxPanel.tsx", "src/components/maono/AlertCenter.tsx"]) {
      expect(files.map(rel)).toContain(f);
    }
  });

  const sources = files.map((f) => [f, readFileSync(f, "utf8").replace(/\r\n/g, "\n")] as const);

  it("no .from(<table>) chain on a server-written table continues into insert / update / upsert / delete", () => {
    const out: string[] = [];
    for (const [f, src] of sources) {
      for (const t of SERVER_TABLES) if (src.includes(t)) for (const w of writeChains(src, t)) out.push(`${rel(f)}:${w.line} ${t} ${w.verb}`);
    }
    expect(out).toEqual([]);
  });

  it("a browser write to variance_alerts sets only the acknowledgement columns", () => {
    for (const [f, src] of sources) {
      if (!src.includes("variance_alerts")) continue;
      for (const m of src.matchAll(/\.from\(["']variance_alerts["']\)\s*\.(insert|update|upsert|delete)\(\{([\s\S]*?)\}\)/g)) {
        expect(m[1], rel(f)).toBe("update");
        const keys = [...m[2].matchAll(/^\s*(\w+)\s*:/gm)].map((k) => k[1]).sort();
        expect(keys, rel(f)).toEqual(["acknowledged_at", "acknowledged_by", "acknowledgment_note"]);
      }
    }
  });

  it.each([
    ["src/components/PeriodCloseManager.tsx", "period-close-signoff-read-only"],
    ["src/jurisdiction-packs/tz/KingaTaxPanel.tsx", "kinga-signoff-read-only"],
  ])("%s says sign-off is recorded by the server and offers no signing control", (file, testId) => {
    const src = read(file);
    expect(src).toContain(MIGRATION);
    expect(src).toContain(`data-testid="${testId}"`);
    expect(src).toMatch(/recorded by the server-side statements workflow/);
    expect(src).not.toMatch(/handleSign|Approve & Lock|Confirm Signature|Lock Period<\/|setSignOffNote/);
    expect(src).toMatch(/\.from\("statement_sign_offs"\)\s*\.select\(/);   // status is still read
  });
});
