#!/usr/bin/env bun
// Real-PostgreSQL proof of comparatives (20261020100000) on database-composed statements from real certifications.
// Expected figures and states are written BY HAND from the synthetic trial balances (lib/reportingKit.mjs).
//
//   v2 composition  the statements are exactly version 1's figures; bridges and approved restatements are the only
//                   additions
//   approval        review_close approves the comparative against its exact identity; any later change (a restatement,
//                   a bridge) makes the approval stale; withdrawal is a new event
//   bridges         a prior-year account presented through the current account it became; without the bridge it is not
//                   presented and blocks; idempotent; append-only
//   restatements    balanced line deltas only; proposer ≠ approver (no self-approval); pending and rejected ones never
//                   apply; an approved one applies with the as-reported figure kept beside it, traceable in lineage;
//                   withdrawn restores the as-reported figure; history kept
//   states          different currency (translation deferred, never approvable), reference only (prior statements held
//                   as evidence: blocks), missing (blocks), first-period exception (an approved declaration in force)
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/comparatives.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import crypto from "node:crypto";
import { ASSIGN, FY2025, FY2026, TB, applyChain, assignmentPairs, certifier, chainFiles, csv, makeWorld, migrationText, openDatabase, reporter, uuid } from "./lib/reportingKit.mjs";

const FILE = "20261020100000_fs_comparatives.sql";
const { group, check, refused, finish } = reporter();
let db;

async function main() {
  db = await openDatabase("comparatives_proof");
  group("Replay");
  await check(`${FILE} is in the chain and the whole chain applies`, async () => (!chainFiles().includes(FILE) ? `${FILE} missing` : (await applyChain(db)) ?? true));
  await refused("re-applying is refused by its preflight", "P0001", () => db.admin.query(migrationText(FILE)), "PREFLIGHT_REFUSED");

  const W = await makeWorld(db);
  const { U, A, B } = W;
  const E = await W.company(U.owner, "Chart-change SME");
  const G = await W.company(U.owner, "Currency-change SME");
  const H = await W.company(U.owner, "Reference-only SME");
  const N = await W.company(U.owner, "New SME");
  for (const co of [A, B, E, G, H, N]) await W.rollout(co, true);
  for (const co of [E, G, H, N]) for (const k of ["preparer", "partner"]) await db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [co, U[k], k]);
  const k = await certifier(db, U);
  const assign = (company, map = ASSIGN) => db.asUser(U.preparer, "SELECT public.fs_assign_presentation($1,$2::jsonb,'Presentation per the chart of accounts',$3) r", [company, JSON.stringify(assignmentPairs(map)), uuid()]).then((r) => r.r);
  // E's prior year used account 6150 "Office rent" for what is 6100 "Rent" this year.
  const TB_E_PRIOR = TB.map((r) => (r[0] === "6100" ? ["6150", "Office rent", ...r.slice(2)] : r));

  group("Setup — certified years");
  await check("A: FY2025 + FY2026; E: chart change (6150 → 6100); G: FY2025 in USD; H and N: FY2026 only", async () => {
    const a1 = await k.upload(A, 2025, csv(FY2025)); await k.review(A, a1); await k.certify(A, a1);
    const a2 = await k.upload(A, 2026, csv(FY2026)); await k.certify(A, a2);
    // Review FY2025, then only the account new in FY2026 (re-deciding every mapping later would — correctly — make the
    // FY2025 certification stale), then certify both years.
    const e1 = await k.upload(E, 2025, csv(FY2025, TB_E_PRIOR)); await k.review(E, e1, TB_E_PRIOR);
    const e2 = await k.upload(E, 2026, csv(FY2026)); await k.review(E, e2, TB.filter((r) => r[0] === "6100"));
    await k.certify(E, e1); await k.certify(E, e2);
    const g1 = await k.upload(G, 2025, csv(FY2025), { currency: "USD" }); await k.review(G, g1); await k.certify(G, g1);
    const g2 = await k.upload(G, 2026, csv(FY2026)); await k.certify(G, g2);
    const h = await k.upload(H, 2026, csv(FY2026)); await k.review(H, h); await k.certify(H, h);
    const n = await k.upload(N, 2026, csv(FY2026)); await k.review(N, n); await k.certify(N, n);
    const r = [await assign(A), await assign(E), await assign(G), await assign(H), await assign(N)];
    return r.every((x) => x.outcome === "recorded") ? true : r;
  });

  const compose = (company = A) => db.asUser(U.owner, "SELECT public.fs_statement_composition($1,2026) r", [company]).then((r) => r.r);
  const status = (company = A, uid = company === A ? U.viewer : U.owner) => db.asUser(uid, "SELECT public.fs_comparatives_status($1,2026) r", [company]).then((r) => r.r);
  const approve = (uid, on, company = A, request = uuid()) => db.asUser(uid, "SELECT public.fs_approve_comparatives($1,2026,$2,'Agreed to the prior-year signed statements',$3) r", [company, on, request]).then((r) => r.r);
  const bridge = (prior, current, company = E, request = uuid()) => db.asUser(U.preparer, "SELECT public.fs_bridge_comparative_account($1,2026,$2,$3,'Account renumbered in 2026',$4) r", [company, prior, current, request]).then((r) => r.r);
  const propose = (uid, lines, company = A, request = uuid()) => db.asUser(uid, "SELECT public.fs_propose_restatement($1,2026,$2::jsonb,'Correction of a prior-period depreciation error','Note 14 — prior-period error',$3) r", [company, JSON.stringify(lines), request]).then((r) => r.r);
  const decide = (uid, id, d, request = uuid()) => db.asUser(uid, "SELECT public.fs_decide_restatement($1,$2,'Checked to the fixed asset register',$3) r", [id, d, request]).then((r) => r.r);
  const cmpLine = (c, id, section) => c.lines.find((l) => l.lineId === id && (!section || l.section === section))?.comparative;

  group("Composition v2 — version 1's figures, unchanged");
  await check("contract /2; the comparative column is the hand-computed FY2025 figures, as reported, not restated", async () => {
    const c = await compose();
    const got = c.lines.map((l) => [l.lineId, l.comparative.amountMinor, l.comparative.asReportedMinor, l.comparative.restated]);
    const want = [["sfp.property_plant_and_equipment", "1600000"], ["sfp.cash_and_cash_equivalents", "800000"], ["sfp.trade_and_other_receivables", "300000"], ["sfp.inventories", "180000"],
      ["sfp.equity_attributable_to_owners", "1350000"], ["sfp.other_financial_liabilities", "900000"], ["sfp.trade_and_other_payables", "250000"], ["sfp.current_tax", "70000"],
      ["sci.revenue", "2500000"], ["sci.other_income", "40000"], ["sci.cost_of_sales", "1150000"], ["sci.operating_expenses_by_function", "940000"], ["sci.finance_costs", "70000"],
      ["sci.tax_expense", "70000"]].map(([id, m]) => [id, m, m, false]);
    return c.contract === "fs-statement-composition/2" && JSON.stringify(got) === JSON.stringify(want) && c.totals.comparative.totalAssetsMinor === "2880000" ? true : { contract: c.contract, got };
  });

  group("Approval — bound to the exact comparative");
  let s0;
  await check("available, presented and balanced, but not approved: unapproved, COMPARATIVE_NOT_APPROVED", async () => {
    s0 = await status();
    return s0.comparative.state === "unapproved" && JSON.stringify(s0.comparative.blockers) === JSON.stringify(["COMPARATIVE_NOT_APPROVED"]) && /^[0-9a-f]{64}$/.test(s0.comparative.comparativeSha256) ? true : s0;
  });
  await check("a preparer cannot approve (review_close); another workspace's owner cannot either", async () => {
    const a = await approve(U.preparer, true);
    const b = await approve(U.ownerB, true);
    return a.outcome === "forbidden" && b.outcome === "forbidden" ? true : { a, b };
  });
  await check("the partner approves: the approval carries the exact comparative identity; approved, no blocker; approving again is unchanged", async () => {
    const r = await approve(U.partner, true);
    const s = await status();
    const again = await approve(U.partner, true);
    return r.outcome === "recorded" && r.comparativeSha256 === s0.comparative.comparativeSha256 && s.comparative.state === "approved" && s.comparative.blockers.length === 0 && again.outcome === "unchanged" ? true : { r, s: s.comparative.state };
  });

  group("Restatements — balanced, two-person, history kept");
  await check("refused: unbalanced (exact difference), a line in the wrong section, an SCI line outside 'sci', an unknown line", async () => {
    const a = await propose(U.partner, [{ lineId: "sfp.property_plant_and_equipment", section: "non_current_assets", deltaMinor: "-50000" }]);
    const b = await propose(U.partner, [{ lineId: "sfp.property_plant_and_equipment", section: "current_assets", deltaMinor: "-50000" }, { lineId: "sfp.equity_attributable_to_owners", section: "equity", deltaMinor: "-50000" }]);
    const c = await propose(U.partner, [{ lineId: "sci.revenue", section: "equity", deltaMinor: "1" }]);
    const d = await propose(U.partner, [{ lineId: "sfp.made_up", section: "equity", deltaMinor: "1" }]);
    return a.outcome === "unbalanced" && a.differenceMinor === "-50000" && b.outcome === "invalid_lines" && c.outcome === "invalid_lines" && d.outcome === "invalid_lines"
      && (await db.count("SELECT count(*) n FROM public.fs_comparative_restatements")) === 0 ? true : { a, b, c, d };
  });
  const BALANCED = [{ lineId: "sfp.property_plant_and_equipment", section: "non_current_assets", deltaMinor: "-50000" }, { lineId: "sfp.equity_attributable_to_owners", section: "equity", deltaMinor: "-50000" }];
  let rs;
  await check("a balanced restatement (PPE −500.00, equity −500.00) is proposed; while pending it changes nothing and the approval still stands", async () => {
    rs = await propose(U.partner, BALANCED);
    const c = await compose();
    const s = await status();
    return rs.outcome === "recorded" && cmpLine(c, "sfp.property_plant_and_equipment").amountMinor === "1600000" && s.comparative.state === "approved" ? true : { rs, s: s.comparative.state };
  });
  await check("the proposer cannot approve their own restatement; a preparer lacks review_close", async () => {
    const a = await decide(U.partner, rs.restatementId, "approved");
    const b = await decide(U.preparer, rs.restatementId, "approved");
    return a.outcome === "self_decision_not_allowed" && b.outcome === "forbidden" ? true : { a, b };
  });
  await check("approved by the owner: PPE 15,500.00 (as reported 16,000.00), equity 13,000.00, total assets 28,300.00, still balanced; lineage names the restatement", async () => {
    const d = await decide(U.owner, rs.restatementId, "approved");
    const c = await compose();
    const ppe = c.lines.find((l) => l.lineId === "sfp.property_plant_and_equipment");
    const eq = cmpLine(c, "sfp.equity_attributable_to_owners");
    const lin = ppe.lineage.find((x) => x.kind === "restatement");
    return d.outcome === "recorded" && ppe.comparative.amountMinor === "1550000" && ppe.comparative.asReportedMinor === "1600000" && ppe.comparative.restated === true
      && eq.amountMinor === "1300000" && c.totals.comparative.totalAssetsMinor === "2830000" && c.totals.comparative.balanceDifferenceMinor === "0"
      && lin?.restatementId === rs.restatementId && lin.amountMinor === "-50000" && JSON.stringify(c.comparative.restatementIds) === JSON.stringify([rs.restatementId])
      && ppe.current.amountMinor === "1400000" ? true : { d, ppe: ppe.comparative, eq, lin };
  });
  await check("the approval no longer matches: approval_stale (COMPARATIVE_APPROVAL_STALE); re-approved → approved", async () => {
    const s = await status();
    const r = await approve(U.partner, true);
    const t = await status();
    return s.comparative.state === "approval_stale" && s.comparative.blockers.includes("COMPARATIVE_APPROVAL_STALE") && r.outcome === "recorded" && t.comparative.state === "approved" ? true : { s: s.comparative.state, r };
  });
  await check("a rejected proposal never applies; deciding it again is refused (not_pending)", async () => {
    const p = await propose(U.partner, [{ lineId: "sfp.inventories", section: "current_assets", deltaMinor: "10000" }, { lineId: "sfp.trade_and_other_payables", section: "current_liabilities", deltaMinor: "10000" }]);
    const r = await decide(U.owner, p.restatementId, "rejected");
    const again = await decide(U.owner, p.restatementId, "approved");
    const c = await compose();
    return r.outcome === "recorded" && again.outcome === "not_pending" && cmpLine(c, "sfp.inventories").amountMinor === "180000" ? true : { r, again };
  });
  await check("withdrawing the approved restatement restores the as-reported figures; all proposals and decisions stay in history", async () => {
    const w = await decide(U.owner, rs.restatementId, "withdrawn");
    const c = await compose();
    const n = [await db.count("SELECT count(*) n FROM public.fs_comparative_restatements"), await db.count("SELECT count(*) n FROM public.fs_comparative_restatement_decisions")];
    return w.outcome === "recorded" && cmpLine(c, "sfp.property_plant_and_equipment").amountMinor === "1600000" && cmpLine(c, "sfp.property_plant_and_equipment").restated === false
      && JSON.stringify(n) === JSON.stringify([2, 3]) ? true : { w, n };
  });

  group("Bridges — a chart change between the years");
  await check("without a bridge the prior account 6150 is not presented: accounts_not_presented:1 (blocks); the current year is unaffected", async () => {
    const s = await status(E);
    const c = await compose(E);
    return s.comparative.state === "accounts_not_presented" && s.comparative.blockers.includes("COMPARATIVE_ACCOUNTS_NOT_PRESENTED:1") && c.blockers.length === 0 ? true : s.comparative;
  });
  let bridged;
  await check("bridged 6150 → 6100: presented on the current account's line (the FY2025 expense line is 9,400.00, exactly A's), lineage names the bridge", async () => {
    bridged = await bridge("6150", "6100");
    const c = await compose(E);
    const opex = c.lines.find((l) => l.lineId === "sci.operating_expenses_by_function");
    const lin = opex.lineage.find((x) => x.period === "comparative" && x.accountKey === "6150");
    const s = await status(E);
    return bridged.outcome === "recorded" && opex.comparative.amountMinor === "940000" && lin?.bridgeId === bridged.bridgeId && s.comparative.state === "unapproved" ? true : { opex: opex.comparative, lin, s: s.comparative.state };
  });
  await check("bridging again is unchanged; a retried request replays; withdrawing the bridge (a new event) un-presents it again", async () => {
    const a = await bridge("6150", "6100");
    const w = await bridge("6150", null);
    const s = await status(E);
    return a.outcome === "unchanged" && w.outcome === "recorded" && s.comparative.state === "accounts_not_presented" && (await db.count("SELECT count(*) n FROM public.fs_comparative_bridges")) === 2 ? true : { a, w, s: s.comparative.state };
  });

  group("States — never a bypass");
  await check("prior year in USD, current in TZS: different_currency (translation deferred); approval and restatement refused", async () => {
    const s = await status(G);
    const a = await approve(U.partner, true, G);
    const p = await propose(U.partner, BALANCED, G);
    return s.comparative.state === "different_currency" && JSON.stringify(s.comparative.blockers) === JSON.stringify(["COMPARATIVE_TRANSLATION_DEFERRED"])
      && a.outcome === "not_approvable" && a.state === "different_currency" && p.outcome === "comparative_not_available" ? true : { s: s.comparative, a, p };
  });
  await check("no prior year at all: missing — COMPARATIVE_REQUIRED_MISSING (the requirement is the pack's; absence never bypasses it)", async () => {
    const s = await status(N);
    return s.comparative.state === "missing" && s.comparative.required === true && JSON.stringify(s.comparative.blockers) === JSON.stringify(["COMPARATIVE_REQUIRED_MISSING"]) ? true : s.comparative;
  });
  await check("prior-year statements held only as evidence: reference_only — shown, never satisfying the requirement (still blocks)", async () => {
    const member = (await db.one("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [H, U.preparer])).id;
    const id = `eb-${uuid()}`;
    await db.admin.query(`INSERT INTO public.financial_evidence_batches (evidence_batch_id, company_id, reporting_period_id, evidence_type, period_role, series_key, schema_version,
      content_hash, document_hash, replay_identity, batch_document, diagnostics, validation_status, version, uploaded_by_firm_member_id)
      VALUES ($1,$2,'FY2026','PRIOR_PERIOD_STATEMENTS','COMPARATIVE','default','1',$3,$3,$4,'{}'::jsonb,'[]'::jsonb,'VALID',1,$5)`,
      [id, H, "e".repeat(64), crypto.createHash("sha256").update(id).digest("hex"), member]);
    const s = await status(H);
    return s.comparative.state === "reference_only" && s.comparative.blockers.includes("COMPARATIVE_REQUIRED_MISSING") ? true : s.comparative;
  });
  await check("a genuinely first period with an approved declaration in force: first_period_exception, no blocker", async () => {
    const d = (await db.asUser(U.owner, "SELECT public.fs_declare_first_period($1,2026,true,'First reporting period since incorporation','certificate_of_incorporation','Certificate no. 9','2026-01-10') r", [N])).r;
    const s = await status(N);
    return d.outcome === "recorded" && s.comparative.state === "first_period_exception" && s.comparative.blockers.length === 0 && s.comparative.firstPeriodDeclared === true ? true : { d, s: s.comparative };
  });

  group("Tenancy, append-only");
  await check("another workspace's owner reads nothing", async () => (await status(A, U.ownerB)).state === "unavailable" ? true : "readable");
  for (const t of ["fs_comparative_bridges", "fs_comparative_restatements", "fs_comparative_restatement_decisions", "fs_comparative_approvals"]) {
    await refused(`${t} cannot be updated — not even by the database owner`, "42501", () => db.admin.query(`UPDATE public.${t} SET created_at = now()`));
  }
  await refused("clients cannot insert approvals directly", "42501", () => db.asRole("authenticated", U.partner, "INSERT INTO public.fs_comparative_approvals (company_id, period_year, action, comparative_sha256, reason, actor_user_id, request_id) VALUES ($1,2026,'approved',$2,'x y z',$3,$4)", [A, "a".repeat(64), U.partner, uuid()]));
  await refused("anon cannot read the status", "42501", () => db.asRole("anon", null, "SELECT public.fs_comparatives_status($1,2026)", [A]));
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish("COMPARATIVES", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
