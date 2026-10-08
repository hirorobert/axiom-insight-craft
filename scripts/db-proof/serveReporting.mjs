#!/usr/bin/env bun
// NON-PRODUCTION. A DISPOSABLE PostgreSQL (embedded, or an EMPTY loopback database in CI) with the whole migration chain,
// a synthetic workspace prepared through the real functions up to — not including — comparatives approval, evidence and
// any report, and a LOOPBACK HTTP bridge for the reporting workbench harness (dev-harness/reporting).
//
// The bridge simulates PostgREST for the `authenticated` role: the caller names a fixture user in `x-sim-user`, and each
// RPC/select runs in its own transaction as that user's auth.uid() (clientDb, reportingKit.mjs). It is NOT GoTrue: no
// password, token or session is involved. Only reads and the reporting functions are exposed; no table is writable.
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/serveReporting.mjs
//   env: REPORTING_BRIDGE_PORT (default 54998). Prints one line `READY {json}` when serving.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { applyChain, certifier, clientDb, EVIDENCE_FY2025_COMPARATIVE, EVIDENCE_FY2026, makeWorld, openDatabase, prepareReporting } from "./lib/reportingKit.mjs";

const PORT = Number(process.env.REPORTING_BRIDGE_PORT ?? 54998);
const RPC = /^(fs_[a-z_]+|close_review_adjustments_summary|close_review_adjusted_trial_balance|get_my_workspace_capabilities)$/;
const WRITE_RPC = /^fs_(assign_presentation|elect_early_application|decide_requirement|record_disclosure|record_schedule|bridge_comparative_account|propose_restatement|decide_restatement|approve_comparatives|commit_revision|set_publication_state)$/;
const READ_RPC = /^(fs_(statement_composition|notes_status|comparatives_status|reporting_dependencies|reporting_input|list_saved_versions|report_readiness)|close_review_adjustments_summary|close_review_adjusted_trial_balance|get_my_workspace_capabilities)$/;
const TABLES = /^(financial_evidence_batches|fs_disclosure_texts|account_mappings|financial_statement_reports|financial_statement_publications|fs_publication_bindings|fs_comparative_restatements|fs_comparative_restatement_decisions)$/;

const db = await openDatabase("reporting_harness");
const failed = await applyChain(db);
if (failed) { console.error(`chain failed: ${failed}`); process.exit(1); }
const W = await makeWorld(db);
await W.rollout(W.A, true);
const k = await certifier(db, W.U);
await prepareReporting(db, W, k, { year: 2026, comparativesApproved: false });

// The evidence a preparer would pick, written outside the repository for the browser's file inputs.
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-reporting-evidence-"));
const files = {};
for (const [role, set] of [["current", EVIDENCE_FY2026], ["comparative", EVIDENCE_FY2025_COMPARATIVE]]) {
  for (const [type, text] of Object.entries(set)) { const f = path.join(fixtures, `${type.toLowerCase()}-${role}.csv`); fs.writeFileSync(f, text); files[`${type}|${role === "current" ? "CURRENT" : "COMPARATIVE"}`] = f; }
}

const users = { owner: W.U.owner, preparer: W.U.preparer, partner: W.U.partner, viewer: W.U.viewer, outsider: W.U.ownerB };
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-sim-user", "access-control-allow-methods": "POST,OPTIONS", "content-type": "application/json" };
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  const uid = users[String(req.headers["x-sim-user"] ?? "")];
  const u = new URL(req.url, "http://x");
  const reply = (status, data) => { res.writeHead(status, cors); res.end(JSON.stringify(data)); };
  if (u.pathname === "/seed") return reply(200, { companyId: W.A, otherCompanyId: W.B, periodYear: 2026, users: Object.keys(users), files });
  if (!uid) return reply(400, { error: { code: "42501", message: "unknown simulated user" } });
  if (u.pathname.startsWith("/rpc/")) {
    const fn = u.pathname.slice(5);
    if (!RPC.test(fn) || !(READ_RPC.test(fn) || WRITE_RPC.test(fn))) return reply(400, { error: { code: "42883", message: "function not exposed" } });
    const r = await clientDb(db, uid).rpc(fn, body);
    return reply(r.error ? 400 : 200, r.error ? { error: r.error } : r.data);
  }
  if (u.pathname.startsWith("/select/")) {
    const table = u.pathname.slice(8);
    if (!TABLES.test(table)) return reply(400, { error: { code: "42501", message: "table not exposed" } });
    const r = await clientDb(db, uid).select(table, body);
    return reply(r.error ? 400 : 200, r.error ? { error: r.error } : r.data);
  }
  return reply(404, {});
});
server.listen(PORT, "127.0.0.1", () => console.log(`READY ${JSON.stringify({ bridge: `http://127.0.0.1:${PORT}`, companyId: W.A, fixtures })}`));

const stop = async () => { server.close(); await db.close(); try { fs.rmSync(fixtures, { recursive: true, force: true }); } catch { /* */ } process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
if (process.env.REPORTING_STOP_ON_STDIN_END === "1") { process.stdin.on("end", stop); process.stdin.resume(); } // the journey closes our stdin to stop us
else setInterval(() => {}, 1 << 30);
