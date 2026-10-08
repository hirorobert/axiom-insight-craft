/**
 * layout-assist (supabase/functions/_shared/layoutAssist.ts, I1-C): data minimization (ai-sample/1), the constrained
 * proposal (layout-proposal/1 → layout-template/1 by column INDEX), and the handler's order of gates — no provider means
 * nothing is read; nothing reaches a provider before authorization, a failed automatic reading and a database
 * reservation (consent, quota, budget); a proposal is validated against the whole file and is never confirmed.
 */
import * as XLSX from "xlsx";
import { describe, expect, it, vi } from "vitest";
import {
  buildAiSample, handleLayoutAssist, proposalToProfile, sampleToken, SAMPLE_COLUMNS, SAMPLE_ROWS,
  type AiSample, type InspectSheet, type LayoutAssistProvider,
} from "../../../supabase/functions/_shared/layoutAssist";
import type { LayoutDeps } from "../../../supabase/functions/_shared/trialBalanceLayout";
import type { XlsxLike } from "../../../supabase/functions/_shared/tbSource";

const USER = "11111111-1111-4111-8111-111111111111";
const UPLOAD = "33333333-3333-4333-8333-333333333333";
const REQUEST = "44444444-4444-4444-8444-444444444444";
// Custom headers the automatic reading does not understand; account names and amounts that must never leave.
const CSV = "Kontonummer;Kontobezeichnung;Soll;Haben\n1000;Bank Mkombozi Ltd;\"1.500,25\";\n3000;Share capital Mwana Holdings;;\"1.000,00\"\n4000;Sales to Juma Traders;;\"900,25\"\n6000;Rent Kariakoo;\"400,00\";\n";
const SECRETS = ["Mkombozi", "Mwana", "Juma", "Kariakoo", "Bank", "Share capital", "Sales", "Rent", "1.500,25", "1500", "900", "400", "1000", "3000", "4000", "6000"];
const GOOD = { format: "layout-proposal/1", sheetIndex: 0, headerRow: 1, columns: { accountCode: 0, accountName: 1, debit: 2, credit: 3, balance: null, dimensions: [] }, numberFormat: "dot_comma", balanceSign: null };

function layoutDeps(csv = CSV) {
  const log: string[] = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    log.push(`rpc:${name}`);
    if (name === "tbu_resolve_processing_actor") return { data: [{ actor_type: "workspace_user", firm_member_id: null, authority_basis: "workspace_owner" }], error: null };
    if (name === "authorize_trial_balance_processing") return { data: { allowed: true, code: "ALLOWED" }, error: null };
    if (name === "tbu_upload_source_bound") return { data: true, error: null };
    return { data: null, error: { code: "42883", message: `no double for ${name} ${JSON.stringify(args).length}` } };
  });
  const q = { select: () => q, eq: () => q, order: () => q, limit: async () => ({ data: [], error: null }) };
  const d: LayoutDeps = {
    loadUpload: async () => { log.push("loadUpload"); return { id: UPLOAD, company_id: "c", file_path: "p/tb.csv", file_name: "tb.csv", lifecycle_state: "active_unprocessed", period_year: 2025 }; },
    rpc: rpc as never, db: { from: () => q } as never,
    download: async () => { log.push("download"); return new TextEncoder().encode(csv); },
    reportingCurrency: async () => "TZS",
    xlsx: XLSX as unknown as XlsxLike,
  };
  return { d, log };
}
function assistDeps(opts: { provider?: LayoutAssistProvider | null; reserve?: Record<string, unknown>; csv?: string } = {}) {
  const { d, log } = layoutDeps(opts.csv);
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "ai_layout_assist_reserve") return { data: opts.reserve ?? { outcome: "reserved", runId: "run-1", state: "reserved", replay: false }, error: null };
    if (name === "ai_layout_assist_complete") return { data: { outcome: "completed" }, error: null };
    return { data: null, error: { code: "42883" } };
  });
  return { deps: { layout: d, provider: opts.provider === undefined ? null : opts.provider, rpc: rpc as never, timeoutMs: 1000 }, calls, log };
}
const provider = (impl: (s: AiSample) => Promise<{ proposal: unknown; costMicros: number | null }>) => {
  const seen: AiSample[] = [];
  const p: LayoutAssistProvider = { id: "test", model: "m", promptVersion: "p1", propose: vi.fn(async (s: AiSample) => { seen.push(s); return impl(s); }) };
  return { p, seen };
};
const suggest = (deps: Parameters<typeof handleLayoutAssist>[2], extra: Record<string, unknown> = {}) =>
  handleLayoutAssist(USER, { action: "suggest", uploadId: UPLOAD, requestId: REQUEST, ...extra }, deps);

describe("ai-sample/1 — data minimization", () => {
  it("allow-listed heading words pass (normalized); everything else is a shape", () => {
    expect(sampleToken("Debit")).toBe("head:debit");
    expect(sampleToken("Soll")).toBe("head:soll");
    expect(sampleToken("Closing balance")).toBe("head:closing balance");
    expect(sampleToken("2025")).toBe("year:2025");
    expect(sampleToken("1.500,25")).toBe("num:9.999,99");
    expect(sampleToken("(12,345,678.90)")).toBe("num:(99,999,999.99)");
    expect(sampleToken("123456789")).toBe("num:9999+");
    expect(sampleToken("31/12/2025")).toBe("date");
    expect(sampleToken("Bank Mkombozi Ltd")).toBe("text:medium");
    expect(sampleToken("Kontonummer")).toBe("text:short");
    expect(sampleToken(null)).toBe("");
  });
  it("property: over 2,000 generated cells, no token carries a digit (except a lone year) or any non-allow-listed word", () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const words = ["Bank", "Mkombozi", "Ltd", "Juma", "Traders", "Rent", "Salary", "debit", "credit", "balance", "Soll", "account", "code"];
    for (let i = 0; i < 2000; i++) {
      const kind = Math.floor(rnd() * 4);
      const cell = kind === 0 ? String(Math.floor(rnd() * 1e9) / 100)
        : kind === 1 ? `${Math.floor(rnd() * 999)}.${Math.floor(rnd() * 999)},${Math.floor(rnd() * 99)}`
        : kind === 2 ? Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => words[Math.floor(rnd() * words.length)]).join(" ")
        : `${words[Math.floor(rnd() * words.length)]} ${Math.floor(rnd() * 99999)}`;
      const t = sampleToken(cell);
      if (!t.startsWith("year:")) expect(t, cell).not.toMatch(/[0-8]/);
      const visible = t.replace(/^(head|num|text|year):/, "");
      for (const w of ["bank", "mkombozi", "ltd", "juma", "traders", "rent", "salary"]) expect(visible.toLowerCase(), cell).not.toContain(w);
    }
  });
  it("a whole file's sample names no account, amount, code or sheet; bounded rows and columns", () => {
    const sheets: InspectSheet[] = [{ name: "Mkombozi TB FY2025", rowCount: 500, suggestion: null,
      preview: Array.from({ length: 40 }, (_, i) => ({ rowNumber: i + 1, cells: Array.from({ length: 45 }, (_, j) => (i === 0 ? `Col${j}` : `Bank Mkombozi ${i * 1000 + j}`)) })) }];
    const s = buildAiSample(sheets);
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/Mkombozi|Bank|FY2025/);
    expect(s.sheets[0].rows).toHaveLength(SAMPLE_ROWS);
    expect(s.sheets[0].rows[0]).toHaveLength(SAMPLE_COLUMNS);
    expect(s.sheets[0]).toMatchObject({ index: 0, kind: "sheet", rowCount: 500 });
  });
});

describe("layout-proposal/1 → layout-template/1", () => {
  const sheets: InspectSheet[] = [{ name: null, rowCount: 5, suggestion: null, preview: [{ rowNumber: 1, cells: ["Kontonummer", "Kontobezeichnung", "Soll", "Haben"] }] }];
  it("indices map to the file's real headers; the result passes the same profile validation as a person's layout", () => {
    const r = proposalToProfile(GOOD, sheets);
    expect(r.ok && r.profile).toEqual({ format: "layout-template/1", sheet: { kind: "csv" }, headerRow: 1, numberFormat: "dot_comma", balanceSign: null,
      columns: { accountCode: "Kontonummer", accountName: "Kontobezeichnung", debit: "Soll", credit: "Haben", balance: null, dimensions: [] } });
  });
  it.each([
    ["an extra field (e.g. amounts)", { ...GOOD, amounts: { "1000": 5 } }],
    ["a wrong format", { ...GOOD, format: "layout-template/1" }],
    ["a column outside the sample", { ...GOOD, columns: { ...GOOD.columns, debit: 31 } }],
    ["an empty heading cell", { ...GOOD, columns: { ...GOOD.columns, debit: 9 } }],
    ["a header row outside the sample", { ...GOOD, headerRow: 16 }],
    ["an unknown number format", { ...GOOD, numberFormat: "guess" }],
    ["an unknown column role", { ...GOOD, columns: { ...GOOD.columns, tax: 2 } }],
    ["a classification or treatment", { ...GOOD, classification: "revenue" }],
    ["not an object", "use columns 0-3"],
  ])("refused: %s", (_label, raw) => {
    expect(proposalToProfile(raw, sheets).ok).toBe(false);
  });
});

describe("handler — order of gates", () => {
  it("no provider (production wiring today): PROVIDER_DISABLED before anything is read or reserved", async () => {
    const { deps, calls, log } = assistDeps({ provider: null });
    const r = await suggest(deps);
    expect([r.status, r.body.code]).toEqual([503, "PROVIDER_DISABLED"]);
    expect(log).toEqual([]);
    expect(calls).toEqual([]);
  });
  it("a request without a valid request id is refused before anything", async () => {
    const { p } = provider(async () => ({ proposal: GOOD, costMicros: 1 }));
    const { deps, log } = assistDeps({ provider: p });
    expect((await handleLayoutAssist(USER, { action: "suggest", uploadId: UPLOAD }, deps)).status).toBe(400);
    expect(log).toEqual([]);
  });
  it("the automatic reading works: refused, no reservation, provider never called", async () => {
    const { p } = provider(async () => ({ proposal: GOOD, costMicros: 1 }));
    const { deps, calls } = assistDeps({ provider: p, csv: "Account code,Account name,Debit,Credit\n1000,Bank,10.00,\n3000,Capital,,10.00\n" });
    const r = await suggest(deps);
    expect([r.status, r.body.code]).toEqual([409, "AUTOMATIC_READING_AVAILABLE"]);
    expect(calls).toEqual([]);
    expect(p.propose).not.toHaveBeenCalled();
  });
  it.each(["CONSENT_REQUIRED", "QUOTA_EXCEEDED", "AI_BUDGET_EXCEEDED", "PROVIDER_DISABLED", "FORBIDDEN"])("reservation refused (%s): the provider is never called", async (code) => {
    const { p } = provider(async () => ({ proposal: GOOD, costMicros: 1 }));
    const { deps, calls } = assistDeps({ provider: p, reserve: { outcome: "refused", code } });
    const r = await suggest(deps);
    expect(r.body.code).toBe(code);
    expect(p.propose).not.toHaveBeenCalled();
    expect(calls.map((c) => c.name)).toEqual(["ai_layout_assist_reserve"]);
  });
  it("success: the provider sees only the minimized sample; the suggestion is validated against the whole file, recorded as advisory, never confirmed", async () => {
    const { p, seen } = provider(async () => ({ proposal: GOOD, costMicros: 1200 }));
    const { deps, calls } = assistDeps({ provider: p });
    const r = await suggest(deps);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "proposed", advisory: true, runId: "run-1" });
    const sent = JSON.stringify(seen[0]);
    for (const s of SECRETS) expect(sent, s).not.toContain(s);
    const report = r.body.report as { layoutFits: boolean; rows: unknown[]; totals: { debit: string } };
    expect(report.layoutFits).toBe(true);
    expect(report.rows).toHaveLength(5);                         // every row of the file, not the sample
    expect(report.totals.debit).toBe("1900.25");
    const reserve = calls.find((c) => c.name === "ai_layout_assist_reserve")!.args;
    expect(reserve).toMatchObject({ p_user_id: USER, p_upload_id: UPLOAD, p_request_id: REQUEST });
    expect(reserve.p_sample_sha256).toMatch(/^[0-9a-f]{64}$/);
    const done = calls.find((c) => c.name === "ai_layout_assist_complete")!.args;
    expect(done).toMatchObject({ p_run_id: "run-1", p_state: "proposed", p_actual_cost_micros: 1200 });
    expect(calls.map((c) => c.name)).not.toContain("layout_record_confirmation");
    // The reservation precedes the provider call.
    expect((p.propose as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeGreaterThan(deps.rpc.mock.invocationCallOrder[0]);
  });
  it("an unusable proposal: recorded as invalid with its cost; 422 with the manual path", async () => {
    const { p } = provider(async () => ({ proposal: { ...GOOD, columns: { ...GOOD.columns, debit: 25 } }, costMicros: 900 }));
    const { deps, calls } = assistDeps({ provider: p });
    const r = await suggest(deps);
    expect([r.status, r.body.code]).toEqual([422, "SUGGESTION_UNUSABLE"]);
    expect(String(r.body.message)).toMatch(/manually/);
    expect(calls.find((c) => c.name === "ai_layout_assist_complete")!.args).toMatchObject({ p_state: "invalid", p_actual_cost_micros: 900, p_proposal: null });
  });
  it("a provider failure or timeout: recorded as failed at the reserved ceiling (cost unknown is never free); 502", async () => {
    const { p } = provider(async () => { throw new Error("timeout"); });
    const { deps, calls } = assistDeps({ provider: p });
    const r = await suggest(deps);
    expect([r.status, r.body.code]).toEqual([502, "PROVIDER_FAILED"]);
    expect(calls.find((c) => c.name === "ai_layout_assist_complete")!.args).toMatchObject({ p_state: "failed", p_actual_cost_micros: null });
  });
  it("a retried request returns the recorded suggestion without a new provider call", async () => {
    const { p } = provider(async () => ({ proposal: GOOD, costMicros: 1 }));
    const { deps } = assistDeps({ provider: p, reserve: { outcome: "reserved", runId: "run-1", state: "proposed", replay: true, proposal: { x: 1 }, validation: { layoutFits: true } } });
    const r = await suggest(deps);
    expect(r.body).toMatchObject({ status: "proposed", replay: true, layout: { x: 1 } });
    expect(p.propose).not.toHaveBeenCalled();
  });
});
