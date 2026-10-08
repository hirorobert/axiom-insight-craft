#!/usr/bin/env bun
// Real-PostgreSQL proof of the reporting workbench's OWN client code (src/lib/reporting) end to end: the browser's
// transport is replaced only by an in-process `authenticated` connection (clientDb); every call, payload and refusal is the
// one the page makes.
//
//   evidence     a preparer supplies the ledger, equity movements and cash map; ONE atomic commit stores them with a
//                version; the version is re-saved on the dependencies the evidence changed (both kept)
//   figures      the cash-flow and changes-in-equity statements carry HAND-COMPUTED figures (below), not the generators'
//                own expectations; the composed statements carry the server's figures
//   sign-off     the canonical path signs the version REVIEWED then FINAL; viewers and preparers are refused
//   replay       the same attempt saves no second version
//   export       the sealed pack is rendered from the STORED document and its binding: same bytes twice, the binding's
//                hashes on the seal
//   next action  the pure next-action function, fed the server's real payloads, names the right page at each step
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/reportingWorkbench.mjs
import { applyChain, certifier, clientDb, EVIDENCE_FY2025_COMPARATIVE, EVIDENCE_FY2026, makeWorld, openDatabase, prepareReporting, reporter, uuid } from "./lib/reportingKit.mjs";
import { ingestEvidence } from "../../src/lib/financialEvidence/intake.ts";
import { signoffClient } from "../../src/lib/reporting/signoff.ts";
import { prepareReportVersion } from "../../src/lib/reporting/prepareVersion.ts";
import { nextReportingAction } from "../../src/lib/reporting/nextAction.ts";
import { parseComposition } from "../../src/lib/statements/composition.ts";
import { parseNotesStatus } from "../../src/lib/notes/notesStatus.ts";
import { parseComparativeStatus } from "../../src/lib/comparatives/comparatives.ts";
import { buildReportPack } from "../../src/lib/exports/reportPack.ts";

const { group, check, refused, finish } = reporter();
let db;

// Hand-computed from EVIDENCE_FY2026 and the FY2026/FY2025 trial balances (minor units, TZS, 2 dp):
//   operating: 29,500.00 − 22,800.00 + 500.00 − 500.00 − 500.00 = 6,200.00     financing: −1,000.00 − 700.00 = −1,700.00
//   net change 4,500.00; opening cash 8,000.00 (FY2025 bank); closing 12,500.00 (FY2026 bank)
//   equity: opening 16,600.00 (10,000 + 6,600); profit 5,100.00; dividends −700.00; closing 21,000.00
const EXPECT = { operating: 620000n, financing: -170000n, net: 450000n, opening: 800000n, closing: 1250000n, equityClose: 2100000n, profit: 510000n };

async function main() {
  db = await openDatabase("workbench_proof");
  group("Replay");
  await check("the whole chain applies", async () => (await applyChain(db)) ?? true);
  const W = await makeWorld(db);
  const { U, A } = W;
  await W.rollout(A, true);
  const k = await certifier(db, U);
  const Y = 2026;
  const as = (uid) => { const d = clientDb(db, uid); return { d, c: signoffClient(d) }; };
  const pre = as(U.preparer), partner = as(U.partner), owner = as(U.owner), viewer = as(U.viewer);
  const rid = `rpt-${A}-${Y}`;
  const parse = (type, role = "CURRENT") => {
    const y = role === "CURRENT" ? Y : Y - 1;
    const text = (role === "CURRENT" ? EVIDENCE_FY2026 : EVIDENCE_FY2025_COMPARATIVE)[type];
    const r = ingestEvidence({ companyId: A, evidenceType: type, periodRole: role, reportingPeriodId: `FY${Y}`, currency: "TZS", scale: 2, text, fileName: `${type.toLowerCase()}-${y}.csv`, periodStart: `${y}-01-01`, periodEnd: `${y}-12-31` });
    if (r.outcome !== "PARSED") throw new Error(`${type} rejected: ${r.diagnostics.map((x) => x.code).join(",")}`);
    return r.batch;
  };
  const state = async (uid, allowed) => {
    const d = clientDb(db, uid);
    const rpc = async (fn) => (await d.rpc(fn, { p_company_id: A, p_period_year: Y })).data;
    const versions = await signoffClient(d).versions(A, Y);
    const last = versions.filter((v) => v.isLatest).at(-1) ?? null;
    const r = last ? await signoffClient(d).readiness(A, last.reportId, last.reportVersion) : null;
    return nextReportingAction({ composition: parseComposition(await rpc("fs_statement_composition")), notes: parseNotesStatus(await rpc("fs_notes_status")),
      comparatives: parseComparativeStatus(await rpc("fs_comparatives_status")), latest: last && r ? { reportVersion: last.reportVersion, state: last.state, blockers: r.blockers } : null, allowed });
  };
  const PREP = ["prepare_close"], REV = ["prepare_close", "review_close"], OWN = ["prepare_close", "review_close", "approve_certification"];

  group("Next action before anything is prepared");
  await check("no reviewed trial balance: the statements page says so", async () => {
    const a = await state(U.preparer, PREP);
    return a.page === "fs-statements" && /no reviewed trial balance/.test(a.detail) ? true : a;
  });

  group("Setup through the real functions (certified years, presentation, Close Review, notes, comparatives)");
  await check("prepared", async () => { await prepareReporting(db, W, k, { year: Y, comparativesApproved: false }); return true; });
  await check("next action: comparatives await a reviewer — for a preparer it is someone else's step", async () => {
    const a = await state(U.preparer, PREP);
    return a.page === "fs-comparatives" && a.tone === "blocked" && /Not yet approved/.test(a.title) ? true : a;
  });
  await check("a reviewer approves the comparatives; next action: add the evidence", async () => {
    await db.asUser(U.partner, "SELECT public.fs_approve_comparatives($1,$2,true,'Agreed to the signed 2025 statements',$3) r", [A, Y, uuid()]);
    const a = await state(U.preparer, PREP);
    return a.page === "signoff" && /evidence/.test(a.title) ? true : a;
  });

  group("Evidence and the first version — one atomic commit, then re-bound");
  let saved;
  const key = `prep-${uuid()}`;
  await check("the ledger, equity movements and cash map are stored WITH a version; the version is re-saved on the dependencies they changed", async () => {
    saved = await prepareReportVersion(pre.d, pre.c, { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: rid, expectedReportVersion: 0,
      newEvidence: [...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "CASH_ACCOUNT_MAP"].map((t) => parse(t)), ...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "PRIOR_PERIOD_STATEMENTS"].map((t) => parse(t, "COMPARATIVE"))],
      idempotencyKey: key, evaluatedAt: "2027-02-01T09:00:00.000Z" });
    const ev = await db.count("SELECT count(*) n FROM public.financial_evidence_batches WHERE company_id=$1", [A]);
    return saved.outcome === "saved" && saved.evidenceVersion === 1 && saved.reportVersion === 2 && ev === 6 ? true
      : { saved: { ...saved, diagnostics: saved.diagnostics?.filter((x) => x.severity === "ERROR") }, ev };
  });
  await check("version 1 (stored the evidence) is stale against the dependencies; version 2 has NO blocker", async () => {
    const r1 = await partner.c.readiness(A, rid, 1);
    const r2 = await partner.c.readiness(A, rid, 2);
    return r1.blockers.includes("REPORTING_DEPENDENCIES_STALE") && r2.ready === true && r2.blockers.length === 0 ? true : { r1: r1.blockers, r2: r2.blockers };
  });
  await check("replaying the same attempt saves nothing new", async () => {
    const again = await prepareReportVersion(pre.d, pre.c, { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: rid, expectedReportVersion: 1,
      newEvidence: [], idempotencyKey: `${key}/rebind`, evaluatedAt: "2027-02-01T09:00:00.000Z" });
    const n = await db.count("SELECT count(*) n FROM public.financial_statement_reports WHERE report_id=$1", [rid]);
    return again.outcome === "saved" && again.reportVersion === 2 && n === 2 ? true : { again: again.outcome, v: again.reportVersion, n };
  });

  group("Figures — hand-computed, independent of the generators");
  let doc;
  const fact = (id) => { const f = doc.facts.find((x) => x.factId === id); return f ? BigInt(f.value.minorUnits.__bigint__ ?? f.value.minorUnits) : null; };
  const lineFacts = (type, pred) => doc.statements.filter((s) => s.type === type).flatMap((s) => s.sections.flatMap((x) => x.lines)).filter(pred).map((l) => l.factBindings.find((b) => b.periodId === "CURRENT")?.factId);
  await check("cash flows: operating 6,200.00; financing −1,700.00; net 4,500.00; opening 8,000.00; closing 12,500.00", async () => {
    doc = (await owner.c.report(rid, 2)).document;
    const total = (re) => lineFacts("STATEMENT_OF_CASH_FLOWS", (l) => re.test(l.lineId)).map(fact);
    const got = { operating: total(/operating.*(total|net)|net.*operating/i)[0], financing: total(/financing.*(total|net)|net.*financing/i)[0], net: total(/net.*(change|increase)/i)[0], opening: total(/opening/)[0], closing: total(/closing/)[0] };
    return Object.entries(EXPECT).filter(([k]) => k in got).every(([k, v]) => got[k] === v) ? true : { got: Object.fromEntries(Object.entries(got).map(([k, v]) => [k, String(v)])), lines: doc.statements.find((s) => s.type === "STATEMENT_OF_CASH_FLOWS")?.sections.flatMap((x) => x.lines.map((l) => l.lineId)) };
  });
  await check("comparative cash flows: opening 5,000.00 (signed prior-year statement), net 3,000.00, closing 8,000.00 = the FY2025 bank balance", async () => {
    const cmp = (re) => doc.statements.filter((s) => s.type === "STATEMENT_OF_CASH_FLOWS").flatMap((s) => s.sections.flatMap((x) => x.lines)).filter((l) => re.test(l.lineId)).map((l) => fact(l.factBindings.find((b) => b.periodId === "COMPARATIVE_1")?.factId));
    const got = { opening: cmp(/opening/)[0], net: cmp(/net-increase/)[0], closing: cmp(/closing/)[0] };
    return got.opening === 500000n && got.net === 300000n && got.closing === 800000n ? true : Object.fromEntries(Object.entries(got).map(([k, v]) => [k, String(v)]));
  });
  await check("the canonical rule pack, run independently on the saved version, reports no failing or insufficient finding", async () => {
    const f = (await db.admin.query("SELECT findings FROM public.financial_statement_evaluations WHERE report_id=$1 AND report_version=2", [rid])).rows[0].findings;
    const bad = f.filter((x) => x.outcome !== "PASS" && x.outcome !== "NOT_APPLICABLE");
    const passed = new Set(f.filter((x) => x.outcome === "PASS").map((x) => x.ruleId));
    return bad.length === 0 && ["subtotal-casting", "sfp-equation", "equity-profit-tie", "equity-closing-tie", "cashflow-closing-cash-reconciliation", "cashflow-account-rollforward"].every((r) => passed.has(r)) ? true : { bad: bad.map((x) => `${x.ruleId}:${x.outcome}`), passed: [...passed] };
  });
  await check("changes in equity: closing total 21,000.00 equals the composed statement of financial position's total equity", async () => {
    const closing = lineFacts("STATEMENT_OF_CHANGES_IN_EQUITY", (l) => /closing/i.test(l.lineId) && /total/i.test(l.lineId)).map(fact);
    const sfpEquity = fact("fact:current:total:totalEquityMinor");
    return closing.includes(EXPECT.equityClose) && sfpEquity === EXPECT.equityClose ? true : { closing: closing.map(String), sfpEquity: String(sfpEquity), lines: doc.statements.find((s) => s.type === "STATEMENT_OF_CHANGES_IN_EQUITY")?.sections.flatMap((x) => x.lines.map((l) => l.lineId)) };
  });
  await check("the cash-ledger authority resolves against the composed statement (account 1000), and the checklist is the server's notes status", async () => {
    const note = doc.notes.find((n) => n.noteId === "note:cash-ledger-authority");
    const cl = doc.textualDisclosures.filter((d) => d.disclosureId.startsWith("checklist:")).map((d) => d.text.split(":")[0]);
    return note?.monetaryFactIds.some((f) => f.startsWith("fact:cashroll:ledger:")) && cl.length === 3 && cl.every((t) => t === "PROVIDED") ? true : { note, cl };
  });
  await check("the recorded wording is in the document verbatim, from the texts in force", async () => {
    const d = doc.textualDisclosures.find((x) => x.disclosureId === "smes.note.policies");
    return d?.text === "Historical cost." ? true : d;
  });

  group("Sign-off through the one canonical path");
  await check("next action for a reviewer: review version 2", async () => { const a = await state(U.partner, REV); return a.page === "signoff" && a.title === "Review version 2" ? true : a; });
  await check("a viewer and a preparer are refused REVIEWED by the server; nothing is recorded", async () => {
    const out = [];
    for (const who of [viewer, pre]) { try { await who.c.setState(A, rid, 2, "REVIEWED", "not allowed to review"); out.push("accepted"); } catch (e) { out.push(e.code); } }
    const n = await db.count("SELECT count(*) n FROM public.financial_statement_publications WHERE report_id=$1", [rid]);
    return out.every((c) => c && c !== "accepted") && n === 0 ? true : { out, n };
  });
  await check("REVIEWED by the reviewer, FINAL by the owner; both bound to the stored document and current dependencies", async () => {
    await partner.c.setState(A, rid, 2, "REVIEWED", "Reviewed against the evidence");
    await owner.c.setState(A, rid, 2, "FINAL", "Approved for issue");
    const b = await owner.c.bindings(rid);
    const deps = await owner.c.dependencies(A, Y);
    return b.length === 2 && b.every((x) => x.reportVersion === 2 && x.dependenciesSha256 === deps.dependenciesSha256) ? true : { b, deps: deps.dependenciesSha256 };
  });
  await check("next action: export the sealed report", async () => { const a = await state(U.owner, OWN); return a.page === "exports" && a.tone === "done" ? true : a; });

  group("Export — the sealed pack from the stored document and its binding");
  await check("same bytes twice; the seal carries the binding's document and dependencies hashes; figures are the document's", async () => {
    const stored = await owner.c.report(rid, 2);
    const b = (await owner.c.bindings(rid)).find((x) => x.state === "FINAL");
    const { deserializeReport } = await import("../../src/lib/financialStatementsWorkspace/persistenceContract.ts");
    const report = deserializeReport(JSON.stringify(stored.document));
    const input = { document: report, entityName: "Synthetic SME Limited", editionTitle: "IFRS for SMEs (2015 edition)", adjustments: [],
      signOff: { state: "FINAL", signedAt: "2027-03-01T10:00:00Z", signedBy: "Owner", contentHash: b.documentSha256, dependenciesSha256: b.dependenciesSha256 } };
    const p1 = buildReportPack(input), p2 = buildReportPack(input);
    return p1.html === p2.html && p1.html.includes(b.documentSha256) && p1.html.includes(b.dependenciesSha256) && p1.csv.includes("12,500.00") && p1.csv.includes("21,000.00") ? true
      : { same: p1.html === p2.html, seal: p1.html.includes(b.documentSha256), csv: p1.csv.split("\n").slice(0, 8) };
  });

  group("A later change creates a new version; the signed one stays as signed");
  await check("a disclosure changes: version 2 stays FINAL but stale; version 3 is saved on the new dependencies and has no blocker", async () => {
    await db.asUser(U.preparer, "SELECT public.fs_record_disclosure($1,$2,'smes.note.estimates','Useful lives and residual values.','Notes v2',$3)", [A, Y, uuid()]);
    const r2 = await partner.c.readiness(A, rid, 2);
    const s = await prepareReportVersion(pre.d, pre.c, { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: rid, expectedReportVersion: 2, newEvidence: [], idempotencyKey: `prep-${uuid()}`, evaluatedAt: new Date().toISOString() });
    const r3 = await partner.c.readiness(A, rid, 3);
    const pub = (await owner.c.publications(rid)).map((p) => `${p.reportVersion}:${p.state}`);
    return r2.blockers.includes("REPORTING_DEPENDENCIES_STALE") && s.outcome === "saved" && s.reportVersion === 3 && r3.blockers.length === 0 && JSON.stringify(pub) === JSON.stringify(["2:REVIEWED", "2:FINAL"]) ? true : { r2: r2.blockers, s, r3: r3.blockers, pub };
  });
  await check("a stale expected version is refused by the server (no lost update)", async () => {
    try { await prepareReportVersion(pre.d, pre.c, { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: rid, expectedReportVersion: 1, newEvidence: [], idempotencyKey: `prep-${uuid()}`, evaluatedAt: new Date().toISOString() }); return "accepted"; }
    catch (e) { return /STALE_REPORT_VERSION/.test(e.message) ? true : e.message; }
  });
  await check("tenant isolation: another workspace's owner reads nothing of this report", async () => {
    const other = as(U.ownerB);
    const v = await other.d.rpc("fs_list_saved_versions", { p_company_id: A, p_period_year: Y });
    const sel = await other.d.select("financial_statement_reports", { report_id: rid });
    return v.error?.code === "42501" && Array.isArray(sel.data) && sel.data.length === 0 ? true : { v, sel: sel.data?.length };
  });
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish("REPORTING_WORKBENCH", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
