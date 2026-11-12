// Native proof of 20261221100000_financial_table_member_write_revocation.sql on the real migration chain in a disposable loopback
// PostgreSQL. Synthetic data only; never a hosted database. Second-pass hostile validation 2026-11-11: S2-S01, S2-S03, S2-S04.
//
// World: the chain up to main (everything before the migration), two workspaces A and B, each with an owner, a partner, a preparer,
// a viewer (all accepted) and an invited-but-not-accepted member, a current FIRM plan, and one row in every table the migration
// touches. Every write attempt below runs as the `authenticated` role with the request's JWT claims set (auth.uid() = the member),
// inside a transaction that is ALWAYS rolled back, so the seeded content never moves and its hash can be compared across the
// migration. Outcomes: "wrote n" (the write took effect for n rows), "zero" (allowed but affected nothing), or the SQLSTATE.
//
// PROOF_MODE=present (default): BEFORE demonstrations, then the migration under lock contention (a long transaction -> 55P03 and
// nothing changed; a short one -> it waits and completes), then every AFTER case. PROOF_MODE=absent: the same world and the same
// AFTER assertions WITHOUT the migration; the manifest's weakness cases must fail there (the defect is real on main).
// DB_PROOF_MODE=external DB_PROOF_CONN=postgres://... | DB_PROOF_MODULES_DIR=<dir>
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyChainBefore, migrationText, openDatabase, REPO, uuid } from "./lib/reportingKit.mjs";
import { CASES, INPUT_TABLES, MIGRATION, PROOF, SERVER_TABLES } from "./financialWriteBoundary.manifest.mjs";

const MODE = process.env.PROOF_MODE === "absent" ? "absent" : "present";
const output = process.env.PROOF_RESULT_FILE ?? path.join(REPO, `proof-results/financialWriteBoundary.${MODE}.json`);
const manifestBytes = fs.readFileSync(new URL("./financialWriteBoundary.manifest.mjs", import.meta.url));
const results = [], failures = [];
let completed = false, crashed = false, crashMessage = null;
const ROLES = ["owner", "partner", "preparer", "viewer", "invited"];

function writeResult() {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ proof: PROOF, mode: MODE, manifestSha256: crypto.createHash("sha256").update(manifestBytes).digest("hex"), completed, crashed, crashMessage, cases: results }, null, 2) + "\n");
}
async function kase(id, fn) {
  const c = CASES.find((x) => x.id === id);
  assert(c, `case ${id} not in manifest`); assert(!results.some((r) => r.id === id), `duplicate ${id}`);
  if (!c.modes.includes(MODE)) return;
  try { await fn(); results.push({ id, outcome: "pass" }); console.log("PASS", id); }
  catch (e) {
    const detail = `${e.code ?? "assertion"}: ${String(e.message).split("\n").slice(0, 6).join(" | ")}`.slice(0, 1500);
    results.push({ id, outcome: "fail", code: e.code ?? "assertion", detail }); failures.push(id);
    console.log("FAIL", id, "-", detail);
  }
}

let db;
const W = {};          // W.A / W.B: { company, upload, run, recon, alert, uid: { owner, partner, ... } }

// ── one attempt, always rolled back ─────────────────────────────────────────────────────────────────────────────────
async function attempt(role, uid, sql, params = []) {
  const c = await db.pool.connect();
  try {
    await c.query("BEGIN");
    if (role !== "postgres") {
      await c.query(`SET LOCAL ROLE ${role}`);
      await c.query(`SELECT set_config('request.jwt.claim.role',$1,true), set_config('request.jwt.claim.sub',$2,true),
                            set_config('request.jwt.claims',$3,true)`, [role, uid ?? "", JSON.stringify(uid ? { sub: uid, role } : { role })]);
    }
    const r = await c.query(sql, params);
    return r.rowCount > 0 ? { kind: "wrote", n: r.rowCount, rows: r.rows } : { kind: "zero", rows: r.rows };
  } catch (e) {
    return { kind: "error", code: e.code, message: String(e.message).split("\n")[0] };
  } finally {
    try { await c.query("ROLLBACK"); } catch { /* */ }
    c.release();
  }
}
const show = (o) => (o.kind === "wrote" ? `wrote ${o.n}` : o.kind === "zero" ? "zero" : `${o.code}`);
const refused = (o) => o.kind === "zero" || (o.kind === "error" && o.code === "42501");
const privilegeDenied = (o) => o.kind === "error" && o.code === "42501" && /permission denied/.test(o.message);

// ── the tables: how to scope a tenant's rows, what a new row looks like, which column a no-op UPDATE touches ────────────────
const rnd = () => crypto.randomBytes(6).toString("hex");
const hex64 = () => crypto.randomBytes(32).toString("hex");
const TABLES = {
  period_closing_balances: { scope: (w) => ["company_id = $1", [w.company]], set: "period_year",
    row: (w) => ({ company_id: w.company, period_year: 2031, period_month: 12 }) },
  statement_sign_offs: { scope: (w) => ["company_id = $1", [w.company]], set: "preparer_note",
    row: (w) => ({ company_id: w.company, period_year: 2031, upload_id: w.upload, status: "draft" }) },
  tax_losses: { scope: (w) => ["company_id = $1", [w.company]], set: "period_year",
    row: (w, uid) => ({ company_id: w.company, period_year: 2031, created_by: uid }) },
  account_pl_mapping: { scope: (w) => ["company_id = $1", [w.company]], set: "match_value",
    row: (w) => ({ company_id: w.company, match_type: "exact", match_value: `P-${rnd()}`, pl_category: "REVENUE", source: "client_override" }) },
  variance_runs: { scope: (w) => ["company_id = $1", [w.company]], set: "status",
    row: (w, uid) => ({ company_id: w.company, tb_upload_ids: [w.upload], period_from: "2031-01-01", period_to: "2031-01-31", fiscal_year: 2031, period_month: 1, triggered_by: uid, status: "complete" }) },
  variance_analyses: { scope: (w) => ["company_id = $1", [w.company]], set: "account_code",
    row: (w) => ({ run_id: w.run, company_id: w.company, account_code: "4000", pl_category: "REVENUE" }) },
  cashflow_forecasts: { scope: (w) => ["company_id = $1", [w.company]], set: "week_number",
    row: (w) => ({ run_id: w.run, company_id: w.company, forecast_week: "2031-01-05", week_number: 1 }) },
  maono_insights: { scope: (w) => ["company_id = $1", [w.company]], set: "ai_output",
    row: (w) => ({ run_id: w.run, company_id: w.company, insight_type: "risk", input_snapshot: {}, ai_output: "fabricated", numeric_validation_passed: true }) },
  board_packs: { scope: (w) => ["company_id = $1", [w.company]], set: "period_label",
    row: (w, uid) => ({ company_id: w.company, period_label: "FY2031", sections_json: {}, generated_by: uid }) },
  filing_obligations: { scope: (w) => ["company_id = $1", [w.company]], set: "obligation_type",
    row: (w) => ({ company_id: w.company, obligation_type: "VAT", period_year: 2031, period_end: "2031-01-31" }) },
  safisha_reconciliations: { scope: (w) => ["tb_upload_id = $1", [w.upload]], set: "confidence_score",
    row: (w, uid) => ({ client_id: uid, tb_upload_id: w.upload2 ?? w.upload }) },
  safisha_transactions: { scope: (w) => ["reconciliation_id = $1", [w.recon]], set: "account_code",
    row: (w) => ({ reconciliation_id: w.recon, source_id: "bank", account_code: "1000", raw_row_hash: hex64() }) },
  safisha_exceptions: { scope: (w) => ["reconciliation_id = $1", [w.recon]], set: "description",
    row: (w) => ({ reconciliation_id: w.recon, account_code: "1000", category: "timing", variance: 1 }) },
  efdms_z_reports: { scope: (w) => ["company_id = $1", [w.company]], set: "gross_sales",
    row: (w) => ({ company_id: w.company, serial_number: `S-${rnd()}`, trader_tin: "100200300", report_date: "2031-01-02" }) },
  efdms_reconciliation: { scope: (w) => ["company_id = $1", [w.company]], set: "risk_notes",
    row: (w) => ({ company_id: w.company, fiscal_year: 2031, period_month: 2 }) },
  efdms_records: { scope: (w) => ["company_id = $1", [w.company]], set: "amount_tzs",
    row: (w) => ({ company_id: w.company, efdms_transaction_id: `T-${rnd()}`, record_type: "sale", transaction_date: "2031-01-02", period_year: 2031, period_month: 1, amount_tzs: 1 }) },
  canonical_financial_records: { scope: (w) => ["company_id = $1", [w.company]], set: "provider_name",
    row: (w, uid) => ({ batch_id: w.batch, company_id: w.company, record_type: "sale", canonical_date: "2031-01-02", period_year: 2031, period_month: 1, amount_tzs: 1,
      source_type: "manual_entry", provider_name: "proof", import_batch_id: `B-${rnd()}`, ingestion_contract_version: "1.0", payload_hash: hex64(), normalized_hash: hex64(), imported_by: uid, raw_payload: {}, requires_secondary_review: true, adapter_confidence: 0.5 }) },
  ingestion_batches: { scope: (w) => ["company_id = $1", [w.company]], set: "provider_name",
    row: (w, uid) => ({ company_id: w.company, source_type: "manual_entry", provider_name: "proof", import_batch_id: `B-${rnd()}`, record_count: 1, imported_by: uid }) },
  variance_budgets: { scope: (w) => ["company_id = $1", [w.company]], set: "account_code",
    row: (w, uid) => ({ company_id: w.company, fiscal_year: 2031, period_month: 1, account_code: `4${rnd().slice(0, 3)}`, submitted_by: uid }) },
  variance_materiality: { scope: (w) => ["company_id = $1", [w.company]], set: "pct_threshold",
    row: (w) => ({ company_id: w.company }) },
  variance_alerts: { scope: (w) => ["company_id = $1", [w.company]], set: "severity",
    row: (w) => ({ company_id: w.company, run_id: w.run, alert_type: "variance_threshold", severity: "warn", message: "seeded" }) },
};
const ALL = [...SERVER_TABLES, ...INPUT_TABLES];
assert.deepEqual(Object.keys(TABLES).sort(), [...ALL].sort());
const val = (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v);
function insertSql(table, row) {
  const cols = Object.keys(row);
  return [`INSERT INTO public.${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`, cols.map((c) => val(row[c]))];
}
const updateSql = (t, w) => { const [where, p] = TABLES[t].scope(w); return [`UPDATE public.${t} SET ${TABLES[t].set} = ${TABLES[t].set} WHERE ${where}`, p]; };
const deleteSql = (t, w) => { const [where, p] = TABLES[t].scope(w); return [`DELETE FROM public.${t} WHERE ${where}`, p]; };
const selectSql = (t, w) => { const [where, p] = TABLES[t].scope(w); return [`SELECT 1 FROM public.${t} WHERE ${where}`, p]; };

/** Every member of `tenant` attempting INSERT / UPDATE / DELETE on `table` scoped to `target`'s rows. */
async function matrix(table, tenant, target = tenant) {
  const out = {};
  for (const r of ROLES) {
    const uid = W[tenant].uid[r];
    out[r] = {
      insert: await attempt("authenticated", uid, ...insertSql(table, TABLES[table].row(W[target], uid))),
      update: await attempt("authenticated", uid, ...updateSql(table, W[target])),
      delete: await attempt("authenticated", uid, ...deleteSql(table, W[target])),
    };
  }
  return out;
}
const fmt = (m) => ROLES.map((r) => `${r}: I=${show(m[r].insert)} U=${show(m[r].update)} D=${show(m[r].delete)}`).join("; ");

async function hashes() {
  const out = {};
  for (const t of ALL) out[t] = (await db.one(`SELECT count(*)::int n, coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), 'empty') h FROM public.${t} x`));
  return out;
}
async function catalog() {
  const priv = {};
  for (const t of ALL) {
    priv[t] = {};
    for (const role of ["public", "anon", "authenticated"]) {
      const r = await db.one(`SELECT array_remove(ARRAY[
          CASE WHEN has_table_privilege($1,$2,'INSERT') THEN 'INSERT' END, CASE WHEN has_table_privilege($1,$2,'UPDATE') THEN 'UPDATE' END,
          CASE WHEN has_table_privilege($1,$2,'DELETE') THEN 'DELETE' END, CASE WHEN has_table_privilege($1,$2,'TRUNCATE') THEN 'TRUNCATE' END,
          CASE WHEN has_table_privilege($1,$2,'REFERENCES') THEN 'REFERENCES' END, CASE WHEN has_table_privilege($1,$2,'TRIGGER') THEN 'TRIGGER' END,
          CASE WHEN has_any_column_privilege($1,$2,'INSERT') THEN 'col:INSERT' END, CASE WHEN has_any_column_privilege($1,$2,'UPDATE') THEN 'col:UPDATE' END,
          CASE WHEN has_any_column_privilege($1,$2,'REFERENCES') THEN 'col:REFERENCES' END], NULL) p`, [role, `public.${t}`]);
      priv[t][role] = r.p;
    }
  }
  const policies = (await db.admin.query(`SELECT tablename t, policyname p, cmd, roles::text roles FROM pg_policies WHERE schemaname='public' AND tablename = ANY($1) ORDER BY 1,2`, [ALL])).rows;
  return { priv, policies };
}

// ── the world ───────────────────────────────────────────────────────────────────────────────────────────────────────
async function account(uid) {
  const prod = (await db.one("SELECT id FROM public.commercial_products WHERE code='CFOCLOSE'")).id;
  const bc = (await db.one("INSERT INTO public.billing_customers (owner_user_id, product_id) VALUES ($1,$2) RETURNING id", [uid, prod])).id;
  await db.admin.query("INSERT INTO public.commercial_licences (billing_customer_id, plan_id, status, source, effective_start, additional_seats) SELECT $1, id, 'ACTIVE', 'ADMIN_GRANT', now() - interval '1 day', 8 FROM public.commercial_plans WHERE product_id=$2 AND code='FIRM'", [bc, prod]);
}
async function tenant(key) {
  const uid = Object.fromEntries(ROLES.map((r) => [r, uuid()]));
  for (const r of ROLES) await db.admin.query("INSERT INTO auth.users (id,email) VALUES ($1,$2)", [uid[r], `${key.toLowerCase()}-${r}@example.test`]);
  await account(uid.owner);
  const company = (await db.one("INSERT INTO public.companies (user_id,name,reporting_framework) VALUES ($1,$2,'ifrs_for_smes') RETURNING id", [uid.owner, `Synthetic workspace ${key}`])).id;
  for (const r of ["partner", "preparer", "viewer"]) await db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [company, uid[r], r]);
  await db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,invited_by,invited_email,accepted_at) VALUES ($1,$2,'preparer',$3,$4,NULL)", [company, uid.invited, uid.owner, `${key.toLowerCase()}-invited@example.test`]);
  const w = { key, company, uid };
  // Seeded rows: written as the database owner with triggers and foreign-key checks off (replica), so each table holds a
  // row whose content the migration must leave untouched. Parents first.
  const c = await db.pool.connect();
  try {
    await c.query("BEGIN"); await c.query("SET LOCAL session_replication_role = replica");
    const ins = async (t, row) => (await c.query(...insertSql(t, row))).rows[0];
    w.upload = (await ins("trial_balance_uploads", { file_name: "synthetic.csv", file_path: `${uid.owner}/synthetic-${key}.csv`, file_size: 10, user_id: uid.owner, company_id: company, company_name: `Synthetic workspace ${key}`, period_year: 2030 })).id;
    w.run = (await ins("variance_runs", { ...TABLES.variance_runs.row(w, uid.owner), fiscal_year: 2030 })).id;
    w.recon = (await ins("safisha_reconciliations", TABLES.safisha_reconciliations.row(w, uid.owner))).id;
    // A second upload with no reconciliation yet: one reconciliation per upload, so new reconciliations target this one.
    w.upload2 = (await ins("trial_balance_uploads", { file_name: "synthetic-2.csv", file_path: `${uid.owner}/synthetic-${key}-2.csv`, file_size: 10, user_id: uid.owner, company_id: company, company_name: `Synthetic workspace ${key}`, period_year: 2031 })).id;
    w.batch = (await ins("ingestion_batches", TABLES.ingestion_batches.row(w, uid.owner))).id;
    for (const t of ALL) {
      if (["variance_runs", "safisha_reconciliations", "ingestion_batches"].includes(t)) continue;
      const row = TABLES[t].row(w, uid.owner);
      // A seeded year differs from the year the write attempts use (no unique-key collision); the two EFDMS-style
      // tables tie period_year to their own date by a CHECK, so they keep it.
      if ("period_year" in row && !["efdms_records", "canonical_financial_records"].includes(t)) row.period_year = 2030;
      if ("fiscal_year" in row) row.fiscal_year = 2030;
      const r = await ins(t, row);
      if (t === "variance_alerts") w.alert = r.id;
    }
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  return w;
}
const capability = async (w, r, cap) => (await db.one("SELECT public.has_workspace_capability($1,$2,$3) v", [w.company, w.uid[r], cap])).v;

// ── run ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
const watchdog = setTimeout(() => { crashed = true; crashMessage = "run deadline"; completed = false; writeResult(); console.log("FINANCIAL_WRITE_BOUNDARY: run deadline"); process.exit(1); }, Number(process.env.PROOF_RUN_DEADLINE_MS ?? 900_000));
try {
  db = await openDatabase("financial_write_boundary");
  let seeded;
  await kase("setup.chain-to-main-two-workspaces-five-members-each-and-a-row-in-every-table", async () => {
    const fail = await applyChainBefore(db, MIGRATION);
    assert.equal(fail, null, `chain before ${MIGRATION}: ${fail}`);
    W.A = await tenant("A"); W.B = await tenant("B");
    seeded = await hashes();
    for (const t of ALL) for (const k of ["A", "B"]) {
      const [where, p] = TABLES[t].scope(W[k]);
      assert.equal(await db.count(`SELECT count(*) n FROM public.${t} WHERE ${where}`, p), 1, `${t}: one seeded row in workspace ${k}`);
    }
    const caps = {};
    for (const r of ROLES) { caps[r] = ""; for (const cap of ["prepare_close", "review_close", "approve_certification"]) caps[r] += Number(await capability(W.A, r, cap)); }
    console.log("  capabilities (prepare_close, review_close, approve_certification) per member of A:", JSON.stringify(caps));
    assert.equal(caps.invited, "000", "an invitation that was never accepted confers no capability");
    assert.equal(caps.viewer, "000");
    assert.equal(caps.preparer[0], "1");
  });
  if (!W.A) throw new Error("setup failed");

  const before = {};
  await kase("before.every-server-written-table-accepts-a-direct-member-write", async () => {
    const missing = [];
    for (const t of SERVER_TABLES) {
      before[t] = await matrix(t, "A");
      console.log(`  BEFORE ${t}: ${fmt(before[t])}`);
      if (!ROLES.some((r) => ["insert", "update", "delete"].some((op) => before[t][r][op].kind === "wrote"))) missing.push(t);
    }
    assert.deepEqual(missing, [], "every server-written table accepted at least one direct member write on main");
  });
  await kase("before.an-invited-not-accepted-member-writes-period-closing-balances", async () => {
    const m = before.period_closing_balances ?? await matrix("period_closing_balances", "A");
    assert.equal(m.invited.insert.kind, "wrote", `invited insert: ${show(m.invited.insert)}`);
    assert.equal(m.invited.update.kind, "wrote", `invited update: ${show(m.invited.update)}`);
    assert.equal(m.viewer.insert.kind, "wrote", `viewer insert: ${show(m.viewer.insert)}`);
  });
  await kase("before.an-invited-not-accepted-member-submits-a-budget-and-rewrites-an-alert", async () => {
    const uid = W.A.uid.invited;
    const budget = await attempt("authenticated", uid, ...insertSql("variance_budgets", TABLES.variance_budgets.row(W.A, uid)));
    const alert = await attempt("authenticated", uid, "UPDATE public.variance_alerts SET severity = 'info', detail = 'rewritten' WHERE id = $1", [W.A.alert]);
    console.log(`  BEFORE invited: budget submit=${show(budget)} alert rewrite=${show(alert)}`);
    assert.equal(budget.kind, "wrote"); assert.equal(alert.kind, "wrote");
  });

  const crossTenant = async () => {
    const bad = [];
    for (const t of ALL) {
      for (const r of ROLES) {
        const uid = W.A.uid[r];
        const read = await attempt("authenticated", uid, ...selectSql(t, W.B));
        if (read.kind === "wrote") bad.push(`${t} ${r} read B (${read.n})`);
        const i = await attempt("authenticated", uid, ...insertSql(t, TABLES[t].row(W.B, uid)));
        const u = await attempt("authenticated", uid, ...updateSql(t, W.B));
        const d = await attempt("authenticated", uid, ...deleteSql(t, W.B));
        for (const [op, o] of [["insert", i], ["update", u], ["delete", d]]) if (!refused(o)) bad.push(`${t} ${r} ${op} into B: ${show(o)} ${o.message ?? ""}`);
      }
    }
    assert.deepEqual(bad, [], "a member of A neither reads nor writes B");
  };
  await kase("before.cross-tenant-reads-and-writes-are-refused", crossTenant);

  // ── the migration (present mode) ──────────────────────────────────────────────────────────────────────────────────
  const sql = migrationText(MIGRATION);
  const sessionHolding = async (lockSql, params) => {
    const c = await db.pool.connect(); await c.query("BEGIN"); await c.query(lockSql, params);
    let ended = false;
    return { end: async (how = "ROLLBACK") => { if (ended) return; ended = true; try { await c.query(how); } finally { c.release(); } } };
  };
  const startMigration = async () => {
    const c = await db.pool.connect();
    const pid = (await c.query("SELECT pg_backend_pid() p")).rows[0].p;
    const t0 = Date.now();
    const done = c.query(sql).then(() => ({ ok: true, ms: Date.now() - t0 }), (e) => ({ ok: false, code: e.code, message: String(e.message).split("\n")[0], ms: Date.now() - t0 }))
      .finally(() => c.release());
    return { pid, done };
  };
  const waitingOnLock = async (pid) => (await db.admin.query("SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted", [pid])).rowCount > 0;
  const until = async (pred, ms = 10_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
  const policyCount = async () => Number((await db.one("SELECT count(*) n FROM pg_policies WHERE schemaname='public' AND tablename = ANY($1) AND cmd <> 'SELECT'", [SERVER_TABLES])).n);

  await kase("migration.behind-a-long-transaction-it-fails-on-lock-timeout-and-changes-nothing", async () => {
    const policiesBefore = await policyCount();
    const catBefore = JSON.stringify(await catalog());
    // A writer holding a row lock on an authoritative table past the migration's 5 s lock budget.
    const holder = await sessionHolding("UPDATE public.period_closing_balances SET period_year = period_year WHERE company_id = $1", [W.A.company]);
    try {
      const m = await startMigration();
      assert(await until(() => waitingOnLock(m.pid)), "the migration queued behind the open transaction");
      const r = await m.done;
      console.log(`  lock-timeout run: ${JSON.stringify(r)}`);
      assert.equal(r.ok, false); assert.equal(r.code, "55P03", `expected lock_not_available, got ${r.code} ${r.message}`);
      assert(r.ms >= 4_500 && r.ms < 30_000, `bounded by lock_timeout, took ${r.ms} ms`);
    } finally { await holder.end("ROLLBACK"); }
    assert.equal(await policyCount(), policiesBefore, "no policy was dropped");
    assert.equal(JSON.stringify(await catalog()), catBefore, "no privilege or policy changed");
    assert.deepEqual(await hashes(), seeded, "no row lost or changed");
  });
  await kase("migration.behind-a-short-transaction-it-waits-then-completes", async () => {
    const holder = await sessionHolding("SELECT 1 FROM public.statement_sign_offs WHERE company_id = $1 FOR UPDATE", [W.A.company]);
    let r;
    try {
      const m = await startMigration();
      assert(await until(() => waitingOnLock(m.pid)), "the migration waits for the open transaction");
      await new Promise((res) => setTimeout(res, 500));
      assert(await waitingOnLock(m.pid), "still waiting, not failed, inside its lock budget");
      await holder.end("COMMIT");
      r = await m.done;
    } finally { await holder.end("ROLLBACK").catch(() => {}); }
    console.log(`  short-transaction run: ${JSON.stringify(r)}`);
    assert.equal(r.ok, true, `${r.code} ${r.message}`);
    assert.equal(await policyCount(), 0, "the write policies are gone");
  });
  await kase("migration.every-table-is-byte-identical-across-the-migration", async () => {
    assert.deepEqual(await hashes(), seeded);
  });
  await kase("migration.a-second-application-is-refused", async () => {
    const r = await db.admin.query(sql).then(() => null, (e) => e);
    assert(r && r.code === "P0001" && /PREFLIGHT_REFUSED: client writes to these financial tables are already retired/.test(r.message), `got ${r?.code} ${r?.message}`);
    assert.deepEqual(await hashes(), seeded);
  });

  // ── AFTER ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  await kase("after.no-member-role-can-insert-update-or-delete-a-server-written-table", async () => {
    const bad = [];
    for (const t of SERVER_TABLES) {
      const m = await matrix(t, "A");
      console.log(`  AFTER  ${t}: ${fmt(m)}`);
      for (const r of ROLES) for (const op of ["insert", "update", "delete"]) if (!refused(m[r][op])) bad.push(`${t} ${r} ${op}: ${show(m[r][op])}`);
    }
    assert.deepEqual(bad, []);
    // and the refusal is the privilege layer itself, not a policy or trigger outcome
    const pcb = await matrix("period_closing_balances", "A");
    for (const r of ROLES) for (const op of ["insert", "update", "delete"]) assert(privilegeDenied(pcb[r][op]), `${r} ${op}: ${show(pcb[r][op])} ${pcb[r][op].message ?? ""}`);
  });
  await kase("after.client-roles-hold-no-write-class-privilege-at-table-or-column-level", async () => {
    const { priv } = await catalog();
    const bad = [];
    for (const t of SERVER_TABLES) for (const role of ["public", "anon", "authenticated"]) if (priv[t][role].length) bad.push(`${t} ${role}: ${priv[t][role].join(",")}`);
    for (const t of INPUT_TABLES) for (const role of ["public", "anon", "authenticated"]) {
      const extra = priv[t][role].filter((p) => ["TRUNCATE", "REFERENCES", "TRIGGER", "col:REFERENCES"].includes(p) || (role !== "authenticated" && p !== "SELECT"));
      if (extra.length) bad.push(`${t} ${role}: ${extra.join(",")}`);
    }
    if (priv.variance_budgets.authenticated.includes("DELETE")) bad.push("variance_budgets authenticated: DELETE");
    if (priv.variance_alerts.authenticated.some((p) => ["INSERT", "UPDATE", "DELETE", "col:INSERT"].includes(p))) bad.push(`variance_alerts authenticated: ${priv.variance_alerts.authenticated}`);
    const cols = (await db.admin.query(`SELECT a.attname c FROM pg_attribute a WHERE a.attrelid='public.variance_alerts'::regclass AND a.attnum>0 AND NOT a.attisdropped
      AND has_column_privilege('authenticated','public.variance_alerts',a.attname,'UPDATE') ORDER BY 1`)).rows.map((x) => x.c);
    if (JSON.stringify(cols) !== JSON.stringify(["acknowledged_at", "acknowledged_by", "acknowledgment_note"])) bad.push(`variance_alerts updatable columns: ${cols}`);
    for (const t of ALL) if (!(await db.one("SELECT has_table_privilege('service_role',$1,'INSERT') AND has_table_privilege('service_role',$1,'UPDATE') v", [`public.${t}`])).v) bad.push(`${t}: service_role lost a privilege`);
    assert.deepEqual(bad, []);
  });
  await kase("after.no-client-write-policy-remains-on-a-server-written-table", async () => {
    const { policies } = await catalog();
    const writes = policies.filter((p) => SERVER_TABLES.includes(p.t) && p.cmd !== "SELECT" && p.roles !== "{service_role}");
    assert.deepEqual(writes, []);
    for (const t of SERVER_TABLES) assert(policies.some((p) => p.t === t && p.cmd === "SELECT"), `${t} keeps its SELECT policy`);
  });
  await kase("after.budget-submission-needs-an-accepted-member-holding-prepare-close", async () => {
    const out = {};
    for (const r of ROLES) out[r] = await attempt("authenticated", W.A.uid[r], ...insertSql("variance_budgets", TABLES.variance_budgets.row(W.A, W.A.uid[r])));
    const del = await attempt("authenticated", W.A.uid.owner, ...deleteSql("variance_budgets", W.A));
    console.log(`  AFTER budgets submit: ${ROLES.map((r) => `${r}=${show(out[r])}`).join(" ")}; owner delete=${show(del)}`);
    assert.equal(out.preparer.kind, "wrote", "a preparer (prepare_close) still submits a budget");
    assert(refused(out.invited), `invited: ${show(out.invited)}`);
    assert(refused(out.viewer), `viewer: ${show(out.viewer)}`);
    assert(privilegeDenied(del), `delete: ${show(del)}`);
    const forged = await attempt("authenticated", W.A.uid.preparer, ...insertSql("variance_budgets", TABLES.variance_budgets.row(W.A, W.A.uid.partner)));
    assert(refused(forged), `submitted_by someone else: ${show(forged)}`);
  });
  await kase("after.an-alert-can-only-be-acknowledged-once-by-a-review-close-holder-as-themselves", async () => {
    let holder = null;
    for (const r of ROLES) if (await capability(W.A, r, "review_close")) { holder = r; break; }
    assert(holder, "someone in A holds review_close");
    const ack = (r, by = W.A.uid[r], id = W.A.alert) => attempt("authenticated", W.A.uid[r],
      "UPDATE public.variance_alerts SET acknowledged_by = $2, acknowledged_at = now(), acknowledgment_note = 'reviewed' WHERE id = $1", [id, by]);
    const ok = await ack(holder);
    const asOther = await ack(holder, W.A.uid.preparer);
    const invited = await ack("invited");
    const viewer = await ack("viewer");
    const rewrite = await attempt("authenticated", W.A.uid[holder], "UPDATE public.variance_alerts SET severity = 'info' WHERE id = $1", [W.A.alert]);
    const insert = await attempt("authenticated", W.A.uid[holder], ...insertSql("variance_alerts", TABLES.variance_alerts.row(W.A)));
    // once acknowledged (by the service role here, committed), no client can overwrite the acknowledgement
    await db.asService("UPDATE public.variance_alerts SET acknowledged_by = $2, acknowledged_at = now(), acknowledgment_note = 'first' WHERE id = $1", [W.A.alert, W.A.uid[holder]]);
    const again = await ack(holder);
    await db.admin.query("SET session_replication_role = replica; UPDATE public.variance_alerts SET acknowledged_by = NULL, acknowledged_at = NULL, acknowledgment_note = NULL WHERE id = '" + W.A.alert + "'; SET session_replication_role = origin;");
    console.log(`  AFTER alerts (${holder} holds review_close): ack=${show(ok)} as-other=${show(asOther)} invited=${show(invited)} viewer=${show(viewer)} rewrite-severity=${show(rewrite)} insert=${show(insert)} re-ack=${show(again)}`);
    assert.equal(ok.kind, "wrote");
    assert(refused(asOther), `acknowledged_by someone else: ${show(asOther)}`);
    assert(refused(invited), `invited: ${show(invited)}`);
    assert(refused(viewer), `viewer: ${show(viewer)}`);
    assert(privilegeDenied(rewrite), `rewrite: ${show(rewrite)}`);
    assert(privilegeDenied(insert), `insert: ${show(insert)}`);
    assert(refused(again), `re-acknowledge: ${show(again)}`);
  });
  await kase("after.members-still-read-what-they-could-read", async () => {
    const bad = [];
    for (const t of ALL) {
      const owner = await attempt("authenticated", W.A.uid.owner, ...selectSql(t, W.A));
      if (owner.kind !== "wrote") bad.push(`${t}: owner reads ${show(owner)}`);
    }
    const pcb = await attempt("authenticated", W.A.uid.partner, ...selectSql("period_closing_balances", W.A));
    if (pcb.kind !== "wrote") bad.push(`period_closing_balances: partner reads ${show(pcb)}`);
    assert.deepEqual(bad, []);
  });
  await kase("after.cross-tenant-reads-and-writes-are-refused", crossTenant);
  await kase("after.the-service-role-still-writes-every-table", async () => {
    const bad = [];
    for (const t of ALL) {
      // The service role passes every privilege and policy; triggers still apply, so a write they accept is used per table:
      // a new sign-off row needs a passing statement validation (hesabu_gate_before_signoff), and materiality is one row per
      // workspace (its key is company_id), so those two are updated; every other table receives a new row.
      const o = t === "statement_sign_offs"
        ? await attempt("service_role", null, "UPDATE public.statement_sign_offs SET preparer_note = 'server' WHERE company_id = $1", [W.A.company])
        : t === "variance_materiality"
          ? await attempt("service_role", null, "UPDATE public.variance_materiality SET pct_threshold = pct_threshold WHERE company_id = $1", [W.A.company])
          : await attempt("service_role", null, ...insertSql(t, TABLES[t].row(W.A, W.A.uid.owner)));
      if (o.kind !== "wrote") bad.push(`${t}: ${show(o)} ${o.message ?? ""}`);
    }
    assert.deepEqual(bad, []);
  });
  await kase("after.materiality-stays-review-close-professional-input", async () => {
    let holder = null;
    for (const r of ROLES) if (await capability(W.A, r, "review_close")) { holder = r; break; }
    const ok = await attempt("authenticated", W.A.uid[holder], "UPDATE public.variance_materiality SET pct_threshold = pct_threshold WHERE company_id = $1", [W.A.company]);
    const viewer = await attempt("authenticated", W.A.uid.viewer, "UPDATE public.variance_materiality SET pct_threshold = pct_threshold WHERE company_id = $1", [W.A.company]);
    const invited = await attempt("authenticated", W.A.uid.invited, "UPDATE public.variance_materiality SET pct_threshold = pct_threshold WHERE company_id = $1", [W.A.company]);
    console.log(`  materiality: ${holder}=${show(ok)} viewer=${show(viewer)} invited=${show(invited)}`);
    assert.equal(ok.kind, "wrote"); assert(refused(viewer)); assert(refused(invited));
  });
  completed = true;
} catch (e) {
  crashed = true; crashMessage = String(e?.message ?? e).split("\n")[0];
  console.log("CRASH", e);
} finally {
  clearTimeout(watchdog);
  writeResult();
  if (db) await db.close();
}
const ok = completed && !crashed && failures.length === 0;
console.log(`\nFINANCIAL_WRITE_BOUNDARY (${MODE}): ${results.length} cases, ${failures.length} failed${failures.length ? ": " + failures.join(", ") : ""}`);
process.exit(ok ? 0 : 1);
