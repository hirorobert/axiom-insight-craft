// NON-PRODUCTION HARNESS. The trial-balance harness's in-browser backend (../trial-balance/syntheticBackend.ts), extended
// with what the account home's first upload touches: the currency registry, private drafts (reserve / sign / commit /
// cancel), create_entity and open_engagement_with_period. No network, no credentials, synthetic data only.
//
// The answers follow the shapes the client code parses (trialBalanceDraft.ts, entityCreation.ts, workspaceSetupClient.ts);
// they are NOT the server's logic. In particular the draft commit's "active trial balance exists" refusal and the
// replacement are modelled on the documented outcomes, not on the edge function itself.
import { COMPANY, ENGAGEMENT, PERIOD, supabase as base, tb } from "../trial-balance/syntheticBackend";
import { HARNESS_USER } from "../trial-balance/syntheticAuth";

type Row = Record<string, unknown>;
type Answer = { data: unknown; error: { code?: string; message: string } | null };

export const journey = {
  /** The next open_engagement_with_period answers with this refusal code (then clears). */
  refusePeriod: null as string | null,
  drafts: [] as Row[],
  calls: [] as string[],
};
(window as unknown as { __journey: typeof journey }).__journey = journey;

const CURRENCIES = [
  { code: "EUR", name: "Euro" }, { code: "GBP", name: "Pound sterling" }, { code: "KES", name: "Kenyan shilling" },
  { code: "TZS", name: "Tanzanian shilling" }, { code: "UGX", name: "Ugandan shilling" }, { code: "USD", name: "US dollar" },
  { code: "ZAR", name: "South African rand" },
];
const ACTIVE = new Set(["active_unprocessed", "active_processing", "active_processed", "blocked"]);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 100;
const uid = (p: string) => `${p}${String(n++).padStart(4, "0")}-0000-4000-8000-000000000000`.slice(0, 36);
const httpError = (status: number, body: Row): Answer => ({ data: null, error: Object.assign(new Error(`Edge Function returned ${status}`), { name: "FunctionsHttpError", context: { status, json: async () => body } }) as never });

const extraRpcs: Record<string, (a: Row) => Answer> = {
  reserve_trial_balance_draft: (a) => {
    const prior = journey.drafts.find((d) => d.key === a.p_idempotency_key);
    if (prior) return { data: [{ outcome: "replayed", draft_id: prior.draft_id, object_path: prior.object_path, expires_at: prior.expires_at }], error: null };
    const draftId = uid("drft");
    const d = { draft_id: draftId, key: a.p_idempotency_key, file_name: a.p_file_name, file_size: a.p_file_size, object_path: `drafts/${HARNESS_USER.id}/${draftId}`, expires_at: new Date(Date.now() + 864e5).toISOString(), state: "reserved", stored: false };
    journey.drafts.push(d);
    return { data: [{ outcome: "reserved", draft_id: draftId, object_path: d.object_path, expires_at: d.expires_at }], error: null };
  },
  list_trial_balance_drafts: () => ({ data: journey.drafts.map(({ draft_id, file_name, file_size, state, stored }) => ({ draft_id, file_name, file_size, state, stored })), error: null }),
  create_entity: (a) => {
    if (!tb.tables.companies.some((c) => c.id === COMPANY)) {
      tb.tables.companies.push({ id: COMPANY, name: a.p_name, code: null, tin: null, reporting_framework: null, fiscal_year_end: a.p_fiscal_year_end, currency: a.p_currency, created_at: new Date().toISOString(), filing_jurisdiction: null, user_id: HARNESS_USER.id, is_active: true });
      return { data: { outcome: "created", company_id: COMPANY }, error: null };
    }
    return { data: { outcome: "already_created", company_id: COMPANY }, error: null };
  },
  open_engagement_with_period: (a) => {
    if (journey.refusePeriod) { const code = journey.refusePeriod; journey.refusePeriod = null; return { data: { outcome: "refused", code }, error: null }; }
    const created = !tb.tables.fiscal_periods.some((p) => p.id === PERIOD);
    if (created) tb.tables.fiscal_periods.push({ id: PERIOD, company_id: a.p_company_id, reporting_currency: a.p_reporting_currency, reporting_start: a.p_period_start, reporting_end: a.p_period_end });
    tb.currency = String(a.p_reporting_currency);
    return { data: { outcome: "opened", engagementId: ENGAGEMENT, periodId: PERIOD, priorPeriodId: null, periodYear: Number(String(a.p_period_end).slice(0, 4)), created, granted: ["FINANCIAL_STATEMENTS"] }, error: null };
  },
};

function draftFunction(body: Row): Answer {
  const d = journey.drafts.find((x) => x.draft_id === body.draft_id);
  if (body.action === "sign") {
    if (!d) return httpError(404, { outcome: "not_found" });
    return d.stored ? { data: { outcome: "already_stored" }, error: null } : { data: { outcome: "signed", path: d.object_path, token: d.draft_id }, error: null };
  }
  if (body.action === "cancel") return { data: { outcome: "cancelled" }, error: null };
  if (body.action !== "commit" || !d) return httpError(404, { outcome: "not_found" });
  const year = Number(body.period_year);
  const active = tb.tables.trial_balance_uploads.find((u) => u.company_id === body.company_id && u.period_year === year && ACTIVE.has(String(u.lifecycle_state)));
  const commitId = uid("cmit");
  if (active && body.replaces_upload_id !== active.id) {
    return httpError(409, { outcome: "active_upload_exists", detail: "A trial balance is already active for this period.", commit_id: commitId });
  }
  const uploadId = uid("upld");
  const path = `workspaces/${COMPANY}/${uploadId}/${String(d.file_name)}`;
  tb.blobs[path] = tb.blobs[String(d.object_path)];
  if (active) active.lifecycle_state = "superseded";
  tb.tables.trial_balance_uploads.unshift({
    id: uploadId, file_name: d.file_name, file_path: path, file_size: d.file_size, status: "processing",
    company_id: body.company_id, company_name: tb.tables.companies[0]?.name ?? "", period_year: year, period_id: body.period_id, engagement_id: body.engagement_id,
    uploaded_at: new Date().toISOString(), processed_at: null, is_valid: null, validation_report: null, accounting_errors: null, processing_result: null,
    safisha_status: null, lifecycle_state: "active_unprocessed", version: 1, user_id: HARNESS_USER.id, replaces_upload_id: active?.id ?? null,
  });
  d.state = "committed";
  return { data: { outcome: "committed", upload_id: uploadId, commit_id: commitId }, error: null };
}

export const supabase = {
  ...base,
  from(table: string) {
    if (table === "currency_registry") {
      return { select: () => ({ order: () => wait(60).then(() => ({ data: CURRENCIES, error: null })) }) } as never;
    }
    return base.from(table);
  },
  async rpc(name: string, args: Row = {}): Promise<Answer> {
    journey.calls.push(name);
    const h = extraRpcs[name];
    if (h) { await wait(80); return h(args); }
    return base.rpc(name, args);
  },
  functions: {
    async invoke(name: string, opts: { body: Row }): Promise<Answer> {
      journey.calls.push(`fn:${name}:${String(opts.body.action ?? "")}`);
      if (name === "trial-balance-draft") { await wait(150); return draftFunction(opts.body); }
      return base.functions.invoke(name, opts);
    },
  },
  storage: {
    from: (bucket: string) => ({
      async uploadToSignedUrl(path: string, token: string, file: File) {
        const d = journey.drafts.find((x) => x.object_path === path);
        if (!d) return base.storage.from(bucket).uploadToSignedUrl(path, token, file);
        await wait(400);
        tb.blobs[path] = new Uint8Array(await file.arrayBuffer());
        d.stored = true;
        return { data: { path }, error: null };
      },
    }),
  },
};
