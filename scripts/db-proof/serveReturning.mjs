#!/usr/bin/env bun
// NON-PRODUCTION. A DISPOSABLE PostgreSQL (embedded, or an EMPTY loopback database in CI) with the whole migration chain, a returning
// client built through the real functions up to the moment the accountant opens the engagement for the new year, and a LOOPBACK HTTP
// bridge for the returning-client browser journey (dev-harness/returning):
//
//   · three certified years (each uploaded ONCE), the FY2025 pack REVIEWED then FINAL in CFOClose with an approved accrual of 100.00;
//   · FY2026 certified once, presentation assigned, Close Review and notes done, evidence saved with a first draft version;
//   · the four files an accountant would pick for Check my books: the QuickBooks general-ledger export, last year's approved closing figure,
//     the document register and the checking settings.
//
// The bridge simulates PostgREST for `authenticated` (x-sim-user names a fixture user; it is NOT GoTrue) and plays the Edge Function
// rfr-check-books in process (a signed-in member with prepare_close; the service credential only for the engine). Nothing here is production.
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/serveReturning.mjs
//   env: RETURNING_BRIDGE_PORT (54996). Prints one line `READY {json}` when serving.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { applyChain, certifier, clientDb, makeWorld, openDatabase, uuid } from "./lib/reportingKit.mjs";
import { toolkit } from "./lib/returningClientKit.mjs";
import { ACCOUNTS, ACCRUAL_LINES, LEDGER } from "./lib/returningClientWorld.mjs";
import { runReadinessCheck } from "../../supabase/functions/_shared/readiness/index.ts";

const PORT = Number(process.env.RETURNING_BRIDGE_PORT ?? 54996);
const Y = 2026;
const RPC = /^(fs_[a-z_0-9]+|rfr_(status|set_scope|register_input|propose_correction|withdraw_input)|close_review_(findings_summary|adjustments_summary|adjusted_trial_balance|propose_adjustment|decide_adjustment|revalidate_adjustment|set_approval_policy)|get_my_workspace_capabilities|get_workspace_access|tb_signoff_rules_blocker)$/;
const TABLES = /^(reporting_pack_issuances|fs_review_comments|fs_review_comment_events|fs_rollforward_carries|fs_prior_final_acceptances|financial_evidence_batches|fs_disclosure_texts|account_mappings|financial_statement_reports|financial_statement_publications|fs_publication_bindings|fs_comparative_restatements|fs_comparative_restatement_decisions|rfr_scope_events|rfr_runs|rfr_reviews|rfr_finalization_manifests)$/;

const db = await openDatabase("returning_harness");
const failed = await applyChain(db);
if (failed) { console.error(`chain failed: ${failed}`); process.exit(1); }
const W = await makeWorld(db);
const { U } = W;
await db.admin.query("SET session_replication_role = replica");
await db.admin.query("UPDATE public.commercial_licences SET plan_id = (SELECT p.id FROM public.commercial_plans p JOIN public.commercial_products pr ON pr.id = p.product_id WHERE pr.code='CFOCLOSE' AND p.code='FIRM'), additional_seats = 50 WHERE billing_customer_id = (SELECT id FROM public.billing_customers WHERE owner_user_id = $1)", [U.owner]);
await db.admin.query("SET session_replication_role = origin");
const NAME = "Returning Client Limited";
const A = await W.company(U.owner, NAME);
for (const m of ["preparer", "partner", "viewer"]) await db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [A, U[m], m]);
await W.rollout(A, true);
const k = await certifier(db, U);
const T = toolkit(db, W, k, NAME);

// ── Three years, each uploaded once; the FY2025 pack finalised in CFOClose with the approved accrual ──
const uploads = { 2024: await T.certifyYear(A, 2024, true), 2025: await T.certifyYear(A, 2025) };
await T.presentation(A);
const adj = await T.proposeAdjustment(A, 2025, ACCRUAL_LINES, "Audit fee accrual agreed in the audit adjustment schedule");
await T.approveAdjustment(adj.adjustmentId);
await T.closeReview(A, 2025); await T.notes(A, 2025); await T.approveComparatives(A, 2025);
const rid25 = `rpt-fy2025-${uuid()}`;
const r25 = await T.attempt(A, 2025, rid25, T.allEvidence(A, 2025, { accrualInPriorYear: true }));
await T.partner.c.setState(A, rid25, r25.reportVersion, "REVIEWED", "Reviewed");
const fin25 = await T.owner.c.setState(A, rid25, r25.reportVersion, "FINAL", "Approved");
if (fin25.state !== "FINAL") throw new Error("FY2025 did not reach FINAL");
uploads[2026] = await T.certifyYear(A, 2026);
await T.closeReview(A, Y); await T.notes(A, Y);
// A first draft version stores the period's evidence once (the Statements page keeps it for every later version).
const seedRid = `rpt-fy2026-${uuid()}`;
const seed = await T.attempt(A, Y, seedRid, T.allEvidence(A, Y, { accrualInPriorYear: true }));
if (seed.outcome !== "saved") throw new Error(`seed version: ${JSON.stringify(seed).slice(0, 300)}`);

// ── The files the accountant picks ──
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-returning-"));
const toMinor = (s) => (s === "" ? 0n : BigInt(Math.round(Number(s) * 100)));
const bal = (y, code) => { const [d, c] = LEDGER[y][code] ?? ["", ""]; return toMinor(d) - toMinor(c); };
const fmt = (m) => { const neg = m < 0n; const v = (neg ? -m : m).toString().padStart(3, "0"); return `${v.slice(0, -2)}.${v.slice(-2)}`; };
const nameOf = Object.fromEntries(ACCOUNTS.map((a) => [a[0], a[1]]));
const glRows = ["Account,Date,Transaction Type,Txn Id,Line,Num,Name,Memo,Debit,Credit"];
const opening = (code) => (code < "4000" ? (code === "3100" ? -1100000n : bal(2025, code)) : 0n);
for (const code of Object.keys(LEDGER[2026])) { const o = opening(code); if (o !== 0n) glRows.push(`${code} ${nameOf[code]},2025-12-31,Beginning Balance,,,,,,${o > 0n ? fmt(o) : ""},${o < 0n ? fmt(-o) : ""}`); }
let line = 0;
for (const code of Object.keys(LEDGER[2026])) { const d = bal(2026, code) - opening(code); if (d === 0n) continue; line += 1; glRows.push(`${code} ${nameOf[code]},2026-12-31,Journal,YEAR-2026,${line},,QuickBooks,FY2026 activity,${d > 0n ? fmt(d) : ""},${d < 0n ? fmt(-d) : ""}`); }
const files = {
  gl: path.join(fixtures, "quickbooks-general-ledger-2026.csv"),
  approved: path.join(fixtures, "approved-prior-year-closing.csv"),
  evidence: path.join(fixtures, "document-register.json"),
  settings: path.join(fixtures, "checking-settings.json"),
};
fs.writeFileSync(files.gl, glRows.join("\n") + "\n");
// Last year's approved closing figure for the line the accrual touched: the credit balance of the payables account in the FINAL pack.
fs.writeFileSync(files.approved, `Line,Account codes,Amount,Level,Source\npayables,2000,-3200.00,account,"FY2025 financial statements as issued (FINAL in CFOClose, report ${rid25} v${r25.reportVersion})"\n`);
fs.writeFileSync(files.evidence, JSON.stringify([{ id: "EV-AUDIT-ADJ", kind: "audit_adjustment_schedule", extraction: "human_confirmed", facts: { amount: "10000", account: "2000", date: "2025-12-31", ref: "AA-2025-01" }, file_name: "audit-adjustment-schedule-2025.pdf" }], null, 2));
fs.writeFileSync(files.settings, JSON.stringify({
  scopeFacts: { opening_lines: ["payables"] },
  classifications: { payables: { kind: "unposted_audit_adjustment", evidence: ["EV-AUDIT-ADJ"] } },
  proposals: [{ id: "corr:opening:payables", line: "payables", lines: [{ account: "3100", amount: "10000" }, { account: "2000", amount: "-10000" }] }],
}, null, 2));

// ── The bridge ──
const users = { owner: U.owner, preparer: U.preparer, partner: U.partner, viewer: U.viewer, outsider: U.ownerB };
const serviceRpc = { rpc: async (fn, args) => { const keys = Object.keys(args); try { const rows = await db.asRole("service_role", null, `SELECT public.${fn}(${keys.map((kk, i) => `${kk} => $${i + 1}`).join(", ")}) r`, keys.map((kk) => args[kk])); return { data: rows[0].r, error: null }; } catch (e) { return { data: null, error: { message: `${e.code ?? ""}:${e.message}` } }; } } };
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-sim-user", "access-control-allow-methods": "POST,OPTIONS", "content-type": "application/json" };
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  const uid = users[String(req.headers["x-sim-user"] ?? "")];
  const u = new URL(req.url, "http://x");
  const reply = (status, data) => { res.writeHead(status, cors); res.end(JSON.stringify(data)); };
  try {
    if (u.pathname === "/seed") return reply(200, { companyId: A, periodYear: Y, files, users, priorReportId: rid25, priorReportVersion: r25.reportVersion, draftReportId: seedRid, draftReportVersion: seed.reportVersion, uploads: Object.fromEntries(Object.entries(uploads).map(([y, x]) => [y, x.id])) });
    if (!uid) return reply(400, { error: { code: "42501", message: "unknown simulated user" } });
    if (u.pathname === "/compile-financial-report") {
      if (Object.keys(body).some((kk) => !["companyId", "reportId", "reportVersion"].includes(kk))) return reply(400, { error: { message: "Identifiers only" } });
      const r = await clientDb(db, uid).invoke("compile-financial-report", body);
      return reply(r.error ? 400 : 200, r.error ? { error: r.error } : r.data);
    }
    if (u.pathname === "/invoke/rfr-check-books") {
      // The Edge Function's contract: a signed-in member with prepare_close; the service credential only for the engine.
      const ok = (await db.one("SELECT public.workspace_capability_allowed($1,$2,'prepare_close') ok", [body.companyId, uid])).ok;
      if (!ok) return reply(200, { outcome: "forbidden" });
      const r = await runReadinessCheck(serviceRpc, body.companyId, body.periodYear);
      return reply(200, { outcome: r.outcome });
    }
    if (u.pathname.startsWith("/rpc/")) {
      const fn = u.pathname.slice(5);
      if (!RPC.test(fn)) return reply(400, { error: { code: "42883", message: "function not exposed" } });
      if (fn === "close_review_adjusted_trial_balance") {
        // A set-returning function answers an ARRAY of rows over PostgREST (clientDb.rpc returns the first row only); minor-unit columns are text.
        const rows = await db.asRole("authenticated", uid, "SELECT account_key, account_code, account_name, classification, certified_debit_minor::text AS certified_debit_minor, certified_credit_minor::text AS certified_credit_minor, adjustment_debit_minor::text AS adjustment_debit_minor, adjustment_credit_minor::text AS adjustment_credit_minor, adjusted_debit_minor::text AS adjusted_debit_minor, adjusted_credit_minor::text AS adjusted_credit_minor FROM public.close_review_adjusted_trial_balance($1,$2)", [body.p_company_id, body.p_period_year]);
        return reply(200, rows);
      }
      const r = await clientDb(db, uid).rpc(fn, body);
      return reply(r.error ? 400 : 200, r.error ? { error: r.error } : r.data);
    }
    if (u.pathname.startsWith("/select/")) {
      const table = u.pathname.slice(8);
      if (!TABLES.test(table)) return reply(400, { error: { code: "42501", message: "table not exposed" } });
      const r = await clientDb(db, uid).select(table, body);
      return reply(r.error ? 400 : 200, r.error ? { error: r.error } : r.data);
    }
    // Test-only read for the journey's assertions (never exposed to a page): exact balances and the manifest.
    if (u.pathname === "/proof/facts") {
      const L = Object.fromEntries((await db.asRole("authenticated", U.owner, "SELECT account_code, (adjusted_debit_minor - adjusted_credit_minor)::text v FROM public.close_review_adjusted_trial_balance($1,$2)", [A, Y])).map((r) => [r.account_code, r.v]));
      const uploadsN = await db.count("SELECT count(*) n FROM public.trial_balance_uploads WHERE company_id=$1 AND period_year=$2", [A, Y]);
      const adjN = await db.count("SELECT count(*) n FROM public.close_review_adjustments WHERE company_id=$1 AND period_year=$2", [A, Y]);
      const pubs = (await db.admin.query("SELECT report_id, report_version, state FROM public.financial_statement_publications WHERE company_id=$1 ORDER BY seq", [A])).rows;
      const bindings = (await db.admin.query("SELECT report_id, report_version, state, dependencies_sha256, dependencies->>'comparativeStatusSha256' AS cmp FROM public.fs_publication_bindings WHERE company_id=$1 ORDER BY seq", [A])).rows;
      const manifest = (await db.admin.query("SELECT m.manifest FROM public.rfr_finalization_manifests m WHERE m.company_id=$1 AND m.period_year=$2 ORDER BY m.id DESC LIMIT 1", [A, Y])).rows[0]?.manifest ?? null;
      return reply(200, { layer: L, uploadsN, adjN, pubs, bindings, manifest });
    }
  } catch (e) { return reply(500, { error: { message: String(e?.message ?? e) } }); }
  return reply(404, {});
});
server.listen(PORT, "127.0.0.1", () => console.log(`READY ${JSON.stringify({ bridge: `http://127.0.0.1:${PORT}`, companyId: A, fixtures })}`));

const stop = async () => { server.close(); await db.close(); try { fs.rmSync(fixtures, { recursive: true, force: true }); } catch { /* */ } process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
if (process.env.RETURNING_STOP_ON_STDIN_END === "1") { process.stdin.on("end", stop); process.stdin.resume(); }
else setInterval(() => {}, 1 << 30);
