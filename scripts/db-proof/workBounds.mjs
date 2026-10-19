#!/usr/bin/env bun
// Real-PostgreSQL proof of the server-enforced work bounds (20261114100000) — through the browser's own save code
// (src/lib/reporting/prepareVersion.ts) where a page would act, and through the database where a defect or an attacker
// would. Every bound is reached AT ITS COMMITTED VALUE and refused BY NAME with nothing stored; the same operation is
// accepted at the bound. No parameter is lowered and no function is replaced to make a bound reachable: the rows that
// bring a lineage to a bound are written directly as the superuser (the control is a trigger on the table, so the path is
// the one every writer takes), and the operation at and past the bound then goes through the real client functions.
//
//   S   the committed bounds are exactly the documented ones (fs-work-bounds/1); anon cannot read them; the trigger
//       functions are internal
//   B1  evidence rows per batch (20,000): a 20,000-row ledger built by the browser intake is saved; a 20,002-row file sent
//       past the intake is refused EVIDENCE_ROWS_LIMIT — no version, no batch
//   B2  evidence bytes per batch (4 MiB): a 20,000-row file with 250-character descriptions (6+ MB as evidence, which the
//       intake's 2,000,000-character limit never lets through) is refused EVIDENCE_DOCUMENT_SIZE_LIMIT
//   B3  evidence rows per version (200,000): a version referencing ten 20,000-row batches (200,000 rows) is accepted; one
//       referencing eleven (220,000) is refused EVIDENCE_ROWS_PER_VERSION_LIMIT
//   B4  report document bytes (8 MiB): a version whose document is just under 8 MiB is accepted; over, refused
//       REPORT_DOCUMENT_SIZE_LIMIT
//   B5  versions per lineage (1,000): a lineage brought to 999 versions accepts the 1,000th save through the client and
//       refuses the 1,001st VERSION_HISTORY_LIMIT with nothing stored
//   B6  comments per version (500): a version brought to 499 comments accepts the 500th through fs_review_comment_open and
//       refuses the 501st REVIEW_COMMENTS_LIMIT
//   B7  events per comment (200): a comment brought to 199 events accepts the 200th (a response) and refuses the 201st
//       (the resolution) REVIEW_COMMENT_EVENTS_LIMIT
//   C   CONTROL REMOVED (the batch trigger dropped): a direct 20,002-row insert is STORED — the regression; CONTROL RESTORED
//       (the trigger re-created from the migration text): refused again. Direct insert: see the note at the case.
//
//   DB_PROOF_MODULES_DIR=<dir with pg + embedded-postgres> bun scripts/db-proof/workBounds.mjs
//   DB_PROOF_MODE=external DB_PROOF_CONN=postgres://… (a throwaway, EMPTY loopback database) also works (CI).
import crypto from "node:crypto";
import { applyChain, certifier, chainFiles, clientDb, EVIDENCE_FY2025_COMPARATIVE, EVIDENCE_FY2026, makeWorld, migrationText, openDatabase, prepareReporting, reporter, uuid } from "./lib/reportingKit.mjs";
import { ingestEvidence } from "../../src/lib/financialEvidence/intake.ts";
import { signoffClient } from "../../src/lib/reporting/signoff.ts";
import { prepareReportVersion } from "../../src/lib/reporting/prepareVersion.ts";

const FILE = "20261114100000_fs_work_bounds.sql";
/** The documented bounds (RECORD §3d). Written by hand; the proof compares the database's answer with them. */
const BOUNDS = Object.freeze({ contract: "fs-work-bounds/1", evidenceRowsPerBatch: 1000, evidenceDocumentBytesPerBatch: 1048576, evidenceRowsPerVersion: 10000, reportDocumentBytes: 8388608, versionsPerLineage: 1000, commentsPerVersion: 500, eventsPerComment: 200 });
const { group, check, refused, finish } = reporter();
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const LF = String.fromCharCode(10);
let db;

async function main() {
  db = await openDatabase("work_bounds_proof");
  group("Replay");
  await check(`${FILE} is in the chain and the whole chain applies`, async () => (!chainFiles().includes(FILE) ? `${FILE} missing` : (await applyChain(db)) ?? true));
  await refused("re-applying is refused by its preflight", "P0001", () => db.admin.query(migrationText(FILE)), "PREFLIGHT_REFUSED");
  await check("static contract: no DELETE or UPDATE anywhere in the migration (DDL only)", async () => {
    const code = migrationText(FILE).replace(/--[^\n]*/g, "");
    const hits = [...code.matchAll(/\b(DELETE\s+FROM|UPDATE\s+[\w.]+\s+SET)\b/gi)].map((m) => m[0]);
    return hits.length === 0 ? true : hits;
  });

  group("S  the bounds as committed");
  await check("fs_work_bounds() answers exactly the documented bounds", async () => {
    const r = (await db.one("SELECT public.fs_work_bounds() b")).b;
    return JSON.stringify(r, Object.keys(r).sort()) === JSON.stringify(BOUNDS, Object.keys(BOUNDS).sort()) ? true : r;
  });
  await check("authenticated may read the bounds; anon may not; the four trigger functions are internal; the four triggers exist", async () => {
    const r = await db.one(`SELECT has_function_privilege('authenticated','public.fs_work_bounds()','EXECUTE') a,
      has_function_privilege('anon','public.fs_work_bounds()','EXECUTE') n,
      has_function_privilege('authenticated','public.fs_bound_evidence_batch()','EXECUTE') t1,
      has_function_privilege('authenticated','public.fs_bound_report_version()','EXECUTE') t2,
      has_function_privilege('authenticated','public.fs_bound_review_comment()','EXECUTE') t3,
      has_function_privilege('authenticated','public.fs_bound_review_comment_event()','EXECUTE') t4,
      (SELECT count(*) FROM pg_trigger WHERE tgname IN ('trg_feb_work_bounds','trg_fsr_work_bounds','trg_fsrc_work_bounds','trg_fsrce_work_bounds')) triggers`);
    return r.a && !r.n && !r.t1 && !r.t2 && !r.t3 && !r.t4 && Number(r.triggers) === 4 ? true : r;
  });

  // ── The world: a certified two-year company prepared up to (not including) evidence and a report ───────────────────────
  const W = await makeWorld(db);
  const { U, A } = W;
  await W.rollout(A, true);
  const k = await certifier(db, U);
  const Y = 2026;
  await prepareReporting(db, W, k, { year: Y });
  const pre = clientDb(db, U.preparer);
  const client = signoffClient(pre);
  const asU = (uid, sql, p) => db.asUser(uid, sql, p);
  const parse = (type, role = "CURRENT", text) => {
    const y = role === "CURRENT" ? Y : Y - 1;
    const body = text ?? (role === "CURRENT" ? EVIDENCE_FY2026 : EVIDENCE_FY2025_COMPARATIVE)[type];
    const r = ingestEvidence({ companyId: A, evidenceType: type, periodRole: role, reportingPeriodId: `FY${Y}`, currency: "TZS", scale: 2, text: body, fileName: `${type.toLowerCase()}-${y}.csv`, mimeType: "text/csv", periodStart: `${y}-01-01`, periodEnd: `${y}-12-31` });
    if (r.outcome !== "PARSED") throw new Error(`${type} ${role}: ${JSON.stringify(r.diagnostics).slice(0, 300)}`);
    return r.batch;
  };
  const rid = `rpt-${uuid()}`;
  const save = (newEvidence) => prepareReportVersion(pre, client, { companyId: A, periodYear: Y, legalName: "Synthetic SME Limited", reportId: rid, newEvidence, idempotencyKey: `attempt-${uuid()}`, evaluatedAt: new Date().toISOString() });
  const latest = (r = rid) => db.count("SELECT coalesce(max(report_version),0) n FROM public.financial_statement_reports WHERE report_id=$1", [r]);
  const batches = () => db.count("SELECT count(*) n FROM public.financial_evidence_batches WHERE company_id=$1", [A]);
  const touch = (i) => asU(U.preparer, "SELECT public.fs_record_disclosure($1,$2,'smes.note.judgements',$3,'Notes v2',$4) r", [A, Y, `None beyond estimates; revision ${i}.`, uuid()]);

  group("Baseline  the six fixture files are saved through the browser's save code");
  await check("the first save stores six batches and binds a version", async () => {
    const r = await save(["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "CASH_ACCOUNT_MAP"].map((t) => parse(t)).concat(["TRANSACTION_LEDGER", "EQUITY_MOVEMENTS", "PRIOR_PERIOD_STATEMENTS"].map((t) => parse(t, "COMPARATIVE"))));
    return r.outcome === "saved" && (await latest()) >= 2 && (await batches()) === 6 ? true : { r: r.outcome, reason: r.reason, v: await latest(), batches: await batches() };
  });

  // ── B1/B2 through the client at the committed values ───────────────────────────────────────────────────────────────────
  group(`B1  evidence rows per batch: ${BOUNDS.evidenceRowsPerBatch.toLocaleString("en-US")} accepted, ${(BOUNDS.evidenceRowsPerBatch + 2).toLocaleString("en-US")} refused by name`);
  // The fixture ledger (7 rows that tie to the bank account) padded to 20,000 rows with netting pairs on the same account.
  const padded = (() => {
    const lines = EVIDENCE_FY2026.TRANSACTION_LEDGER.trimEnd().split(LF);
    for (let i = lines.length - 1; i < BOUNDS.evidenceRowsPerBatch; i++) {
      const date = `${Y}-${String(1 + (i % 12)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`;
      lines.push(`N${i},${date},1000,Netting ${i % 2 ? "payment" : "receipt"} ${i},${i % 2 ? "" : "1.00"},${i % 2 ? "1.00" : ""},OPERATING,${i % 2 ? "Payments to suppliers and employees" : "Receipts from customers"}`);
    }
    return lines.join(LF) + LF;
  })();
  let ledger20k;
  await check(`a ${BOUNDS.evidenceRowsPerBatch.toLocaleString("en-US")}-row ledger parsed by the browser intake is saved (its batch holds exactly that many rows, under the byte bound)`, async () => {
    ledger20k = parse("TRANSACTION_LEDGER", "CURRENT", padded);
    const r = await save([ledger20k]);
    const n = await db.one("SELECT jsonb_array_length(batch_document->'rows') n, octet_length(batch_document::text) bytes FROM public.financial_evidence_batches WHERE evidence_batch_id=$1", [ledger20k.evidenceBatchId]);
    return r.outcome === "saved" && Number(n?.n) === BOUNDS.evidenceRowsPerBatch && Number(n.bytes) < BOUNDS.evidenceDocumentBytesPerBatch ? true : { r: r.outcome, reason: r.reason, n };
  });
  /** A batch the browser never produces: the parsed 20,000-row batch with rows added past the intake limit (a netting pair, so every tie holds). */
  const overRows = (extraRows) => {
    const rows = [...ledger20k.document.rows, ...extraRows];
    return { ...ledger20k, evidenceBatchId: `eb-proof-${uuid()}`, contentHash: sha(JSON.stringify(rows)), document: { ...ledger20k.document, rows } };
  };
  const cols = ledger20k.document.columns;
  const row = (id, receipt, payment, description = `Netting ${id}`) => cols.map((c) => ({ transaction_id: id, date: `${Y}-06-30`, cash_account_code: "1000", description, receipt, payment, activity: "OPERATING", cash_flow_line: receipt ? "Receipts from customers" : "Payments to suppliers and employees" })[c] ?? "");
  let vBefore, bBefore;
  await refused(`a ${(BOUNDS.evidenceRowsPerBatch + 2).toLocaleString("en-US")}-row file sent past the intake is refused EVIDENCE_ROWS_LIMIT`, "22023", async () => { vBefore = await latest(); bBefore = await batches(); await save([overRows([row("X1", "1.00", ""), row("X2", "", "1.00")])]); }, "EVIDENCE_ROWS_LIMIT");
  await check("nothing was stored by the refused save: no version, no batch", async () => ((await latest()) === vBefore && (await batches()) === bBefore ? true : { v: await latest(), vBefore, b: await batches(), bBefore }));

  group(`B2  evidence bytes per batch: a ${BOUNDS.evidenceRowsPerBatch.toLocaleString("en-US")}-row file with long descriptions is refused by name`);
  const fat = (() => {
    const d = cols.indexOf("description");
    // Long enough that the file is over the byte bound while it is under the row bound (the intake would refuse it at 2,000,000 characters).
    const pad = Math.ceil((BOUNDS.evidenceDocumentBytesPerBatch * 1.5) / BOUNDS.evidenceRowsPerBatch);
    const rows = ledger20k.document.rows.map((r) => r.map((c, i) => (i === d ? "D".repeat(pad) : c)));
    return { ...ledger20k, evidenceBatchId: `eb-proof-${uuid()}`, contentHash: sha(JSON.stringify(rows)), document: { ...ledger20k.document, rows } };
  })();
  await check("the file is over the byte bound as evidence and under the row bound", async () =>
    (Buffer.byteLength(JSON.stringify(fat.document)) > BOUNDS.evidenceDocumentBytesPerBatch && fat.document.rows.length === BOUNDS.evidenceRowsPerBatch ? true : Buffer.byteLength(JSON.stringify(fat.document))));
  await refused("refused EVIDENCE_DOCUMENT_SIZE_LIMIT", "22023", async () => { vBefore = await latest(); bBefore = await batches(); await save([fat]); }, "EVIDENCE_DOCUMENT_SIZE_LIMIT");
  await check("nothing was stored by the refused save", async () => ((await latest()) === vBefore && (await batches()) === bBefore ? true : { v: await latest(), b: await batches() }));

  // ── C  control removed / restored — a DIRECT superuser insert of the over-limit batch (a copy of the stored 20,000-row
  //      batch with two rows appended). The application path for this case (the client save with the trigger dropped) made
  //      the embedded Windows PostgreSQL backend exit (code 143) in every attempt, with the trigger absent only; that is a
  //      harness fact recorded in RECORD §7.5, not a product result. The trigger is the control and sits on the table, so
  //      the direct insert exercises exactly the statement every writer reaches. ──────────────────────────────────────────
  group(`C  CONTROL REMOVED: without the batch trigger a ${(BOUNDS.evidenceRowsPerBatch + 2).toLocaleString("en-US")}-row batch is stored (the regression); restored: refused`);
  const trigger = migrationText(FILE).match(/CREATE TRIGGER trg_feb_work_bounds[\s\S]*?;\n/)[0];
  const insertOver = (id) => db.admin.query(`INSERT INTO public.financial_evidence_batches (evidence_batch_id, company_id, reporting_period_id, evidence_type, period_role, series_key, schema_version,
      source_file_name, content_hash, document_hash, replay_identity, currency, scale, batch_document, diagnostics, validation_status, version, supersedes_batch_id, uploaded_by_firm_member_id)
    SELECT $2, company_id, reporting_period_id, evidence_type, period_role, 'over-' || $2, schema_version, source_file_name, encode(sha256(($2 || 'c')::bytea), 'hex'), encode(sha256(($2 || 'd')::bytea), 'hex'),
      encode(sha256(($2 || 'r')::bytea), 'hex'), currency, scale,
      jsonb_set(batch_document, '{rows}', (batch_document -> 'rows') || jsonb_build_array(batch_document -> 'rows' -> 0) || jsonb_build_array(batch_document -> 'rows' -> 1)),
      diagnostics, validation_status, 1, NULL, uploaded_by_firm_member_id
    FROM public.financial_evidence_batches WHERE evidence_batch_id = $1`, [ledger20k.evidenceBatchId, id]);
  await refused("with the control: the direct 20,002-row insert is refused EVIDENCE_ROWS_LIMIT (the trigger, not the function, is the control)", "22023", () => insertOver(`eb-over-${uuid()}`), "EVIDENCE_ROWS_LIMIT");
  await db.admin.query("DROP TRIGGER trg_feb_work_bounds ON public.financial_evidence_batches");
  const overId = `eb-over-${uuid()}`;
  await check("control removed: the same insert is stored (two rows over the bound in one batch)", async () => {
    await insertOver(overId);
    const n = await db.one("SELECT jsonb_array_length(batch_document->'rows') n FROM public.financial_evidence_batches WHERE evidence_batch_id=$1", [overId]);
    return Number(n?.n) === BOUNDS.evidenceRowsPerBatch + 2 ? true : n;
  });
  await db.admin.query(trigger);
  await refused("control restored: refused EVIDENCE_ROWS_LIMIT again", "22023", () => insertOver(`eb-over-${uuid()}`), "EVIDENCE_ROWS_LIMIT");

  // ── B3/B4 on a synthetic lineage written directly (the trigger is the control; its path is every writer's) ────────────────
  group(`B3  evidence rows per version: ${BOUNDS.evidenceRowsPerVersion / BOUNDS.evidenceRowsPerBatch} batches at the row bound (${BOUNDS.evidenceRowsPerVersion.toLocaleString("en-US")} rows) accepted, one more refused`);
  const synth = `rpt-synthetic-${uuid()}`;
  const copyBatch = (i) => db.admin.query(`INSERT INTO public.financial_evidence_batches (evidence_batch_id, company_id, reporting_period_id, evidence_type, period_role, series_key, schema_version,
      source_file_name, content_hash, document_hash, replay_identity, currency, scale, batch_document, diagnostics, validation_status, version, supersedes_batch_id, uploaded_by_firm_member_id)
    SELECT $2, company_id, reporting_period_id, evidence_type, period_role, 'synthetic-' || $3, schema_version, source_file_name, encode(sha256(($2 || 'c')::bytea), 'hex'), encode(sha256(($2 || 'd')::bytea), 'hex'),
      encode(sha256(($2 || 'r')::bytea), 'hex'), currency, scale, batch_document, diagnostics, validation_status, 1, NULL, uploaded_by_firm_member_id
    FROM public.financial_evidence_batches WHERE evidence_batch_id = $1`, [ledger20k.evidenceBatchId, `eb-synthetic-${uuid()}`, String(i)]).then(() => undefined);
  const copyVersion = (version, ids, docSql = "report_document") => db.admin.query(`INSERT INTO public.financial_statement_reports (report_id, report_version, company_id, period_year, provenance_origin, report_document, content_hash, document_hash, evidence_batch_ids, created_by_firm_member_id)
    SELECT $1, $2, company_id, period_year, provenance_origin, ${docSql}, content_hash, document_hash, $3::text[], created_by_firm_member_id
    FROM public.financial_statement_reports WHERE report_id = $4 ORDER BY report_version DESC LIMIT 1`, [synth, version, ids, rid]);
  const synthIds = [];
  const K = BOUNDS.evidenceRowsPerVersion / BOUNDS.evidenceRowsPerBatch; // the per-version bound is a whole number of full batches
  for (let i = 0; i < K + 1; i++) { const id = `eb-synthetic-${uuid()}`; synthIds.push(id); await db.admin.query(`INSERT INTO public.financial_evidence_batches (evidence_batch_id, company_id, reporting_period_id, evidence_type, period_role, series_key, schema_version,
      source_file_name, content_hash, document_hash, replay_identity, currency, scale, batch_document, diagnostics, validation_status, version, supersedes_batch_id, uploaded_by_firm_member_id)
    SELECT $2, company_id, reporting_period_id, evidence_type, period_role, 'synthetic-' || $3, schema_version, source_file_name, encode(sha256(($2 || 'c')::bytea), 'hex'), encode(sha256(($2 || 'd')::bytea), 'hex'),
      encode(sha256(($2 || 'r')::bytea), 'hex'), currency, scale, batch_document, diagnostics, validation_status, 1, NULL, uploaded_by_firm_member_id
    FROM public.financial_evidence_batches WHERE evidence_batch_id = $1`, [ledger20k.evidenceBatchId, id, String(i)]); }
  void copyBatch;
  await check(`${K + 1} batches at the row bound exist (each accepted: at the per-batch bound)`, async () => ((await db.count("SELECT count(*) n FROM public.financial_evidence_batches WHERE evidence_batch_id = ANY($1::text[]) AND jsonb_array_length(batch_document->'rows') = $2", [synthIds, BOUNDS.evidenceRowsPerBatch])) === K + 1 ? true : "count differs"));
  await check(`a version referencing ${K} of them (${BOUNDS.evidenceRowsPerVersion.toLocaleString("en-US")} rows) is accepted`, async () => { await copyVersion(1, synthIds.slice(0, K)); return (await latest(synth)) === 1 ? true : await latest(synth); });
  await refused(`a version referencing ${K + 1} (${((K + 1) * BOUNDS.evidenceRowsPerBatch).toLocaleString("en-US")} rows) is refused EVIDENCE_ROWS_PER_VERSION_LIMIT`, "22023", () => copyVersion(2, synthIds), "EVIDENCE_ROWS_PER_VERSION_LIMIT");
  await check("nothing was stored: the synthetic lineage still ends at version 1", async () => ((await latest(synth)) === 1 ? true : await latest(synth)));

  group("B4  report document bytes: just under 8 MiB accepted, over refused");
  // The latest real document with one added text field, padded so the stored text lands exactly on / just over the bound.
  const baseBytes = Number((await db.one("SELECT octet_length((report_document || jsonb_build_object('proofPadding', ''))::text) n FROM public.financial_statement_reports WHERE report_id=$1 ORDER BY report_version DESC LIMIT 1", [rid])).n);
  const padTo = (target) => `report_document || jsonb_build_object('proofPadding', repeat('p', ${target - baseBytes}))`;
  await check("a version whose document is exactly at the bound is accepted", async () => {
    await copyVersion(2, synthIds.slice(0, 1), padTo(BOUNDS.reportDocumentBytes));
    const n = Number((await db.one("SELECT octet_length(report_document::text) n FROM public.financial_statement_reports WHERE report_id=$1 AND report_version=2", [synth])).n);
    return n === BOUNDS.reportDocumentBytes ? true : n;
  });
  await refused("a version whose document is over the bound is refused REPORT_DOCUMENT_SIZE_LIMIT", "22023", () => copyVersion(3, synthIds.slice(0, 1), padTo(BOUNDS.reportDocumentBytes + 64)), "REPORT_DOCUMENT_SIZE_LIMIT");
  await check("nothing was stored", async () => ((await latest(synth)) === 2 ? true : await latest(synth)));

  // ── B5 on the real lineage: brought to 999 versions directly, then the client saves the 1,000th and is refused the 1,001st ─
  group("B5  versions per lineage: the 1,000th save is accepted, the 1,001st refused by name with nothing stored");
  const cur = await latest();
  // Filler rows carry a minimal document and no evidence: they bring the COUNT to the bound; the client's own save then
  // provides the real 1,000th version.
  await check(`the lineage is brought from ${cur} to 999 versions (minimal filler rows, written directly)`, async () => {
    await db.admin.query(`INSERT INTO public.financial_statement_reports (report_id, report_version, company_id, period_year, provenance_origin, report_document, content_hash, document_hash, evidence_batch_ids, created_by_firm_member_id)
      SELECT r.report_id, g.v, r.company_id, r.period_year, r.provenance_origin, jsonb_build_object('synthetic', true, 'version', g.v), r.content_hash, r.document_hash, '{}'::text[], r.created_by_firm_member_id
      FROM public.financial_statement_reports r CROSS JOIN generate_series($2::int, 999) g(v) WHERE r.report_id = $1 AND r.report_version = $3`, [rid, cur + 1, cur]);
    return (await latest()) === 999 ? true : await latest();
  });
  await check("the 1,000th version is saved through the client", async () => { await touch(1); const r = await save([]); return r.outcome === "saved" && (await latest()) === 1000 ? true : { r: r.outcome, reason: r.reason, v: await latest() }; });
  await refused("the 1,001st is refused VERSION_HISTORY_LIMIT", "22023", async () => { await touch(2); await save([]); }, "VERSION_HISTORY_LIMIT");
  await check("nothing was stored: the lineage ends at 1,000", async () => ((await latest()) === 1000 ? true : await latest()));

  // ── B6/B7 on the real lineage's version 1,000 ──────────────────────────────────────────────────────────────────────────
  group("B6  comments per version: the 500th is recorded, the 501st refused by name");
  const v = await latest();
  const item = "fact:current:current_liabilities:sfp.trade_and_other_payables";
  const open = (sev, body) => asU(U.partner, "SELECT public.fs_review_comment_open($1,$2,$3,'fact',$4,$5,$6,$7) r", [A, rid, v, item, sev, body, uuid()]);
  let c1;
  await check("the first comment is recorded through the client function; 498 more are written directly", async () => {
    c1 = (await open("advisory", "First.")).r;
    if (c1?.outcome !== "recorded") return c1;
    await db.admin.query(`INSERT INTO public.fs_review_comments (company_id, report_id, report_version, item_kind, item_id, severity, body, opened_content, author_user_id, firm_member_id, request_id)
      SELECT company_id, report_id, report_version, item_kind, item_id, severity, 'Copy ' || g.i, opened_content, author_user_id, firm_member_id, gen_random_uuid()
      FROM public.fs_review_comments c CROSS JOIN generate_series(1, 498) g(i) WHERE c.id = $1`, [c1.commentId]);
    return (await db.count("SELECT count(*) n FROM public.fs_review_comments WHERE report_id=$1 AND report_version=$2", [rid, v])) === 499 ? true : "count differs";
  });
  await check("the 500th comment is recorded", async () => { const r = (await open("advisory", "Five hundredth.")).r; return r?.outcome === "recorded" ? true : r; });
  await refused("the 501st is refused REVIEW_COMMENTS_LIMIT", "22023", () => open("advisory", "Five hundred and first."), "REVIEW_COMMENTS_LIMIT");
  await check("exactly 500 comments exist on the version", async () => ((await db.count("SELECT count(*) n FROM public.fs_review_comments WHERE report_id=$1 AND report_version=$2", [rid, v])) === 500 ? true : "count differs"));

  group("B7  events per comment: the 200th is recorded, the 201st refused by name");
  await check("the first comment has its opening event; 198 more are written directly", async () => {
    await db.admin.query(`INSERT INTO public.fs_review_comment_events (comment_id, company_id, action, body, report_version, content_at, actor_user_id, firm_member_id, request_id)
      SELECT comment_id, company_id, 'responded', 'Copy ' || g.i, report_version, content_at, actor_user_id, firm_member_id, gen_random_uuid()
      FROM public.fs_review_comment_events e CROSS JOIN generate_series(1, 198) g(i) WHERE e.comment_id = $1 AND e.action = 'opened'`, [c1.commentId]);
    return (await db.count("SELECT count(*) n FROM public.fs_review_comment_events WHERE comment_id=$1", [c1.commentId])) === 199 ? true : "count differs";
  });
  await check("the 200th event (a response through the client function) is recorded", async () => { const r = (await asU(U.preparer, "SELECT public.fs_review_comment_respond($1,$2,'Looked at it.',$3) r", [A, c1.commentId, uuid()])).r; return r?.outcome === "recorded" ? true : r; });
  await refused("the 201st (the resolution) is refused REVIEW_COMMENT_EVENTS_LIMIT", "22023", () => asU(U.partner, "SELECT public.fs_review_comment_resolve($1,$2,'Fine.',$3) r", [A, c1.commentId, uuid()]), "REVIEW_COMMENT_EVENTS_LIMIT");
  await check("exactly 200 events exist on the comment", async () => ((await db.count("SELECT count(*) n FROM public.fs_review_comment_events WHERE comment_id=$1", [c1.commentId])) === 200 ? true : "count differs"));

}

let crashed = false;
try { await main(); } catch (e) { crashed = true; console.error(`\nINFRASTRUCTURE FAILURE: ${e?.stack ?? e}`); }
const ok = finish("WORK_BOUNDS", crashed);
process.on("uncaughtException", (e) => { if (/Connection terminated unexpectedly/.test(String(e?.message))) return; console.error(`shutdown error: ${e?.stack ?? e}`); process.exit(1); });
await db?.close();
process.exit(ok ? 0 : 1);
