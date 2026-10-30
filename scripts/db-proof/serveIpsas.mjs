#!/usr/bin/env bun
// NON-PRODUCTION. A DISPOSABLE PostgreSQL (embedded, or an EMPTY loopback database in CI) with the whole migration chain, an
// IPSAS accrual workspace with its 2025 and 2026 trial balances certified by the real engine, and a LOOPBACK HTTP bridge for the
// IPSAS preparation harness (dev-harness/ipsas).
//
// The bridge simulates PostgREST for the `authenticated` role: the caller names a fixture user in `x-sim-user`, and each RPC runs in
// its own transaction as that user's auth.uid() (clientDb, reportingKit.mjs). It is NOT GoTrue: no password, token or session is
// involved. Only the ipsas_* functions (preparation and grants) and the capability read are exposed; no table is readable or writable.
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/serveIpsas.mjs
//   env: IPSAS_BRIDGE_PORT (default 54995). Prints one line `READY {json}` when serving.
import http from "node:http";
import { applyChain, certifier, clientDb, csv, FY2025, FY2026, makeWorld, openDatabase, TB } from "./lib/reportingKit.mjs";

const PORT = Number(process.env.IPSAS_BRIDGE_PORT ?? 54995);
const RPC = /^(ipsas_prep_context|ipsas_save_preparation|ipsas_confirm|ipsas_grants_context|ipsas_save_grants|ipsas_confirm_grant|get_my_workspace_capabilities)$/;
// The standard synthetic trial balance plus grant accounts, balanced by a grants bank account (major units; columns: code, name, class, statement,
// normal, d26, c26, d25, c25). 2026: receivable 4,500,000 · unfulfilled grant obligations 5,500,000 · grant revenue 6,500,000 · grants bank 7,500,000.
// 2025: receivable 600,000 · obligations 3,600,000 · revenue 3,400,000 · grants bank 6,400,000.
const TB_ALL = [...TB,
  ["1010", "Bank - grants account", "current_assets", "balance_sheet", "debit", "7500000.00", "", "6400000.00", ""],
  ["1300", "Grant receivable", "current_assets", "balance_sheet", "debit", "4500000.00", "", "600000.00", ""],
  ["2300", "Unfulfilled grant obligations", "current_liabilities", "balance_sheet", "credit", "", "5500000.00", "", "3600000.00"],
  ["4300", "Grant revenue", "revenue", "income_statement", "credit", "", "6500000.00", "", "3400000.00"]];

const db = await openDatabase("ipsas_harness");
const failed = await applyChain(db);
if (failed) { console.error(`chain failed: ${failed}`); process.exit(1); }
const W = await makeWorld(db);
const AI = await W.company(W.U.owner, "Synthetic Community Trust", "ipsas_accrual");
for (const k of ["preparer", "partner", "viewer"]) await db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [AI, W.U[k], k]);
await W.rollout(AI, true);
const k = await certifier(db, W.U);
// Mapping is shared by the company. Reviewing it again invalidates the first year's
// certificate, even if the choices are identical. Review once, then certify both sources.
let mappingReviewed = false;
for (const [y, col] of [[2025, FY2025], [2026, FY2026]]) {
  const u = await k.upload(AI, y, csv(col, TB_ALL));
  if (!mappingReviewed) { await k.review(AI, u, TB_ALL); mappingReviewed = true; }
  await k.certify(AI, u);
}
for (const y of [2025, 2026]) {
  if (!(await db.one("SELECT id FROM public.get_authoritative_certification($1,$2)", [AI, y]))) {
    throw new Error(`IPSAS fixture has no current authoritative certification for ${y}`);
  }
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
  if (u.pathname === "/seed") return reply(200, { companyId: AI, otherCompanyId: W.A, periodYear: 2026, users: Object.keys(users) });
  if (!uid) return reply(400, { error: { code: "42501", message: "unknown simulated user" } });
  if (u.pathname.startsWith("/rpc/")) {
    const fn = u.pathname.slice(5);
    if (!RPC.test(fn)) return reply(400, { error: { code: "42883", message: "function not exposed" } });
    const r = await clientDb(db, uid).rpc(fn, body);
    return reply(r.error ? 400 : 200, r.error ? { error: r.error } : r.data);
  }
  return reply(404, {});
});
server.listen(PORT, "127.0.0.1", () => console.log(`READY ${JSON.stringify({ bridge: `http://127.0.0.1:${PORT}`, companyId: AI })}`));

const stop = async () => { server.close(); await db.close(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
if (process.env.IPSAS_STOP_ON_STDIN_END === "1") { process.stdin.on("end", stop); process.stdin.resume(); } // the journey closes our stdin to stop us
else setInterval(() => {}, 1 << 30);
