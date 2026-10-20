#!/usr/bin/env bun
// Real-PostgreSQL proof of the transaction memo (20261116100000): the composition and the reporting input are computed ONCE
// per transaction, every answer is unchanged, the memo never outlives a transaction, and the account-capacity guard still
// fires. Measured with pg_stat_xact_user_functions inside the very transaction that runs the readiness call.
//
//   M1  one fs_report_readiness call at 500 accounts per year: _fs_statement_composition_compute runs once and
//       _fs_reporting_input_compute once (before: 5 and 7 — the duplicate recomputation); readiness is identical
//   M2  the answers do not change: composition, notes, dependencies (their identities) and readiness are equal with the memo
//       and with the control removed (the compute texts re-installed under the public names)
//   M3  no stale answer across transactions: a presentation change in one request is seen by the next composition call
//   M4  the capacity guard still refuses through the memo (an over-capacity company answers over_capacity)
//   M5  the memo is internal: authenticated cannot call the compute or memo functions directly
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/transactionMemo.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import { applyChain, certifier, chainFiles, clientDb, makeWorld, migrationText, openDatabase, reporter, uuid } from "./lib/reportingKit.mjs";
import { ASSIGN, CODES, CURRENT, EVIDENCE, NOTES, NOT_APPLICABLE, PERIODS, PPE_SCHEDULE, PRIOR, TB } from "../e2e/localStackFixtures.mjs";
import { ingestEvidence } from "../../src/lib/financialEvidence/intake.ts";
import { signoffClient } from "../../src/lib/reporting/signoff.ts";
import { prepareReportVersion } from "../../src/lib/reporting/prepareVersion.ts";

const FILE = "20261116100000_fs_transaction_memo.sql";
const { group, check, refused, finish } = reporter();
const LF = String.fromCharCode(10);
let db;
const minor = (t) => (t ? Math.round(Number(t) * 100) : 0);
const money = (m) => (m / 100).toFixed(2);
/** The reviewed 18-account chart scaled to n accounts per year (the bank account unsplit, every other account split into parts). */
const scaledRows = (n) => {
  const parents = TB.filter((r) => r[0] !== CODES.bank); const parts = n - 1; const base = Math.floor(parts / parents.length), extra = parts - base * parents.length;
  const rows = [TB.find((r) => r[0] === CODES.bank)];
  parents.forEach((r, pi) => { const k = base + (pi < extra ? 1 : 0); const cur = minor(r[5] || r[6]), pri = minor(r[7] || r[8]); const cd = !!r[5], pd = !!r[7];
    for (let i = 0; i < k; i++) { const cm = i === k - 1 ? cur - Math.floor(cur / k) * (k - 1) : Math.floor(cur / k); const pm = i === k - 1 ? pri - Math.floor(pri / k) * (k - 1) : Math.floor(pri / k);
      rows.push([`${r[0]}${String(i).padStart(3, "0")}`, `${r[1]} ${i + 1}`, r[2], r[3], r[4], cd ? money(cm) : "", cd ? "" : money(cm), pd ? money(pm) : "", pd ? "" : money(pm)]); } });
  return rows;
};
const parentOf = (code) => (code === CODES.bank ? code : code.slice(0, -3));
const csvOf = (rows, col) => "Account code,Account name,Debit,Credit" + LF + rows.map((r) => `${r[0]},${r[1]},${r[col]},${r[col + 1]}`).join(LF) + LF;
const paddedLedger = (rowsN) => {
  const lines = EVIDENCE.current.TRANSACTION_LEDGER.trimEnd().split(LF);
  const target = (rowsN - (lines.length - 1)) % 2 === 0 ? rowsN : rowsN - 1;
  for (let i = lines.length - 1; i < target; i++) { const m = 7 + (i % 12); const y = m > 12 ? 2026 : 2025; const mm = ((m - 1) % 12) + 1; const d = 1 + (i % 28);
    lines.push(`N${i},${y}-${String(mm).padStart(2, "0")}-${String(d).padStart(2, "0")},${CODES.bank},Invented ${i % 2 ? "payment" : "receipt"} ${i},${i % 2 ? "" : "1.00"},${i % 2 ? "1.00" : ""},OPERATING,${i % 2 ? "Payments to suppliers and employees" : "Receipts from customers"}`); }
  return lines.join(LF) + LF;
};
const FN = (name) => new RegExp("CREATE OR REPLACE FUNCTION public\\." + name + "\\([^)]*\\)[\\s\\S]*?\\nEND;\\n\\$\\$;");
const fnFrom = (file, name) => { const m = migrationText(file).match(FN(name)); if (!m) throw new Error(`no ${name} in ${file}`); return m[0]; };

async function main() {
  db = await openDatabase("transaction_memo_proof");
  group("Replay");
  await check(`${FILE} is in the chain and the whole chain applies`, async () => (!chainFiles().includes(FILE) ? `${FILE} missing` : (await applyChain(db)) ?? true));
  await refused("re-applying is refused by its preflight", "P0001", () => db.admin.query(migrationText(FILE)), "PREFLIGHT_REFUSED");
  await check("static contract: no DELETE or UPDATE anywhere in the migration (DDL only)", async () => {
    const code = migrationText(FILE).replace(/--[^\n]*/g, "");
    const hits = [...code.matchAll(/\b(DELETE\s+FROM|UPDATE\s+[\w.]+\s+SET)\b/gi)].map((m) => m[0]);
    return hits.length === 0 ? true : hits;
  });

  // ── A 500-accounts-per-year company, prepared to a saved version with a 1,000-row ledger (the capacity candidate) ─────────
  const W = await makeWorld(db);
  const { U, A } = W;
  await W.rollout(A, true);
  const k = await certifier(db, U);
  const Y = 2026;
  const rows = scaledRows(500);
  const decisions = rows.map(([code, name, cls, st, nb]) => ({ account_code: code, account_name: name, proposal_type: "NONE", decision_action: "USER_MANUAL_CLASSIFICATION", statement: st, classification: cls, normal_balance: nb, is_cash_account: code === CODES.bank }));
  const p = await k.upload(A, Y - 1, csvOf(rows, PRIOR), { start: PERIODS.prior.start, end: PERIODS.prior.end });
  await db.asUser(U.owner, "SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb)", [A, p.id, uuid(), JSON.stringify(decisions)]); await k.certify(A, p);
  const c = await k.upload(A, Y, csvOf(rows, CURRENT), { start: PERIODS.current.start, end: PERIODS.current.end }); await k.certify(A, c);
  const pre = clientDb(db, U.preparer), partner = clientDb(db, U.partner);
  const rpc = async (d, fn, args) => { const { data, error } = await d.rpc(fn, args); if (error) throw Object.assign(new Error(`${fn}: ${error.message}`), { code: error.code }); return data; };
  const assign = rows.map(([code]) => ({ accountKey: code, lineId: ASSIGN[parentOf(code)] }));
  for (let i = 0; i < assign.length; i += 500) await rpc(pre, "fs_assign_presentation", { p_company_id: A, p_assignments: assign.slice(i, i + 500), p_reason: "Presentation per the chart of accounts", p_request_id: uuid() });
  await rpc(pre, "close_review_refresh_findings", { p_company_id: A, p_period_year: Y });
  const st0 = await rpc(pre, "close_review_finding_states", { p_company_id: A, p_period_year: Y }); const st = Array.isArray(st0) ? st0 : st0 ? [st0] : [];
  for (const f of st.filter((x) => !x.resolved)) await rpc(pre, "close_review_finding_action", { p_finding_id: f.finding_id, p_action: "explain", p_text: "Reviewed against the fixed asset register", p_evidence_ref: "FAR", p_request_id: uuid() });
  await rpc(pre, "fs_decide_requirement", { p_company_id: A, p_period_year: Y, p_requirement_id: "smes.note.share_capital", p_decision: "applicable", p_reason: "The entity has share capital", p_request_id: uuid() });
  for (const id of NOT_APPLICABLE) await rpc(pre, "fs_decide_requirement", { p_company_id: A, p_period_year: Y, p_requirement_id: id, p_decision: "not_applicable", p_reason: "None in the periods presented", p_request_id: uuid() });
  for (const [id, text] of Object.entries(NOTES)) await rpc(pre, "fs_record_disclosure", { p_company_id: A, p_period_year: Y, p_requirement_id: id, p_body: text, p_source_ref: "Notes v1", p_request_id: uuid() });
  await rpc(pre, "fs_record_schedule", { p_company_id: A, p_period_year: Y, p_schedule_id: "ppe", p_rows: PPE_SCHEDULE, p_source_ref: "Fixed asset register FY2026", p_request_id: uuid() });
  await rpc(partner, "fs_approve_comparatives", { p_company_id: A, p_period_year: Y, p_approve: true, p_reason: "Agreed", p_request_id: uuid() });
  const parse = (type, role, text, period) => { const r = ingestEvidence({ companyId: A, evidenceType: type, periodRole: role, reportingPeriodId: `FY${Y}`, currency: "TZS", scale: 2, text, fileName: `${type.toLowerCase()}.csv`, mimeType: "text/csv", periodStart: period.start, periodEnd: period.end }); if (r.outcome !== "PARSED") throw new Error(type + " " + JSON.stringify(r.diagnostics).slice(0, 200)); return r.batch; };
  const ev = [parse("TRANSACTION_LEDGER", "CURRENT", paddedLedger(1000), PERIODS.current), parse("EQUITY_MOVEMENTS", "CURRENT", EVIDENCE.current.EQUITY_MOVEMENTS, PERIODS.current), parse("CASH_ACCOUNT_MAP", "CURRENT", EVIDENCE.current.CASH_ACCOUNT_MAP, PERIODS.current),
    parse("TRANSACTION_LEDGER", "COMPARATIVE", EVIDENCE.prior.TRANSACTION_LEDGER, PERIODS.prior), parse("EQUITY_MOVEMENTS", "COMPARATIVE", EVIDENCE.prior.EQUITY_MOVEMENTS, PERIODS.prior), parse("PRIOR_PERIOD_STATEMENTS", "COMPARATIVE", EVIDENCE.prior.PRIOR_PERIOD_STATEMENTS, PERIODS.prior)];
  const rid = `rpt-${uuid()}`;
  const saved = await prepareReportVersion(pre, signoffClient(pre), { companyId: A, periodYear: Y, legalName: "Synthetic 500", reportId: rid, newEvidence: ev, idempotencyKey: `attempt-${uuid()}`, evaluatedAt: new Date().toISOString() });
  if (saved.outcome !== "saved") throw new Error(`setup: the save was not saved: ${saved.reason}`);
  const v = saved.reportVersion;
  const COMPUTE = ["_fs_statement_composition_compute", "_fs_reporting_input_compute", "fs_statement_composition", "fs_reporting_input"];
  // One readiness call as PostgREST would run it (one transaction, the partner's claims), with the function statistics of THAT
  // transaction read before it commits (pg_stat_xact_user_functions): exact counts, independent of the shared collector's
  // flush timing (CI runs 39374190705 and 39375957485 read 0 from pg_stat_user_functions before the backend had flushed).
  const readinessMeasured = async () => {
    const c = await db.pool.connect();
    try {
      await c.query("BEGIN"); await c.query("SET LOCAL track_functions = 'all'"); await c.query("SET LOCAL ROLE authenticated");
      await c.query("SELECT set_config('request.jwt.claim.role', 'authenticated', true), set_config('request.jwt.claim.sub', $1, true)", [U.partner]);
      // The view also carries the backend's not-yet-flushed counts from earlier transactions on this pooled connection: report the difference.
      const countsNow = async () => { const st = await c.query("SELECT funcname, calls, round(total_time) AS ms FROM pg_stat_xact_user_functions WHERE schemaname = 'public' AND funcname = ANY($1)", [COMPUTE]); const o = {}; for (const n of COMPUTE) o[n] = { calls: 0, ms: 0 }; for (const x of st.rows) o[x.funcname] = { calls: Number(x.calls), ms: Number(x.ms) }; return o; };
      const before = await countsNow();
      const t0 = performance.now();
      const r = await c.query("SELECT public.fs_report_readiness($1, $2, $3) AS rd", [A, rid, v]);
      const ms = Math.round(performance.now() - t0);
      const after = await countsNow();
      await c.query("COMMIT");
      const counts = {}; for (const n of COMPUTE) counts[n] = { calls: after[n].calls - before[n].calls, ms: after[n].ms - before[n].ms };
      return { ms, rd: r.rows[0].rd, counts };
    } catch (e) { try { await c.query("ROLLBACK"); } catch { /* */ } throw e; } finally { c.release(); }
  };
  const identity = async () => {
    const comp = await rpc(pre, "fs_statement_composition", { p_company_id: A, p_period_year: Y });
    const notes = await rpc(pre, "fs_notes_status", { p_company_id: A, p_period_year: Y });
    const deps = await rpc(pre, "fs_reporting_dependencies", { p_company_id: A, p_period_year: Y });
    const rd = await rpc(partner, "fs_report_readiness", { p_company_id: A, p_report_id: rid, p_report_version: v });
    return { composition: comp.compositionSha256, notes: notes.statusSha256, deps: deps.dependenciesSha256, ready: rd.ready, blockers: rd.blockers };
  };

  group("M1  one readiness call at 500 accounts per year: each authority computed once");
  let withMemo;
  await check("fs_statement_composition and fs_reporting_input are each COMPUTED once inside one fs_report_readiness (the wrappers are entered several times)", async () => {
    const m = await readinessMeasured();
    withMemo = { ms: m.ms, rd: m.rd };
    const c = m.counts;
    console.log(`        readiness with the memo: ${withMemo.ms} ms in process; compute calls ${JSON.stringify(c)}`);
    return c._fs_statement_composition_compute?.calls === 1 && c._fs_reporting_input_compute?.calls === 1 && (c.fs_statement_composition?.calls ?? 0) >= 2 && (c.fs_reporting_input?.calls ?? 0) >= 2 ? true : c;
  });

  group("M2  the answers are unchanged: identities and readiness equal with the memo and with the control removed");
  const memoised = await identity();
  const previousComp = fnFrom("20261115100000_fs_account_capacity.sql", "fs_statement_composition");
  const previousInput = fnFrom("20261016100000_fs_reporting_input.sql", "fs_reporting_input");
  const current = [fnFrom(FILE, "fs_statement_composition"), fnFrom(FILE, "fs_reporting_input")];
  let withoutMemo;
  await db.admin.query(previousComp); await db.admin.query(previousInput);
  try {
    await check("control removed (the compute texts under the public names): the same identities and readiness; the composition is computed 5 times and the input 7 times in one readiness call", async () => {
      const plain = await identity();
      const m = await readinessMeasured();
      withoutMemo = { ms: m.ms };
      const c = m.counts;
      console.log(`        readiness without the memo: ${withoutMemo.ms} ms in process; public-name calls ${JSON.stringify(c)}`);
      return JSON.stringify(plain) === JSON.stringify(memoised) && (c.fs_statement_composition?.calls ?? 0) >= 4 && (c.fs_reporting_input?.calls ?? 0) >= 6 ? true : { plain, memoised, c };
    });
  } finally { for (const t of current) await db.admin.query(t); }
  await check("control restored: identities unchanged again; the memoised readiness is faster than the plain one (measured in process)", async () => {
    const again = await identity();
    return JSON.stringify(again) === JSON.stringify(memoised) && withMemo.ms < withoutMemo.ms ? true : { again, memoised, withMemo: withMemo.ms, withoutMemo: withoutMemo.ms };
  });

  group("M3  no stale answer across transactions");
  await check("a presentation change in one request is seen by the next composition call (the memo died with its transaction)", async () => {
    const before = (await rpc(pre, "fs_statement_composition", { p_company_id: A, p_period_year: Y })).compositionSha256;
    const first = rows[1][0]; // a receivable part → inventories
    const r = await rpc(pre, "fs_assign_presentation", { p_company_id: A, p_assignments: [{ accountKey: first, lineId: "sfp.inventories" }], p_reason: "Reclassified for the proof", p_request_id: uuid() });
    const after = (await rpc(pre, "fs_statement_composition", { p_company_id: A, p_period_year: Y })).compositionSha256;
    return r?.outcome === "recorded" && before !== after ? true : { r, before, after };
  });

  group("M4  the capacity guard still refuses through the memo");
  await check("a company over the envelope answers over_capacity (the guard lives in the compute body)", async () => {
    const B = await W.company(U.owner, "Synthetic Over Ltd"); await W.rollout(B, true);
    for (const who of ["preparer", "partner"]) await db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [B, U[who], who]);
    const bound = Number((await db.one("SELECT (public.fs_work_bounds() ->> 'accountsReadPerComposition')::int b")).b);
    const per = Math.ceil((bound + 1) / 2);
    const big = scaledRows(per);
    const dec = big.map(([code, name, cls, st, nb]) => ({ account_code: code, account_name: name, proposal_type: "NONE", decision_action: "USER_MANUAL_CLASSIFICATION", statement: st, classification: cls, normal_balance: nb, is_cash_account: code === CODES.bank }));
    const p1 = await k.upload(B, Y - 1, csvOf(big, PRIOR), { start: PERIODS.prior.start, end: PERIODS.prior.end });
    await db.asUser(U.owner, "SELECT public.resolve_account_review_batch($1,$2,$3,$4::jsonb)", [B, p1.id, uuid(), JSON.stringify(dec)]); await k.certify(B, p1);
    const c1 = await k.upload(B, Y, csvOf(big, CURRENT), { start: PERIODS.current.start, end: PERIODS.current.end }); await k.certify(B, c1);
    const comp = await rpc(pre, "fs_statement_composition", { p_company_id: B, p_period_year: Y });
    return comp.state === "over_capacity" && comp.capacity?.total === 2 * per ? true : comp;
  });

  group("M5  the memo and the compute bodies are internal");
  await refused("authenticated cannot call _fs_statement_composition_compute", "42501", () => rpc(pre, "_fs_statement_composition_compute", { p_company_id: A, p_period_year: Y }));
  await refused("authenticated cannot call _fs_memo_put", "42501", () => rpc(pre, "_fs_memo_put", { p_key: "x", p_body: {} }));
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish("TRANSACTION_MEMO", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
