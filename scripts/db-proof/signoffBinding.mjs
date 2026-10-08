#!/usr/bin/env bun
// Real-PostgreSQL proof of sign-off bound to content and dependencies (20261021100000), end to end on real certifications:
// composition → notes and schedules → comparatives → Close Review → a report built by the TypeScript builder from the
// database's composition → REVIEWED → FINAL through the ONE canonical path (fs_set_publication_state).
//
//   ready        a complete report on current dependencies has no blocker, and the canonical path signs it
//   binding      every REVIEWED/FINAL records the server's document hash and the dependencies identity, atomically;
//                bindings are append-only
//   figures      a changed figure, an extra figure bound on the composed statements, a missing binding and a stale
//                binding are each refused by name — and the canonical path refuses to sign them
//   immutability FINAL never changes; a later change makes the old version stale (history kept) and needs a new version,
//                which signs with its own binding
//   defence      inserting a publication behind the canonical path's back for a stale report fails in the trigger
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/signoffBinding.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import crypto from "node:crypto";
import { ASSIGN, FY2025, FY2026, applyChain, assignmentPairs, certifier, chainFiles, csv, makeWorld, migrationText, openDatabase, reporter, uuid } from "./lib/reportingKit.mjs";
import { composedStatements } from "../../src/lib/statements/canonicalDocument.ts";
import { parseComposition } from "../../src/lib/statements/composition.ts";
import { canonicalStringify } from "../../src/lib/canonicalStatement/serialization.ts";

const FILE = "20261021100000_fs_signoff_binding.sql";
const { group, check, refused, finish } = reporter();
const hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
let db;

async function main() {
  db = await openDatabase("signoff_proof");
  group("Replay");
  await check(`${FILE} is in the chain and the whole chain applies`, async () => (!chainFiles().includes(FILE) ? `${FILE} missing` : (await applyChain(db)) ?? true));
  await refused("re-applying is refused by its preflight", "P0001", () => db.admin.query(migrationText(FILE)), "PREFLIGHT_REFUSED");

  const W = await makeWorld(db);
  const { U, A } = W;
  await W.rollout(A, true);
  const k = await certifier(db, U);
  const Y = 2026;
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  const evidenceIds = {};

  group("Setup — every authority complete, through the real functions");
  await check("certified years, presentation, Close Review findings resolved, notes complete, evidence present, comparatives approved", async () => {
    const p = await k.upload(A, 2025, csv(FY2025)); await k.review(A, p); await k.certify(A, p);
    const c = await k.upload(A, Y, csv(FY2026)); await k.certify(A, c);
    await asU(U.preparer, "SELECT public.fs_assign_presentation($1,$2::jsonb,'Presentation per the chart of accounts',$3)", [A, JSON.stringify(assignmentPairs(ASSIGN)), uuid()]);
    // Close Review: check the findings, then resolve each blocking one with an explanation.
    const run = (await asU(U.preparer, "SELECT public.close_review_refresh_findings($1,$2) r", [A, Y])).r;
    const open = (await db.admin.query(`SELECT f.id, f.rule_id, f.required_resolution FROM public.close_review_findings f WHERE f.run_id=$1`, [run.runId])).rows;
    for (const f of open) await asU(U.preparer, "SELECT public.close_review_finding_action($1,'explain','Accumulated depreciation is a contra-asset by design','Fixed asset register 2026',$2) r", [f.id, uuid()]);
    // Notes.
    const WORDS = { "smes.note.compliance": "Prepared in accordance with the IFRS for SMEs (2015 edition).", "smes.note.identification": "Synthetic SME Limited; year ended 31 December 2026; TZS.",
      "smes.note.policies": "Historical cost.", "smes.note.judgements": "None beyond estimates.", "smes.note.estimates": "Useful lives.", "smes.note.subclassifications": "All receivables from third parties.",
      "smes.note.share_capital": "10,000 ordinary shares, fully paid." };
    await asU(U.preparer, "SELECT public.fs_decide_requirement($1,$2,'smes.note.share_capital','applicable','The entity has share capital',$3)", [A, Y, uuid()]);
    for (const [id, text] of Object.entries(WORDS)) await asU(U.preparer, "SELECT public.fs_record_disclosure($1,$2,$3,$4,'Notes v1',$5)", [A, Y, id, text, uuid()]);
    await asU(U.preparer, "SELECT public.fs_record_schedule($1,$2,'ppe',$3::jsonb,'Fixed asset register 2026',$4)", [A, Y,
      JSON.stringify([{ classLabel: "Equipment", openingMinor: "1600000", closingMinor: "1400000", movements: [{ kind: "depreciation", amountMinor: "-200000" }] }]), uuid()]);
    // Evidence (accepted through a revision, as the product does).
    for (const type of ["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "CASH_ACCOUNT_MAP"]) evidenceIds[type] = await evidence(type);
    // Comparatives.
    const ap = (await asU(U.partner, "SELECT public.fs_approve_comparatives($1,$2,true,'Agreed to the signed 2025 statements',$3) r", [A, Y, uuid()])).r;
    const deps = (await asU(U.owner, "SELECT public.fs_reporting_dependencies($1,$2) r", [A, Y])).r;
    return ap.outcome === "recorded" && deps.state === "current" && deps.blockers.length === 0 ? true : { ap, blockers: deps.blockers };
  });
  async function evidence(type) {
    const rid = `rpt-ev-${uuid()}`;
    const batchId = `eb-${uuid()}`;
    await asU(U.partner, "SELECT * FROM public.fs_commit_revision($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::text[],$11::jsonb)", [
      A, rid, 0, `key-${uuid()}`, Y, "TRIAL_BALANCE_DERIVED", JSON.stringify({ reportIdentity: { reportId: rid, companyId: A, reportVersion: 1 }, statements: [], facts: [] }), hex(rid),
      JSON.stringify([{ evidenceBatchId: batchId, reportingPeriodId: `FY${Y}`, evidenceType: type, periodRole: "CURRENT", seriesKey: `s-${uuid()}`, schemaVersion: "1",
        sourceFileName: "evidence.csv", contentHash: hex(batchId), currency: "TZS", scale: 2, batchDocument: { rows: [{ amount: "1.00", memo: "ok" }] }, validationStatus: "VALID", diagnostics: [], expectedPreviousBatchId: null }]),
      [batchId], JSON.stringify({ evaluationRunId: `ev-${uuid()}`, rulePackId: "rp", rulePackVersion: "2", engineVersion: "e2", inputHash: hex(`ie${rid}`), findings: [] })]);
    return batchId;
  }
  // A report built exactly as the workbench will: the composed statements from the database's composition (the
  // TypeScript builder), the evidence-built statements (here, stand-ins carrying their evidence provenance), the notes.
  const buildDoc = async (rid, version, tamper = null) => {
    const comp = parseComposition((await asU(U.owner, "SELECT public.fs_statement_composition($1,$2) r", [A, Y])).r);
    const input = (await asU(U.owner, "SELECT public.fs_reporting_input($1,$2) r", [A, Y])).r;
    const deps = (await asU(U.owner, "SELECT public.fs_reporting_dependencies($1,$2) r", [A, Y])).r;
    const built = composedStatements(comp, { start: input.comparative.reportingStart, end: input.comparative.reportingEnd });
    const ev = (id, periodId) => ({ factId: id, version: 1, value: { currency: "TZS", scale: 2, minorUnits: 100n }, reportingPeriod: { periodId, isComparative: periodId !== "CURRENT" },
      signConvention: "NATURAL", provenance: { source: { sourceDocumentId: evidenceIds.TRANSACTION_LEDGER, sourceHash: "e".repeat(64), artifactKind: "EVIDENCE_BATCH" },
        locator: { kind: "EVIDENCE_ROW", batchId: evidenceIds.TRANSACTION_LEDGER, rowNumber: 1 }, extractionMethod: "EVIDENCE_BATCH_DERIVED", extractionConfidence: { kind: "CERTAIN" }, originalText: "1.00" }, supersedesVersion: null });
    const evLine = (lineId) => ({ lineId, label: lineId, concept: lineId, role: "DETAIL", normalBalance: "DEBIT_NORMAL", isContra: false, castingChildLineIds: [],
      factBindings: [{ periodId: "CURRENT", factId: `fact:ev:${lineId}:c` }, { periodId: "COMPARATIVE_1", factId: `fact:ev:${lineId}:p` }] });
    const evStatement = (type, lines) => ({ statementId: `stmt:${type}`, type, title: type, sections: [{ sectionId: `s:${type}`, label: type, lines: lines.map(evLine) }] });
    const evidenceStatements = [evStatement("STATEMENT_OF_CHANGES_IN_EQUITY", ["line:socie:equity"]), evStatement("STATEMENT_OF_CASH_FLOWS", ["line:cf:opening", "line:cf:closing"])];
    const evFacts = ["line:socie:equity", "line:cf:opening", "line:cf:closing"].flatMap((l) => [ev(`fact:ev:${l}:c`, "CURRENT"), ev(`fact:ev:${l}:p`, "COMPARATIVE_1")]);
    let facts = [...built.facts, ...evFacts];
    let statements = [...built.statements, ...evidenceStatements];
    if (tamper === "figure") facts = facts.map((f) => (f.factId === "fact:current:current_assets:sfp.inventories" ? { ...f, value: { ...f.value, minorUnits: f.value.minorUnits + 1n } } : f));
    if (tamper === "account") { // one account's figure moves while its line's total is unchanged — only the per-account check sees it
      const ids = facts.filter((f) => f.factId.startsWith("fact:current:account:")).map((f) => f.factId).slice(0, 2);
      facts = facts.map((f) => (f.factId === ids[0] ? { ...f, value: { ...f.value, minorUnits: f.value.minorUnits + 1n } } : f.factId === ids[1] ? { ...f, value: { ...f.value, minorUnits: f.value.minorUnits - 1n } } : f));
    }
    if (tamper === "extra") {
      facts = [...facts, { ...facts[0], factId: "fact:current:current_assets:sfp.made_up" }];
      statements = statements.map((s) => (s.statementId !== "stmt:sfp" ? s : { ...s, sections: [...s.sections, { sectionId: "section:extra", label: "Extra", lines: [{ ...s.sections[0].lines[0], lineId: "line:extra", factBindings: [{ periodId: "CURRENT", factId: "fact:current:current_assets:sfp.made_up" }] }] }] }));
    }
    const doc = {
      schemaVersion: "1.0.0", reportIdentity: { reportId: rid, companyId: A, reportVersion: version }, entity: { legalName: "Synthetic SME Limited" },
      period: { periodId: "CURRENT", startDate: input.current.reportingStart, endDate: input.current.reportingEnd, periodYear: Y }, comparativePeriods: built.comparativePeriods,
      framework: { kind: "IFRS_FOR_SMES" }, presentationCurrency: { currency: "TZS", scale: 2, roundingPolicy: { mode: "HALF_UP", scale: 2 }, presentationMultiplier: 1n },
      statements, notes: [{ noteId: "note:cash-ledger-authority", monetaryFactIds: ["fact:cashroll:ledger:1000", "fact:cashroll:tb:1000"] }], noteReferences: [], accountingPolicies: [],
      textualDisclosures: [...["accounting-policies", "basis-of-preparation", "supporting-notes"].map((a) => ({ disclosureId: `checklist:${a}`, text: `PROVIDED: ${a}` })),
        { disclosureId: "mapping:coverage", text: "total=18;unmapped=0;ambiguous=0" }],
      facts, provenanceOrigin: "TRIAL_BALANCE_DERIVED",
      ...(tamper === "unbound" ? {} : { reportingDependencies: { dependenciesSha256: tamper === "stale" ? "0".repeat(64) : deps.dependenciesSha256, compositionSha256: deps.compositionSha256,
        notesStatusSha256: deps.notesStatusSha256, comparativeStatusSha256: deps.comparativeStatusSha256 } }),
    };
    return doc;
  };
  const save = async (rid, version, doc) => {
    const text = canonicalStringify(doc);
    await asU(U.preparer, "SELECT * FROM public.fs_save_report_version($1,$2,$3,$4,'TRIAL_BALANCE_DERIVED',$5::jsonb,$6,$7::text[])", [rid, version, A, Y, text, hex(text), [evidenceIds.TRANSACTION_LEDGER, evidenceIds.EQUITY_MOVEMENTS]]);
    await asU(U.partner, "SELECT * FROM public.fs_save_evaluation($1,$2,$3,$4,'rule-pack','1','engine-1',$5,'[]'::jsonb)", [`ev-${rid}-${version}`, rid, version, A, hex(`e${rid}${version}`)]);
  };
  const readiness = (rid, version = 1) => asU(U.partner, "SELECT public.fs_report_readiness($1,$2,$3) r", [A, rid, version]).then((r) => r.r);
  const setState = (uid, rid, version, state) => asU(uid, "SELECT * FROM public.fs_set_publication_state($1,$2,$3,$4,'sign-off proof step')", [rid, version, A, state]);
  const ours = (r) => r.blockers.filter((b) => /^(REPORTING_DEPENDENCIES|STATEMENT_FIGURE)/.test(b));

  group("Refusals by name — and the canonical path refuses to sign them");
  for (const [tamper, want] of [["figure", /^STATEMENT_FIGURE_MISMATCH:1:fact:current:current_assets:sfp\.inventories$/], ["account", /^STATEMENT_FIGURE_MISMATCH:2:fact:current:account:/], ["extra", /^STATEMENT_FIGURE_NOT_COMPOSED:1:fact:current:current_assets:sfp\.made_up$/],
    ["unbound", /^REPORTING_DEPENDENCIES_UNBOUND$/], ["stale", /^REPORTING_DEPENDENCIES_STALE$/]]) {
    await check(`${tamper}: refused (${want.source.replace(/\\/g, "").replace(/[\^$]/g, "")}); REVIEWED is refused`, async () => {
      const rid = `rpt-${tamper}-${uuid()}`;
      await save(rid, 1, await buildDoc(rid, 1, tamper));
      const r = await readiness(rid);
      let refusal = null;
      try { await setState(U.partner, rid, 1, "REVIEWED"); } catch (e) { refusal = e.code; }
      return ours(r).length === 1 && want.test(ours(r)[0]) && refusal === "PT409" ? true : { b: r.blockers, refusal };
    });
  }

  group("Ready → REVIEWED → FINAL through the one canonical path, each bound");
  const rid = `rpt-final-${uuid()}`;
  let deps1;
  await check("the complete report on current dependencies is ready (no blocker of any kind)", async () => {
    await save(rid, 1, await buildDoc(rid, 1));
    deps1 = (await asU(U.owner, "SELECT public.fs_reporting_dependencies($1,$2) r", [A, Y])).r;
    const r = await readiness(rid);
    return r.ready === true && r.blockers.length === 0 ? true : r.blockers;
  });
  await check("REVIEWED (review_close) then FINAL (approve_certification); each publication has exactly one binding with the server's document hash and the dependencies identity", async () => {
    const rv = await setState(U.partner, rid, 1, "REVIEWED");
    const fin = await setState(U.owner, rid, 1, "FINAL");
    const b = (await db.admin.query("SELECT publication_id, state, document_sha256, declared_content_hash, dependencies_sha256 FROM public.fs_publication_bindings WHERE report_id=$1 ORDER BY seq", [rid])).rows;
    const stored = (await db.one("SELECT encode(sha256(convert_to(report_document::text,'UTF8')),'hex') h, content_hash FROM public.financial_statement_reports WHERE report_id=$1 AND report_version=1", [rid]));
    return rv.state === "REVIEWED" && fin.state === "FINAL" && b.length === 2 && b[0].publication_id === rv.id && b[1].publication_id === fin.id
      && b.every((x) => x.document_sha256 === stored.h && x.declared_content_hash === stored.content_hash && x.dependencies_sha256 === deps1.dependenciesSha256)
      && JSON.stringify(b.map((x) => x.state)) === JSON.stringify(["REVIEWED", "FINAL"]) ? true : { b, stored };
  });
  await check("FINAL is immutable (PT409)", async () => {
    try { await setState(U.partner, rid, 1, "REVIEWED"); return "reopened"; } catch (e) { return e.code === "PT409" ? true : e.code; }
  });

  group("A later change: the signed version stays as signed; the next sign-off needs a new version");
  await check("a disclosure changes: the FINAL version and its bindings are untouched, but it is now stale against the dependencies", async () => {
    const before = await db.count("SELECT count(*) n FROM public.fs_publication_bindings");
    await asU(U.preparer, "SELECT public.fs_record_disclosure($1,$2,'smes.note.estimates','Useful lives and residual values.','Notes v2',$3)", [A, Y, uuid()]);
    const r = await readiness(rid);
    const pub = (await db.admin.query("SELECT state FROM public.financial_statement_publications WHERE report_id=$1 ORDER BY seq", [rid])).rows.map((x) => x.state);
    return ours(r).includes("REPORTING_DEPENDENCIES_STALE") && JSON.stringify(pub) === JSON.stringify(["REVIEWED", "FINAL"]) && (await db.count("SELECT count(*) n FROM public.fs_publication_bindings")) === before ? true : { b: r.blockers, pub };
  });
  await check("version 2 on the new dependencies is ready and REVIEWED, with its own binding (a different dependencies identity)", async () => {
    await save(rid, 2, await buildDoc(rid, 2));
    const r = await readiness(rid, 2);
    const rv = await setState(U.partner, rid, 2, "REVIEWED");
    const b = (await db.admin.query("SELECT dependencies_sha256 FROM public.fs_publication_bindings WHERE report_id=$1 AND report_version=2", [rid])).rows;
    return r.ready === true && rv.state === "REVIEWED" && b.length === 1 && b[0].dependencies_sha256 !== deps1.dependenciesSha256 ? true : { b: r.blockers, rv };
  });
  await check("a dependency's own blocker is the report's: withdrawing the comparative approval blocks version 2's FINAL by name", async () => {
    await asU(U.partner, "SELECT public.fs_approve_comparatives($1,$2,false,'Re-checking the prior year',$3)", [A, Y, uuid()]);
    const r = await readiness(rid, 2);
    let refusal = null;
    try { await setState(U.owner, rid, 2, "FINAL"); } catch (e) { refusal = String(e.message); }
    return r.blockers.includes("COMPARATIVE_NOT_APPROVED") && r.blockers.includes("REPORTING_DEPENDENCIES_STALE") && /BLOCKED/.test(refusal ?? "") ? true : { b: r.blockers, refusal };
  });

  group("Defence in depth, append-only");
  await check("a publication inserted behind the canonical path's back for a stale report fails in the binding trigger (BINDING_STALE); nothing recorded", async () => {
    const member = (await db.one("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [A, U.partner])).id;
    const before = await db.count("SELECT count(*) n FROM public.financial_statement_publications");
    let code = null;
    try { await db.admin.query("INSERT INTO public.financial_statement_publications (report_id, report_version, company_id, state, reason, actor_firm_member_id) VALUES ($1,2,$2,'FINAL','bypass attempt here',$3)", [rid, A, member]); } catch (e) { code = `${e.code}:${String(e.message).split(":")[0]}`; }
    return code === "PT409:BINDING_STALE" && (await db.count("SELECT count(*) n FROM public.financial_statement_publications")) === before ? true : code;
  });
  await refused("bindings cannot be updated — not even by the database owner", "42501", () => db.admin.query("UPDATE public.fs_publication_bindings SET state='REVIEWED'"));
  await refused("bindings cannot be deleted", "42501", () => db.admin.query("DELETE FROM public.fs_publication_bindings"));
  await refused("clients cannot write bindings", "42501", () => db.asRole("authenticated", U.owner, "INSERT INTO public.fs_publication_bindings (publication_id, company_id, report_id, report_version, state, document_sha256, declared_content_hash, dependencies_sha256, dependencies) VALUES ($1,$2,'x',1,'FINAL',$3,'x',$3,'{}')", [uuid(), A, "a".repeat(64)]));
  await refused("anon cannot read dependencies", "42501", () => db.asRole("anon", null, "SELECT public.fs_reporting_dependencies($1,2026)", [A]));
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish("SIGNOFF_BINDING", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
