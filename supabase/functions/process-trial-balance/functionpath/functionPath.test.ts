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
import { installAttemptDoubles } from "./attemptDouble.ts";
import { validateTbAmounts } from "../../_shared/tbAmounts.ts";
import { treatmentRequestId } from "../../_shared/treatmentRequest.ts";
import { LAYOUT_TEMPLATE_FORMAT, profileSha256, resolveLayout, resolvedLayoutSha256, type LayoutProfile } from "../../_shared/layoutProfile.ts";
import { parseCsvText } from "../../_shared/tbIngestion.ts";
import { sha256HexBytes } from "../../_shared/hash.ts";

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
  // E2: the handler records every outcome through the S2 attempt functions (doubles: ./attemptDouble.ts).
  installAttemptDoubles(w);
  setWorld(w);
  return w;
}

const mapping = (code: string, classification: string, statement: string, normal: string): Row => ({
  company_id: COMPANY, account_code: code, account_name: code, normalized_account_name: null, statement, classification,
  line_item: classification, normal_balance: normal, is_cash_account: null, is_retained_earnings: null, is_payroll_account: null,
  // S1 (20261006100000): a professionally reviewed company mapping carries the review decision the database validated.
  review_decision_id: `decision-${code}`,
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
  // E2: the attempt began (after the read-only parse) and failed; nothing is certified.
  assertEquals(w2.tables.engine_runs.map((r) => [r.status, r.error_code]), [["failed", "INGESTION_REFUSED"]]);
  assertEquals((w2.tables.tb_certifications ?? []).length, 0);
});

Deno.test("three-decimal currency: amounts kept exact to 0.001 and recorded with exponent 3", async () => {
  const w = setup({ csv: "Code,Name,Debit,Credit\n1000,Cash,1.234,\n3000,Capital,,1.234\n", currency: "BHD", mappings: REVIEWED });
  await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  const exact = ((upload(w).processing_result as Record<string, Record<string, Record<string, unknown>>>).validation_report.tb_balance_check.exact) as Record<string, unknown>;
  assertEquals([exact.currency, exact.currency_exponent, exact.total_debits], ["BHD", 3, "1.234"]);
});

Deno.test("no reporting period → the attempt fails (INGESTION_REFUSED), nothing certified, the upload is not left at 'validating'", async () => {
  const w = setup({ csv: BALANCED, currency: null, priorStatus: "processing" });
  const r = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(r.status, 200);
  assertEquals(upload(w).status, "blocked");
  assert(((upload(w).accounting_errors as { code: string }[]).map((e) => e.code)).includes("CURRENCY_UNRESOLVED"));
  assertEquals(w.tables.engine_runs.map((x) => [x.status, x.error_code]), [["failed", "INGESTION_REFUSED"]]);
  assertEquals((w.tables.tb_certifications ?? []).length, 0);
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

Deno.test("a database failure mid-run fails the attempt (UNHANDLED_EXCEPTION): never stuck at 'validating', never the earlier result", async () => {
  const w = setup({ csv: BALANCED, mappings: REVIEWED, priorStatus: "needs_review" });
  w.failReads.add("keyword_dictionary");
  w.rpc.get_effective_non_reporting_status = () => { throw new Error("boom"); };
  const r = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(r.status, 500);
  // E2: a failure never re-exposes the status (or result) the upload had before this attempt.
  assertEquals([upload(w).status, upload(w).is_valid], ["error", false]);
  assertEquals((w.tables.engine_runs ?? []).filter((e) => e.status === "failed" && e.error_code === "UNHANDLED_EXCEPTION").length, 1);
  assertEquals((w.tables.tb_certifications ?? []).length, 0);
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

// ── S1 provenance consumption (20261006100000) ───────────────────────────────────────────────────────────────────
// A company mapping is the company's REVIEWED mapping only with review_decision_id. The database accepts that link only
// for a matching decision (same company, same account key, approving action, identical seven-field content) and clears
// it on any later content, company or key change — so a present link is the contract; anything else is a suggestion.
const unproven = REVIEWED.map((m) => ({ ...m, review_decision_id: null }));
const reviewAccounts = (w: World) => (upload(w).processing_result as { needs_review_accounts?: { account_code: string; reason?: string; suggestion_reason?: string }[] }).needs_review_accounts ?? [];
const reasonOf = (a: Record<string, unknown>) => String(a.reason ?? a.suggestion_reason ?? a.review_reason ?? JSON.stringify(a));

Deno.test("S1 valid provenance: linked company mappings are trusted → certified with no review", async () => {
  const w = setup({ csv: BALANCED, mappings: REVIEWED });
  await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(upload(w).status, "complete");
  assertEquals([w.tables.tb_certifications[0].p_is_blocking, w.tables.tb_certifications[0].p_requires_review], [false, false]);
  assertEquals(reviewAccounts(w), []);
});

Deno.test("S1 absent / cleared provenance: an unproven company mapping is a suggestion → needs review, with an accurate reason", async () => {
  const w = setup({ csv: BALANCED, mappings: unproven });
  await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(upload(w).status, "needs_review");
  assertEquals(w.tables.tb_certifications[0].p_requires_review, true);
  const review = reviewAccounts(w);
  assertEquals(review.map((a) => a.account_code).sort(), ["1000", "3000", "4000", "6000"]);
  for (const a of review) {
    const reason = reasonOf(a as Record<string, unknown>);
    assert(/no recorded review decision confirms it/.test(reason), reason);
    assert(!/shared chart of accounts/.test(reason), reason);
  }
});

Deno.test("S1 malformed provenance (empty or non-string link) is not provenance → needs review", async () => {
  for (const bad of ["", 42, false, {}]) {
    const w = setup({ csv: BALANCED, mappings: REVIEWED.map((m) => ({ ...m, review_decision_id: bad })) });
    await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
    assertEquals(upload(w).status, "needs_review", `link ${JSON.stringify(bad)}`);
  }
});

Deno.test("S1 compatibility: a pre-S1 database (no review_decision_id field at all) fails safe → needs review", async () => {
  const w = setup({ csv: BALANCED, mappings: REVIEWED.map(({ review_decision_id: _x, ...m }) => m) });
  await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(upload(w).status, "needs_review");
  assertEquals(w.tables.tb_certifications[0].p_requires_review, true);
});

Deno.test("S1 mixed accounts: linked rows trusted, only the unproven account goes to review", async () => {
  const w = setup({ csv: BALANCED, mappings: [...REVIEWED.slice(0, 3), { ...REVIEWED[3], review_decision_id: null }] });
  await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(upload(w).status, "needs_review");
  assertEquals(reviewAccounts(w).map((a) => a.account_code), ["6000"]);
});

Deno.test("S1 precedence: this company's unconfirmed row is the suggestion over a shared row for the same code", async () => {
  const shared = { ...REVIEWED[3], company_id: null, review_decision_id: null, classification: "cost_of_goods_sold", line_item: "shared" };
  for (const order of [[shared, { ...REVIEWED[3], review_decision_id: null }], [{ ...REVIEWED[3], review_decision_id: null }, shared]]) {
    const w = setup({ csv: BALANCED, mappings: [...REVIEWED.slice(0, 3), ...order] });
    await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
    const r = reviewAccounts(w);
    assertEquals(r.map((a) => a.account_code), ["6000"]);
    assert(/no recorded review decision confirms it/.test(reasonOf(r[0] as Record<string, unknown>)));
  }
});

Deno.test("S1 boundary: a global (company_id NULL) mapping is only a suggestion — certification requires review", async () => {
  const w = setup({ csv: BALANCED, mappings: unproven.map((m) => ({ ...m, company_id: null })) });
  await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(upload(w).status, "needs_review");
  assertEquals(w.tables.tb_certifications[0].p_requires_review, true);
  assertEquals(reviewAccounts(w).length, 4);
  assert(/shared chart of accounts/.test(reasonOf(reviewAccounts(w)[0] as Record<string, unknown>)));
});

Deno.test("S1 tenant isolation: another company's mapping — even a linked one — is never read for this upload", async () => {
  const w = setup({ csv: BALANCED, mappings: REVIEWED.map((m) => ({ ...m, company_id: "55555555-5555-4555-8555-555555555555" })) });
  await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(upload(w).status, "needs_review");
  assertEquals(w.tables.tb_certifications[0].p_requires_review, true);
});

// ── E1: exact class-side amounts, treatment questions, no silent suppression ─────────────────────────────────────────
// The engine writes processing_result.amounts ("tb-amounts/1"), certified rows gain exact fields under "tb-row/1" (the
// legacy netBalance keeps its meaning), every run records the numeric engine generation, a closing-stock-like credit on
// a current asset raises a treatment question instead of moving money, a non-zero account is never left out, and a
// mapping outside the balance sheet and income statement goes to review.
const result = (w: World) => upload(w).processing_result as Record<string, unknown>;

Deno.test("E1 exact amounts: tb-amounts/1 validates, equation exact, cash claimed as not checked; rows carry tb-row/1; generation 2", async () => {
  const cashMapped = REVIEWED.map((m) => m.account_code === "1000" ? { ...m, is_cash_account: true } : m);
  const w = setup({ csv: BALANCED, mappings: cashMapped });
  await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(upload(w).status, "complete");
  const amounts = result(w).amounts as Record<string, unknown>;
  const v = validateTbAmounts(amounts);
  assert(v.ok, JSON.stringify(v));
  assertEquals(amounts.classes, { assets_minor: "150025", liabilities_minor: "0", equity_minor: "100000", income_minor: "90025", expenses_minor: "40000" });
  assertEquals(amounts.equation, { lhs_minor: "150025", rhs_minor: "150025", difference_minor: "0", status: "balanced" });
  assertEquals(amounts.cash, { reported_minor: "150025", credit_balances_minor: "0", overdraft_minor: "0", net_position_minor: "150025", accounts: 1 });
  assertEquals(amounts.reconciliation, { status: "not_checked" });
  assertEquals((result(w).validation_report as Record<string, unknown>).cash_reconciliation, null);
  const rows = w.tables.tb_certifications[0].p_rows_snapshot as Record<string, unknown>[];
  const sales = rows.find((r) => r.accountCode === "4000")!;
  assertEquals([sales.rowContract, sales.debitMinor, sales.creditMinor, sales.classSideMinor, sales.netBalance], ["tb-row/1", "0", "90025", "90025", 900.25]);
  assertEquals(w.tables.engine_runs.map((r) => [r.engine_version, r.engine_generation]), [["safisha-tb-certification-v4", 4]]);
});

Deno.test("E1 contra asset: accumulated depreciation (credit normal) reduces assets; balanced and certified (R3c)", async () => {
  const csv = "Code,Name,Debit,Credit\n1500,Equipment,1000,\n1510,Accumulated depreciation,,300\n3000,Capital,,700\n";
  const w = setup({ csv, mappings: [mapping("1500", "non_current_assets", "balance_sheet", "debit"), mapping("1510", "non_current_assets", "balance_sheet", "credit"), REVIEWED[1]] });
  await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(upload(w).status, "complete");
  const a = result(w).amounts as Record<string, Record<string, unknown>>;
  assertEquals([a.classes.assets_minor, a.equation.status], ["70000", "balanced"]);
  const contra = (w.tables.tb_certifications[0].p_rows_snapshot as Record<string, unknown>[]).find((r) => r.accountCode === "1510")!;
  assertEquals([contra.classSideMinor, contra.netBalance], ["-30000", 300]); // exact class side; legacy meaning kept
});

const STOCK_CSV = "Code,Name,Debit,Credit\n1000,Cash,1500,\n1200,Closing stock,,500\n3000,Capital,,1000\n";
const STOCK_MAPPINGS = [REVIEWED[0], mapping("1200", "current_assets", "balance_sheet", "debit"), REVIEWED[1]];

Deno.test("E1 treatment: a current-asset credit matching closing stock raises a treatment request; figures are not moved", async () => {
  const w = setup({ csv: STOCK_CSV, mappings: STOCK_MAPPINGS });
  w.rpc.get_confirmed_treatments = () => ({ data: [], error: null });
  await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(upload(w).status, "needs_review");
  const reqs = result(w).treatment_requests as Record<string, string>[];
  assertEquals(reqs.length, 1);
  const expected = await treatmentRequestId({
    rule_id: "closing_stock_credit", rule_version: "1", company_id: COMPANY, upload_id: UPLOAD,
    source_file_hash: reqs[0].source_file_hash, account_key: "1200", account_code: "1200",
    debit_minor: "0", credit_minor: "50000", mapping_decision_id: "decision-1200",
  });
  assertEquals(reqs[0].request_id, expected);
  assertEquals(reqs[0].source_file_hash, upload(w).source_file_hash);
  const review = reviewAccounts(w) as unknown as Record<string, unknown>[];
  assertEquals(review.map((r) => [r.account_code, r.treatment_request_id, r.suggested_classification]), [["1200", expected, "current_assets"]]);
  assertEquals(result(w).statements, null);
  assertEquals(w.tables.tb_certifications[0].p_requires_review, true);
});

Deno.test("E1 treatment confirmed for exactly that request: complete, kept as mapped (a negative current asset)", async () => {
  const w = setup({ csv: STOCK_CSV, mappings: STOCK_MAPPINGS });
  w.rpc.get_confirmed_treatments = (args) => ({ data: (args.p_request_ids as string[]).map((id) => ({ request_id: id, decision_id: "d", decided_at: "now" })), error: null });
  await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(upload(w).status, "complete");
  const a = result(w).amounts as Record<string, Record<string, unknown>>;
  assertEquals([a.classes.assets_minor, a.classes.expenses_minor, a.equation.status], ["100000", "0", "balanced"]);
  const cogs = (result(w).statements as Record<string, Record<string, { accounts: unknown[] }>>).income_statement.cost_of_goods_sold.accounts;
  assertEquals(cogs.length, 0); // never re-routed into cost of sales
});

Deno.test("E1 treatment lookup failure fails closed: no certification, the attempt failed, the upload shows an error", async () => {
  const w = setup({ csv: STOCK_CSV, mappings: STOCK_MAPPINGS });
  w.rpc.get_confirmed_treatments = () => ({ data: null, error: { code: "XX000", message: "down" } });
  const r = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(r.status, 500);
  assertEquals((w.tables.tb_certifications ?? []).length, 0);
  assertEquals(upload(w).status, "error");
  assertEquals((w.tables.engine_runs ?? []).filter((e) => e.status === "failed" && e.error_code === "UNHANDLED_EXCEPTION").length, 1);
});

Deno.test("E1 refuted pattern: a debit current asset named closing stock raises no question (R3b)", async () => {
  const csv = "Code,Name,Debit,Credit\n1000,Cash,1500,\n1200,Closing stock,500,\n3000,Capital,,2000\n";
  const w = setup({ csv, mappings: STOCK_MAPPINGS });
  await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(upload(w).status, "complete");
  assertEquals(result(w).treatment_requests, undefined);
});

Deno.test("E1 non-reporting: a suppressed non-zero account goes to review with its amount; a zero one may be suppressed (OD3)", async () => {
  const csv = "Code,Name,Debit,Credit\n1000,Cash,1500,\n1410,Suspense,100,\n1420,Old clearing,50,50\n3000,Capital,,1600\n";
  const w = setup({ csv, mappings: [REVIEWED[0], REVIEWED[1]] });
  w.rpc.get_effective_non_reporting_status = () => ({ data: [
    { account_code: "1410", account_name: "Suspense", suppressed: true, stale_reason: null },
    { account_code: "1420", account_name: "Old clearing", suppressed: true, stale_reason: null },
  ], error: null });
  await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(upload(w).status, "needs_review");
  const review = reviewAccounts(w);
  assertEquals(review.map((a) => a.account_code), ["1410"]);
  const reason = reasonOf(review[0] as Record<string, unknown>);
  assert(/non-reporting/.test(reason) && /100\.00/.test(reason), reason);
  assertEquals((result(w).non_reporting_accounts as { account_code: string }[]).map((a) => a.account_code), ["1420"]);
});

Deno.test("E1 genuine equation failure cannot become authoritative: a legacy cash-flow-class mapping goes to review (D1)", async () => {
  const csv = "Code,Name,Debit,Credit\n1000,Cash,1500,\n1600,Investment outflow,500,\n3000,Capital,,2000\n";
  const w = setup({ csv, mappings: [REVIEWED[0], mapping("1600", "investing_activities", "cash_flow", "debit"), REVIEWED[1]] });
  await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(upload(w).status, "needs_review");
  assertEquals(upload(w).is_valid, false);
  assertEquals(reviewAccounts(w).map((a) => a.account_code), ["1600"]);
  assertEquals([w.tables.tb_certifications[0].p_requires_review, (w.tables.tb_certifications[0].p_rows_snapshot as unknown[]).length], [true, 0]);
});

Deno.test("E1 a cash account must be an asset or a liability: otherwise review (C2)", async () => {
  const w = setup({ csv: BALANCED, mappings: REVIEWED.map((m) => m.account_code === "3000" ? { ...m, is_cash_account: true } : m) });
  await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(upload(w).status, "needs_review");
  assertEquals(reviewAccounts(w).map((a) => a.account_code), ["3000"]);
});

Deno.test("E1 REPROCESS_REQUIRED: a new request on an upload whose latest certification is in force is refused; an invalidated one runs", async () => {
  const w = setup({ csv: BALANCED, mappings: REVIEWED, priorStatus: "complete" });
  w.tables.tb_certifications = [{ id: "cert-0", upload_id: UPLOAD, sequence_no: 1 }];
  const r = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals([r.status, r.json.code], [409, "REPROCESS_REQUIRED"]);
  assertEquals(upload(w).status, "complete"); // nothing written: the attempt never began
  assertEquals(w.tables.tb_certifications.length, 1);
  assertEquals(w.tables.engine_runs ?? [], []); // E2: refused by tb_begin_attempt before any run exists
  assertEquals(w.calls.filter((c) => c.kind === "update").length, 0);

  w.tables.tb_certification_invalidations = [{ id: "inv-0", certification_id: "cert-0" }];
  const r2 = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(r2.status, 200);
  assertEquals(upload(w).status, "complete");
  assertEquals(w.tables.tb_certifications.length, 2);
});

// ── E2: the attempt functions ─────────────────────────────────────────────────────────────────────────────────────
Deno.test("E2 nothing is written before the attempt begins; begin, snapshot, finalize in that order; one finalize", async () => {
  const w = setup({ csv: BALANCED, mappings: REVIEWED });
  await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  const order = w.calls.filter((c) => c.kind === "update" || c.kind === "download" || ["tb_begin_attempt", "tb_snapshot_dependencies", "tb_finalize_attempt"].includes(c.target))
    .map((c) => (c.kind === "rpc" ? c.target : c.kind));
  assertEquals(order, ["download", "tb_begin_attempt", "tb_snapshot_dependencies", "tb_finalize_attempt"]);
  assertEquals(upload(w).status, "complete");
});

Deno.test("E2 the snapshot names every account by code and by name, in the company's and the shared scope, plus framework, currency, dictionary", async () => {
  const w = setup({ csv: BALANCED, mappings: REVIEWED });
  await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  const keys = (w.tables.engine_run_dependencies as { scope: string; dep_key: string }[]).map((d) => `${d.scope === COMPANY ? "C" : d.scope}|${d.dep_key}`).sort();
  for (const k of ["C|code:1000", "global|code:1000", "C|name:cash at bank", "global|name:cash at bank", "C|#framework", "C|#currency", "global|#dictionary"]) assert(keys.includes(k), k);
  assertEquals(keys.length, 4 * 4 + 3);
});

Deno.test("E2 a preempted attempt (not current at finalize) records nothing and answers ATTEMPT_SUPERSEDED", async () => {
  const w = setup({ csv: BALANCED, mappings: REVIEWED });
  const real = w.rpc.tb_snapshot_dependencies;
  w.rpc.tb_snapshot_dependencies = (a) => {
    const r = real(a);
    upload(w).current_engine_run_id = "someone-else"; // a reprocess request preempted this attempt meanwhile
    return r;
  };
  const r = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals([r.status, r.json.code], [409, "ATTEMPT_SUPERSEDED"]);
  assertEquals((w.tables.tb_certifications ?? []).length, 0);
  assertEquals(upload(w).status, "validating"); // left to the attempt that replaced it
});

Deno.test("E2 a dependency changed while running: the database fails the attempt and the handler answers DEPENDENCY_CHANGED", async () => {
  const w = setup({ csv: BALANCED, mappings: REVIEWED });
  const real = w.rpc.tb_finalize_attempt;
  w.rpc.tb_finalize_attempt = (a) => real({ ...a, p_result: { outcome: "failed", error_code: "DEPENDENCY_CHANGED", upload: { status: "error", is_valid: false, processing_result: {}, accounting_errors: [] } } });
  const r = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals([r.status, r.json.code], [409, "DEPENDENCY_CHANGED"]);
  assertEquals((w.tables.tb_certifications ?? []).length, 0);
});

Deno.test("E2 the reporting currency changed before the snapshot: re-read after it, the attempt fails DEPENDENCY_CHANGED, nothing certified", async () => {
  const w = setup({ csv: BALANCED, mappings: REVIEWED });
  const real = w.rpc.tb_snapshot_dependencies;
  w.rpc.tb_snapshot_dependencies = (a) => {
    w.tables.fiscal_periods[0].reporting_currency = "KES"; // changed after ingestion read TZS, before this revision was recorded
    return real(a);
  };
  const r = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals([r.status, r.json.code], [409, "DEPENDENCY_CHANGED"]);
  assertEquals((w.tables.tb_certifications ?? []).length, 0);
  const finals = w.calls.filter((c) => c.target === "tb_finalize_attempt");
  assertEquals(finals.length, 1);
  const sent = (finals[0].payload as { p_result: { outcome: string; error_code: string } }).p_result;
  assertEquals([sent.outcome, sent.error_code], ["failed", "DEPENDENCY_CHANGED"]);
  assertEquals(w.calls.some((c) => c.kind === "select" && c.target === "account_mappings"), false); // no classification read
  assertEquals(upload(w).status, "error");
});

Deno.test("E2 begin refusals answer without processing: hold (503), source changed, in progress, legacy upload outside a workspace", async () => {
  const held = setup({ csv: BALANCED, mappings: REVIEWED });
  held.rpc.tb_begin_attempt = () => ({ data: null, error: { code: "PT503", message: "PROCESSING_HELD" } });
  const r1 = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals([r1.status, r1.json.code], [503, "PROCESSING_HELD"]);
  assertEquals(held.calls.filter((c) => c.kind === "update").length, 0);

  const changed = setup({ csv: BALANCED, mappings: REVIEWED });
  upload(changed).source_file_hash = "f".repeat(64);
  const r2 = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals([r2.status, r2.json.code], [409, "SOURCE_CHANGED"]);

  const busy = setup({ csv: BALANCED, mappings: REVIEWED });
  busy.tables.engine_runs = [{ id: "run-x", status: "running" }];
  upload(busy).current_engine_run_id = "run-x";
  const r3 = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals([r3.status, r3.json.status], [409, "in_progress"]);

  const personal = setup({ csv: BALANCED, mappings: REVIEWED });
  upload(personal).company_id = null;
  const r4 = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals([r4.status, r4.json.code], [409, "COMPANY_REQUIRED"]);
  assertEquals(personal.calls.filter((c) => c.kind === "update" || c.target === "tb_begin_attempt").length, 0);
});

// ── A2: confirmed layouts (20261010100000) ───────────────────────────────────────────────────────────────────────────
const EUROPEAN = 'Code;Name;Soll;Haben
1000;Cash at bank;"1.500,25";
3000;Share capital;;"1.000,00"
4000;Sales;;"900,25"
6000;Rent;"400,00";
';
const EURO_LAYOUT: LayoutProfile = {
  format: LAYOUT_TEMPLATE_FORMAT, sheet: { kind: "csv" }, headerRow: 1, numberFormat: "dot_comma", balanceSign: null,
  columns: { accountCode: "Code", accountName: "Name", debit: "Soll", credit: "Haben", balance: null, dimensions: [] },
};
async function confirmLayout(w: World, csv: string, profile: LayoutProfile, over: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const ph = await profileSha256(profile);
  const parsed = parseCsvText(csv);
  if (!parsed.ok) throw new Error("fixture");
  const r = resolveLayout(parsed.rows, null, profile, ph);
  if (!r.ok) throw new Error("layout does not fit fixture");
  const row = {
    id: `lc-${(w.tables.layout_confirmations ?? []).length + 1}`, upload_id: UPLOAD, company_id: COMPANY, confirmation_no: (w.tables.layout_confirmations ?? []).length + 1,
    source_file_hash: await sha256HexBytes(enc(csv)), profile, profile_sha256: ph, resolved_profile_sha256: await resolvedLayoutSha256(r.resolved), template_id: null, ...over,
  };
  (w.tables.layout_confirmations ??= []).push(row);
  return row;
}

Deno.test("A2 no layout authority (migration not applied): refused 503 before any write, no attempt begun", async () => {
  const w = setup({ csv: BALANCED, mappings: REVIEWED });
  w.missingTables.add("layout_confirmations");
  const r = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals([r.status, r.json.code], [503, "LAYOUT_AUTHORITY_UNAVAILABLE"]);
  assertEquals(w.calls.filter((c) => c.kind === "update" || c.kind === "insert" || c.target === "tb_begin_attempt" || c.kind === "download").length, 0);
});

Deno.test("A2 no confirmation: the automatic path, the layout key recorded at revision snapshot, input hash = accounts hash", async () => {
  const w = setup({ csv: BALANCED, mappings: REVIEWED });
  await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(upload(w).status, "complete");
  const keys = (w.tables.engine_run_dependencies ?? []).map((d) => d.dep_key);
  assert(keys.includes(`#layout_confirmation:${UPLOAD}`));
});

Deno.test("A2 a confirmed European layout: read exactly as confirmed, certified, the layout bound into the input hash", async () => {
  const plain = setup({ csv: EUROPEAN, fileName: "tb.csv", mappings: REVIEWED });
  await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assert(upload(plain).status !== "complete"); // the automatic path cannot read this file (unrecognised headers)
  const w = setup({ csv: EUROPEAN, fileName: "tb.csv", mappings: REVIEWED });
  await confirmLayout(w, EUROPEAN, EURO_LAYOUT);
  const r = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals(r.status, 200);
  assertEquals(upload(w).status, "complete");
  const amounts = result(w).amounts as Record<string, Record<string, unknown>>;
  assertEquals(amounts.equation.status, "balanced");
  assertEquals(amounts.classes.assets_minor, "150025");
  const run = w.tables.engine_runs[0];
  assertEquals([run.engine_version, run.engine_generation], ["safisha-tb-certification-v4", 4]);
  assert(String(w.tables.tb_certifications[0].p_normalized_input_hash) === String(run.input_hash));
});

Deno.test("A2 the confirmation is for other bytes: refused before the attempt (LAYOUT_SOURCE_MISMATCH), nothing written", async () => {
  const w = setup({ csv: EUROPEAN, mappings: REVIEWED });
  await confirmLayout(w, EUROPEAN, EURO_LAYOUT, { source_file_hash: "a".repeat(64) });
  const r = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals([r.status, r.json.code], [409, "LAYOUT_SOURCE_MISMATCH"]);
  assertEquals(w.calls.filter((c) => c.kind === "update" || c.target === "tb_begin_attempt").length, 0);
});

Deno.test("A2 a tampered resolved hash is refused before the attempt (LAYOUT_RECORD_INVALID)", async () => {
  const w = setup({ csv: EUROPEAN, mappings: REVIEWED });
  await confirmLayout(w, EUROPEAN, EURO_LAYOUT, { resolved_profile_sha256: "b".repeat(64) });
  const r = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals([r.status, r.json.code], [409, "LAYOUT_RECORD_INVALID"]);
  assertEquals(w.calls.filter((c) => c.target === "tb_begin_attempt").length, 0);
});

Deno.test("A2 a new confirmation lands before the snapshot: the attempt fails DEPENDENCY_CHANGED, nothing certified", async () => {
  const w = setup({ csv: EUROPEAN, mappings: REVIEWED });
  await confirmLayout(w, EUROPEAN, EURO_LAYOUT);
  const real = w.rpc.tb_snapshot_dependencies;
  w.rpc.tb_snapshot_dependencies = async (a) => {
    await confirmLayout(w, EUROPEAN, { ...EURO_LAYOUT, columns: { ...EURO_LAYOUT.columns, accountCode: null } });
    return real(a);
  };
  const r = await call({ uploadId: UPLOAD, clientRequestId: crypto.randomUUID() });
  assertEquals([r.status, r.json.code], [409, "DEPENDENCY_CHANGED"]);
  assertEquals((w.tables.tb_certifications ?? []).length, 0);
});
