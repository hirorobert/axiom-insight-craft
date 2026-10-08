/**
 * The measured evaluation a layout-assist provider must pass before it may be enabled (I1-C; revision 2 §3.6).
 *
 * It runs the PRODUCTION pipeline — handleLayoutAssist: the same ai-sample/1, the same proposal mapping and the same
 * whole-file validation — over a labelled corpus, with only the database edges doubled (reservation always granted;
 * completion recorded in memory). Metrics:
 *   exactTemplateAccuracy  share of answerable cases whose suggested layout equals the expected layout exactly;
 *   fieldAccuracy          share of expected fields (sheet, header row, each column role, number format, sign) matched;
 *   fitAccuracy            share of answerable cases whose suggestion fits the whole file;
 *   refusalCorrectness     share of unanswerable cases (expected: null) where no fitting layout was suggested;
 *   latency p50 / p95 (ms) and mean cost per call (micro-units).
 * Thresholds are the owner's (revision 2 §9): they are required inputs — there are no defaults — and every metric must
 * meet its threshold for `passed`.
 */
import * as XLSX from "xlsx";
import { handleLayoutAssist, type LayoutAssistProvider } from "../../supabase/functions/_shared/layoutAssist";
import type { LayoutProfile } from "../../supabase/functions/_shared/layoutProfile";
import type { LayoutDeps } from "../../supabase/functions/_shared/trialBalanceLayout";
import type { XlsxLike } from "../../supabase/functions/_shared/tbSource";

export interface EvalCase { id: string; fileName: string; bytes: Uint8Array; currency: string; periodYear: number; expected: LayoutProfile | null }
export interface EvalThresholds {
  exactTemplateAccuracy: number; fieldAccuracy: number; fitAccuracy: number; refusalCorrectness: number;
  latencyP95Ms: number; meanCostMicros: number;
}
export interface EvalResult {
  cases: { id: string; outcome: string; exact: boolean | null; fields: [number, number] | null; fits: boolean | null; ms: number; costMicros: number | null }[];
  metrics: { exactTemplateAccuracy: number; fieldAccuracy: number; fitAccuracy: number; refusalCorrectness: number; latencyP50Ms: number; latencyP95Ms: number; meanCostMicros: number };
  passed: boolean;
  failures: string[];
}

const UPLOAD = "33333333-3333-4333-8333-333333333333";
const USER = "11111111-1111-4111-8111-111111111111";

function doubles(c: EvalCase) {
  const q = { select: () => q, eq: () => q, order: () => q, limit: async () => ({ data: [], error: null }) };
  const layout: LayoutDeps = {
    loadUpload: async () => ({ id: UPLOAD, company_id: "eval", file_path: `eval/${c.fileName}`, file_name: c.fileName, lifecycle_state: "active_unprocessed", period_year: c.periodYear }),
    rpc: (async (name: string) => {
      if (name === "tbu_resolve_processing_actor") return { data: [{ actor_type: "workspace_user", firm_member_id: null, authority_basis: "workspace_owner" }], error: null };
      if (name === "authorize_trial_balance_processing") return { data: { allowed: true, code: "ALLOWED" }, error: null };
      if (name === "tbu_upload_source_bound") return { data: true, error: null };
      return { data: null, error: { code: "42883" } };
    }) as never,
    db: { from: () => q } as never,
    download: async () => c.bytes,
    reportingCurrency: async () => c.currency,
    xlsx: XLSX as unknown as XlsxLike,
  };
  const rpc = (async (name: string) => (name === "ai_layout_assist_reserve"
    ? { data: { outcome: "reserved", runId: "eval", state: "reserved", replay: false }, error: null }
    : { data: { outcome: "completed" }, error: null })) as never;
  return { layout, rpc };
}

const FIELDS = (p: LayoutProfile): unknown[] => [
  JSON.stringify(p.sheet), p.headerRow, p.columns.accountCode, p.columns.accountName, p.columns.debit, p.columns.credit,
  p.columns.balance, JSON.stringify(p.columns.dimensions), p.numberFormat, p.balanceSign,
];
const quantile = (xs: number[], q: number) => { if (xs.length === 0) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; };

export async function evaluateLayoutAssist(provider: LayoutAssistProvider, corpus: EvalCase[], thresholds: EvalThresholds, now: () => number = () => performance.now()): Promise<EvalResult> {
  for (const k of ["exactTemplateAccuracy", "fieldAccuracy", "fitAccuracy", "refusalCorrectness", "latencyP95Ms", "meanCostMicros"] as const) {
    if (typeof thresholds?.[k] !== "number" || !Number.isFinite(thresholds[k])) throw new Error(`threshold ${k} is required (owner decision; no default)`);
  }
  if (corpus.length === 0) throw new Error("the corpus is empty");
  let cost: number | null = null;
  const metered: LayoutAssistProvider = { id: provider.id, model: provider.model, promptVersion: provider.promptVersion,
    propose: async (s, signal) => { const r = await provider.propose(s, signal); cost = r.costMicros; return r; } };
  const cases: EvalResult["cases"] = [];
  for (const c of corpus) {
    const { layout, rpc } = doubles(c);
    cost = null;
    const t0 = now();
    const r = await handleLayoutAssist(USER, { action: "suggest", uploadId: UPLOAD, requestId: "44444444-4444-4444-8444-444444444444" }, { layout, rpc, provider: metered });
    const ms = now() - t0;
    const got = r.status === 200 ? (r.body.layout as LayoutProfile) : null;
    const fits = r.status === 200 ? !!(r.body.report as { layoutFits?: boolean }).layoutFits : null;
    if (c.expected) {
      const e = FIELDS(c.expected), g = got ? FIELDS(got) : [];
      const matched = got ? e.filter((v, i) => v === g[i]).length : 0;
      cases.push({ id: c.id, outcome: String(r.body.status === "proposed" ? "proposed" : r.body.code), exact: !!got && matched === e.length, fields: [matched, e.length], fits, ms, costMicros: cost });
    } else {
      cases.push({ id: c.id, outcome: String(r.body.status === "proposed" ? "proposed" : r.body.code), exact: null, fields: null, fits, ms, costMicros: cost });
    }
  }
  const answerable = cases.filter((c) => c.fields);
  const unanswerable = cases.filter((c) => !c.fields);
  const share = (n: number, d: number) => (d === 0 ? 1 : n / d);
  const costs = cases.map((c) => c.costMicros).filter((x): x is number => x !== null);
  const metrics = {
    exactTemplateAccuracy: share(answerable.filter((c) => c.exact).length, answerable.length),
    fieldAccuracy: share(answerable.reduce((a, c) => a + c.fields![0], 0), answerable.reduce((a, c) => a + c.fields![1], 0)),
    fitAccuracy: share(answerable.filter((c) => c.fits).length, answerable.length),
    refusalCorrectness: share(unanswerable.filter((c) => c.fits !== true).length, unanswerable.length),
    latencyP50Ms: quantile(cases.map((c) => c.ms), 0.5),
    latencyP95Ms: quantile(cases.map((c) => c.ms), 0.95),
    // A call that reported no cost is counted at the threshold (never as free).
    meanCostMicros: cases.length === 0 ? 0 : (costs.reduce((a, b) => a + b, 0) + (cases.length - costs.length) * thresholds.meanCostMicros) / cases.length,
  };
  const failures: string[] = [];
  for (const k of ["exactTemplateAccuracy", "fieldAccuracy", "fitAccuracy", "refusalCorrectness"] as const) if (metrics[k] < thresholds[k]) failures.push(`${k} ${metrics[k].toFixed(3)} < ${thresholds[k]}`);
  if (metrics.latencyP95Ms > thresholds.latencyP95Ms) failures.push(`latencyP95Ms ${metrics.latencyP95Ms.toFixed(0)} > ${thresholds.latencyP95Ms}`);
  if (metrics.meanCostMicros > thresholds.meanCostMicros) failures.push(`meanCostMicros ${metrics.meanCostMicros.toFixed(0)} > ${thresholds.meanCostMicros}`);
  return { cases, metrics, passed: failures.length === 0, failures };
}
