#!/usr/bin/env bun
// Real-PostgreSQL proof of notes, disclosure requirements and movement schedules (20261019100000), on statements the
// database composed from real certifications (20261018100000).
//
// Expected statuses, blockers and reconciliation differences are written BY HAND from the synthetic trial balances
// (scripts/db-proof/lib/reportingKit.mjs) — an independent check of the rules, not an accounting validation.
//
//   vocabulary    requirements and schedule definitions equal the TypeScript pack (both editions agree on kind,
//                 applicability and blocking)
//   status        every requirement's status and the blockers, before and after the preparer's work
//   authority     prepare_close only; rollout and kill switch; another workspace refused; framework checked
//   decisions     only the conditional disclosures the data cannot decide; idempotent; append-only history
//   texts         the preparer's wording verbatim; withdrawal is a new event; not a disclosure → refused
//   schedules     the server refuses malformed amounts, wrong signs, unknown or repeated kinds, repeated classes and
//                 classes that do not add up — storing nothing; a stored schedule reconciles to the composed statement
//                 (closing = current line; opening = composed prior-year line), mismatches are exact and block; without
//                 an authoritative comparative the opening is UNVERIFIED (stated, never passed)
//   statements    the statement of changes in equity and of cash flows follow their evidence; never a trial balance
//   period        a non-annual period needs its disclosure
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/notesSchedules.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import crypto from "node:crypto";
import { ASSIGN, FY2025, FY2026, applyChain, assignmentPairs, certifier, chainFiles, csv, makeWorld, migrationText, openDatabase, reporter, uuid } from "./lib/reportingKit.mjs";
import { IFRS_FOR_SMES_2015, IFRS_FOR_SMES_2025, IFRS_FOR_SMES_PACK_VERSION } from "../../src/lib/frameworkPacks/ifrsForSmes.ts";

const NOTES_FILE = "20261019100000_fs_notes_and_schedules.sql";
const { group, check, refused, finish } = reporter();
let db;

async function main() {
  db = await openDatabase("notes_proof");
  group("Replay");
  await check(`${NOTES_FILE} is in the chain and the whole chain applies`, async () => {
    if (!chainFiles().includes(NOTES_FILE)) return `${NOTES_FILE} missing`;
    return (await applyChain(db)) ?? true;
  });
  await refused("re-applying is refused by its preflight", "P0001", () => db.admin.query(migrationText(NOTES_FILE)), "PREFLIGHT_REFUSED");

  group("Vocabulary — requirements and schedules are the TypeScript pack's");
  await check("every requirement (id, kind, statement, applicability, blocking, order) and the pack version are identical", async () => {
    const rows = (await db.admin.query("SELECT pack_version, requirement_id, kind, statement, applicability, blocking, sort_order FROM public.fs_pack_requirements ORDER BY sort_order")).rows;
    const want = IFRS_FOR_SMES_2015.requirements.map((r, i) => ({ pack_version: IFRS_FOR_SMES_PACK_VERSION, requirement_id: r.id, kind: r.kind, statement: r.statement ?? null,
      applicability: r.applicability, blocking: r.blocking, sort_order: i + 1 }));
    const same2025 = JSON.stringify(IFRS_FOR_SMES_2025.requirements.map((r) => [r.id, r.kind, r.statement, r.applicability, r.blocking]))
      === JSON.stringify(IFRS_FOR_SMES_2015.requirements.map((r) => [r.id, r.kind, r.statement, r.applicability, r.blocking]));
    return JSON.stringify(rows) === JSON.stringify(want) && same2025 ? true : { n: [rows.length, want.length], same2025 };
  });
  await check("every schedule (id, requirement, label, lines, movement kinds and signs, prior-period flag) is identical", async () => {
    const rows = (await db.admin.query("SELECT schedule_id, requirement_id, label, line_ids, movements, prior_period_required FROM public.fs_schedule_definitions ORDER BY sort_order")).rows;
    const want = IFRS_FOR_SMES_2015.schedules.map((s) => ({ schedule_id: s.id, requirement_id: s.requirementId, label: s.label, line_ids: [...s.lineIds],
      movements: s.movements.map((m) => ({ kind: m.kind, sign: m.sign })), prior_period_required: s.priorPeriodRequired }));
    return JSON.stringify(rows) === JSON.stringify(want) ? true : { got: rows[0], want: want[0] };
  });
  await refused("requirements are immutable", "42501", () => db.admin.query("UPDATE public.fs_pack_requirements SET blocking=false"));

  // World: A with two certified years (composed and fully presented); C with one year (no comparative); D with a
  // six-month period; F on full IFRS.
  const W = await makeWorld(db);
  const { U, A, B } = W;
  const C = await W.company(U.owner, "Single-year SME");
  const D = await W.company(U.owner, "Short-period SME");
  const F = await W.company(U.owner, "Full IFRS entity", "full_ifrs");
  for (const co of [A, B, C, D, F]) await W.rollout(co, true);
  const k = await certifier(db, U);
  const assign = (company) => db.asUser(U.preparer, "SELECT public.fs_assign_presentation($1,$2::jsonb,'Presentation per the chart of accounts',$3) r", [company, JSON.stringify(assignmentPairs(ASSIGN)), uuid()]).then((r) => r.r);
  for (const co of [C, D]) await db.admin.query("INSERT INTO public.firm_members (company_id,user_id,role,accepted_at) VALUES ($1,$2,'preparer',now())", [co, U.preparer]);
  group("Setup — certified years and presentation");
  await check("A: FY2025 and FY2026 certified and fully presented; C: FY2026 only; D: a six-month FY2026", async () => {
    const p = await k.upload(A, 2025, csv(FY2025)); await k.review(A, p); await k.certify(A, p);
    const c = await k.upload(A, 2026, csv(FY2026)); await k.certify(A, c);
    const c1 = await k.upload(C, 2026, csv(FY2026)); await k.review(C, c1); await k.certify(C, c1);
    const d1 = await k.upload(D, 2026, csv(FY2026), { start: "2026-01-01", end: "2026-06-30" }); await k.review(D, d1); await k.certify(D, d1);
    const r = [await assign(A), await assign(C), await assign(D)];
    const comp = (await db.asUser(U.owner, "SELECT public.fs_statement_composition($1,2026) r", [A])).r;
    return r.every((x) => x.outcome === "recorded") && comp.blockers.length === 0 && comp.comparative.state === "available" ? true : { r, b: comp.blockers };
  });

  const status = (uid, company = A) => db.asUser(uid, "SELECT public.fs_notes_status($1,2026) r", [company]).then((r) => r.r);
  const decide = (uid, req, decision, { company = A, request = uuid(), reason = "Decided from the articles" } = {}) =>
    db.asUser(uid, "SELECT public.fs_decide_requirement($1,2026,$2,$3,$4,$5) r", [company, req, decision, reason, request]).then((r) => r.r);
  const disclose = (uid, req, body, { company = A, request = uuid(), source = "Board-approved notes, v1" } = {}) =>
    db.asUser(uid, "SELECT public.fs_record_disclosure($1,2026,$2,$3,$4,$5) r", [company, req, body, body === null ? null : source, request]).then((r) => r.r);
  const schedule = (uid, id, rows, { company = A, request = uuid(), source = "Fixed asset register 2026" } = {}) =>
    db.asUser(uid, "SELECT public.fs_record_schedule($1,2026,$2,$3::jsonb,$4,$5) r", [company, id, JSON.stringify(rows), source, request]).then((r) => r.r);
  const st = (s, id) => s.requirements.find((r) => r.requirementId === id);

  group("Status — before any notes work (hand-written expectations)");
  let initial;
  await check("statuses: statements composed; SOCIE and SCF need evidence; six disclosures missing; share capital undecided; early application n/a; PPE schedule missing; the other schedules n/a; the period is annual", async () => {
    initial = await status(U.viewer);
    const want = {
      "smes.set.sfp": "composed", "smes.set.sci": "composed", "smes.set.socie": "evidence_missing", "smes.set.scf": "evidence_missing", "smes.set.notes": "derived",
      "smes.period.annual": "satisfied", "smes.note.compliance": "missing", "smes.note.identification": "missing", "smes.note.policies": "missing",
      "smes.note.judgements": "missing", "smes.note.estimates": "missing", "smes.note.subclassifications": "missing", "smes.note.share_capital": "undecided",
      "smes.schedule.ppe": "missing", "smes.schedule.investment_property_cost": "not_applicable", "smes.schedule.investment_property_fair_value": "not_applicable",
      "smes.schedule.intangibles": "not_applicable", "smes.schedule.provisions": "not_applicable", "smes.note.early_application": "not_applicable",
    };
    const got = Object.fromEntries(initial.requirements.map((r) => [r.requirementId, r.status]));
    const bad = Object.entries(want).filter(([id, s]) => got[id] !== s);
    return initial.state === "evaluated" && bad.length === 0 && Object.keys(got).length === Object.keys(want).length ? true : { bad, extra: Object.keys(got).filter((x) => !(x in want)) };
  });
  await check("blockers, in requirement order, exactly", async () => {
    const want = ["STATEMENT_EVIDENCE_MISSING:smes.set.socie", "STATEMENT_EVIDENCE_MISSING:smes.set.scf",
      "REQUIRED_DISCLOSURE_MISSING:smes.note.compliance", "REQUIRED_DISCLOSURE_MISSING:smes.note.identification", "REQUIRED_DISCLOSURE_MISSING:smes.note.policies",
      "REQUIRED_DISCLOSURE_MISSING:smes.note.judgements", "REQUIRED_DISCLOSURE_MISSING:smes.note.estimates", "REQUIRED_DISCLOSURE_MISSING:smes.note.subclassifications",
      "REQUIREMENT_UNDECIDED:smes.note.share_capital", "SCHEDULE_MISSING:ppe"];
    return JSON.stringify(initial.blockers) === JSON.stringify(want) ? true : initial.blockers;
  });
  await check("the PPE schedule is applicable because the composed line has a carrying amount: 14,000.00 now, 16,000.00 a year ago", async () => {
    const p = st(initial, "smes.schedule.ppe");
    return p.composedClosingMinor === "1400000" && p.composedOpeningMinor === "1600000" ? true : p;
  });

  group("Authority");
  await check("a member without prepare_close and another workspace's owner are refused for all three writes", async () => {
    const r = [await decide(U.viewer, "smes.note.share_capital", "applicable"), await disclose(U.viewer, "smes.note.compliance", "x"),
      await schedule(U.viewer, "ppe", [{ classLabel: "E", openingMinor: "1", closingMinor: "1", movements: [] }]),
      await decide(U.ownerB, "smes.note.share_capital", "applicable"), await disclose(U.ownerB, "smes.note.compliance", "x")];
    return r.every((x) => x.outcome === "forbidden") ? true : r;
  });
  await check("a full-IFRS workspace is refused (framework_not_ifrs_for_smes)", async () => (await disclose(U.owner, "smes.note.compliance", "x", { company: F })).outcome === "framework_not_ifrs_for_smes" ? true : "allowed");
  await check("kill switch: every write refused and the status unavailable", async () => {
    await db.asService("SELECT public.fs_set_kill_switch(true,'proof kill switch','proof')");
    const r = [await decide(U.preparer, "smes.note.share_capital", "applicable"), await disclose(U.preparer, "smes.note.compliance", "x"),
      await schedule(U.preparer, "ppe", [{ classLabel: "E", openingMinor: "1", closingMinor: "1", movements: [] }])];
    const s = await status(U.owner);
    await db.asService("SELECT public.fs_set_kill_switch(false,'proof kill switch off','proof')");
    return r.every((x) => x.outcome === "feature_disabled") && s.state === "unavailable" ? true : { r, s: s.state };
  });

  group("Decisions — only what the data cannot decide");
  await check("an always-required disclosure, the early-application disclosure and a schedule are not decidable", async () => {
    const r = [await decide(U.preparer, "smes.note.compliance", "not_applicable"), await decide(U.preparer, "smes.note.early_application", "not_applicable"),
      await decide(U.preparer, "smes.schedule.ppe", "not_applicable")];
    return r.every((x) => x.outcome === "not_decidable") ? true : r;
  });
  let req;
  await check("share capital: decided applicable (the entity has share capital); a retry replays; other content is refused; the same decision is unchanged", async () => {
    req = uuid();
    const a = await decide(U.preparer, "smes.note.share_capital", "applicable", { request: req });
    const b = await decide(U.preparer, "smes.note.share_capital", "applicable", { request: req });
    const c = await decide(U.preparer, "smes.note.share_capital", "not_applicable", { request: req });
    const d = await decide(U.preparer, "smes.note.share_capital", "applicable");
    const s = st(await status(U.owner), "smes.note.share_capital");
    return a.outcome === "recorded" && b.replay === true && c.outcome === "request_reused" && d.outcome === "unchanged" && s.status === "missing" ? true : { a, b, c, d, s };
  });

  group("Texts — the preparer's words, verbatim");
  const WORDING = {
    "smes.note.compliance": "These financial statements have been prepared in accordance with the IFRS for SMEs (2015 edition).",
    "smes.note.identification": "Synthetic SME Limited; year ended 31 December 2026; Tanzanian shillings; amounts in shillings.",
    "smes.note.policies": "Measurement basis: historical cost.\nProperty, plant and equipment: straight-line depreciation.",
    "smes.note.judgements": "No judgements other than those involving estimations.",
    "smes.note.estimates": "Useful lives of equipment.",
    "smes.note.subclassifications": "Receivables are all due from third parties.",
    "smes.note.share_capital": "10,000 ordinary shares of TZS 1 each, issued and fully paid.",
  };
  await check("seven disclosures recorded and stored byte for byte (newlines included), with their source", async () => {
    const r = [];
    for (const [id, text] of Object.entries(WORDING)) r.push(await disclose(U.preparer, id, text));
    const stored = (await db.admin.query("SELECT requirement_id, body, source_ref FROM public.fs_disclosure_texts ORDER BY seq")).rows;
    return r.every((x) => x.outcome === "recorded") && stored.every((x) => x.body === WORDING[x.requirement_id] && x.source_ref === "Board-approved notes, v1") ? true : { r };
  });
  await check("a schedule requirement is not a disclosure; an empty text is refused", async () => {
    const a = await disclose(U.preparer, "smes.schedule.ppe", "x");
    const b = await disclose(U.preparer, "smes.note.compliance", "   ");
    return a.outcome === "not_a_disclosure" && b.outcome === "invalid_request" ? true : { a, b };
  });

  group("Schedules — the server validates every amount before storing anything");
  const PPE_OK = [{ classLabel: "Equipment", openingMinor: "1600000", closingMinor: "1400000", movements: [{ kind: "depreciation", amountMinor: "-200000" }] }];
  await check("refusals name every problem and store nothing: does not add up (by 50,000), wrong sign, unknown kind, repeated kind, malformed amount, repeated class", async () => {
    const r = await schedule(U.preparer, "ppe", [
      { classLabel: "A", openingMinor: "1600000", closingMinor: "1450000", movements: [{ kind: "depreciation", amountMinor: "-200000" }] },
      { classLabel: "B", openingMinor: "0", closingMinor: "100", movements: [{ kind: "depreciation", amountMinor: "100" }] },
      { classLabel: "C", openingMinor: "0", closingMinor: "0", movements: [{ kind: "amortisation", amountMinor: "0" }] },
      { classLabel: "D", openingMinor: "0", closingMinor: "0", movements: [{ kind: "additions", amountMinor: "5" }, { kind: "additions", amountMinor: "-5" }] },
      { classLabel: "E", openingMinor: "1400000.5", closingMinor: "0", movements: [] },
      { classLabel: "A", openingMinor: "0", closingMinor: "0", movements: [] },
    ]);
    const codes = (r.problems ?? []).map((p) => `${p.row ?? "-"}:${p.code}${p.differenceMinor ? `:${p.differenceMinor}` : ""}`);
    const want = ["1:CLASS_DOES_NOT_ADD_UP:50000", "2:MOVEMENT_SIGN", "3:MOVEMENT_KIND_UNKNOWN", "4:MOVEMENT_SIGN", "4:MOVEMENT_KIND_REPEATED", "5:ROW_MALFORMED", "-:CLASS_REPEATED"];
    return r.outcome === "invalid_schedule" && JSON.stringify(codes) === JSON.stringify(want) && (await db.count("SELECT count(*) n FROM public.fs_schedule_submissions")) === 0 ? true : { r, codes };
  });
  await check("an unknown schedule is refused", async () => (await schedule(U.preparer, "made_up", PPE_OK)).outcome === "unknown_schedule" ? true : "allowed");
  await check("closing 15,000.00 against the composed 14,000.00: stored, CLOSING MISMATCH by exactly 1,000.00, blocks", async () => {
    const r = await schedule(U.preparer, "ppe", [{ classLabel: "Equipment", openingMinor: "1700000", closingMinor: "1500000", movements: [{ kind: "depreciation", amountMinor: "-200000" }] }]);
    const p = st(await status(U.owner), "smes.schedule.ppe");
    const b = (await status(U.owner)).blockers;
    return r.outcome === "recorded" && p.status === "closing_mismatch" && p.differenceMinor === "100000" && b.includes("SCHEDULE_CLOSING_MISMATCH:ppe") ? true : { r, p };
  });
  await check("closing agrees but opening 16,500.00 against the composed prior year 16,000.00: OPENING MISMATCH by exactly 500.00, blocks", async () => {
    await schedule(U.preparer, "ppe", [{ classLabel: "Equipment", openingMinor: "1650000", closingMinor: "1400000", movements: [{ kind: "depreciation", amountMinor: "-250000" }] }]);
    const p = st(await status(U.owner), "smes.schedule.ppe");
    return p.status === "opening_mismatch" && p.differenceMinor === "50000" ? true : p;
  });
  let sub;
  await check("two classes that add up and agree both ways: RECONCILED; the movements are stored in the cited order", async () => {
    sub = await schedule(U.preparer, "ppe", [
      { classLabel: "Vehicles", openingMinor: "600000", closingMinor: "500000", movements: [{ kind: "depreciation", amountMinor: "-100000" }] },
      { classLabel: "Equipment", openingMinor: "1000000", closingMinor: "900000", movements: [{ kind: "depreciation", amountMinor: "-150000" }, { kind: "additions", amountMinor: "50000" }] },
    ]);
    const p = st(await status(U.owner), "smes.schedule.ppe");
    const stored = (await db.one("SELECT rows FROM public.fs_schedule_submissions WHERE id=$1", [sub.submissionId])).rows;
    return p.status === "reconciled" && p.scheduleClosingMinor === "1400000" && p.scheduleOpeningMinor === "1600000"
      && JSON.stringify(stored[1].movements.map((m) => m.kind)) === JSON.stringify(["additions", "depreciation"]) ? true : { p, m: stored[1].movements };
  });
  await check("the same content again is unchanged; history keeps all three submissions", async () => {
    const same = await schedule(U.preparer, "ppe", [
      { classLabel: "Vehicles", openingMinor: "600000", closingMinor: "500000", movements: [{ kind: "depreciation", amountMinor: "-100000" }] },
      { classLabel: "Equipment", openingMinor: "1000000", closingMinor: "900000", movements: [{ kind: "additions", amountMinor: "50000" }, { kind: "depreciation", amountMinor: "-150000" }] },
    ]);
    return same.outcome === "unchanged" && (await db.count("SELECT count(*) n FROM public.fs_schedule_submissions")) === 3 ? true : same;
  });
  await check("a single-year workspace (no authoritative comparative): the opening is UNVERIFIED — stated, not passed, not blocking", async () => {
    await schedule(U.preparer, "ppe", PPE_OK, { company: C });
    const s = await status(U.owner, C);
    const p = st(s, "smes.schedule.ppe");
    return p.status === "reconciled_opening_unverified" && p.composedOpeningMinor === null && !s.blockers.some((b) => b.includes("ppe")) ? true : { p, b: s.blockers };
  });

  group("Statements follow their evidence — never a trial balance");
  const member = (await db.one("SELECT id FROM public.firm_members WHERE company_id=$1 AND user_id=$2", [A, U.preparer])).id;
  // Accepted evidence rows inserted directly by the database owner: acceptance itself is proven by run.mjs; this proves
  // only how the status reads it.
  const lastBatch = {};
  const hex = (x) => crypto.createHash("sha256").update(x).digest("hex");
  const evidence = async (type, status, version = 1, series = "default") => {
    const id = `eb-${uuid()}`;
    await db.admin.query(`INSERT INTO public.financial_evidence_batches (evidence_batch_id, company_id, reporting_period_id, evidence_type, period_role,
      series_key, schema_version, content_hash, document_hash, replay_identity, batch_document, diagnostics, validation_status, version, supersedes_batch_id, uploaded_by_firm_member_id)
      VALUES ($1,$2,'FY2026',$3,'CURRENT',$4,'1',$5,$5,$6,'{}'::jsonb,'[]'::jsonb,$7,$8,$9,$10)`,
      [id, A, type, series, "f".repeat(64), hex(id), status, version, version === 1 ? null : lastBatch[`${type}/${series}`], member]);
    lastBatch[`${type}/${series}`] = id;
  };
  await check("equity-movement evidence (VALID) → the statement of changes in equity has its evidence", async () => {
    await evidence("EQUITY_MOVEMENTS", "VALID");
    return st(await status(U.owner), "smes.set.socie").status === "evidence_present" ? true : "missing";
  });
  await check("a cash ledger without the cash account map is not enough; with it, the cash-flow statement has its evidence", async () => {
    await evidence("TRANSACTION_LEDGER", "VALID");
    const a = st(await status(U.owner), "smes.set.scf").status;
    await evidence("CASH_ACCOUNT_MAP", "VALID_WITH_WARNINGS");
    const b = st(await status(U.owner), "smes.set.scf").status;
    return a === "evidence_missing" && b === "evidence_present" ? true : { a, b };
  });
  await check("a newer INVALID version of the ledger series withdraws that evidence again", async () => {
    await evidence("TRANSACTION_LEDGER", "INVALID", 2);
    const a = st(await status(U.owner), "smes.set.scf").status;
    await evidence("TRANSACTION_LEDGER", "VALID", 3);
    return a === "evidence_missing" && st(await status(U.owner), "smes.set.scf").status === "evidence_present" ? true : a;
  });

  group("Complete — and the identity moves with every change");
  let done;
  await check("everything provided: no blocker; the status identity is deterministic", async () => {
    done = await status(U.owner);
    const again = await status(U.viewer);
    return done.blockers.length === 0 && /^[0-9a-f]{64}$/.test(done.statusSha256) && again.statusSha256 === done.statusSha256 ? true : done.blockers;
  });
  await check("withdrawing a text is a new event: the disclosure is missing again and the identity changes", async () => {
    const before = await db.count("SELECT count(*) n FROM public.fs_disclosure_texts WHERE requirement_id='smes.note.estimates'");
    const w = await disclose(U.preparer, "smes.note.estimates", null);
    const s = await status(U.owner);
    const after = await db.count("SELECT count(*) n FROM public.fs_disclosure_texts WHERE requirement_id='smes.note.estimates'");
    return w.outcome === "recorded" && w.withdrawn === true && after === before + 1 && s.blockers.includes("REQUIRED_DISCLOSURE_MISSING:smes.note.estimates") && s.statusSha256 !== done.statusSha256 ? true : { w, b: s.blockers };
  });

  group("Period — a non-annual period needs its disclosure");
  await check("a six-month period: missing until disclosed, then provided", async () => {
    const a = st(await status(U.owner, D), "smes.period.annual");
    await disclose(U.preparer, "smes.period.annual", "The entity changed its year end to 30 June; amounts are not entirely comparable.", { company: D });
    const b = st(await status(U.owner, D), "smes.period.annual");
    return a.status === "missing" && b.status === "provided" ? true : { a, b };
  });

  group("Tenancy, append-only");
  await check("another workspace's owner reads nothing", async () => (await status(U.ownerB)).state === "unavailable" ? true : "readable");
  for (const t of ["fs_requirement_decisions", "fs_disclosure_texts", "fs_schedule_submissions"]) {
    await refused(`${t} cannot be updated — not even by the database owner`, "42501", () => db.admin.query(`UPDATE public.${t} SET created_at = now()`));
    await refused(`${t} cannot be deleted`, "42501", () => db.admin.query(`DELETE FROM public.${t}`));
  }
  await refused("clients cannot insert texts directly", "42501", () => db.asRole("authenticated", U.preparer, "INSERT INTO public.fs_disclosure_texts (company_id, period_year, requirement_id, body, actor_user_id, request_id) VALUES ($1,2026,'smes.note.compliance','x',$2,$3)", [A, U.preparer, uuid()]));
  await refused("anon cannot read the status", "42501", () => db.asRole("anon", null, "SELECT public.fs_notes_status($1,2026)", [A]));
}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish("NOTES_SCHEDULES", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
