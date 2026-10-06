// Function-path tests: the REAL process-trial-balance handler (index.ts, unmodified) driven end to end through
// Deno with an import map that swaps only the network edges — the Supabase client (an in-memory database double) and
// std's serve (captures the handler). Everything else is the deployed code: authorization, entitlement and lifecycle
// refusals, source binding, the storage read, SheetJS from esm.sh, the ingestion core, idempotency, classification and
// the certification commit.
//
//   deno test --allow-env --allow-net=esm.sh,deno.land --import-map=supabase/functions/process-trial-balance/functionpath/import_map.json \
//     supabase/functions/process-trial-balance/functionpath/functionPath.test.ts
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { newWorld, setWorld, type Row, type World } from "./supabaseDouble.ts";
import { capturedHandler } from "./serverDouble.ts";

Deno.env.set("SUPABASE_URL", "http://functionpath.invalid");
Deno.env.set("SUPABASE_ANON_KEY", "anon");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service");
await import("../index.ts");
const handler = capturedHandler();

const USER = "11111111-1111-4111-8111-111111111111";
const COMPANY = "22222222-2222-4222-8222-222222222222";
const UPLOAD = "33333333-3333-4333-8333-333333333333";
const PERIOD = "44444444-4444-4444-8444-444444444444";
const PATH = `workspaces/${COMPANY}/src/tb.csv`;
const enc = (s: string) => new TextEncoder().encode(s);

function setup(opts: { csv: string; fileName?: string; currency?: string | null; mappings?: Row[]; priorStatus?: string } ): World {
  const w = newWorld();
  w.claims = { sub: USER, exp: Math.floor(Date.now() / 1000) + 3600 };
  const fileName = opts.fileName ?? "tb.csv";
  w.tables.trial_balance_uploads = [{
    id: UPLOAD, company_id: COMPANY, user_id: USER, status: opts.priorStatus ?? "processing", lifecycle_state: "active_unprocessed",
    file_path: PATH, file_name: fileName, period_year: 2025, period_id: opts.currency === null ? null : PERIOD, engagement_id: null,
  }];
  w.tables.fiscal_periods = [{ id: PERIOD, company_id: COMPANY, reporting_currency: opts.currency ?? "TZS" }];
  w.tables.companies = [{ id: COMPANY, reporting_framework: "full_ifrs" }];
  w.tables.account_mappings = opts.mappings ?? [];
  w.tables.keyword_dictionary = [];
  w.storage[PATH] = enc(opts.csv);
  w.rpc.tbu_resolve_processing_actor = () => ({ data: [{ actor_type: "workspace_user", firm_member_id: null, authority_basis: "workspace_owner" }], error: null });
  w.rpc.authorize_trial_balance_processing = () => ({ data: { allowed: true, code: "ALLOWED" }, error: null });
  w.rpc.tbu_upload_source_bound = () => ({ data: true, error: null });
  w.rpc.get_effective_non_reporting_status = () => ({ data: [], error: null });
  w.rpc.get_authoritative_certification = () => ({ data: [], error: null });
  w.rpc.commit_tb_certification = (args) => {
    (w.tables.tb_certifications ??= []).push(args);
    const key = (w.tables.idempotency_keys ?? []).find((k) => k.engine_run_id === args.p_engine_run_id);
    if (key) { key.status = "completed"; key.replay_result = { status: "completed" }; }
    return { data: { certification_id: "cert-1" }, error: null };
  };
  setWorld(w);
  return w;
}

const mapping = (code: string, classification: string, statement: string, normal: string): Row => ({
  company_id: COMPANY, account_code: code, account_name: code, normalized_account_name: null, statement, classification,
  line_item: classification, normal_balance: normal, is_cash_account: null, is_retained_earnings: null, is_payroll_account: null,
});
const REVIEWED = [
  mapping("1000", "current_assets", "balance_sheet", "debit"),
  mapping("3000", "equity", "balance_sheet", "credit"),
  mapping("4000", "revenue", "income_statement", "credit"),
  mapping("6000", "operating_expenses", "income_statement", "debit"),
];
const BALANCED = "Trial balance for the year ended 31 December 2025\nCode,Name,Debit,Credit\n1000,Cash at bank,\"1,500.25\",\n3000,Share capital,,1000.00\n4000,Sales,,900.25\n6000,Rent,400.00,\n,Total,\"1,900.25\",\"1,900.25\"\n";

async function call(body: Record<string, unknown>, auth = "Bearer a.b.c"): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await handler(new Request("http://functionpath.invalid/process-trial-balance", { method: "POST", headers: { Authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
}
const upload = (w: World) => w.tables.trial_balance_uploads[0];
const ingestion = (w: World) => (upload(w).processing_result as Record<string, unknown>).ingestion as Record<string, unknown>;
const milestoneStates = (w: World) => (ingestion(w).milestones as { id: string; status: string }[]).map((m) => `${m.id}:${m.status}`);

Deno.test("reviewed mappings + exact balance → complete, certified with rows; exact totals and milestones recorded", async () => {
  const w = setup({ csv: BALANCED, mappings: REVIEWED });
  const r = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(r.status, 200);
  assertEquals(upload(w).status, "complete");
  assertEquals(upload(w).is_valid, true);
  const cert = w.tables.tb_certifications[0];
  assertEquals([cert.p_is_blocking, cert.p_requires_review], [false, false]);
  assertEquals((cert.p_rows_snapshot as unknown[]).length, 4);
  assertEquals((ingestion(w).totals as Record<string, string>), { debit: "1900.25", credit: "1900.25", difference: "0.00" });
  assertEquals(milestoneStates(w), ["read:passed", "columns:passed", "rows:passed", "amounts:passed", "balance:passed", "classification:passed", "recorded:passed"]);
  const exact = ((upload(w).processing_result as Record<string, Record<string, Record<string, unknown>>>).validation_report.tb_balance_check.exact);
  assertEquals(exact, { currency: "TZS", currency_exponent: 2, total_debits: "1900.25", total_credits: "1900.25", difference: "0.00" });
});

Deno.test("no reviewed mapping → every machine guess goes to review; certification requires review; nothing accepted", async () => {
  const w = setup({ csv: BALANCED });
  const r = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(r.status, 200);
  assertEquals(upload(w).status, "needs_review");
  assertEquals(upload(w).is_valid, false);
  assertEquals([w.tables.tb_certifications[0].p_is_blocking, w.tables.tb_certifications[0].p_requires_review], [false, true]);
  assert(milestoneStates(w).includes("classification:needs_review"));
});

Deno.test("dimension-split trial balance: one code across departments is kept as separate rows, reviewed ONCE per code", async () => {
  const csv = "Code,Name,Department,Debit,Credit\n6000,Salaries,Admin,300,\n6000,Salaries,Sales,200,\n1000,Cash,,,100\n3000,Capital,,,400\n";
  const w = setup({ csv });
  const r = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(r.status, 200);
  const pr = upload(w).processing_result as Record<string, unknown>;
  const review = pr.needs_review_accounts as { account_code: string; debit: number }[];
  assertEquals(review.filter((a) => a.account_code === "6000"), [{ ...review.find((a) => a.account_code === "6000")!, debit: 500 }]);
  assertEquals((ingestion(w).lineage_summary as Record<string, number>).account, 4);

  // Once 6000 (and the others) are reviewed, both department rows are certified separately with their dimension.
  const w2 = setup({ csv, mappings: [...REVIEWED, mapping("6000", "operating_expenses", "income_statement", "debit")] });
  await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  const rows = w2.tables.tb_certifications[0].p_rows_snapshot as { accountCode: string; dimensions?: Record<string, string>; debitBalance: number }[];
  assertEquals(rows.filter((x) => x.accountCode === "6000").map((x) => [x.dimensions?.Department, x.debitBalance]), [["Admin", 300], ["Sales", 200]]);
});

Deno.test("ambiguous duplicate code → blocked with an explanation; a transaction listing is explained, not processed", async () => {
  const w = setup({ csv: "Code,Name,Debit,Credit\n1000,Cash,10,\n1000,Cash,5,\n3000,Capital,,15\n" });
  await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(upload(w).status, "blocked");
  const ex = w.tables.tb_certifications[0].p_exceptions as { code: string; message: string }[];
  assert(ex.some((e) => e.code === "DUPLICATE_ACCOUNT_CODE" && /cost centre, department, branch, fund or project/.test(e.message)));

  const w2 = setup({ csv: "Date,Voucher,Account Code,Account Name,Debit,Credit\n2025-01-03,JV1,1000,Cash,10,\n2025-01-03,JV1,3000,Capital,,10\n" });
  const r2 = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(r2.status, 200);
  assertEquals(upload(w2).status, "blocked");
  assert(((upload(w2).accounting_errors as { code: string }[]).map((e) => e.code)).includes("UNSUPPORTED_LAYOUT"));
  assertEquals(w2.tables.engine_runs, undefined); // refused before any engine run
});

Deno.test("three-decimal currency: amounts kept exact to 0.001 and recorded with exponent 3", async () => {
  const w = setup({ csv: "Code,Name,Debit,Credit\n1000,Cash,1.234,\n3000,Capital,,1.234\n", currency: "BHD", mappings: REVIEWED });
  await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  const exact = ((upload(w).processing_result as Record<string, Record<string, Record<string, unknown>>>).validation_report.tb_balance_check.exact) as Record<string, unknown>;
  assertEquals([exact.currency, exact.currency_exponent, exact.total_debits], ["BHD", 3, "1.234"]);
});

Deno.test("no reporting period → refused before any engine run, and the upload is not left at 'validating'", async () => {
  const w = setup({ csv: BALANCED, currency: null, priorStatus: "processing" });
  const r = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(r.status, 200);
  assertEquals(upload(w).status, "blocked");
  assert(((upload(w).accounting_errors as { code: string }[]).map((e) => e.code)).includes("CURRENCY_UNRESOLVED"));
  assertEquals(w.tables.engine_runs, undefined);
});

Deno.test("retry with the SAME request id replays: no second run or certification, and the recorded status is kept", async () => {
  const w = setup({ csv: BALANCED, mappings: REVIEWED });
  const id = crypto.randomUUID();
  await call({ uploadId: UPLOAD, clientRequestId: id });
  assertEquals(upload(w).status, "complete");
  const r = await call({ uploadId: UPLOAD, clientRequestId: id });
  assertEquals(r.status, 200);
  assertEquals(r.json.replay, true);
  assertEquals(w.tables.tb_certifications.length, 1);
  assertEquals(upload(w).status, "complete"); // previously left at "validating"
});

Deno.test("a database failure mid-run restores the prior status (never stuck at 'validating') and fails the engine run", async () => {
  const w = setup({ csv: BALANCED, mappings: REVIEWED, priorStatus: "needs_review" });
  w.failReads.add("keyword_dictionary");
  w.rpc.get_effective_non_reporting_status = () => { throw new Error("boom"); };
  const r = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(r.status, 500);
  assertEquals(upload(w).status, "needs_review");
  assertEquals((w.tables.engine_runs ?? []).filter((e) => e.status === "failed" && e.error_code === "UNHANDLED_EXCEPTION").length, 1);
  assert(!JSON.stringify(r.json).includes("boom")); // no raw error reaches the response
});

Deno.test("refusals: no token → 401; not authorized → 403 before any write or download", async () => {
  const w = setup({ csv: BALANCED });
  assertEquals((await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() }, "")).status, 401);
  w.rpc.tbu_resolve_processing_actor = () => ({ data: [], error: null });
  const r = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(r.status, 403);
  assertEquals(w.calls.filter((c) => c.kind === "update" || c.kind === "download").length, 0);
});

// ── S1 boundary: how the deployed handler consumes account mappings (20261006100000 adds review_decision_id) ─────────
// The handler does not read review_decision_id. These tests pin what it does TODAY so the provenance-consumption change
// flips the first one deliberately: until then S1 alone does not stop an unproven company mapping from being trusted.
const unproven = REVIEWED.map((m) => ({ ...m, review_decision_id: null }));

Deno.test("S1 OPEN GAP: a company mapping WITHOUT review provenance is still trusted as reviewed (certified, no review)", async () => {
  const w = setup({ csv: BALANCED, mappings: unproven });
  const r = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(r.status, 200);
  assertEquals(upload(w).status, "complete");
  assertEquals([w.tables.tb_certifications[0].p_is_blocking, w.tables.tb_certifications[0].p_requires_review], [false, false]);
  assertEquals((upload(w).processing_result as { needs_review_accounts?: unknown[] }).needs_review_accounts ?? [], []);
});

Deno.test("S1 boundary: a global (company_id NULL) mapping is only a suggestion — certification requires review", async () => {
  const w = setup({ csv: BALANCED, mappings: unproven.map((m) => ({ ...m, company_id: null })) });
  await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(upload(w).status, "needs_review");
  assertEquals(w.tables.tb_certifications[0].p_requires_review, true);
  assertEquals(((upload(w).processing_result as { needs_review_accounts: unknown[] }).needs_review_accounts).length, 4);
});

Deno.test("S1 boundary: another company's mapping is never read for this upload", async () => {
  const w = setup({ csv: BALANCED, mappings: REVIEWED.map((m) => ({ ...m, company_id: "55555555-5555-4555-8555-555555555555" })) });
  await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(upload(w).status, "needs_review");
  assertEquals(w.tables.tb_certifications[0].p_requires_review, true);
});
