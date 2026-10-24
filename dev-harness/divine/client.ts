// Isolated UI transport fixture. NO hosted connection, credentials or production writes.
// The existing harness runs the real ingestion parser; membership/transactions below are simulated, not DB proof.
import { supabase as journeyClient, journey } from "../journey/syntheticClient";
import { tb, COMPANY, PERIOD, ENGAGEMENT, harnessSnapshot, harnessRestore } from "../trial-balance/syntheticBackend";
import { HARNESS_USER } from "../trial-balance/syntheticAuth";
export { tb, COMPANY, PERIOD, ENGAGEMENT };
type Row = Record<string, any>;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const KEY = "divine-ui-fixture-v1";
export const fixture = { calls: [] as { name: string; args: Row }[], failPeriod: false, dropPeriodAnswer: false, delay: 0, readOnly: false, failCreate: false, dropCreateAnswer: false, dropPurposeAnswer: false, failPurpose: false, reportingEnabled: sessionStorage.getItem("divine-reporting") === "enabled" };
(window as any).__divine = { tb, fixture, journey };
const ok = (data: unknown) => ({ data, error: null });
const save = () => sessionStorage.setItem(KEY, harnessSnapshot());
const saved = sessionStorage.getItem(KEY);
if (saved) harnessRestore(saved);
else { tb.tables.companies = []; tb.tables.fiscal_periods = []; tb.tables.engagements = []; tb.tables.firm_members = []; tb.tables.profiles = []; }
tb.tables.workspace_purpose_events ??= [];
window.addEventListener("beforeunload", save);
const company = (id: string) => tb.tables.companies.find((c) => c.id === id) as Row | undefined;
function open(a: Row, explicit: boolean) {
  const year = explicit ? Number(a.p_period_end.slice(0,4)) : a.p_period_year;
  let p = tb.tables.fiscal_periods.find((p) => p.company_id === a.p_company_id && String(p.reporting_end).startsWith(String(year)));
  if (!p) { p = { id: PERIOD, company_id: a.p_company_id, fiscal_year_end: `${year}-12-31`, reporting_start: `${year}-01-01`, reporting_end: `${year}-12-31`, reporting_currency: company(a.p_company_id)?.currency, created_at: new Date().toISOString(), prior_period_id: null }; tb.tables.fiscal_periods.push(p); }
  if (explicit) Object.assign(p, { reporting_start: a.p_period_start, reporting_end: a.p_period_end, reporting_currency: a.p_reporting_currency });
  let e = tb.tables.engagements.find((e) => e.fiscal_period_id === p!.id);
  const created = !e;
  if (!e) { e = { id: ENGAGEMENT, fiscal_period_id: p.id, company_id: a.p_company_id, engagement_type: "composite", status: "open", opened_at: new Date().toISOString(), closed_at: null }; tb.tables.engagements.push(e); }
  save();
  return explicit ? ok({ outcome: "opened", engagementId: e.id, periodId: p.id, periodYear: year, created, granted: ["FINANCIAL_STATEMENTS"] }) : ok({ engagementId: e.id, periodId: p.id, created, granted: ["FINANCIAL_STATEMENTS"] });
}
function portfolio() {
  return tb.tables.engagements.map((e) => {
    const c = company(String(e.company_id))!, p = tb.tables.fiscal_periods.find((p) => p.id === e.fiscal_period_id)!;
    const u = tb.tables.trial_balance_uploads.find((u) => u.company_id === c.id);
    const certified = tb.tables.tb_certifications.some((r) => r.upload_id === u?.id && !r.is_blocking && !r.requires_review);
    const status = !u ? "no_trial_balance" : u.status === "processing" ? "processing" : certified ? "ready" : "needs_decision";
    return { engagement_id: e.id, company_id: c.id, company_name: c.name, period_year: Number(String(p.reporting_end).slice(0,4)), period_start: p.reporting_start, period_end: p.reporting_end, currency: p.reporting_currency, purpose: tb.tables.workspace_purpose_events.filter(x => x.company_id === c.id).at(-1)?.purpose ?? "not_stated", status, services: ["FINANCIAL_STATEMENTS"], upload: u ? { file_name: u.file_name, uploaded_at: u.uploaded_at, uploaded_by: "Fixture owner" } : null };
  }).reverse();
}
export const supabase = {
  ...journeyClient,
  from: journeyClient.from,
  async rpc(name: string, args: Row = {}) {
    fixture.calls.push({ name, args });
    await wait(20);
    if (name === "create_entity") {
      if (fixture.failCreate) { fixture.failCreate = false; throw new Error("Synthetic save failure"); }
      if (!tb.tables.companies.length) {
        tb.tables.companies.push({ id: COMPANY, name: args.p_name, fiscal_year_end: args.p_fiscal_year_end, currency: args.p_currency, reporting_framework: args.p_reporting_framework, created_at: new Date().toISOString(), user_id: HARNESS_USER.id, is_active: true });
        tb.tables.firm_members.push({ id: "ffffffff-ffff-4fff-8fff-ffffffffffff", company_id: COMPANY, user_id: HARNESS_USER.id, role: "owner", accepted_at: new Date().toISOString() });
      }
      save(); if (fixture.dropCreateAnswer) { fixture.dropCreateAnswer = false; throw new Error("Synthetic lost create response"); } return ok({ outcome: "created", company_id: COMPANY });
    }
    if (name === "set_workspace_purpose") {
      await wait(fixture.delay);
      if (fixture.failPurpose) { fixture.failPurpose = false; throw new Error("Synthetic purpose failure"); }
      const rows = tb.tables.workspace_purpose_events;
      if (rows.filter(x => x.company_id === args.p_company_id).at(-1)?.purpose !== args.p_purpose) rows.push({ company_id: args.p_company_id, purpose: args.p_purpose, reason: args.p_reason, created_at: new Date().toISOString(), seq: rows.length + 1 });
      save(); if (fixture.dropPurposeAnswer) { fixture.dropPurposeAnswer = false; throw new Error("Synthetic lost purpose response"); }
      return ok({ outcome: "recorded" });
    }
    if (name === "get_my_entity_capacity") return ok({ determined: true, capacity: 100, used: tb.tables.companies.length, plan_code: "PRACTICE" });
    if (name === "get_my_billing_summary") return ok({ has_billing_customer: true, plan_code: "PRACTICE", licence_status: "ACTIVE", entitlements: ["CLOSE_ASSURANCE"], effective_start: "2025-01-01", effective_end: "2030-01-01" });
    if (name === "get_workspace_commercial_state") return ok({ access: true, capabilities: { CLOSE_ASSURANCE: { allowed: true, code: "ENTITLED" } }, plan_code: "PRACTICE" });
    if (name === "get_account_home") {
      const rows = tb.tables.engagements.map((e) => ({ engagement_id: e.id, company_id: e.company_id, company_name: company(String(e.company_id))?.name, period_year: 2025, opened_at: e.opened_at }));
      const without = tb.tables.companies.filter((c) => !tb.tables.engagements.some((e) => e.company_id === c.id));
      return ok({ outcome: "ok", engagements: { total: rows.length, rows }, companies_without_engagement: { total: without.length, rows: without }, withheld: { total: 0, rows: [] }, shared: { total: 0, rows: [] } });
    }
    if (name === "list_portfolio_engagements") { const rows = portfolio(); return ok({ outcome: "ok", total: rows.length, rows, view_token: "fixture", status_counts: {}, next_cursor: null }); }
    if (name === "get_workspace_access") {
      const c = company(args.p_company_id); return ok(c ? [{ company_id: c.id, access: "owner", capabilities: ["prepare_trial_balance", "review_close", "manage_source_files", "reconcile"], stages: ["prepare", "reconcile"], ...c }] : []);
    }
    if (name === "get_my_workspace_capabilities") { const caps = fixture.readOnly ? [] : ["prepare_close", "review_close", "manage_members"]; return ok({ access: true, capabilities: caps, allowed: caps, has_current_plan: true, manage_billing: true }); }
    if (name === "financial_statements_workspace_access") return ok(fixture.reportingEnabled ? { enabled: true } : { enabled: false, reason: "NOT_ENABLED" });
    if (name === "fold_engagement_mandate") return ok([{ capability: "FINANCIAL_STATEMENTS", granted: true }]);
    if (name === "fold_engagement_authority") return ok([]);
    if (name === "get_engagement_setup_state") return ok({ dataStart: null, sequence: 0 });
    if (name === "get_tb_finding_policies") return ok({ outcome: "ok", may_change: false, policies: [{ code: "CLEARING_ACCOUNT_BALANCE", mode: "review", revision: 0, reason: null }] });
    if (name === "open_engagement_with_scope") return open(args, false);
    if (name === "open_engagement_with_period") {
      await wait(fixture.delay);
      if (fixture.failPeriod) { fixture.failPeriod = false; throw new Error("Synthetic lost response before commit"); }
      const r = open(args, true);
      if (fixture.dropPeriodAnswer) { fixture.dropPeriodAnswer = false; throw new Error("Synthetic lost response after commit"); }
      return r;
    }
    if (name === "get_period_currency_correction") return ok(tb.tables.tb_certifications.some((c) => !c.requires_review && !c.is_blocking) ? { outcome: "not_eligible", currency: "TZS", block: { code: "ACCEPTED_CERTIFICATION" } } : { outcome: "eligible", currency: "TZS" });
    if (name === "accept_workspace_invitations") return ok({ accepted: [], blocked: [] });
    return journeyClient.rpc(name, args);
  },
};
