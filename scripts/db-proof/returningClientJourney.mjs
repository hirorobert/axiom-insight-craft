#!/usr/bin/env bun
// Real-PostgreSQL proof of the RETURNING-CLIENT journey, source A (the prior year's pack finalised inside CFOClose with an approved
// reporting adjustment that the source ledger never carried), through the real server path:
//
//   prior year  FY2025 certified from the ledger, an approved accrual of 100.00 (Dr 6100 / Cr 2000), the pack REVIEWED then FINAL
//   this year   FY2026 certified ONCE from the ledger; Check my books in the same engagement; the existing report preview; server sign-off
//   figures     comparative expense line 1,000,000 / payable 320,000 / profit 500,000 (minor); current payable 320,000, opening equity
//               2,090,000, current-year profit 510,000 - unchanged by the prior-year correction
//   QuickBooks  the same journal later booked as CURRENT-year expense: linked + approved treatment -> payable 100, no current-year
//               expense from the item, one economic correction; an unlinked same-amount journal stays open for review
//   boundary    one finding, one next action; independent checks continue; an unresolved required difference blocks FINAL; a ledger edit
//               that leaves every trial-balance total unchanged invalidates the review; repeated imports and retries apply nothing twice
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/returningClientJourney.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import crypto from "node:crypto";
import { applyChain, certifier, makeWorld, openDatabase, reporter, uuid } from "./lib/reportingKit.mjs";
import { toolkit } from "./lib/returningClientKit.mjs";
import { ACCRUAL_LINES, LEDGER, tbCsv } from "./lib/returningClientWorld.mjs";
import { runReadinessCheck } from "../../supabase/functions/_shared/readiness/index.ts";
import { presentIssues } from "../../src/lib/readiness/present.ts";

const { group, check, refused, finish } = reporter();
const hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const Y = 2026, CORR = "corr:opening:payables";
let db;

const toMinor = (s) => (s === "" ? 0n : BigInt(Math.round(Number(s) * 100)));
const bal = (y, code, ledger = LEDGER) => { const [d, c] = ledger[y][code] ?? ["", ""]; return toMinor(d) - toMinor(c); };

async function main() {
  db = await openDatabase("returning_client");
  group("Replay");
  await check("the whole chain applies", async () => (await applyChain(db)) ?? true);
  const W = await makeWorld(db);
  const { U } = W;
  await db.admin.query("SET session_replication_role = replica");
  await db.admin.query("UPDATE public.commercial_licences SET plan_id = (SELECT p.id FROM public.commercial_plans p JOIN public.commercial_products pr ON pr.id = p.product_id WHERE pr.code='CFOCLOSE' AND p.code='FIRM'), additional_seats = 50 WHERE billing_customer_id = (SELECT id FROM public.billing_customers WHERE owner_user_id = $1)", [U.owner]);
  await db.admin.query("SET session_replication_role = origin");
  const k = await certifier(db, U);
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  const serviceRpc = { rpc: async (fn, args) => { const keys = Object.keys(args); try { const rows = await db.asRole("service_role", null, `SELECT public.${fn}(${keys.map((kk, i) => `${kk} => $${i + 1}`).join(", ")}) r`, keys.map((kk) => args[kk])); return { data: rows[0].r, error: null }; } catch (e) { return { data: null, error: { message: `${e.code ?? ""}:${e.message}` } }; } } };
  const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return `${e.code ?? ""}:${String(e.message).split("\n")[0]}`; } };

  /** One returning client: FY2024-FY2026 certified once each, FY2025 finalised in CFOClose with the approved accrual. */
  async function returningClient(label) {
    const name = `Returning Client ${label} Limited`;
    const A = await W.company(U.owner, name);
    for (const m of ["preparer", "partner", "viewer"]) await db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,$3,now())", [A, U[m], m]);
    await W.rollout(A, true);
    const T = toolkit(db, W, k, name);
    const uploads = {};
    uploads[2024] = await T.certifyYear(A, 2024, true); uploads[2025] = await T.certifyYear(A, 2025); uploads[2026] = await T.certifyYear(A, 2026);
    await T.presentation(A);
    const adj = await T.proposeAdjustment(A, 2025, ACCRUAL_LINES, "Audit fee accrual agreed in the audit adjustment schedule");
    const appr = await T.approveAdjustment(adj.adjustmentId);
    await T.closeReview(A, 2025); await T.notes(A, 2025); await T.approveComparatives(A, 2025);
    const rid25 = `rpt-fy2025-${uuid()}`;
    const r25 = await T.attempt(A, 2025, rid25, T.allEvidence(A, 2025, { accrualInPriorYear: true }));
    const rv = await T.partner.c.setState(A, rid25, r25.reportVersion, "REVIEWED", "Reviewed");
    const fin = await T.owner.c.setState(A, rid25, r25.reportVersion, "FINAL", "Approved");
    const priorDoc = (await db.one("SELECT content_hash, encode(sha256(convert_to(report_document::text,'UTF8')),'hex') h FROM public.financial_statement_reports WHERE report_id=$1 AND report_version=$2", [rid25, r25.reportVersion]));
    const reg = (family, key, payload, req = uuid()) => asU(U.preparer, "SELECT public.rfr_register_input($1,$2,$3,$4,$5::jsonb,'export_file',$6,$7) r", [A, Y, family, key, JSON.stringify(payload), hex(JSON.stringify(payload)), req]).then((r) => r.r);
    /** The QuickBooks export of FY2026: opening balances at 1 Jan 2026, one aggregate entry per account to the certified closing. */
    const ledgerPayload = ({ tb = LEDGER, postings = [], snapshot = "qbo-export-2026-001", moveDate = "2026-12-31" } = {}) => {
      const opening = {}, entries = [];
      for (const code of Object.keys(tb[2026])) {
        const open = code < "4000" ? (code === "3100" ? -1100000n : bal(2025, code)) : 0n;
        opening[code] = String(open);
        const delta = bal(2026, code, tb) - open;
        if (delta !== 0n) entries.push({ id: `agg:${code}`, date: code === "6000" ? moveDate : "2026-12-31", account: code, amount: String(delta), constructed_aggregate: true });
      }
      return { snapshot, accounts: opening, entries, postings };
    };
    const BRIDGE = { basis: "FY2025 pack finalised in CFOClose", lines: [{ line: "payables", approved: "-320000", accounts: ["2000"], level: "account", classification: { kind: "unposted_audit_adjustment", evidence: ["EV-AUDIT-ADJ"] } }],
      proposals: [{ id: CORR, line: "payables", lines: [{ account: "3100", amount: "10000" }, { account: "2000", amount: "-10000" }] }] };
    const EVID = { kind: "audit_adjustment_schedule", extraction: "human_confirmed", facts: { amount: "10000", account: "2000", date: "2025-12-31", ref: "AA-2025-01" } };
    const optIn = () => asU(U.preparer, "SELECT public.rfr_set_scope($1,$2,'rfr-pilot-ipsas-accrual','1.0.0',$3::jsonb,'Check the books for the returning client') r", [A, Y, JSON.stringify({ opening_lines: ["payables"] })]).then((r) => r.r);
    const importAll = async (lp = ledgerPayload()) => ({ ledger: await reg("ledger_snapshot", "gl", lp), evidence: await reg("evidence", "EV-AUDIT-ADJ", EVID), bridge: await reg("opening_bridge", "opening_bridge", BRIDGE) });
    const checkBooks = () => runReadinessCheck(serviceRpc, A, Y);
    const linesOf = (prop) => prop.lines.map((l) => (BigInt(l.amount) > 0n ? { accountKey: l.account, debitMinor: l.amount, creditMinor: "0" } : { accountKey: l.account, debitMinor: "0", creditMinor: String(-BigInt(l.amount)) }));
    const propose = (prop, extra = {}) => asU(U.preparer, "SELECT public.rfr_propose_correction($1,$2,$3,$4,$5::text[],$6,$7,$8::jsonb,$9,NULL,$10,$11) r", [A, Y, prop.id, "opening:payables", [prop.id], "Prior-year accrual agreed to the audit adjustment schedule", "AA-2025-01", JSON.stringify(linesOf(prop)), uuid(), extra.bundle ?? null, extra.supersedes ?? null]).then((r) => r.r);
    const layer = async () => Object.fromEntries((await db.asRole("authenticated", U.owner, "SELECT account_code, (adjusted_debit_minor - adjusted_credit_minor)::text v FROM public.close_review_adjusted_trial_balance($1,$2)", [A, Y])).map((r) => [r.account_code, r.v]));
    const composition = async (yr = Y) => (await asU(U.owner, "SELECT public.fs_statement_composition($1,$2) r", [A, yr])).r;
    const line = (c, id) => c.lines.find((l) => l.lineId === id);
    const deps = async () => (await asU(U.owner, "SELECT public.fs_reporting_dependencies($1,$2) r", [A, Y])).r;
    return { A, name, T, uploads, rid25, r25, rv, fin, priorDoc, adj, appr, reg, optIn, importAll, ledgerPayload, BRIDGE, EVID, checkBooks, propose, linesOf, layer, composition, line, deps };
  }

  // ═══════════════════════════ Source A: the prior year's pack finalised inside CFOClose ═══════════════════════════
  group("A1. The prior year: certified from the ledger, an approved accrual of 100.00, the pack FINAL in CFOClose");
  let a;
  await check("three years are certified ONCE each; the FY2025 accrual is proposed by one person and approved by another; the FY2025 pack is REVIEWED then FINAL", async () => {
    a = await returningClient("A");
    const n = await db.count("SELECT count(*) n FROM public.trial_balance_uploads WHERE company_id=$1", [a.A]);
    return a.adj.outcome === "proposed" && a.appr.outcome === "recorded" && a.appr.selfApproved === false && a.rv.state === "REVIEWED" && a.fin.state === "FINAL" && n === 3 ? true : { adj: a.adj.outcome, appr: a.appr, rv: a.rv?.state, fin: a.fin?.state, n };
  });
  await check("the FY2025 ledger never carried the accrual (expense line 9,900.00 + 100.00 adjustment); the issued FY2025 pack carries it: payable 3,200.00 and an expense line of 10,000.00", async () => {
    const atb = await db.asRole("authenticated", U.owner, "SELECT account_code, certified_debit_minor::text cd, certified_credit_minor::text cc, adjusted_debit_minor::text ad, adjusted_credit_minor::text ac FROM public.close_review_adjusted_trial_balance($1,2025) WHERE account_code IN ('2000','6100')", [a.A]);
    const by = Object.fromEntries(atb.map((r) => [r.account_code, r]));
    return by["6100"]?.cd === "240000" && by["6100"]?.ad === "250000" && by["2000"]?.cc === "310000" && by["2000"]?.ac === "320000" ? true : atb;
  });

  group("A2. This year: one engagement, one certified FY2026 trial balance, Check my books");
  let run1, issues1;
  await check("the FY2026 comparative IS the prior pack as issued: payable 320,000, expense line 1,000,000 (6100 = 250,000), profit 500,000 (minor units); it reconciles to the prior FINAL", async () => {
    const c = await a.composition();
    const pay = a.line(c, "sfp.trade_and_other_payables"), opx = a.line(c, "sci.operating_expenses_by_function");
    const d = await a.deps();
    return pay.comparative.amountMinor === "320000" && opx.comparative.amountMinor === "1000000" && c.totals.comparative.profitOrLossMinor === "500000" && c.totals.comparative.state === "complete"
      && d.priorFinalReconciliation?.state === "reconciled" ? true : { pay: pay.comparative, opx: opx.comparative, profit: c.totals.comparative.profitOrLossMinor, prior: d.priorFinalReconciliation };
  });
  let before;
  await check("BEFORE the correction the ledger's FY2026 books are short by the accrual: payable 310,000, profit 510,000; opt in, import the QuickBooks export + the audit adjustment schedule + the approved prior-year figure", async () => {
    const c = await a.composition();
    before = { pay: a.line(c, "sfp.trade_and_other_payables").current.amountMinor, profit: c.totals.current.profitOrLossMinor, equity: c.totals.current.totalEquityMinor };
    const o = await a.optIn(); const imp = await a.importAll();
    return before.pay === "310000" && before.profit === "510000" && o.outcome === "recorded" && Object.values(imp).every((x) => x.outcome === "recorded") ? true : { before, o, imp };
  });
  await check("ONE finding for the discrepancy, ONE scope held, ONE clear next action; the independent checks (pack, rule pack, ledger tie-out) are READY and continue", async () => {
    run1 = await a.checkBooks();
    const bad = run1.result.findings.filter((f) => f.outcome !== "pass");
    issues1 = presentIssues(run1.result, { currency: "TZS", exponent: 2 });
    return run1.outcome === "recorded" && bad.length === 1 && bad[0].rule === "OPENING_ADJUSTMENT_UNPOSTED" && bad[0].detail.difference === "10000"
      && run1.result.scopes["opening:payables"] === "HELD" && run1.result.scopes.pack === "READY" && run1.result.scopes.rule_pack === "READY" && run1.result.scopes.ledger === "READY"
      && issues1.length === 1 && issues1[0].scope === "opening:payables" && issues1[0].nextAction.kind === "review_correction" && /100\.00/.test(issues1[0].headline)
      && run1.result.proposals.length === 1 && run1.result.proposals[0].id === CORR ? true : { bad: bad.map((f) => f.rule), scopes: run1.result.scopes, issues: issues1.map((i) => [i.scope, i.nextAction.kind, i.headline]) };
  });
  await check("drafting continues while the opening issue is open: the report version saves; the sign-off is REFUSED by the readiness gate (an unresolved required difference blocks REVIEWED and FINAL)", async () => {
    await a.T.closeReview(a.A, Y); await a.T.notes(a.A, Y);
    const rid = `rpt-fy2026-early-${uuid()}`;
    const r = await a.T.attempt(a.A, Y, rid, a.T.allEvidence(a.A, Y, { accrualInPriorYear: true }));
    const rd = r.outcome === "saved" ? await a.T.partner.c.readiness(a.A, rid, r.reportVersion) : null;
    const ref = r.outcome === "saved" ? await refusal(() => a.T.partner.c.setState(a.A, rid, r.reportVersion, "REVIEWED", "Attempt while the opening difference is open")) : null;
    return r.outcome === "saved" && rd.blockers.some((b) => /^RFR_/.test(b)) && ref !== null && /RFR_/.test(ref) ? true : { r: r.outcome, blockers: rd?.blockers, ref };
  });
  await check("the single TB upload is untouched by all of this: FY2026 still has exactly one certified upload (no duplicate trial balance upload)", async () =>
    (await db.count("SELECT count(*) n FROM public.trial_balance_uploads WHERE company_id=$1 AND period_year=2026", [a.A])) === 1 ? true : "duplicate");

  group("A3. The supported correction: proposed by one person, approved by another, exact balances, never applied twice");
  let propRes, adjId;
  await check("the opening-first correction is proposed (Dr 3100 opening equity 100.00 / Cr 2000 payable 100.00); repeated proposals and a retried approval apply ONE adjustment", async () => {
    const p1 = await a.propose(run1.result.proposals[0]), p2 = await a.propose(run1.result.proposals[0]), p3 = await a.propose(run1.result.proposals[0]);
    adjId = p1.adjustmentId; propRes = p1;
    const req = uuid();
    const s1 = await asU(U.partner, "SELECT public.close_review_decide_adjustment($1,'approve','Agreed to the audit adjustment schedule',NULL,$2) r", [adjId, req]).then((r) => r.r);
    const s2 = await asU(U.partner, "SELECT public.close_review_decide_adjustment($1,'approve','Agreed to the audit adjustment schedule',NULL,$2) r", [adjId, req]).then((r) => r.r);
    const n = await db.count("SELECT count(*) n FROM public.rfr_corrections WHERE company_id=$1 AND correction_id=$2", [a.A, CORR]);
    return p1.outcome === "proposed" && p2.outcome === "already_proposed" && p3.outcome === "already_proposed" && s1.outcome === "recorded" && s2.replay === true && n === 1 ? true : { p: [p1.outcome, p2.outcome, p3.outcome], s: [s1, s2], n };
  });
  await check("the adjusted FY2026 trial balance is exact: payable 320,000 (credit), opening equity 3100 = 1,090,000 (credit), expense 6100 unchanged at 240,000; the engine agrees; the scope is READY and finalization is not held", async () => {
    const run2 = await a.checkBooks(); const L = await a.layer();
    return run2.balancesAgree === true && L["2000"] === "-320000" && L["3100"] === "-1090000" && L["6100"] === "240000" && run2.result.scopes["opening:payables"] === "READY" && run2.result.finalization.held === false
      && run2.result.applied_adjustments.join() === CORR ? true : { agree: run2.balancesAgree, L: { 2000: L["2000"], 3100: L["3100"], 6100: L["6100"] }, scopes: run2.result.scopes, fin: run2.result.finalization };
  });
  await check("retries and repeated imports apply nothing again: re-importing the same files is a replay, a second engine run records the same content, the payable stays 320,000 and there is still one correction", async () => {
    const d0 = (await db.one("SELECT public.rfr_content_digest($1,$2) d", [a.A, Y])).d;
    const imp = await a.importAll();
    const r3 = await a.checkBooks(); const r4 = await a.checkBooks();
    const d1 = (await db.one("SELECT public.rfr_content_digest($1,$2) d", [a.A, Y])).d;
    const L = await a.layer();
    const n = await db.count("SELECT count(*) n FROM public.rfr_corrections WHERE company_id=$1 AND correction_id=$2", [a.A, CORR]);
    const adjN = await db.count("SELECT count(*) n FROM public.close_review_adjustments WHERE company_id=$1 AND period_year=$2", [a.A, Y]);
    return d0 === d1 && L["2000"] === "-320000" && n === 1 && adjN === 1 && r3.balancesAgree && r4.balancesAgree && r3.result.applied_adjustments.length === 1 ? true : { d0, d1, imp: Object.values(imp).map((x) => x.outcome), L2000: L["2000"], n, adjN };
  });
  await check("current-year profit is unchanged by the prior-year correction (510,000), payable 320,000, opening equity: total equity opening 2,090,000 = prior closing", async () => {
    const c = await a.composition();
    return a.line(c, "sfp.trade_and_other_payables").current.amountMinor === "320000" && c.totals.current.profitOrLossMinor === "510000" && c.totals.current.equityAccountsMinor === "2090000" ? true : { pay: a.line(c, "sfp.trade_and_other_payables").current, profit: c.totals.current.profitOrLossMinor, eq: c.totals.current.equityAccountsMinor };
  });

  group("A4. The existing report preview and the server sign-off");
  let ver, depsAtPreview, cmpAtPreview;
  await check("the comparative is approved against the prior pack; the preview version saves and is READY (no blocker of any kind)", async () => {
    await a.T.closeReview(a.A, Y);
    const cmp = await a.T.approveComparatives(a.A, Y);
    const rid = `rpt-fy2026-${uuid()}`;
    const r = await a.T.attempt(a.A, Y, rid, a.T.allEvidence(a.A, Y, { accrualInPriorYear: true }));
    ver = { rid, v: r.reportVersion };
    const rd = await a.T.partner.c.readiness(a.A, rid, r.reportVersion);
    depsAtPreview = await a.deps();
    cmpAtPreview = (await asU(U.owner, "SELECT public.fs_comparatives_status($1,$2) r", [a.A, Y])).r.comparative;
    return cmp.outcome === "recorded" && r.outcome === "saved" && rd.ready === true && rd.blockers.length === 0 && cmpAtPreview.state === "approved" ? true : { cmp: cmp.outcome, r: r.outcome, blockers: rd.blockers };
  });
  await check("the preview's figures are the server's, exactly: comparative payable 320,000 / expense 1,000,000; current payable 320,000; opening equity 2,090,000; profit 510,000; closing equity 2,600,000", async () => {
    const f = Object.fromEntries(depsAtPreview.figures.map((x) => [x.factId, x.amountMinor]));
    const doc = (await db.one("SELECT report_document FROM public.financial_statement_reports WHERE report_id=$1 AND report_version=$2", [ver.rid, ver.v])).report_document;
    const dv = new Map(doc.facts.map((x) => [x.factId, x.value.minorUnits.__bigint__]));
    const want = { "fact:line:eq:total-opening:CURRENT": "2090000", "fact:line:eq:total-profit:CURRENT": "510000", "fact:line:eq:total-closing:CURRENT": "2600000", "fact:line:eq:total-opening:COMPARATIVE_1": "1660000", "fact:line:eq:total-profit:COMPARATIVE_1": "500000", "fact:line:eq:total-closing:COMPARATIVE_1": "2090000" };
    const wrong = Object.entries(want).filter(([id, v]) => f[id] !== v || dv.get(id) !== v);
    const c = await a.composition();
    return wrong.length === 0 && a.line(c, "sfp.trade_and_other_payables").comparative.amountMinor === "320000" && a.line(c, "sci.operating_expenses_by_function").comparative.amountMinor === "1000000" ? true : { wrong };
  });
  let finalBinding;
  await check("REVIEWED (partner) then FINAL (owner): preview and FINAL use the SAME approved comparative - both bindings carry the preview's dependencies identity and that comparative status", async () => {
    const rv = await a.T.partner.c.setState(a.A, ver.rid, ver.v, "REVIEWED", "Reviewed: figures agree to the issued prior-year pack and the approved correction");
    const fin = await a.T.owner.c.setState(a.A, ver.rid, ver.v, "FINAL", "Approved for issue");
    const b = (await db.admin.query("SELECT state, dependencies_sha256, dependencies, document_sha256 FROM public.fs_publication_bindings WHERE report_id=$1 AND report_version=$2 ORDER BY seq", [ver.rid, ver.v])).rows;
    finalBinding = b;
    const now = await a.deps();
    return rv.state === "REVIEWED" && fin.state === "FINAL" && b.length === 2 && b.every((x) => x.dependencies_sha256 === depsAtPreview.dependenciesSha256 && x.dependencies.comparativeStatusSha256 === depsAtPreview.comparativeStatusSha256)
      && now.comparativeStatusSha256 === depsAtPreview.comparativeStatusSha256 && cmpAtPreview.approval.comparativeSha256 === (await asU(U.owner, "SELECT public.fs_comparatives_status($1,$2) r", [a.A, Y])).r.comparative.approval.comparativeSha256 ? true : { rv: rv.state, fin: fin.state, n: b.length };
  });
  await check("traceable as SEPARATE records: the issued prior pack (its FINAL publication and document hash), the opening bridge (a hash-addressed input) and the correction (one approved adjustment); the FINAL manifest binds the readiness run and review", async () => {
    const priorPub = await db.count("SELECT count(*) n FROM public.financial_statement_publications WHERE report_id=$1 AND state='FINAL'", [a.rid25]);
    const bridge = (await db.one("SELECT payload_sha256 FROM public.rfr_inputs WHERE company_id=$1 AND period_year=$2 AND family='opening_bridge' ORDER BY seq DESC LIMIT 1", [a.A, Y])).payload_sha256;
    const corr = (await db.one("SELECT c.adjustment_id FROM public.rfr_corrections c WHERE c.company_id=$1 AND c.correction_id=$2", [a.A, CORR]));
    const man = (await db.one("SELECT m.manifest FROM public.rfr_finalization_manifests m JOIN public.financial_statement_publications p ON p.id=m.publication_id WHERE p.report_id=$1 AND p.state='FINAL'", [ver.rid])).manifest;
    const prior = (await a.deps()).priorFinalReconciliation;
    return priorPub === 1 && /^[0-9a-f]{64}$/.test(bridge) && corr.adjustment_id === adjId && /^[0-9a-f]{64}$/.test(a.priorDoc.h) && man.contract === "rfr-finalization-manifest/1" && man.scopes["opening:payables"] === "READY" && prior.state === "reconciled" ? true : { priorPub, bridge, man: man.scopes, prior };
  });

  // ═══════════════ A5: a ledger edit that leaves every trial-balance total unchanged invalidates the review ═══════════════
  group("A5. A ledger edit that changes no trial-balance total invalidates the review before FINAL");
  let c5;
  await check("REVIEWED on the ready books; then ONE ledger entry is re-dated (every account total identical): the content changes, the readiness run is stale, and FINAL is refused; the unchanged certified trial balance is not re-uploaded", async () => {
    c5 = await returningClient("E");
    await c5.optIn(); await c5.importAll(); const r1 = await c5.checkBooks();
    await c5.propose(r1.result.proposals[0]);
    const adj = (await db.one("SELECT adjustment_id FROM public.rfr_corrections WHERE company_id=$1 AND correction_id=$2", [c5.A, CORR])).adjustment_id;
    await asU(U.partner, "SELECT public.close_review_decide_adjustment($1,'approve','Agreed',NULL,$2) r", [adj, uuid()]);
    await c5.checkBooks();
    await c5.T.closeReview(c5.A, Y); await c5.T.notes(c5.A, Y); await c5.T.approveComparatives(c5.A, Y);
    const rid = `rpt-fy2026-e-${uuid()}`;
    const r = await c5.T.attempt(c5.A, Y, rid, c5.T.allEvidence(c5.A, Y, { accrualInPriorYear: true }));
    const rv = await c5.T.partner.c.setState(c5.A, rid, r.reportVersion, "REVIEWED", "Reviewed");
    c5.ver = { rid, v: r.reportVersion };
    const d0 = (await db.one("SELECT public.rfr_content_digest($1,$2) d", [c5.A, Y])).d;
    const edit = await c5.reg("ledger_snapshot", "gl", c5.ledgerPayload({ moveDate: "2026-12-30" }));
    const tbSame = (await db.count("SELECT count(*) n FROM public.trial_balance_uploads WHERE company_id=$1 AND period_year=2026", [c5.A])) === 1;
    const d1 = (await db.one("SELECT public.rfr_content_digest($1,$2) d", [c5.A, Y])).d;
    const ref = await refusal(() => c5.T.owner.c.setState(c5.A, rid, r.reportVersion, "FINAL", "Attempt after a ledger edit"));
    const finals = await db.count("SELECT count(*) n FROM public.financial_statement_publications WHERE report_id=$1 AND state='FINAL'", [rid]);
    const stale = (await c5.T.partner.c.readiness(c5.A, rid, r.reportVersion)).blockers.filter((b) => /^RFR_/.test(b));
    return rv.state === "REVIEWED" && edit.outcome === "recorded" && tbSame && d0 !== d1 && ref !== null && /RFR_MANIFEST_STALE|RFR_NOT_EVALUATED|RFR_STALE|RFR_REVIEW_STALE/.test(ref) && finals === 0 && stale.length > 0 ? true : { rv: rv.state, edit: edit.outcome, tbSame, d0eq: d0 === d1, ref, finals, stale };
  });
  await check("after a fresh check the run is current again but the REVIEW still binds the OLD content: FINAL is refused as RFR_REVIEW_STALE; restoring the original export makes the reviewed content current and FINAL is accepted", async () => {
    const r = await c5.checkBooks();
    const stale = (await c5.T.partner.c.readiness(c5.A, c5.ver.rid, c5.ver.v)).blockers.filter((b) => /^RFR_/.test(b));
    const ref = await refusal(() => c5.T.owner.c.setState(c5.A, c5.ver.rid, c5.ver.v, "FINAL", "Attempt on a changed ledger"));
    await c5.reg("ledger_snapshot", "gl", c5.ledgerPayload());
    await c5.checkBooks();
    const fin = await c5.T.owner.c.setState(c5.A, c5.ver.rid, c5.ver.v, "FINAL", "Approved on the reviewed content");
    return r.outcome === "recorded" && stale.includes("RFR_REVIEW_STALE") && /RFR_REVIEW_STALE/.test(ref ?? "") && fin.state === "FINAL" ? true : { stale, ref, fin: fin.state };
  });

  // ═══════════════ QuickBooks later carries the same journal as current-year expense ═══════════════
  group("Q. The same journal later appears in QuickBooks as CURRENT-year expense");
  const replaceTb = async (c, tbYear) => {
    const cur = c.uploads[2026];
    const v = (await db.one("SELECT version FROM public.trial_balance_uploads WHERE id=$1", [cur.id])).version;
    await asU(U.owner, "SELECT * FROM public.remove_trial_balance_upload($1,$2,'Replaced by the corrected export')", [cur.id, v]);
    const up = await k.upload(c.A, Y, tbYear, { periodId: cur.periodId }); await k.certify(c.A, up); c.uploads[2026] = up;
  };
  const LEDGER_Q = JSON.parse(JSON.stringify(LEDGER)); LEDGER_Q[2026][6100] = ["2500.00", ""]; LEDGER_Q[2026][2000] = ["", "3200.00"];
  const tbQ = "Account code,Account name,Debit,Credit\n" + Object.entries(LEDGER_Q[2026]).map(([code, [d, c2]]) => `${code},${{ 1000: "Bank", 1100: "Trade receivables", 1200: "Inventory", 1500: "Equipment at cost", 1510: "Accumulated depreciation", 2000: "Trade payables", 2100: "Income tax payable", 2500: "Bank loan", 3000: "Share capital", 3100: "Retained earnings", 4000: "Sales", 4100: "Interest income", 5000: "Cost of sales", 6000: "Salaries", 6100: "Professional fees", 6200: "Depreciation", 6300: "Interest expense", 7000: "Income tax expense" }[code]},${d},${c2}`).join("\n") + "\n";
  const posting = (links) => ({ id: "QBO-JE-1001", lines: [{ account: "6100", amount: "10000" }, { account: "2000", amount: "-10000" }], links });
  let q;
  await check("setup: an approved opening correction exists (payable 320,000, opening equity reduced by 100.00); QuickBooks is then re-exported with Dr expense 100.00 / Cr payable 100.00 and the certified trial balance is replaced (a reviewed replacement, not a second upload)", async () => {
    q = await returningClient("Q");
    await q.optIn(); await q.importAll(); const r1 = await q.checkBooks();
    const p = await q.propose(r1.result.proposals[0]);
    await asU(U.partner, "SELECT public.close_review_decide_adjustment($1,'approve','Agreed',NULL,$2) r", [p.adjustmentId, uuid()]);
    q.origAdj = p.adjustmentId;
    await replaceTb(q, tbQ);
    return p.outcome === "proposed" ? true : p;
  });
  await check("LINKED journal (it names the correction): the engine finds it but it is not the same effect - it is booked as expense, not as opening equity; the original adjustment requires revalidation; the scope holds and states the residual exactly", async () => {
    await q.reg("ledger_snapshot", "gl", q.ledgerPayload({ tb: LEDGER_Q, snapshot: "qbo-export-2026-002", postings: [posting([CORR])] }));
    const r = await q.checkBooks();
    const cs = r.result.corrections.find((c) => c.id === CORR);
    const reval = (await asU(U.owner, "SELECT public.close_review_adjustments_summary($1,$2) r", [q.A, Y])).r.requiresRevalidation;
    return cs?.state === "partial_or_different" && cs.residual?.["3100"] === "10000" && cs.residual?.["6100"] === "-10000" && r.result.scopes["opening:payables"] === "HELD" && reval === 1 ? true : { cs, scopes: r.result.scopes, reval };
  });
  await check("the APPROVED TREATMENT: the original is declined on revalidation, the residual (Dr 3100 100.00 / Cr 6100 100.00, superseding the original) is proposed and approved by another person; the books end with payable 320,000, ZERO current-year expense from the item (6100 = 240,000), opening equity reduced by 100.00, ONE economic correction; the engine agrees and the scope is READY", async () => {
    await asU(U.partner, "SELECT public.close_review_revalidate_adjustment($1,'decline','Booked in QuickBooks; treatment below',false,$2) r", [q.origAdj, uuid()]);
    const resid = { id: "corr:opening:payables:residual", lines: [{ account: "3100", amount: "10000" }, { account: "6100", amount: "-10000" }] };
    const rp = await asU(U.preparer, "SELECT public.rfr_propose_correction($1,$2,$3,'opening:payables',$4::text[],$5,'AA-2025-01',$6::jsonb,$7,NULL,'bundle:residual',$8) r", [q.A, Y, resid.id, [resid.id], "Reclassify the QuickBooks current-year expense to opening equity", JSON.stringify(q.linesOf(resid)), uuid(), CORR]).then((r) => r.r);
    await asU(U.partner, "SELECT public.close_review_decide_adjustment($1,'approve','The journal is the prior-year accrual; reclassified to opening equity',NULL,$2) r", [rp.adjustmentId, uuid()]);
    const r = await q.checkBooks(); const L = await q.layer();
    const effective = r.result.applied_adjustments;
    const cs = r.result.corrections.find((c) => c.id === CORR);
    const c = await q.composition();
    return rp.outcome === "proposed" && cs?.state === "completed_by_residual" && r.balancesAgree === true && L["2000"] === "-320000" && L["6100"] === "240000" && L["3100"] === "-1090000"
      && r.result.scopes["opening:payables"] === "READY" && r.result.finalization.held === false && effective.length === 1 && effective[0] === "corr:opening:payables:residual"
      && q.line(c, "sfp.trade_and_other_payables").current.amountMinor === "320000" && c.totals.current.profitOrLossMinor === "510000" ? true
      : { rp: rp.outcome, state: cs?.state, agree: r.balancesAgree, L: { 2000: L["2000"], 6100: L["6100"], 3100: L["3100"] }, effective, scopes: r.result.scopes, profit: c.totals.current.profitOrLossMinor };
  });
  let u;
  await check("an UNLINKED same-amount journal (it does not name the correction) is NOT read as the correction and is not ignored: the engine marks it a candidate needing confirmation and the scope stays open for review", async () => {
    u = await returningClient("U");
    await u.optIn(); await u.importAll(); const r1 = await u.checkBooks();
    const p = await u.propose(r1.result.proposals[0]);
    await asU(U.partner, "SELECT public.close_review_decide_adjustment($1,'approve','Agreed',NULL,$2) r", [p.adjustmentId, uuid()]);
    await replaceTb(u, tbQ);
    await u.reg("ledger_snapshot", "gl", u.ledgerPayload({ tb: LEDGER_Q, snapshot: "qbo-export-2026-002", postings: [posting([])] }));
    const r = await u.checkBooks();
    const cs = r.result.corrections.find((c) => c.id === CORR);
    const f = r.result.findings.find((x) => x.rule === "CORRECTION_CANDIDATE_NEEDS_CONFIRMATION");
    return cs?.state === "candidate_needs_confirmation" && f?.outcome === "suspected" && r.result.scopes["opening:payables"] === "HELD" && r.result.finalization.held === true ? true : { cs, f, scopes: r.result.scopes };
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish("RETURNING CLIENT (source A)", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
