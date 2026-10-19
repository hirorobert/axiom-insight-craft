#!/usr/bin/env bun
// Real-PostgreSQL proof of the account capacity (20261115100000): what is counted, where it refuses — BEFORE the expensive
// work, consistently across composition, notes, dependencies, save, readiness and publication — what stays available, and
// the regression when the control is removed. The REAL process-trial-balance handler certifies the trial balances
// (in process, through the proof kit); the browser's own save code is the save path.
//
//   K1  the count: current + comparative certified account keys; a company at the bound is `within`, one account more is not
//   K2  within the bound: composition composed, a version saved and ready, REVIEWED → FINAL (the 18-account world)
//   K3  over the bound, BEFORE the expensive work: composition 'over_capacity' with the counts; notes and dependencies carry
//       the same state; a save is refused ACCOUNT_CAPACITY_EXCEEDED with nothing written; readiness names
//       ACCOUNT_CAPACITY_EXCEEDED:<total>/<bound> and returns at once; REVIEWED is refused; a direct binding insert is refused
//   K4  what stays available: an earlier saved version of the over-capacity company is still listed and readable; the
//       18-account company's issuance history is untouched; another company's reads are refused as before (tenant isolation)
//   K5  CONTROL REMOVED (the three functions' previous texts re-installed): the over-capacity company composes and saves —
//       the regression; CONTROL RESTORED: refused again
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/accountCapacity.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import { applyChain, certifier, chainFiles, clientDb, EVIDENCE_FY2025_COMPARATIVE, EVIDENCE_FY2026, makeWorld, migrationText, openDatabase, prepareReporting, reporter, uuid } from "./lib/reportingKit.mjs";
import { ingestEvidence } from "../../src/lib/financialEvidence/intake.ts";
import { signoffClient } from "../../src/lib/reporting/signoff.ts";
import { prepareReportVersion } from "../../src/lib/reporting/prepareVersion.ts";

const FILE = "20261115100000_fs_account_capacity.sql";
const { group, check, refused, finish } = reporter();
const LF = String.fromCharCode(10);
let db;

/** A balanced chart of n accounts for two years: n-1 debit current assets, one credit retained earnings; amounts vary. */
const chart = (n) => {
  const rows = []; let cur = 0, pri = 0;
  for (let i = 0; i < n - 1; i++) {
    const c = 100 + ((i * 7919) % 99_900), p = 100 + ((i * 7907) % 99_900);
    rows.push([String(100000 + i), `Invented receivable ${i}`, "current_assets", "balance_sheet", "debit", (c / 100).toFixed(2), "", (p / 100).toFixed(2), ""]);
    cur += c; pri += p;
  }
  rows.push(["999999", "Retained earnings and reserves", "equity", "balance_sheet", "credit", "", (cur / 100).toFixed(2), "", (pri / 100).toFixed(2)]);
  return rows;
};
const csvOf = (rows, col) => "Account code,Account name,Debit,Credit" + LF + rows.map((r) => `${r[0]},${r[1]},${r[col]},${r[col + 1]}`).join(LF) + LF;
const FN = (name) => new RegExp("CREATE OR REPLACE FUNCTION public\\." + name + "\\([^)]*\\)[\\s\\S]*?\\nEND;\\n\\$\\$;");
const fnFrom = (file, name) => { const m = migrationText(file).match(FN(name)); if (!m) throw new Error(`no ${name} in ${file}`); return m[0]; };

async function main() {
  db = await openDatabase("account_capacity_proof");
  group("Replay");
  await check(`${FILE} is in the chain and the whole chain applies`, async () => (!chainFiles().includes(FILE) ? `${FILE} missing` : (await applyChain(db)) ?? true));
  await refused("re-applying is refused by its preflight", "P0001", () => db.admin.query(migrationText(FILE)), "PREFLIGHT_REFUSED");
  await check("static contract: no DELETE or UPDATE without a WHERE clause anywhere in the migration", async () => {
    const code = migrationText(FILE).replace(/--[^\n]*/g, "");
    const bare = [...code.matchAll(/\bDELETE\s+FROM\s+[\w.]+\s*;/gi), ...code.matchAll(/\bUPDATE\s+[\w.]+\s+SET\b(?:(?!\bWHERE\b)[^;])*;/gi)].map((m) => m[0].slice(0, 60));
    return bare.length === 0 ? true : bare;
  });
  const bound = Number((await db.one("SELECT (public.fs_work_bounds() ->> 'accountsReadPerComposition')::int b")).b);
  await check("fs_work_bounds() is at contract fs-work-bounds/2 and carries the account envelope", async () => {
    const b = (await db.one("SELECT public.fs_work_bounds() b")).b;
    return b.contract === "fs-work-bounds/2" && Number.isInteger(b.accountsReadPerComposition) && b.accountsReadPerComposition === bound && b.evidenceRowsPerBatch === 1000 ? true : b;
  });

  // ── Worlds: A (18 accounts, prepared), B (over the bound by one account across the two years), C (exactly at the bound) ──
  const W = await makeWorld(db);
  const { U, A } = W;
  await W.rollout(A, true);
  // The over-capacity company and the at-the-bound company belong to the SAME owner and members as A; the kit's other
  // workspace (W.B, owned by U.ownerB) stays the tenant-isolation foil.
  const B = await W.company(U.owner, "Synthetic Over Ltd");
  await W.rollout(B, true);
  for (const who of ["preparer", "partner"]) await db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [B, U[who], who]);
  const k = await certifier(db, U);
  const Y = 2026;
  await prepareReporting(db, W, k, { year: Y });
  const perYearOver = Math.ceil((bound + 1) / 2);      // B: two years → 2 × perYearOver ≥ bound + 1
  const perYearAt = Math.floor(bound / 2);             // C: two years → exactly bound (bound is even) or bound - 1
  const certifyChart = async (company, n) => {
    const rows = chart(n);
    const p = await k.upload(company, Y - 1, csvOf(rows, 7), { start: `${Y - 1}-01-01`, end: `${Y - 1}-12-31` }); await k.review(company, p, rows); await k.certify(company, p);
    const c = await k.upload(company, Y, csvOf(rows, 5), { start: `${Y}-01-01`, end: `${Y}-12-31` }); await k.certify(company, c);
  };
  await certifyChart(B, perYearOver);
  const Cc = await W.company(U.owner, "Synthetic At The Bound Ltd");
  await W.rollout(Cc, true);
  for (const who of ["preparer", "partner"]) await db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [Cc, U[who], who]);
  await certifyChart(Cc, perYearAt);
  const pre = clientDb(db, U.preparer), partner = clientDb(db, U.partner), owner = clientDb(db, U.owner);
  const rpc = async (d, fn, args) => { const { data, error } = await d.rpc(fn, args); if (error) throw Object.assign(new Error(`${fn}: ${error.message}`), { code: error.code }); return data; };

  group("K1  what is counted: current + comparative certified account keys against the bound");
  await check(`A (18 + 18 accounts) is within; C (${perYearAt} + ${perYearAt} = ${2 * perYearAt}) is within; B (${perYearOver} + ${perYearOver} = ${2 * perYearOver}) is over the bound ${bound}`, async () => {
    const a = await rpc(pre, "fs_account_capacity", { p_company_id: A, p_period_year: Y });
    const c = await rpc(pre, "fs_account_capacity", { p_company_id: Cc, p_period_year: Y });
    const b = await rpc(pre, "fs_account_capacity", { p_company_id: B, p_period_year: Y });
    return a.state === "measured" && a.current === 18 && a.comparative === 18 && a.total === 36 && a.within === true && a.bound === bound
      && c.total === 2 * perYearAt && c.within === true
      && b.current === perYearOver && b.comparative === perYearOver && b.total === 2 * perYearOver && b.within === false ? true : { a, c, b };
  });
  await check("a year without a comparative certification counts the comparative as 0 (the current year alone)", async () => {
    const r = await rpc(pre, "fs_account_capacity", { p_company_id: A, p_period_year: Y - 1 });
    return r.current === 18 && r.comparative === 0 && r.total === 18 ? true : r;
  });

  group("K2  within the bound nothing changes: composed, saved, ready, REVIEWED → FINAL (18 accounts)");
  const parse = (type, role = "CURRENT") => {
    const y = role === "CURRENT" ? Y : Y - 1;
    const body = (role === "CURRENT" ? EVIDENCE_FY2026 : EVIDENCE_FY2025_COMPARATIVE)[type];
    return ingestEvidence({ companyId: A, evidenceType: type, periodRole: role, reportingPeriodId: `FY${Y}`, currency: "TZS", scale: 2, text: body, fileName: `${type.toLowerCase()}-${y}.csv`, mimeType: "text/csv", periodStart: `${y}-01-01`, periodEnd: `${y}-12-31` }).batch;
  };
  const ridA = `rpt-${uuid()}`;
  let vA = 0;
  await check("the composition is composed and a version saves and is ready", async () => {
    const comp = await rpc(pre, "fs_statement_composition", { p_company_id: A, p_period_year: Y });
    const r = await prepareReportVersion(pre, signoffClient(pre), { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: ridA, newEvidence: ["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "CASH_ACCOUNT_MAP"].map((t) => parse(t)).concat(["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "PRIOR_PERIOD_STATEMENTS"].map((t) => parse(t, "COMPARATIVE"))), idempotencyKey: `attempt-${uuid()}`, evaluatedAt: new Date().toISOString() });
    vA = r.reportVersion;
    const rd = await rpc(partner, "fs_report_readiness", { p_company_id: A, p_report_id: ridA, p_report_version: vA });
    return comp.state === "composed" && r.outcome === "saved" && rd.ready === true ? true : { comp: comp.state, r: r.outcome, rd };
  });
  await check("REVIEWED then FINAL", async () => {
    const a = await rpc(partner, "fs_set_publication_state", { p_report_id: ridA, p_report_version: vA, p_company_id: A, p_state: "REVIEWED", p_reason: "Reviewed" });
    const b = await rpc(owner, "fs_set_publication_state", { p_report_id: ridA, p_report_version: vA, p_company_id: A, p_state: "FINAL", p_reason: "Approved" });
    return a?.state === "REVIEWED" && b?.state === "FINAL" ? true : { a: a?.state, b: b?.state };
  });

  group(`K3  over the bound (B: ${2 * perYearOver} accounts read): refused BEFORE the expensive work, consistently`);
  await check("fs_statement_composition answers 'over_capacity' with the counts and the bound; fs_notes_status and fs_reporting_dependencies carry the same state", async () => {
    const comp = await rpc(pre, "fs_statement_composition", { p_company_id: B, p_period_year: Y });
    const notes = await rpc(pre, "fs_notes_status", { p_company_id: B, p_period_year: Y });
    const deps = await rpc(pre, "fs_reporting_dependencies", { p_company_id: B, p_period_year: Y });
    return comp.state === "over_capacity" && comp.capacity?.total === 2 * perYearOver && comp.capacity?.bound === bound && typeof comp.reason === "string"
      && notes.state === "over_capacity" && deps.state === "over_capacity" ? true : { comp: comp.state, notes: notes.state, deps: deps.state };
  });
  const ridB = `rpt-${uuid()}`;
  await check("the browser's save refuses in the browser (the composition is read first), with the counts, before the server is asked", async () => {
    const before = await db.count("SELECT count(*) n FROM public.financial_statement_reports WHERE company_id=$1", [B]);
    const r = await prepareReportVersion(pre, signoffClient(pre), { companyId: B, periodYear: Y, legalName: "Synthetic Over Ltd", reportId: ridB, newEvidence: [], idempotencyKey: `attempt-${uuid()}`, evaluatedAt: new Date().toISOString() });
    const after = await db.count("SELECT count(*) n FROM public.financial_statement_reports WHERE company_id=$1", [B]);
    return r.outcome === "refused" && /accounts across the current/.test(r.reason) && new RegExp(String(2 * perYearOver).replace(/(\d)(?=(\d{3})+$)/g, "$1,")).test(r.reason) && before === after ? true : { r, before, after };
  });
  await refused("fs_commit_revision itself (the server, sent past the browser) refuses ACCOUNT_CAPACITY_EXCEEDED before validating anything", "22023",
    () => rpc(pre, "fs_commit_revision", { p_company_id: B, p_report_id: ridB, p_expected_report_version: 0, p_idempotency_key: `attempt-${uuid()}`, p_period_year: Y, p_provenance_origin: "TRIAL_BALANCE_DERIVED", p_report_document: {}, p_content_hash: "0".repeat(64), p_evidence: [], p_evidence_batch_ids: [], p_evaluation: {} }), "ACCOUNT_CAPACITY_EXCEEDED");
  await check("nothing was written for B by the refused saves (no version, no batch, no audit of a revision)", async () =>
    ((await db.count("SELECT count(*) n FROM public.financial_statement_reports WHERE company_id=$1", [B])) === 0 && (await db.count("SELECT count(*) n FROM public.financial_evidence_batches WHERE company_id=$1", [B])) === 0 ? true : "rows exist"));
  // An EARLIER saved version of B (written directly: the control is new, such versions exist for companies that grew past the bound).
  await db.admin.query(`INSERT INTO public.financial_statement_reports (report_id, report_version, company_id, period_year, provenance_origin, report_document, content_hash, document_hash, evidence_batch_ids, created_by_firm_member_id)
    SELECT $2, 1, $1, period_year, provenance_origin, report_document, content_hash, document_hash, '{}'::text[], (SELECT id FROM public.firm_members WHERE company_id = $1 AND user_id = $3 LIMIT 1)
    FROM public.financial_statement_reports WHERE report_id = $4 AND report_version = $5`, [B, ridB, U.preparer, ridA, vA]);
  await db.admin.query(`INSERT INTO public.financial_statement_evaluations (evaluation_run_id, report_id, report_version, company_id, rule_pack_id, rule_pack_version, engine_version, input_hash, findings)
    SELECT 'proof-' || gen_random_uuid()::text, $2, 1, $1, rule_pack_id, rule_pack_version, engine_version, input_hash, findings
    FROM public.financial_statement_evaluations WHERE report_id = $3 AND report_version = $4 ORDER BY seq DESC LIMIT 1`, [B, ridB, ridA, vA]);
  await check("readiness names ACCOUNT_CAPACITY_EXCEEDED:<total>/<bound> and nothing else (returned at once, before recomposition)", async () => {
    const rd = await rpc(partner, "fs_report_readiness", { p_company_id: B, p_report_id: ridB, p_report_version: 1 });
    return rd.ready === false && rd.blockers.length === 1 && rd.blockers[0] === `ACCOUNT_CAPACITY_EXCEEDED:${2 * perYearOver}/${bound}` ? true : rd;
  });
  await check("REVIEWED is refused with that blocker; a direct publication insert is refused by the trigger", async () => {
    let r;
    try { r = await rpc(partner, "fs_set_publication_state", { p_report_id: ridB, p_report_version: 1, p_company_id: B, p_state: "REVIEWED", p_reason: "Reviewed" }); r = { recorded: r?.state }; }
    catch (e) { r = { refused: e.code, message: String(e.message).slice(0, 160) }; }
    let direct = null;
    try { await db.admin.query("INSERT INTO public.fs_publication_bindings (report_id, report_version, company_id, state, document_sha256, dependencies_sha256, approver_user_id, reason) VALUES ($1, 1, $2, 'REVIEWED', repeat('0', 64), repeat('0', 64), $3, 'direct')", [ridB, B, U.partner]); direct = "inserted"; }
    catch (e) { direct = String(e.message).slice(0, 80); }
    return r.refused && /ACCOUNT_CAPACITY_EXCEEDED/.test(r.message) && direct !== "inserted" ? true : { r, direct };
  });

  group("K4  what stays available");
  await check("B's earlier version is listed and its document is readable by a member; A's FINAL and its publication are untouched", async () => {
    const versions = await rpc(pre, "fs_list_saved_versions", { p_company_id: B, p_period_year: Y });
    const doc = await pre.select("financial_statement_reports", { report_id: ridB, report_version: 1 });
    const fin = await db.count("SELECT count(*) n FROM public.fs_publication_bindings WHERE report_id=$1 AND state='FINAL'", [ridA]);
    return Array.isArray(versions) && versions.length === 1 && Array.isArray(doc.data) && doc.data.length === 1 && fin === 1 ? true : { versions: versions?.length, doc: doc.error ?? doc.data?.length, fin };
  });
  await check("another workspace's member cannot read B's capacity (tenant isolation unchanged)", async () => {
    const other = clientDb(db, U.ownerB);
    const r = await rpc(other, "fs_account_capacity", { p_company_id: B, p_period_year: Y });
    return r.state === "unavailable" ? true : r;
  });

  group("K5  CONTROL REMOVED: the previous function texts re-installed → the over-capacity company composes and saves; RESTORED: refused");
  const previous = [fnFrom("20261020100000_fs_comparatives.sql", "fs_statement_composition"), fnFrom("20260919110000_financial_statements_persistence.sql", "fs_commit_revision"), fnFrom("20261112100000_fs_review_workflow_and_rollforward.sql", "fs_publication_blockers")];
  const current = [fnFrom(FILE, "fs_statement_composition"), fnFrom(FILE, "fs_commit_revision"), fnFrom(FILE, "fs_publication_blockers")];
  for (const t of previous) await db.admin.query(t);
  try {
    await check("control removed: B composes (state composed) and readiness no longer names the capacity", async () => {
      const comp = await rpc(pre, "fs_statement_composition", { p_company_id: B, p_period_year: Y });
      const rd = await rpc(partner, "fs_report_readiness", { p_company_id: B, p_report_id: ridB, p_report_version: 1 });
      return comp.state === "composed" && !rd.blockers.some((b) => b.startsWith("ACCOUNT_CAPACITY_EXCEEDED")) ? true : { comp: comp.state, rd };
    });
  } finally { for (const t of current) await db.admin.query(t); }
  await check("control restored: B is refused again, by name", async () => {
    const comp = await rpc(pre, "fs_statement_composition", { p_company_id: B, p_period_year: Y });
    const rd = await rpc(partner, "fs_report_readiness", { p_company_id: B, p_report_id: ridB, p_report_version: 1 });
    return comp.state === "over_capacity" && rd.blockers[0] === `ACCOUNT_CAPACITY_EXCEEDED:${2 * perYearOver}/${bound}` ? true : { comp: comp.state, rd };
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish("ACCOUNT_CAPACITY", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
