// NON-PRODUCTION HARNESS. An in-browser stand-in for the Supabase client behind the REAL Prepare page.
//
// It implements exactly what that page touches: the query builder over in-memory tables, the RPCs (access, upload
// reservation/registration, certification, account review), the signed upload, and the two functions. Its
// process-trial-balance runs the REAL ingestion core (supabase/functions/_shared/tbSource.ts + tbIngestion.ts) on the
// bytes the browser uploaded, with SheetJS 0.18.5 — the same code the edge function runs. Classification is a
// deliberately simple stand-in (this company's saved mapping by code is "reviewed"; anything else is a suggestion that
// needs review), mirroring the server's review policy, not its full classifier.
//
// Failure injection (window.__tb.inject) lets the browser test drive the uploader's retry and recovery paths.
import * as XLSX from "xlsx";
import { readTrialBalanceSource, type XlsxLike } from "../../supabase/functions/_shared/tbSource";
import { MilestoneLog, formatMinor, markIngestionMilestones, type IngestResult } from "../../supabase/functions/_shared/tbIngestion";
import { HARNESS_USER } from "./syntheticAuth";

type Row = Record<string, unknown>;
type Answer = { data: unknown; error: { code?: string; message: string } | null };

export const COMPANY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const PERIOD = "pppppppp-pppp-4ppp-8ppp-pppppppppppp".replace(/p/g, "1");
export const ENGAGEMENT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

export type Injection = "drop_before" | "drop_after" | "server_error" | "in_progress" | "upload_fails" | null;

export const tb = {
  tables: {
    companies: [{ id: COMPANY, name: "Synthetic Trading Co", code: null, tin: null, reporting_framework: "full_ifrs", fiscal_year_end: "2025-12-31", currency: "TZS", created_at: "2026-01-01T00:00:00Z", filing_jurisdiction: null, user_id: HARNESS_USER.id, is_active: true }],
    fiscal_periods: [{ id: PERIOD, company_id: COMPANY, reporting_currency: "TZS" }],
    trial_balance_uploads: [] as Row[],
    tb_certifications: [] as Row[],
    safisha_reconciliations: [] as Row[],
    safisha_exceptions: [] as Row[],
    account_mappings: [] as Row[],
    hesabu_validations: [] as Row[],
    statement_sign_offs: [] as Row[],
    filing_obligations: [] as Row[],
    audit_logs: [] as Row[],
  } as Record<string, Row[]>,
  blobs: {} as Record<string, Uint8Array>,
  /** Who the page reads as: the owner, or a Prepare-only grant holder (reconciliation rows are not visible to them). */
  viewer: "owner" as "owner" | "prepare_only",
  inject: null as Injection,
  /** Every process-trial-balance request and what happened to it. */
  checks: [] as { clientRequestId: string; outcome: string }[],
  runs: 0,
  requests: {} as Record<string, { uploadId: string; status: "reserved" | "completed" }>,
  currency: "TZS",
};
(window as unknown as { __tb: typeof tb }).__tb = tb;

let seq = 1;
const id = (prefix: string) => `${prefix}-${String(seq++).padStart(4, "0")}-0000-4000-8000-000000000000`.slice(0, 36);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T,>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

// ── Query builder ────────────────────────────────────────────────────────────────────────────────────────────────────

class Query implements PromiseLike<Answer> {
  private filters: ((r: Row) => boolean)[] = [];
  private mode: "select" | "insert" | "update" | "remove" = "select";
  private payload: Row | Row[] | null = null;
  private card: "many" | "single" | "maybe" = "many";
  private desc: string | null = null;
  private max: number | null = null;
  constructor(private readonly table: string) {}
  select() { return this; }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this; }
  is(c: string, v: unknown) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  not(c: string, op: string, v: unknown) { this.filters.push((r) => !(op === "is" ? (r[c] ?? null) === v : r[c] === v)); return this; }
  or() { return this; }
  order(c: string, o?: { ascending?: boolean }) { if (o?.ascending === false) this.desc = c; return this; }
  limit(n: number) { this.max = n; return this; }
  single() { this.card = "single"; return this; }
  maybeSingle() { this.card = "maybe"; return this; }
  insert(p: Row | Row[]) { this.mode = "insert"; this.payload = p; return this; }
  update(p: Row) { this.mode = "update"; this.payload = p; return this; }
  delete() { this.mode = "remove"; return this; }
  private run(): Answer {
    const rows = (tb.tables[this.table] ??= []);
    if (this.mode === "insert") {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload as Row];
      for (const p of list) rows.push({ id: id(this.table.slice(0, 4)), ...p });
      return { data: null, error: null };
    }
    let hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.mode === "update") { for (const r of hit) Object.assign(r, this.payload); return { data: clone(hit), error: null }; }
    if (this.mode === "remove") { tb.tables[this.table] = rows.filter((r) => !hit.includes(r)); return { data: null, error: null }; }
    // Reconciliation rows are firm-member visible only (row-level access): a Prepare-only viewer reads none.
    if (tb.viewer === "prepare_only" && (this.table === "safisha_reconciliations" || this.table === "safisha_exceptions")) hit = [];
    if (this.desc) { const k = this.desc; hit = [...hit].sort((a, b) => (String(a[k]) < String(b[k]) ? 1 : -1)); }
    if (this.max !== null) hit = hit.slice(0, this.max);
    const out = clone(hit);
    if (this.card === "single") return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { code: "PGRST116", message: "not one row" } };
    if (this.card === "maybe") return { data: out[0] ?? null, error: null };
    return { data: out, error: null };
  }
  then<A = Answer, B = never>(ok?: ((v: Answer) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return wait(30).then(() => this.run()).then(ok, bad);
  }
}

// ── The synthetic process-trial-balance (REAL ingestion core) ───────────────────────────────────────────────────────

const SUGGEST: [RegExp, string, string][] = [
  [/cash|bank/i, "current_assets", "balance_sheet"], [/receivable|debtor/i, "current_assets", "balance_sheet"],
  [/payable|creditor|accru/i, "current_liabilities", "balance_sheet"], [/capital|retained|equity/i, "equity", "balance_sheet"],
  [/sales|revenue|income/i, "revenue", "income_statement"], [/equipment|vehicle|furniture/i, "non_current_assets", "balance_sheet"],
];

function ingestionRecord(ingest: IngestResult, log: MilestoneLog): Row {
  const e = ingest.exponent ?? 0;
  return {
    version: ingest.version, currency: ingest.currency, currency_exponent: ingest.exponent, period_year: ingest.periodYear, sheet: ingest.sheetName,
    columns: ingest.columns,
    totals: ingest.totals ? { debit: formatMinor(ingest.totals.debitMinor, e), credit: formatMinor(ingest.totals.creditMinor, e), difference: formatMinor(ingest.totals.differenceMinor, e) } : null,
    lineage_summary: ingest.lineageSummary, lineage: ingest.lineage.map((l) => [l.rowNumber, l.disposition, l.identity ?? l.reason ?? null]),
    issues: ingest.issues, milestones: log.list(),
  };
}

async function runCheck(uploadId: string): Promise<string> {
  tb.runs++;
  const upload = tb.tables.trial_balance_uploads.find((u) => u.id === uploadId)!;
  upload.status = "validating";
  await wait(1200); // a check takes a moment
  const bytes = tb.blobs[String(upload.file_path)];
  const ingest = readTrialBalanceSource(bytes, { fileName: String(upload.file_name), periodYear: 2025, currency: tb.currency }, XLSX as unknown as XlsxLike);
  const log = new MilestoneLog();
  markIngestionMilestones(log, ingest);
  const e = ingest.exponent ?? 0;
  const issues = ingest.issues.filter((i) => i.severity === "blocking");
  const exact = ingest.totals ? { currency: ingest.currency, currency_exponent: ingest.exponent, total_debits: formatMinor(ingest.totals.debitMinor, e), total_credits: formatMinor(ingest.totals.creditMinor, e), difference: formatMinor(ingest.totals.differenceMinor < 0n ? -ingest.totals.differenceMinor : ingest.totals.differenceMinor, e) } : null;
  const tbCheck = exact ? { passed: ingest.totals!.differenceMinor === 0n, total_debits: Number(exact.total_debits), total_credits: Number(exact.total_credits), difference: Number(exact.difference), exact } : null;
  const cert = (is_blocking: boolean, requires_review: boolean, exceptions: Row[]) => tb.tables.tb_certifications.push({
    id: id("cert"), sequence_no: tb.tables.tb_certifications.length + 1, company_id: COMPANY, upload_id: uploadId, period_year: 2025,
    is_blocking, requires_review, certified_at: new Date().toISOString(),
    exceptions: [...exceptions, { code: "L5_SUPPORTING_EVIDENCE", layer: 5, severity: "info", accountCode: null, message: "NOT_EVALUATED: no supporting-evidence reconciliation has been run for this upload" }, { code: "L6_PRIOR_PERIOD_SIGNAL", layer: 6, severity: "info", accountCode: null, message: "NO_PRIOR: no authoritative certification exists for period 2024" }],
  });

  if (issues.length > 0) {
    log.mark("recorded", "passed");
    const imbalance = issues.some((i) => i.code === "TRIAL_BALANCE_IMBALANCE");
    Object.assign(upload, {
      status: "blocked", is_valid: false, accounting_errors: issues.map((i) => ({ code: i.code, message: i.message, rows: i.rows })),
      processing_result: { status: "blocked", errors: issues, validation_report: { tb_balance_check: imbalance ? tbCheck : null }, ingestion: ingestionRecord(ingest, log) },
      processed_at: new Date().toISOString(),
    });
    if (ingest.accounts.length > 0) cert(true, false, issues.map((i) => ({ code: i.code, layer: i.code === "TRIAL_BALANCE_IMBALANCE" ? 3 : 2, severity: "error", accountCode: null, message: i.message })));
    return "blocked";
  }
  const mapped = new Set(tb.tables.account_mappings.map((m) => String(m.account_code)));
  const review = new Map<string, Row>();
  for (const a of ingest.accounts) {
    if (mapped.has(a.accountCode)) continue;
    const hit = SUGGEST.find(([re]) => re.test(a.accountName));
    const prev = review.get(a.accountCode);
    const debit = Number(a.debitMinor) / 10 ** e, credit = Number(a.creditMinor) / 10 ** e;
    if (prev) { prev.debit = Number(prev.debit) + debit; prev.credit = Number(prev.credit) + credit; prev.balance = Number(prev.debit) - Number(prev.credit); continue; }
    review.set(a.accountCode, {
      account_code: a.accountCode, account_name: a.accountName, debit, credit, balance: debit - credit,
      suggested_classification: hit?.[1] ?? "operating_expenses", suggested_statement: hit?.[2] ?? "income_statement",
      confidence_source: "rule", reason: `Suggested from the account name — confirm before the trial balance is accepted.`,
    });
  }
  const mapping_completeness = { passed: review.size === 0, total_accounts: ingest.accounts.length, mapped_accounts: ingest.accounts.length - review.size, needs_review: review.size };
  log.mark("classification", review.size ? "needs_review" : "passed", review.size ? `${review.size} of ${ingest.accounts.length} accounts need a reviewer's confirmation` : `${ingest.accounts.length} accounts on reviewed mappings`);
  log.mark("recorded", "passed");
  const base = { validation_report: { tb_balance_check: tbCheck, mapping_completeness }, summary: { total_accounts: ingest.accounts.length, parser_version: ingest.version }, ingestion: ingestionRecord(ingest, log) };
  if (review.size > 0) {
    Object.assign(upload, { status: "needs_review", is_valid: false, accounting_errors: [], processing_result: { status: "needs_review", needs_review_accounts: [...review.values()], ...base }, processed_at: new Date().toISOString() });
    cert(false, true, [...review.values()].map((r) => ({ code: "NEEDS_REVIEW", layer: 4, severity: "warning", accountCode: r.account_code, message: r.reason })));
    return "needs_review";
  }
  Object.assign(upload, { status: "complete", is_valid: true, accounting_errors: [], validation_report: base.validation_report, processing_result: { status: "valid", ...base }, processed_at: new Date().toISOString(), lifecycle_state: "active_processed" });
  cert(false, false, []);
  return "complete";
}

const networkError = () => ({ data: null, error: Object.assign(new Error("Failed to send a request to the Edge Function"), { name: "FunctionsFetchError", context: undefined }) });
const httpError = (status: number, body: Row) => ({ data: null, error: Object.assign(new Error(`Edge Function returned ${status}`), { name: "FunctionsHttpError", context: { status, json: async () => body } }) });

async function processTrialBalance(body: { uploadId: string; clientRequestId: string }): Promise<Answer> {
  const inject = tb.inject;
  tb.inject = null;
  const known = tb.requests[body.clientRequestId];
  if (known?.status === "completed") { tb.checks.push({ clientRequestId: body.clientRequestId, outcome: "replay" }); return { data: { status: "completed", replay: true }, error: null }; }
  if (known?.status === "reserved") { tb.checks.push({ clientRequestId: body.clientRequestId, outcome: "in_progress" }); return httpError(409, { status: "in_progress", message: "This upload is already being checked." }) as never; }
  if (inject === "drop_before") { await wait(400); tb.checks.push({ clientRequestId: body.clientRequestId, outcome: "network_error_before_run" }); return networkError() as never; }
  if (inject === "server_error") { await wait(400); tb.checks.push({ clientRequestId: body.clientRequestId, outcome: "500" }); return httpError(503, { status: "blocked", error: "Processing failed" }) as never; }
  tb.requests[body.clientRequestId] = { uploadId: body.uploadId, status: "reserved" };
  if (inject === "in_progress") {
    // Another request is already running this check: answer 409 now and finish it in the background.
    void runCheck(body.uploadId).then(() => { tb.requests[body.clientRequestId].status = "completed"; });
    tb.checks.push({ clientRequestId: body.clientRequestId, outcome: "409_in_progress" });
    return httpError(409, { status: "in_progress", message: "This upload is already being checked." }) as never;
  }
  const outcome = await runCheck(body.uploadId);
  tb.requests[body.clientRequestId].status = "completed";
  if (inject === "drop_after") { tb.checks.push({ clientRequestId: body.clientRequestId, outcome: `ran(${outcome})_then_network_error` }); return networkError() as never; }
  tb.checks.push({ clientRequestId: body.clientRequestId, outcome });
  return { data: { status: outcome }, error: null };
}

// ── The client ───────────────────────────────────────────────────────────────────────────────────────────────────────

const rpcs: Record<string, (a: Row) => Answer | Promise<Answer>> = {
  get_workspace_access: () => ({ data: [{ company_id: COMPANY, access: tb.viewer === "owner" ? "owner" : "capability", capabilities: tb.viewer === "owner" ? ["prepare_trial_balance", "review_close", "manage_source_files", "reconcile"] : ["prepare_trial_balance", "manage_source_files"], stages: tb.viewer === "owner" ? ["prepare", "reconcile"] : ["prepare"], name: "Synthetic Trading Co", fiscal_year_end: "2025-12-31", reporting_framework: "full_ifrs", currency: "TZS", created_at: "2026-01-01T00:00:00Z" }], error: null }),
  list_shared_workspaces: () => ({ data: [], error: null }),
  get_my_workspace_capabilities: () => ({ data: { access: true, capabilities: ["prepare_trial_balance", "review_close", "manage_source_files"], allowed: ["prepare_trial_balance", "review_close", "manage_source_files"], has_current_plan: true, manage_billing: true }, error: null }),
  get_trial_balance_removal_eligibility: () => ({ data: [{ eligible: false, reason: "harness" }], error: null }),
  reserve_trial_balance_source: (a) => {
    const reservation = id("resv");
    return { data: [{ outcome: "reserved", reservation_id: reservation, object_path: `workspaces/${COMPANY}/${reservation}/${String(a.p_file_name)}` }], error: null };
  },
  register_trial_balance_upload: (a) => {
    const path = Object.keys(tb.blobs).find((p) => p.includes(String(a.p_reservation_id)));
    if (!path) return { data: [{ outcome: "object_missing", upload_id: null, detail: "The uploaded file was not found." }], error: null };
    const existing = tb.tables.trial_balance_uploads.find((u) => u.reservation_id === a.p_reservation_id);
    if (existing) return { data: [{ outcome: "already_registered", upload_id: existing.id, detail: null }], error: null };
    const uploadId = id("upld");
    tb.tables.trial_balance_uploads.unshift({
      id: uploadId, reservation_id: a.p_reservation_id, file_name: path.split("/").pop(), file_path: path, file_size: a.p_file_size, status: "processing",
      company_id: COMPANY, company_name: "Synthetic Trading Co", period_year: 2025, period_id: a.p_period_id, engagement_id: a.p_engagement_id,
      uploaded_at: new Date().toISOString(), processed_at: null, is_valid: null, validation_report: null, accounting_errors: null, processing_result: null,
      safisha_status: null, lifecycle_state: "active_unprocessed", version: 1, user_id: HARNESS_USER.id,
    });
    return { data: [{ outcome: "registered", upload_id: uploadId, detail: null }], error: null };
  },
  get_authoritative_certification: (a) => {
    const rows = tb.tables.tb_certifications.filter((c) => c.company_id === a.p_company_id && c.period_year === a.p_period_year && !c.is_blocking && !c.requires_review);
    return { data: rows.length ? [clone(rows[rows.length - 1])] : [], error: null };
  },
  resolve_account_review_batch: (a) => {
    for (const d of a.p_decisions as Row[]) {
      if (!tb.tables.account_mappings.some((m) => m.account_code === d.account_code)) {
        tb.tables.account_mappings.push({ company_id: COMPANY, account_code: d.account_code, classification: d.classification, statement: d.statement });
      }
    }
    return { data: { ok: true }, error: null };
  },
};

export const supabase = {
  from: (table: string) => new Query(table),
  async rpc(name: string, args: Row = {}): Promise<Answer> {
    await wait(40);
    const h = rpcs[name];
    return h ? await h(args) : { data: null, error: { code: "42883", message: `synthetic backend has no ${name}` } };
  },
  functions: {
    async invoke(name: string, opts: { body: Row }): Promise<Answer> {
      if (name === "trial-balance-source-signer") {
        const reservation = String(opts.body.reservation_id);
        return { data: { outcome: "signed", path: `workspaces/${COMPANY}/${reservation}/__pending__`, token: reservation }, error: null };
      }
      if (name === "process-trial-balance") return processTrialBalance(opts.body as { uploadId: string; clientRequestId: string });
      return { data: null, error: { message: `synthetic backend has no function ${name}` } };
    },
  },
  storage: {
    from: (_bucket: string) => ({
      async uploadToSignedUrl(path: string, token: string, file: File) {
        await wait(500);
        if (tb.inject === "upload_fails") { tb.inject = null; return { data: null, error: { message: "network" } }; }
        tb.blobs[path.replace("__pending__", file.name) || `${token}/${file.name}`] = new Uint8Array(await file.arrayBuffer());
        return { data: { path }, error: null };
      },
    }),
  },
  auth: {
    getSession: async () => ({ data: { session: { access_token: "synthetic", expires_at: Math.floor(Date.now() / 1000) + 3600, user: HARNESS_USER } }, error: null }),
    getUser: async () => ({ data: { user: HARNESS_USER }, error: null }),
    refreshSession: async () => ({ data: { session: { access_token: "synthetic" } }, error: null }),
    signOut: async () => ({ error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => undefined } } }),
  },
  channel: () => { const ch = { on: () => ch, subscribe: () => ch }; return ch; },
  removeChannel: () => undefined,
};
