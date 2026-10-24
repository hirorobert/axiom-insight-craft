#!/usr/bin/env bun
// Real-PostgreSQL proof of the publication integrity gate (20261124100000) and the document structure (20261126100000): the
// trust boundary from a saved financial-statements document to an official pack, attacked where a tampering or defective
// client would act, through the browser's own client code where a page would act, and through the database directly where
// an attacker would. Every case has a stable id in publicationIntegrityGate.manifest.mjs; the run writes a structured
// result (PROOF_RESULT_FILE, default proof-results/publicationIntegrityGate.<mode>.json) that scripts/ci/validateProofResult.mjs
// checks against the manifest: with the gate PRESENT every case passes; with the gate ABSENT (INTEGRITY_GATE_ABSENT=1: the
// chain replayed up to, and excluding, 20261124100000) exactly the weakness cases fail and every setup/control case passes.
//
//   W1  document closure        fabricated note figure, second fact version, re-denomination, re-scaling, presentation
//                               currency, period and comparative headers, provenance label - each saved with a browser
//                               evaluation that reports nothing - refused by name; the honest document unchanged
//   S1  document structure      a server figure bound on the wrong line, swapped period columns, a relabelled line, a line
//                               moved to another section, a duplicated statement, a fact whose own period contradicts its
//                               identity, a fact naming an unbound source, a malformed fact, a flipped role - refused by name
//   W2  clearing a finding      a preparer's ACCEPT/REJECT is refused; DEFER records; the reviewer clears
//   W3  withdrawing a review    a preparer cannot move REVIEWED back to DRAFT; the reviewer can
//   W4  superseded FINAL        once a later version of the lineage is FINAL the earlier FINAL cannot be issued officially
//                               again, a pending issuance cannot be sealed, its earlier pack verifies and is disclosed as
//                               superseded, the versions list says so, the new FINAL issues
//   I   issued history          the first FINAL's document and bindings byte-identical after everything above
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/publicationIntegrityGate.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
//   INTEGRITY_GATE_ABSENT=1   the regression run (must fail on exactly the weakness cases; the validator checks it)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyChain, applyChainBefore, certifier, chainFiles, clientDb, EVIDENCE_FY2025_COMPARATIVE, EVIDENCE_FY2026, makeWorld, migrationText, openDatabase, prepareReporting, REPO, reporter, uuid } from "./lib/reportingKit.mjs";
import { CASES, PROOF } from "./publicationIntegrityGate.manifest.mjs";
import { ingestEvidence } from "../../src/lib/financialEvidence/intake.ts";
import { signoffClient } from "../../src/lib/reporting/signoff.ts";
import { prepareReportVersion } from "../../src/lib/reporting/prepareVersion.ts";
import { canonicalStringify } from "../../src/lib/canonicalStatement/serialization.ts";

const FILE = "20261124100000_fs_publication_integrity_gate.sql";
// The regression run replays the chain as it was before BOTH publication-integrity PRs: 20261123100000 (the independent server
// compilation, PR #191) also refuses every tampered document below (SERVER_COMPILATION_REQUIRED, then SERVER_DOCUMENT_MISMATCH),
// so the weakness is main's behaviour before either; with the gate PRESENT each case asserts both controls name it.
const ABSENT_STOP = "20261123100000_fs_server_compilation.sql";
const ABSENT = process.env.INTEGRITY_GATE_ABSENT === "1";
const MODE = ABSENT ? "absent" : "present";
const RESULT_FILE = process.env.PROOF_RESULT_FILE ?? path.join(REPO, "proof-results", `${PROOF}.${MODE}.json`);
const { group, check, finish } = reporter();
const hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
let db;

// ── The structured result: every manifest case once, with its outcome ─────────────────────────────────────────────────
const ids = new Set(CASES.map((c) => c.id));
const recorded = [];
const startedAt = new Date().toISOString();
const manifestSha256 = hex(fs.readFileSync(new URL("./publicationIntegrityGate.manifest.mjs", import.meta.url), "utf8"));
/** A check with a manifest id. An id not in the manifest, or used twice, is a proof defect and fails the run. */
async function kase(id, title, fn) {
  if (!ids.has(id)) throw new Error(`proof defect: case ${id} is not in the manifest`);
  if (recorded.some((r) => r.id === id)) throw new Error(`proof defect: case ${id} recorded twice`);
  let outcome = "fail", detail = "";
  await check(`[${id}] ${title}`, async () => {
    try {
      const r = await fn();
      if (r === true) { outcome = "pass"; return true; }
      detail = JSON.stringify(r)?.slice(0, 1200) ?? "";
      return r;
    } catch (e) {
      detail = `exception ${e.code ?? ""}: ${String(e?.message ?? e).split("\n")[0]}${e.where ? ` | where: ${String(e.where).slice(0, 300)}` : ""}`;
      throw e;
    }
  });
  recorded.push({ id, title, outcome, detail });
}
function writeResult(completed, crashed, crashMessage) {
  fs.mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  fs.writeFileSync(RESULT_FILE, JSON.stringify({ proof: PROOF, mode: MODE, manifestSha256, startedAt, finishedAt: new Date().toISOString(), completed, crashed, crashMessage: crashMessage ?? null,
    cases: recorded.map(({ id, outcome, detail }) => ({ id, outcome, ...(detail ? { detail } : {}) })) }, null, 2) + "\n");
  console.log(`structured result: ${RESULT_FILE}`);
}

async function main() {
  db = await openDatabase("integrity_gate_proof");
  group(ABSENT ? "Replay WITHOUT the gate (regression run: the weakness cases below must fail)" : "Replay");
  if (ABSENT) {
    await kase("setup.chain-before-gate", `the chain before ${ABSENT_STOP} applies (main's behaviour: neither PR #191 nor PR #192)`, async () => (await applyChainBefore(db, ABSENT_STOP)) ?? true);
  } else {
    await kase("setup.chain", `${FILE} is in the chain and the whole chain applies`, async () => (!chainFiles().includes(FILE) ? `${FILE} missing` : (await applyChain(db)) ?? true));
    await kase("setup.reapply-refused", "re-applying is refused by its preflight", async () => {
      try { await db.admin.query(migrationText(FILE)); return "re-applied"; } catch (e) { return e.code === "P0001" && /PREFLIGHT_REFUSED/.test(e.message) ? true : `${e.code}: ${e.message}`; }
    });
  }
  await kase("setup.static-contract", "no DELETE or UPDATE without a WHERE clause anywhere in the three migrations (Supabase API sessions load safeupdate)", async () => {
    const bare = [];
    for (const f of [FILE, "20261125100000_fs_final_authority.sql", "20261126100000_fs_document_structure.sql"]) {
      const code = migrationText(f).replace(/--[^\n]*/g, "");
      bare.push(...[...code.matchAll(/\bDELETE\s+FROM\s+[\w.]+\s*;/gi), ...code.matchAll(/\bUPDATE\s+[\w.]+\s+SET\b(?:(?!\bWHERE\b)[^;])*;/gi)].map((m) => `${f}: ${m[0].slice(0, 60)}`));
    }
    return bare.length === 0 ? true : bare;
  });

  const W = await makeWorld(db);
  const { U, A } = W;
  await W.rollout(A, true);
  const k = await certifier(db, U);
  const Y = 2026;
  // With the compiler ABSENT the client has no server function to call (the chain stops before 20261123100000).
  const as = (uid) => { const { invoke, ...rest } = clientDb(db, uid); const d = ABSENT ? rest : { ...rest, invoke }; return { d, c: signoffClient(d) }; };
  const pre = as(U.preparer), partner = as(U.partner), owner = as(U.owner);
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  const parse = (type, role = "CURRENT") => {
    const y = role === "CURRENT" ? Y : Y - 1;
    const body = (role === "CURRENT" ? EVIDENCE_FY2026 : EVIDENCE_FY2025_COMPARATIVE)[type];
    const r = ingestEvidence({ companyId: A, evidenceType: type, periodRole: role, reportingPeriodId: `FY${Y}`, currency: "TZS", scale: 2, text: body, fileName: `${type.toLowerCase()}-${y}.csv`, periodStart: `${y}-01-01`, periodEnd: `${y}-12-31` });
    if (r.outcome !== "PARSED") throw new Error(`${type} rejected: ${JSON.stringify(r).slice(0, 300)}`);
    return r.batch;
  };
  const allEvidence = () => [...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "CASH_ACCOUNT_MAP"].map((t) => parse(t)), ...["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "PRIOR_PERIOD_STATEMENTS"].map((t) => parse(t, "COMPARATIVE"))];
  const attempt = (who, rid, newEvidence = []) => prepareReportVersion(who.d, who.c, { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: rid, newEvidence, idempotencyKey: `attempt-${uuid()}`, evaluatedAt: "2027-02-02T09:00:00.000Z" });
  const readiness = (rid, v) => partner.c.readiness(A, rid, v);
  const stored = (rid, v) => db.one("SELECT report_document, content_hash, evidence_batch_ids, encode(sha256(convert_to(report_document::text,'UTF8')),'hex') AS doc_sha FROM public.financial_statement_reports WHERE report_id=$1 AND report_version=$2", [rid, v]);
  const latest = (rid) => db.count("SELECT count(*) n FROM public.financial_statement_reports WHERE report_id=$1", [rid]);
  const refusal = async (fn) => { try { await fn(); return null; } catch (e) { return `${e.code ?? ""}:${String(e.message).split("\n")[0]}`; } };
  const publications = (rid, v) => db.admin.query("SELECT state FROM public.financial_statement_publications WHERE report_id=$1 AND report_version=$2 ORDER BY seq", [rid, v]).then((r) => r.rows.map((x) => x.state));
  /** Saves a document as the next version of a lineage directly, as a tampering client would, with an evaluation that reports nothing. */
  const saveDoc = async (rid, version, doc, evidenceIds, findings = []) => {
    const d = { ...doc, reportIdentity: { ...doc.reportIdentity, reportId: rid, reportVersion: version } };
    const text = canonicalStringify(d);
    await asU(U.preparer, "SELECT * FROM public.fs_save_report_version($1,$2,$3,$4,'TRIAL_BALANCE_DERIVED',$5::jsonb,$6,$7::text[])", [rid, version, A, Y, text, hex(text), evidenceIds]);
    await asU(U.preparer, "SELECT * FROM public.fs_save_evaluation($1,$2,$3,$4,'rule-pack','1','engine-1',$5,$6::jsonb)", [`ev-${rid}-${version}`, rid, version, A, hex(`e${rid}${version}`), JSON.stringify(findings)]);
    return version;
  };
  /** A tampered document: saved as the next draft, must be refused by name and REVIEWED must be refused. */
  const tamperCase = async (id, label, rid, doc, evidenceIds, wantBlockers) => {
    await kase(id, `${label}: refused by name; REVIEWED refused`, async () => {
      const v = await saveDoc(rid, (await latest(rid)) + 1, doc, evidenceIds);
      const r = await readiness(rid, v);
      const ref = await refusal(() => partner.c.setState(A, rid, v, "REVIEWED", "Attempted review of a tampered document"));
      // PRESENT: the independent compiler control (20261123100000) must name the same document too (no receipt can match it).
      const want = ABSENT ? wantBlockers : [...wantBlockers, "SERVER_COMPILATION_REQUIRED"];
      const missing = want.filter((b) => !r.blockers.some((x) => x === b || x.startsWith(b)));
      return missing.length === 0 && r.ready === false && /PT409/.test(ref ?? "") ? true : { ready: r.ready, missing, blockers: r.blockers.slice(0, 12), ref };
    });
  };
  const mapLines = (doc, type, fn) => ({ ...doc, statements: doc.statements.map((s) => (s.type !== type ? s : { ...s, sections: s.sections.map((sec) => ({ ...sec, lines: sec.lines.map(fn) })) })) });

  group("Setup through the real functions: two certified years, presentation, Close Review, notes (pack 1.2.0), schedule, comparatives");
  await kase("setup.world", "prepared", async () => { await prepareReporting(db, W, k, { year: Y }); return true; });

  // ── H0 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("H0. The honest document (the browser's own builder) is ready with no blocker, and signs");
  const rid1 = `rpt-gate-${uuid()}`;
  let v0, doc0, ev0;
  await kase("h0.honest-ready", "evidence + bind through prepareReportVersion: ready, no blocker; every monetary fact of the document is a server figure", async () => {
    const a = await attempt(pre, rid1, allEvidence());
    const b = await attempt(pre, rid1);
    v0 = b.reportVersion;
    const r = await readiness(rid1, v0);
    const s = await stored(rid1, v0);
    doc0 = s.report_document; ev0 = s.evidence_batch_ids;
    const deps = (await asU(U.owner, "SELECT public.fs_reporting_dependencies($1,$2) r", [A, Y])).r;
    const fig = new Map(deps.figures.map((x) => [x.factId, x.amountMinor]));
    const extra = doc0.facts.filter((f) => fig.get(f.factId) !== f.value.minorUnits.__bigint__).map((f) => f.factId);
    return a.outcome === "saved" && b.outcome === "saved" && r.ready === true && r.blockers.length === 0 && extra.length === 0 && doc0.facts.length > 100 ? true : { a: a.outcome, b: b.outcome, r, extra: extra.slice(0, 5), n: doc0?.facts?.length };
  });
  let vFinal, storedFinal, bindingsFinal;
  await kase("h0.honest-final", "the honest path signs: REVIEWED (partner) then FINAL (owner); the bindings carry the server's document hash", async () => {
    vFinal = v0;
    const rv = await partner.c.setState(A, rid1, vFinal, "REVIEWED", "Reviewed: figures agree to evidence and composition");
    const fin = await owner.c.setState(A, rid1, vFinal, "FINAL", "Approved for issue");
    storedFinal = await stored(rid1, vFinal);
    bindingsFinal = JSON.stringify((await db.admin.query("SELECT state, document_sha256, dependencies_sha256, approver_user_id FROM public.fs_publication_bindings WHERE report_id=$1 AND report_version=$2 ORDER BY seq", [rid1, vFinal])).rows);
    const b = JSON.parse(bindingsFinal);
    return rv.state === "REVIEWED" && fin.state === "FINAL" && b.length === 2 && b.every((x) => x.document_sha256 === storedFinal.doc_sha) ? true : { rv: rv.state, fin: fin.state, b };
  });

  // ── W1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("W1. Document closure: facts and headers the browser evaluation was the only check on (each a later draft of the lineage, as a tampering client would save it, with an evaluation reporting nothing)");
  const closing = () => doc0.facts.find((f) => f.factId === "fact:line:cf:closing:CURRENT");
  const fabricatedId = "fact:note:ppe:additions:CURRENT";
  await tamperCase("w1.fabricated-note-figure", "a fabricated note figure (a PPE note with an invented amount, nothing bound on the statements)", rid1,
    { ...doc0, facts: [...doc0.facts, { ...closing(), factId: fabricatedId, value: { ...closing().value, minorUnits: { __bigint__: "99999900" } } }],
      notes: [...doc0.notes, { noteId: "note:ppe-fabricated", noteNumber: "9", title: "Property, plant and equipment", monetaryFactIds: [fabricatedId], totalFactId: fabricatedId }] },
    ev0, [`DOCUMENT_FACT_NOT_COMPOSED:1:${fabricatedId}`, `NOTE_FACT_NOT_COMPOSED:1:${fabricatedId}`]);
  await tamperCase("w1.second-fact-version", "a second version of closing cash with another amount beside the server's (the browser renders the highest version; the statement binding still matches the first)", rid1,
    { ...doc0, facts: [...doc0.facts, { ...closing(), version: 2, supersedesVersion: 1, value: { ...closing().value, minorUnits: { __bigint__: (BigInt(closing().value.minorUnits.__bigint__) + 100000n).toString() } } }] },
    ev0, ["DOCUMENT_FACT_NOT_COMPOSED:1:fact:line:cf:closing:CURRENT"]);
  await kase("w1.reader-prefers-latest-version", "the second version WOULD be the one presented: the browser's own reader takes the highest fact version", async () => {
    const { readStoredReport } = await import("../../src/lib/financialGeneration/composedReport.ts");
    const tampered = { ...doc0, facts: [...doc0.facts, { ...closing(), version: 2, supersedesVersion: 1, value: { ...closing().value, minorUnits: { __bigint__: "1" } } }] };
    const report = readStoredReport(JSON.parse(canonicalStringify(tampered)));
    const latestOf = report.facts.filter((f) => f.factId === "fact:line:cf:closing:CURRENT").sort((a, b) => b.version - a.version)[0];
    return String(latestOf.value.minorUnits) === "1" ? true : latestOf;
  });
  await tamperCase("w1.redenominated-facts", "every fact re-denominated to USD (amounts unchanged)", rid1,
    { ...doc0, facts: doc0.facts.map((f) => ({ ...f, value: { ...f.value, currency: "USD" } })) }, ev0, ["DOCUMENT_FACT_DENOMINATION:"]);
  await tamperCase("w1.rescaled-fact", "one fact rescaled (scale 0: 12,500.00 would read 1,250,000)", rid1,
    { ...doc0, facts: doc0.facts.map((f) => (f.factId === "fact:line:cf:closing:CURRENT" ? { ...f, value: { ...f.value, scale: 0 } } : f)) }, ev0, ["DOCUMENT_FACT_DENOMINATION:1:fact:line:cf:closing:CURRENT"]);
  await tamperCase("w1.presentation-currency", "the presentation currency re-labelled USD", rid1,
    { ...doc0, presentationCurrency: { ...doc0.presentationCurrency, currency: "USD" } }, ev0, ["DOCUMENT_CURRENCY_MISMATCH:USD/2:TZS/2"]);
  await tamperCase("w1.period-header", "the period header re-dated (year ended 31 December 2027)", rid1,
    { ...doc0, period: { ...doc0.period, endDate: "2027-12-31" } }, ev0, ["DOCUMENT_PERIOD_MISMATCH:current:2026:2026-01-01:2027-12-31"]);
  await tamperCase("w1.comparative-header", "the comparative period header re-dated", rid1,
    { ...doc0, comparativePeriods: doc0.comparativePeriods.map((p) => ({ ...p, startDate: "2024-01-01" })) }, ev0, ["DOCUMENT_PERIOD_MISMATCH:comparative:2025:2024-01-01:2025-12-31"]);
  await tamperCase("w1.provenance-relabelled", "the document's provenance relabelled DOCUMENT_REVIEWED while the row is trial-balance derived", rid1,
    { ...doc0, provenanceOrigin: "DOCUMENT_REVIEWED" }, ev0, ["DOCUMENT_PROVENANCE_MISMATCH:DOCUMENT_REVIEWED:TRIAL_BALANCE_DERIVED"]);

  // ── S1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("S1. Document structure: valid server figures whose MEANING a crafted document changes (line, column, label, section, statement, period field, source, shape, role)");
  const SFP = "STATEMENT_OF_FINANCIAL_POSITION", SCI = "STATEMENT_OF_PROFIT_OR_LOSS";
  const CASH = "line:current_assets:sfp.cash_and_cash_equivalents", INV = "line:current_assets:sfp.inventories", LOAN = "line:non_current_liabilities:sfp.other_financial_liabilities";
  const cashFact = "fact:current:current_assets:sfp.cash_and_cash_equivalents", invFact = "fact:current:current_assets:sfp.inventories";
  await tamperCase("s1.swapped-line-binding", "cash and inventories swap their CURRENT facts (both still server figures): cash would read as inventory", rid1,
    mapLines(doc0, SFP, (l) => (l.lineId === CASH ? { ...l, factBindings: l.factBindings.map((b) => (b.periodId === "CURRENT" ? { ...b, factId: invFact } : b)) }
      : l.lineId === INV ? { ...l, factBindings: l.factBindings.map((b) => (b.periodId === "CURRENT" ? { ...b, factId: cashFact } : b)) } : l)),
    ev0, [`DOCUMENT_STRUCTURE_MISMATCH:2:${CASH}:bindings`]);
  await tamperCase("s1.swapped-period-columns", "the cash line's CURRENT and COMPARATIVE_1 columns swapped (each a server figure of the other period)", rid1,
    mapLines(doc0, SFP, (l) => (l.lineId === CASH ? { ...l, factBindings: l.factBindings.map((b) => ({ periodId: b.periodId === "CURRENT" ? "COMPARATIVE_1" : "CURRENT", factId: b.factId })) } : l)),
    ev0, [`DOCUMENT_STRUCTURE_MISMATCH:1:${CASH}:bindings`]);
  await tamperCase("s1.relabelled-line", "the inventories line relabelled 'Cash and cash equivalents'", rid1,
    mapLines(doc0, SFP, (l) => (l.lineId === INV ? { ...l, label: "Cash and cash equivalents" } : l)), ev0, [`DOCUMENT_STRUCTURE_MISMATCH:1:${INV}:label`]);
  await tamperCase("s1.line-moved-to-another-section", "the bank loan line moved from non-current to current liabilities (its id, label and figures intact)", rid1,
    (() => {
      const sfp = doc0.statements.find((s) => s.type === SFP);
      const loan = sfp.sections.flatMap((s) => s.lines).find((l) => l.lineId === LOAN);
      const moved = { ...sfp, sections: sfp.sections.map((s) => s.sectionId === "section:non_current_liabilities" ? { ...s, lines: s.lines.filter((l) => l.lineId !== LOAN) }
        : s.sectionId === "section:current_liabilities" ? { ...s, lines: [loan, ...s.lines] } : s) };
      return { ...doc0, statements: doc0.statements.map((s) => (s.type === SFP ? moved : s)) };
    })(), ev0, [`DOCUMENT_STRUCTURE_MISMATCH:1:${LOAN}:section`]);
  await tamperCase("s1.duplicate-statement", "a second copy of the statement of comprehensive income", rid1,
    { ...doc0, statements: [...doc0.statements, { ...doc0.statements.find((s) => s.type === SCI), statementId: "stmt:sci-2" }] }, ev0, ["DOCUMENT_STATEMENT_MISMATCH:1:STATEMENT_OF_PROFIT_OR_LOSS", "DOCUMENT_LINE_DUPLICATE:"]);
  await tamperCase("s1.fact-period-field", "the current cash fact declares itself comparative (its identity and amount unchanged)", rid1,
    { ...doc0, facts: doc0.facts.map((f) => (f.factId === cashFact ? { ...f, reportingPeriod: { periodId: "COMPARATIVE_1", isComparative: true } } : f)) }, ev0, [`DOCUMENT_FACT_PERIOD_MISMATCH:1:${cashFact}`]);
  await tamperCase("s1.provenance-unbound", "the closing-cash fact names an evidence batch that is not this version's", rid1,
    { ...doc0, facts: doc0.facts.map((f) => (f.factId === "fact:line:cf:closing:CURRENT" ? { ...f, provenance: { ...f.provenance, source: { ...f.provenance.source, sourceDocumentId: `eb-${uuid().replace(/-/g, "")}` } } } : f)) },
    ev0, ["DOCUMENT_PROVENANCE_UNBOUND:1:fact:line:cf:closing:CURRENT"]);
  await tamperCase("s1.malformed-fact", "a fact without its minor units (nothing to compare)", rid1,
    { ...doc0, facts: doc0.facts.map((f) => (f.factId === cashFact ? { ...f, value: { currency: f.value.currency, scale: f.value.scale } } : f)) }, ev0, ["DOCUMENT_FACT_NOT_COMPOSED:1:" + cashFact, "DOCUMENT_SHAPE_INVALID:facts:"]);
  await tamperCase("s1.total-role-flipped", "the total-assets line presented as a detail line", rid1,
    mapLines(doc0, SFP, (l) => (l.lineId === "line:sfp:total:totalAssetsMinor" ? { ...l, role: "DETAIL", castingChildLineIds: [] } : l)), ev0, ["DOCUMENT_STRUCTURE_MISMATCH:1:line:sfp:total:totalAssetsMinor:role"]);
  await kase("w1.builder-after-tampered-drafts", "after the tampered drafts, the browser's builder still produces a signable version once a dependency changes (nothing hand-edited is ever reused as current)", async () => {
    const w = (await asU(U.preparer, "SELECT public.fs_record_disclosure($1,$2,'smes.note.judgements','No significant judgements beyond the estimates disclosed.','Notes v2',$3) r", [A, Y, uuid()])).r;
    const r = await attempt(pre, rid1);
    const rd = await readiness(rid1, r.reportVersion);
    return w.outcome === "recorded" && r.outcome === "saved" && rd.ready === true && rd.blockers.length === 0 ? true : { w, r: r.outcome, rd };
  });

  // ── W3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("W3. Withdrawing a recorded review is a reviewer's act");
  const rid2 = `rpt-gate-review-${uuid()}`;
  let v2;
  await kase("w3.second-lineage-reviewed", "a second lineage of the period, ready through the browser's builder; the partner records REVIEWED", async () => {
    const r = await attempt(pre, rid2);
    v2 = r.reportVersion;
    const rv = await partner.c.setState(A, rid2, v2, "REVIEWED", "Reviewed for the withdrawal case");
    return r.outcome === "saved" && rv.state === "REVIEWED" ? true : { r: r.outcome, rv: rv.state };
  });
  await kase("w3.preparer-cannot-withdraw", "the preparer cannot move it back to DRAFT (42501); the recorded state stays REVIEWED", async () => {
    const ref = await refusal(() => asU(U.preparer, "SELECT * FROM public.fs_set_publication_state($1,$2,$3,'DRAFT','preparer withdrawing the review')", [rid2, v2, A]));
    const pub = await publications(rid2, v2);
    return /^42501:/.test(ref ?? "") && JSON.stringify(pub) === '["REVIEWED"]' ? true : { ref, pub };
  });
  await kase("w3.reviewer-withdraws-and-reviews", "the reviewer can withdraw (DRAFT), then review again", async () => {
    await asU(U.partner, "SELECT * FROM public.fs_set_publication_state($1,$2,$3,'DRAFT','Reviewer withdraws pending a question')", [rid2, v2, A]);
    const rv = await partner.c.setState(A, rid2, v2, "REVIEWED", "Reviewed again");
    const pub = await publications(rid2, v2);
    return rv.state === "REVIEWED" && JSON.stringify(pub) === '["REVIEWED","DRAFT","REVIEWED"]' ? true : { rv: rv.state, pub };
  });

  // ── W2 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("W2. Clearing a blocking finding is a reviewer's decision");
  const rid3 = `rpt-gate-finding-${uuid()}`;
  const finding = { findingKey: "FK-GATE-1", ruleId: "orphaned-note-reference-detection", actionable: true, outcome: "FAIL", failureSeverity: "HIGH", message: "A note reference points nowhere" };
  const decision = (id, type) => ({ decisionId: id, decisionType: type, target: { kind: "FINDING_KEY", findingKey: "FK-GATE-1" }, rationale: "proof", decidedAt: "2027-02-02T10:00:00.000Z" });
  const appendDecision = (uid, id, type) => asU(uid, "SELECT * FROM public.fs_append_decision($1,$2,$3,$4::jsonb)", [id, rid3, A, JSON.stringify(decision(id, type))]);
  await kase("w2.blocking-finding-blocks", "a third lineage: the honest document saved with an evaluation that carries one blocking finding -> BLOCKING_FINDINGS:1", async () => {
    const r = await attempt(pre, rid3);
    const v = await saveDoc(rid3, r.reportVersion + 1, doc0, ev0, [finding]);
    const rd = await readiness(rid3, v);
    return r.outcome === "saved" && rd.blockers.includes("BLOCKING_FINDINGS:1") ? true : { r: r.outcome, b: rd.blockers };
  });
  await kase("w2.preparer-cannot-clear", "the preparer's ACCEPT_FINDING and REJECT_FINDING are refused (42501); the finding still blocks", async () => {
    const a = await refusal(() => appendDecision(U.preparer, "d-gate-accept-pre", "ACCEPT_FINDING"));
    const b = await refusal(() => appendDecision(U.preparer, "d-gate-reject-pre", "REJECT_FINDING"));
    const rd = await readiness(rid3, await latest(rid3));
    const n = await db.count("SELECT count(*) n FROM public.financial_statement_reviewer_decisions WHERE report_id=$1", [rid3]);
    return /^42501:/.test(a ?? "") && /^42501:/.test(b ?? "") && rd.blockers.includes("BLOCKING_FINDINGS:1") && n === 0 ? true : { a, b, b2: rd.blockers, n };
  });
  await kase("w2.preparer-defers-reviewer-clears", "the preparer may still DEFER (recorded; the finding still blocks); the reviewer's ACCEPT_FINDING clears it", async () => {
    const d = await appendDecision(U.preparer, "d-gate-defer-pre", "DEFER");
    const still = await readiness(rid3, await latest(rid3));
    const acc = await appendDecision(U.partner, "d-gate-accept-partner", "ACCEPT_FINDING");
    const after = await readiness(rid3, await latest(rid3));
    return d.decision_id === "d-gate-defer-pre" && still.blockers.includes("BLOCKING_FINDINGS:1") && acc.decision_id === "d-gate-accept-partner" && !after.blockers.some((b) => b.startsWith("BLOCKING_FINDINGS")) ? true : { d: d?.decision_id, still: still.blockers, acc: acc?.decision_id, after: after.blockers };
  });

  // ── W4 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("W4. A FINAL superseded by a later FINAL of its lineage is never issued officially again, and is disclosed as superseded");
  const { issueOfficialPack, verifyOfficialPack, retrieveOfficialPack } = await import(pathToFileURL(path.join(REPO, "supabase/functions/_shared/reportingPackSeal.mjs")).href);
  const bucket = new Map();
  const serviceRpc = async (fn, args) => {
    const keys = Object.keys(args);
    try {
      const rows = await db.asRole("service_role", null, `SELECT public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) r`, keys.map((k) => args[k]));
      return { data: rows[0].r, error: null };
    } catch (e) { return { data: null, error: e }; }
  };
  const deps = {
    rpc: serviceRpc,
    put: async (p, b) => {
      if (bucket.has(p)) return { error: { message: "exists" } };
      await db.admin.query("INSERT INTO storage.objects (bucket_id, name, metadata) VALUES ('reporting-packs', $1, $2::jsonb)", [p, JSON.stringify({ size: b.byteLength, mimetype: "application/json" })]);
      bucket.set(p, b);
      return { error: null };
    },
    get: async (p) => bucket.get(p) ?? null,
    sha256Hex: async (b) => hex(b),
  };
  const issueRpc = async (uid, ref, rid = uuid()) => (await asU(uid, "SELECT public.issue_official_reporting_pack($1,$2,$3,$4) r", [A, Y, ref, rid])).r;
  const refFinal = `fs-report:${rid1}:v${vFinal}`;
  let firstIssuance, pendingIssuance;
  await kase("w4.final-issued-officially", "the FINAL version is issued officially (issue -> the server's canonical document stored -> sealed); verify: intact, official, not superseded", async () => {
    const i = await issueRpc(U.owner, refFinal);
    firstIssuance = i.issuance_id;
    const sealed = await issueOfficialPack(deps, { userId: U.owner, issuanceId: firstIssuance });
    const v = await verifyOfficialPack(deps, U.owner, firstIssuance);
    return i.outcome === "issued" && sealed.body.outcome === "sealed" && v.outcome === "intact" && v.official === true && v.superseded === false ? true : { i, sealed: sealed.body.outcome, v };
  });
  let vNext;
  await kase("w4.correction-becomes-final", "a second issuance of the same FINAL is opened but not yet sealed; then a correction: a disclosure wording changes, the new version is ready, REVIEWED and FINAL (the correction supersedes the earlier FINAL)", async () => {
    const p = await issueRpc(U.owner, refFinal);
    pendingIssuance = p.issuance_id;
    const w = (await asU(U.preparer, "SELECT public.fs_record_disclosure($1,$2,'smes.note.estimates','Useful lives of equipment: eight years (revised after the issue).','Notes v2',$3) r", [A, Y, uuid()])).r;
    const r = await attempt(pre, rid1);
    vNext = r.reportVersion;
    const rd = await readiness(rid1, vNext);
    const rv = await partner.c.setState(A, rid1, vNext, "REVIEWED", "Reviewed the correction");
    const fin = await owner.c.setState(A, rid1, vNext, "FINAL", "Approved the correction for issue");
    return p.outcome === "issued" && w.outcome === "recorded" && r.outcome === "saved" && vNext > vFinal && rd.ready === true && rv.state === "REVIEWED" && fin.state === "FINAL" ? true : { p: p.outcome, w, r: r.outcome, vNext, vFinal, rd, rv: rv.state, fin: fin.state };
  });
  await kase("w4.superseded-issue-refused", "the superseded FINAL cannot be issued officially again: superseded_final_version, audited as REFUSED SUPERSEDED_FINAL_VERSION; nothing issued", async () => {
    const before = await db.count("SELECT count(*) n FROM public.reporting_pack_issuances WHERE company_id=$1", [A]);
    const i = await issueRpc(U.owner, refFinal);
    const after = await db.count("SELECT count(*) n FROM public.reporting_pack_issuances WHERE company_id=$1", [A]);
    const ev = await db.count("SELECT count(*) n FROM public.reporting_pack_issuance_events WHERE company_id=$1 AND event='REFUSED' AND detail->>'code'='SUPERSEDED_FINAL_VERSION'", [A]);
    return i.outcome === "superseded_final_version" && after === before && ev === 1 ? true : { i, before, after, ev };
  });
  await kase("w4.pending-seal-refused", "the issuance opened before the correction cannot be sealed after it: superseded_final_version; nothing sealed", async () => {
    const s = await issueOfficialPack(deps, { userId: U.owner, issuanceId: pendingIssuance });
    const sealed = await db.count("SELECT count(*) n FROM public.reporting_pack_issuances WHERE id=$1 AND consumed_at IS NOT NULL", [pendingIssuance]);
    return s.body.outcome === "superseded_final_version" && sealed === 0 ? true : { s: s.body, sealed };
  });
  await kase("w4.earlier-pack-disclosed-superseded", "the pack sealed before the correction still verifies intact and official (the official pack of the version it names), and is disclosed as superseded; retrieve returns the same bytes with the same disclosure", async () => {
    const v = await verifyOfficialPack(deps, U.owner, firstIssuance);
    const r = await retrieveOfficialPack(deps, U.owner, firstIssuance);
    const row = await db.one("SELECT content_sha256 FROM public.reporting_pack_issuances WHERE id=$1", [firstIssuance]);
    return v.outcome === "intact" && v.official === true && v.superseded === true && r.outcome === "retrieved" && r.superseded === true && hex(r.document) === row.content_sha256 ? true : { v, r: { outcome: r.outcome, superseded: r.superseded } };
  });
  await kase("w4.versions-list-superseded", "the versions list names the superseding version on the earlier FINAL and none on the new one", async () => {
    const vs = await owner.c.versions(A, Y);
    const old = vs.find((x) => x.reportId === rid1 && x.reportVersion === vFinal), neu = vs.find((x) => x.reportId === rid1 && x.reportVersion === vNext);
    return old?.state === "FINAL" && old.supersededByFinal === vNext && neu?.state === "FINAL" && neu.supersededByFinal === null ? true : { old, neu };
  });
  await kase("w4.new-final-issues", "the new FINAL issues officially: sealed; verify intact, official, not superseded", async () => {
    const i = await issueRpc(U.owner, `fs-report:${rid1}:v${vNext}`);
    const sealed = await issueOfficialPack(deps, { userId: U.owner, issuanceId: i.issuance_id });
    const v = await verifyOfficialPack(deps, U.owner, i.issuance_id);
    return i.outcome === "issued" && sealed.body.outcome === "sealed" && v.outcome === "intact" && v.official === true && v.superseded === false ? true : { i: i.outcome, sealed: sealed.body.outcome, v };
  });
  await kase("w4.outsider-learns-nothing", "an outsider learns nothing from verify (not_found) and cannot issue (workspace_access_denied)", async () => {
    const v = await verifyOfficialPack(deps, U.ownerB, firstIssuance);
    const i = await issueRpc(U.ownerB, refFinal);
    return v.outcome === "not_found" && v.official === false && i.outcome === "workspace_access_denied" ? true : { v, i };
  });

  // ── I ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  group("I. Issued history unchanged");
  await kase("i.history-unchanged", "the earlier FINAL version's document, hash and bindings are byte-identical after everything above; every publication state change is audited with its actor", async () => {
    const now = await stored(rid1, vFinal);
    const b = JSON.stringify((await db.admin.query("SELECT state, document_sha256, dependencies_sha256, approver_user_id FROM public.fs_publication_bindings WHERE report_id=$1 AND report_version=$2 ORDER BY seq", [rid1, vFinal])).rows);
    const audit = await db.count("SELECT count(*) n FROM public.financial_statement_audit_events WHERE company_id=$1 AND action='PUBLICATION_STATE_SET' AND actor_firm_member_id IS NOT NULL", [A]);
    return now.doc_sha === storedFinal.doc_sha && now.content_hash === storedFinal.content_hash && b === bindingsFinal && audit >= 7 ? true : { same: now.doc_sha === storedFinal.doc_sha, b: b === bindingsFinal, audit };
  });

  // Every manifest case of this mode was reached (a skipped case is a proof defect, not a pass).
  const expectedHere = CASES.filter((c) => (c.modes ?? ["present", "absent"]).includes(MODE)).map((c) => c.id);
  const missing = expectedHere.filter((id) => !recorded.some((r) => r.id === id));
  if (missing.length) throw new Error(`proof defect: cases never reached: ${missing.join(", ")}`);
}

main().then(async () => {
  writeResult(true, false);
  const ok = finish(ABSENT ? "publication integrity gate (control ABSENT - the weakness cases are expected to fail)" : "publication integrity gate", false);
  await db?.close();
  process.exit(ok ? 0 : 1);
}).catch(async (e) => {
  console.error("CRASH:", e);
  writeResult(false, true, String(e?.message ?? e));
  finish("publication integrity gate", true);
  await db?.close();
  process.exit(1);
});
