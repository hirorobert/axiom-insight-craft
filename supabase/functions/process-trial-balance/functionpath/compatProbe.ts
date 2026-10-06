// Mixed-version probe: runs ONE process-trial-balance handler (the one at $PTB_INDEX — the current tree, or main's
// extracted by scripts/compat/tbMixedVersions.mjs) through the same in-memory doubles as functionPath.test.ts, over the
// release-relevant scenarios, and prints the server's outputs as JSON for the client-side evaluation.
//
//   PTB_INDEX=<file URL of index.ts> deno run --allow-env --allow-read --allow-net=esm.sh,deno.land \
//     --import-map=<this dir>/import_map.json <this dir>/compatProbe.ts
import { newWorld, setWorld, type Row, type World } from "./supabaseDouble.ts";
import { capturedHandler } from "./serverDouble.ts";

Deno.env.set("SUPABASE_URL", "http://compat.invalid");
Deno.env.set("SUPABASE_ANON_KEY", "anon");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service");
await import(Deno.env.get("PTB_INDEX")!);
const handler = capturedHandler();

const USER = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const UPLOAD = "33333333-3333-4333-8333-333333333333";
const PERIOD = "44444444-4444-4444-8444-444444444444";
const PATH = `workspaces/${COMPANY}/src/tb.csv`;

function world(csv: string, currency: string, mappings: Row[]): World {
  const w = newWorld();
  w.claims = { sub: USER, exp: Math.floor(Date.now() / 1000) + 3600 };
  w.tables.trial_balance_uploads = [{ id: UPLOAD, company_id: COMPANY, user_id: USER, status: "processing", lifecycle_state: "active_unprocessed", file_path: PATH, file_name: "tb.csv", period_year: 2025, period_id: PERIOD, engagement_id: null }];
  w.tables.fiscal_periods = [{ id: PERIOD, company_id: COMPANY, reporting_currency: currency }];
  w.tables.companies = [{ id: COMPANY, reporting_framework: "full_ifrs" }];
  w.tables.account_mappings = mappings;
  w.tables.keyword_dictionary = [];
  w.storage[PATH] = new TextEncoder().encode(csv);
  w.rpc.tbu_resolve_processing_actor = () => ({ data: [{ actor_type: "workspace_user", firm_member_id: null, authority_basis: "workspace_owner" }], error: null });
  w.rpc.authorize_trial_balance_processing = () => ({ data: { allowed: true, code: "ALLOWED" }, error: null });
  w.rpc.tbu_upload_source_bound = () => ({ data: true, error: null });
  w.rpc.get_effective_non_reporting_status = () => ({ data: [], error: null });
  w.rpc.get_authoritative_certification = () => ({ data: [], error: null });
  w.rpc.commit_tb_certification = (args) => {
    (w.tables.tb_certifications ??= []).push(args);
    const key = (w.tables.idempotency_keys ?? []).find((k) => k.engine_run_id === args.p_engine_run_id);
    if (key) { key.status = "completed"; key.replay_result = { status: "completed" }; }
    return { data: { certification_id: "cert" }, error: null };
  };
  setWorld(w);
  return w;
}
const mapping = (code: string, classification: string, statement: string, normal: string): Row => ({
  company_id: COMPANY, account_code: code, account_name: code, normalized_account_name: null, statement, classification,
  line_item: classification, normal_balance: normal, is_cash_account: null, is_retained_earnings: null, is_payroll_account: null,
  review_decision_id: `decision-${code}`, // S1: a saved review decision links its mapping (older handlers ignore the field)
});
const ALL = [mapping("1000", "current_assets", "balance_sheet", "debit"), mapping("3000", "equity", "balance_sheet", "credit"), mapping("6000", "operating_expenses", "income_statement", "debit")];
const call = async (id: string) => {
  const res = await handler(new Request("http://compat.invalid/x", { method: "POST", headers: { Authorization: "Bearer a.b.c", "content-type": "application/json" }, body: JSON.stringify({ uploadId: UPLOAD, clientRequestId: id }) }));
  return { http: res.status, body: await res.json() };
};
const snapshot = (w: World) => {
  const u = w.tables.trial_balance_uploads[0];
  const pr = (u.processing_result ?? {}) as Record<string, unknown>;
  return {
    status: u.status, is_valid: u.is_valid ?? null, processing_result: pr, accounting_errors: u.accounting_errors ?? null,
    certifications: (w.tables.tb_certifications ?? []).map((c) => ({ is_blocking: c.p_is_blocking, requires_review: c.p_requires_review, rows: (c.p_rows_snapshot as unknown[]).length, codes: (c.p_rows_snapshot as { accountCode: string }[]).map((r) => r.accountCode) })),
    engine_runs: (w.tables.engine_runs ?? []).length,
  };
};

const DIM = "Code,Name,Department,Debit,Credit\n6000,Salaries,Admin,300,\n6000,Salaries,Sales,200,\n1000,Cash,,,100\n3000,Capital,,,400\n";
const BHD_OK = "Code,Name,Debit,Credit\n1000,Cash,1.234,\n3000,Capital,,1.234\n";
const BHD_OFF = "Code,Name,Debit,Credit\n1000,Cash,1.234,\n3000,Capital,,1.233\n";
const TZS = "Code,Name,Debit,Credit\n1000,Cash,1500.25,\n3000,Capital,,1500.25\n";
const out: Record<string, unknown> = {};

{ const w = world(DIM, "TZS", []); out.dimension_review = { response: await call(crypto.randomUUID()), ...snapshot(w) }; }
{ // classification confirmation: review needed → decisions saved as company mappings → reprocess (new request id)
  const w = world(DIM, "TZS", []); await call(crypto.randomUUID());
  w.tables.account_mappings = ALL;
  out.dimension_confirmed = { response: await call(crypto.randomUUID()), ...snapshot(w) };
}
{ const w = world(BHD_OK, "BHD", ALL); out.bhd_balanced = { response: await call(crypto.randomUUID()), ...snapshot(w) }; }
{ const w = world(BHD_OFF, "BHD", ALL); out.bhd_off_by_0_001 = { response: await call(crypto.randomUUID()), ...snapshot(w) }; }
{ // retry with the SAME request id after a completed run (the #45 uploader's "Check again" after a lost response)
  const w = world(TZS, "TZS", ALL); const id = crypto.randomUUID(); await call(id);
  out.retry_same_id = { response: await call(id), ...snapshot(w) };
}
{ // retry with a NEW request id on the same upload (main's uploader / Prepare "Retry processing")
  const w = world(TZS, "TZS", ALL); await call(crypto.randomUUID());
  out.retry_new_id = { response: await call(crypto.randomUUID()), ...snapshot(w) };
}
console.log("COMPAT_JSON " + JSON.stringify(out));
