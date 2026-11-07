/**
 * Ready for Reporting V3 — sandbox proof checker (contract C5), rfr-acceptance/2.
 *
 * What changed (audit defect D3): the earlier checker compared two operator-supplied CSV files and reported PASS, so a
 * header-only file given twice with dummy metadata passed. This version separates three things that were conflated:
 *
 *   EXPORT_PARITY   two files agree. Proves only that they agree. Never reported as a sandbox proof.
 *   KNOWN_POSTINGS  the connector output equals what the postings seeded into the sandbox company imply.
 *   RECORDED_RUN    a run of the connector against that company was recorded (ids, times, response hash) and the file
 *                   judged is the response that run recorded.
 *
 * LIVE_SANDBOX_PROOF is reported only when all three hold. Without access the honest status is NOT_RUN.
 *
 * Statuses and exit codes (run.mjs): PASS 0 · FAIL 1 · REFUSED 2 (invalid, empty, duplicated, unattributed or
 * non-independent input; nothing was judged) · NOT_RUN 3 (no recorded run because access is unavailable; stated).
 *
 * Limit that no file check can remove: the checker cannot see QuickBooks. It refuses every shortcut it can detect and
 * records what the operator attests; the request ids in the recorded run exist so the run can be audited at Intuit.
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve, isAbsolute } from "node:path";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const INT = /^-?\d+$/;
const NONNEG = /^\d+$/;
const TIE_COLUMNS = ["account_id", "currency", "opening_minor", "debit_minor", "credit_minor", "closing_minor", "entry_count"];
const POSTING_COLUMNS = ["txn_ref", "line", "date", "account_id", "currency", "debit_minor", "credit_minor"];

export class Refusal extends Error {}
const refuse = (m) => { throw new Refusal(m); };

/** Strict RFC 4180 reader: quoted fields, doubled quotes, CRLF or LF. Refuses ragged rows, blank lines and stray quotes. */
export function parseCsv(text, what) {
  const rows = [];
  let row = [], field = "", i = 0, inQ = false, sawAny = false;
  const endRow = () => { row.push(field); field = ""; rows.push(row); row = []; };
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { if (field !== "") refuse(`${what}: stray quote`); inQ = true; sawAny = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    if (c === "\n") { endRow(); i++; continue; }
    field += c; i++;
  }
  if (inQ) refuse(`${what}: unterminated quote`);
  if (field !== "" || row.length) endRow();
  void sawAny;
  if (!rows.length) refuse(`${what}: empty file`);
  const width = rows[0].length;
  rows.forEach((r, n) => { if (r.length === 1 && r[0] === "") refuse(`${what}: blank line ${n + 1}`); if (r.length !== width) refuse(`${what}: line ${n + 1} has ${r.length} fields, header has ${width}`); });
  return rows;
}

function readTable(path, columns, what) {
  const rows = parseCsv(readFileSync(path, "utf8"), what);
  const head = rows[0];
  for (const c of columns) if (!head.includes(c)) refuse(`${what}: missing column ${c}`);
  if (new Set(head).size !== head.length) refuse(`${what}: duplicate column name`);
  const body = rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
  if (!body.length) refuse(`${what}: no data rows (a header-only file is not evidence)`);
  return body;
}

function readTie(path, what) {
  const body = readTable(path, TIE_COLUMNS, what);
  const map = new Map();
  for (const r of body) {
    if (!r.account_id) refuse(`${what}: empty account_id`);
    if (map.has(r.account_id)) refuse(`${what}: duplicate account ${r.account_id}`);
    if (!/^[A-Z]{3}$/.test(r.currency)) refuse(`${what}: account ${r.account_id}: currency must be three capital letters`);
    for (const f of ["opening_minor", "closing_minor"]) if (!INT.test(r[f])) refuse(`${what}: account ${r.account_id}: ${f} is not an integer`);
    for (const f of ["debit_minor", "credit_minor", "entry_count"]) if (!NONNEG.test(r[f])) refuse(`${what}: account ${r.account_id}: ${f} is not a non-negative integer`);
    map.set(r.account_id, r);
  }
  return map;
}

function readPostings(path, what) {
  const body = readTable(path, POSTING_COLUMNS, what);
  const seen = new Set();
  for (const r of body) {
    const key = `${r.txn_ref}#${r.line}`;
    if (!r.txn_ref || !NONNEG.test(r.line)) refuse(`${what}: posting needs txn_ref and a numeric line`);
    if (seen.has(key)) refuse(`${what}: duplicate posting ${key}`);
    seen.add(key);
    if (!ISO_DATE.test(r.date)) refuse(`${what}: posting ${key}: bad date`);
    if (!NONNEG.test(r.debit_minor) || !NONNEG.test(r.credit_minor)) refuse(`${what}: posting ${key}: debit/credit must be non-negative integers`);
    if ((BigInt(r.debit_minor) > 0n) === (BigInt(r.credit_minor) > 0n)) refuse(`${what}: posting ${key}: exactly one of debit and credit must be non-zero`);
  }
  return body;
}

/** Expected per-account result implied by the seeded postings: those dated before the period are the opening, the rest are the movements. */
export function impliedFromPostings(postings, periodStart, periodEnd) {
  const out = new Map();
  for (const p of postings) {
    if (p.date > periodEnd) continue;
    const a = out.get(p.account_id) ?? { currency: p.currency, opening: 0n, debit: 0n, credit: 0n, entries: 0 };
    if (a.currency !== p.currency) refuse(`known postings: account ${p.account_id} mixes currencies`);
    const d = BigInt(p.debit_minor), c = BigInt(p.credit_minor);
    if (p.date < periodStart) a.opening += d - c; else { a.debit += d; a.credit += c; a.entries += 1; }
    out.set(p.account_id, a);
  }
  return out;
}

function validateMetadata(m) {
  if (m.environment !== "sandbox") refuse('metadata: environment must be exactly "sandbox"');
  if (!HEX64.test(m.realm_sha256 ?? "")) refuse("metadata: realm_sha256 must be a 64-hex SHA-256 of the sandbox realm id");
  if (!ISO_DATE.test(m.period_start ?? "") || !ISO_DATE.test(m.period_end ?? "")) refuse("metadata: period_start and period_end must be ISO dates");
  if (m.period_start > m.period_end) refuse("metadata: period_start is after period_end");
  if (!["Accrual", "Cash"].includes(m.accounting_method)) refuse('metadata: accounting_method must be "Accrual" or "Cash"');
  if (typeof m.operator !== "string" || m.operator.trim().length < 2) refuse("metadata: operator (the person who ran this) is required");
  if (!ISO_TS.test(m.pulled_at ?? "")) refuse("metadata: pulled_at must be an ISO UTC timestamp");
  const at = Date.parse(m.pulled_at);
  if (at > Date.now() + 60_000) refuse("metadata: pulled_at is in the future");
  if (at < Date.parse("2020-01-01T00:00:00Z")) refuse("metadata: pulled_at is implausibly old");
}

function validateIndependent(ip, independentSha) {
  if (!ip || typeof ip !== "object") refuse("independent provenance is missing: the comparison export must be produced in QuickBooks itself by a person, and say so");
  if (ip.method !== "quickbooks_ui_export") refuse('independent_provenance.method must be "quickbooks_ui_export"');
  if (typeof ip.produced_by !== "string" || ip.produced_by.trim().length < 2) refuse("independent_provenance.produced_by is required");
  if (!ISO_TS.test(ip.produced_at ?? "")) refuse("independent_provenance.produced_at must be an ISO UTC timestamp");
  if (typeof ip.report_name !== "string" || !ip.report_name.trim()) refuse("independent_provenance.report_name is required");
  if (ip.file_sha256 !== independentSha) refuse("independent_provenance.file_sha256 does not match the independent export file");
}

function validateRun(run, m, connectorSha, base) {
  if (!run || typeof run !== "object") return null;
  if (typeof run.run_id !== "string" || !run.run_id) refuse("recorded_run.run_id is required");
  if (!ISO_TS.test(run.started_at ?? "") || !ISO_TS.test(run.finished_at ?? "")) refuse("recorded_run.started_at/finished_at must be ISO UTC timestamps");
  if (run.started_at > run.finished_at) refuse("recorded_run finished before it started");
  if (run.realm_sha256 !== m.realm_sha256) refuse("recorded_run.realm_sha256 differs from the manifest's");
  if (run.endpoint !== "GeneralLedger") refuse('recorded_run.endpoint must be "GeneralLedger"');
  if (run.http_status !== 200) refuse("recorded_run.http_status must be 200");
  if (!Array.isArray(run.intuit_tids) || !run.intuit_tids.length || run.intuit_tids.some((x) => typeof x !== "string" || !x)) refuse("recorded_run.intuit_tids (Intuit's request ids, for audit) are required");
  if (run.output_sha256 !== connectorSha) refuse("recorded_run.output_sha256 is not the connector file being judged");
  if (!run.raw_response_file) refuse("recorded_run.raw_response_file is required");
  const rawPath = isAbsolute(run.raw_response_file) ? run.raw_response_file : resolve(base, run.raw_response_file);
  if (!existsSync(rawPath)) refuse("recorded_run.raw_response_file does not exist");
  if (sha256(readFileSync(rawPath)) !== run.raw_response_sha256) refuse("recorded_run.raw_response_sha256 does not match the raw response file");
  if (!(Date.parse(run.finished_at) <= Date.parse(m.pulled_at) + 1000)) refuse("recorded_run finished after the manifest's pulled_at");
  return run;
}

/**
 * @returns {{ status: "PASS"|"FAIL"|"REFUSED"|"NOT_RUN", category: string, rows: {id:string,status:string,errors:string[]}[], reason?: string, files?: object }}
 */
export function checkSandbox(manifestPath) {
  let m;
  try { m = JSON.parse(readFileSync(manifestPath, "utf8")); } catch (e) { return { status: "REFUSED", category: "NONE", rows: [], reason: `manifest unreadable: ${e.message}` }; }
  const base = dirname(resolve(manifestPath));
  const abs = (f) => (isAbsolute(f) ? f : resolve(base, f));
  try {
    validateMetadata(m);
    for (const k of ["connector_file", "independent_export_file", "known_postings_file"]) if (!m[k] || typeof m[k] !== "string") refuse(`${k} is required`);
    for (const k of ["connector_file", "independent_export_file", "known_postings_file"]) if (!existsSync(abs(m[k]))) refuse(`${k} does not exist`);
    const connBytes = readFileSync(abs(m.connector_file)), indepBytes = readFileSync(abs(m.independent_export_file));
    const connectorSha = sha256(connBytes), independentSha = sha256(indepBytes);
    if (connectorSha === independentSha) refuse("the connector output and the independent export are the same bytes: that is one file, not two sources");
    validateIndependent(m.independent_provenance, independentSha);
    const connector = readTie(abs(m.connector_file), "connector output");
    const independent = readTie(abs(m.independent_export_file), "independent export");
    const postings = readPostings(abs(m.known_postings_file), "known postings");
    const rows = [];

    // EXPORT_PARITY: the two sources agree, account by account.
    const parity = [];
    for (const k of new Set([...connector.keys(), ...independent.keys()])) {
      const x = connector.get(k), y = independent.get(k);
      if (!x || !y) { parity.push(`account ${k} only in ${x ? "connector output" : "independent export"}`); continue; }
      for (const f of TIE_COLUMNS.slice(1)) if (x[f] !== y[f]) parity.push(`account ${k} ${f}: connector ${x[f]} vs export ${y[f]}`);
    }
    for (const [who, mp] of [["connector", connector], ["independent", independent]]) for (const [k, r] of mp) if (BigInt(r.opening_minor) + BigInt(r.debit_minor) - BigInt(r.credit_minor) !== BigInt(r.closing_minor)) parity.push(`${who} account ${k}: opening + debits - credits does not reproduce closing`);
    rows.push({ id: "C5-parity", status: "run", errors: parity });

    // KNOWN_POSTINGS: the connector reproduces what was actually seeded.
    const implied = impliedFromPostings(postings, m.period_start, m.period_end);
    const known = [];
    for (const k of new Set([...implied.keys(), ...connector.keys()])) {
      const w = implied.get(k), x = connector.get(k);
      if (!w || !x) { known.push(`account ${k} ${w ? "was seeded but is absent from the connector output" : "is in the connector output but was never seeded"}`); continue; }
      const got = { currency: x.currency, opening_minor: x.opening_minor, debit_minor: x.debit_minor, credit_minor: x.credit_minor, entry_count: x.entry_count };
      const want = { currency: w.currency, opening_minor: w.opening.toString(), debit_minor: w.debit.toString(), credit_minor: w.credit.toString(), entry_count: String(w.entries) };
      for (const f of Object.keys(want)) if (got[f] !== want[f]) known.push(`account ${k} ${f}: connector ${got[f]} vs seeded postings ${want[f]}`);
    }
    rows.push({ id: "C5-known-postings", status: "run", errors: known });

    // RECORDED_RUN
    const files = { connector: connectorSha, independent: independentSha, known_postings: sha256(readFileSync(abs(m.known_postings_file))) };
    let run = null;
    if (m.recorded_run) run = validateRun(m.recorded_run, m, connectorSha, base);
    else if (typeof m.access_unavailable_reason === "string" && m.access_unavailable_reason.trim().length >= 10) {
      rows.push({ id: "C5-recorded-run", status: "NOT_RUN", errors: [`NOT_RUN: ${m.access_unavailable_reason.trim()}`] });
    } else refuse("no recorded_run and no access_unavailable_reason: state either the recorded run or why none exists");
    if (run) rows.push({ id: "C5-recorded-run", status: "run", errors: [] });

    const failed = rows.some((r) => r.errors.length && r.status === "run");
    if (failed) return { status: "FAIL", category: run ? "LIVE_SANDBOX_PROOF" : "EXPORT_PARITY", rows, files };
    if (!run) return { status: "NOT_RUN", category: "EXPORT_PARITY", rows, files, reason: "No recorded sandbox run: only file consistency was checked. This is not a sandbox proof." };
    return { status: "PASS", category: "LIVE_SANDBOX_PROOF", rows, files };
  } catch (e) {
    if (e instanceof Refusal) return { status: "REFUSED", category: "NONE", rows: [], reason: e.message };
    throw e;
  }
}
