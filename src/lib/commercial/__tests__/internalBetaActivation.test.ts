/**
 * Internal beta activation (admin) — the pure helpers behind the "Internal beta" tab, the panel's wiring and the
 * migration's authority shape. Real-database behaviour is proven by scripts/db-proof/internalBetaActivation.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAiArgs, buildOpenArgs, buildReasonArgs, buildSyntheticArgs, describeWriteError, describeWriteOutcome, minimumReservationMicros,
  OUTCOME_UNCONFIRMED, parseOverview, usdToMicros, type AiForm,
} from "../internalBetaActivation";

const A = "659daa94-116c-4803-99f8-157e0bdd4c62";
const B = "11111111-1111-4111-8111-111111111111";
const C = "22222222-2222-4222-8222-222222222222";
const SHA = "c".repeat(64);
const raw = (over: Record<string, unknown> = {}, policy: Record<string, unknown> = {}) => ({
  contract: "internal-beta-admin-overview/1",
  policy: { revision: 1, reportingEnabled: false, aiEnabled: false, model: null, prices: null, reservationMicros: null,
    creditsConfirmedAt: null, pricingConfirmedAt: null, maxInputTokens: 20000, maxOutputTokens: 1200, maxRequestSeconds: 30,
    totalBudgetMicros: 5000000, priorUsageReservedMicros: 1341400, spentMicros: 0, openRuns: 0, remainingMicros: 3658600, ...policy },
  masterSwitchEngaged: true, reportingOpen: false,
  companies: [
    { companyId: A, name: "Acceptance", allowlisted: true, enrolledMembers: 1, syntheticScopes: [] },
    { companyId: B, name: "Other", allowlisted: false, enrolledMembers: 2, syntheticScopes: [] },
    { companyId: C, name: "Empty", allowlisted: false, enrolledMembers: 0, syntheticScopes: [] },
  ],
  events: [], rolloutAudit: [], ...over,
});
const ov = (over = {}, policy = {}) => parseOverview(raw(over, policy))!;

describe("parseOverview — strict; anything unexpected is 'could not be read'", () => {
  it("reads the server's contract", () => {
    const o = ov();
    expect(o).toMatchObject({ revision: 1, masterSwitchEngaged: true, reportingOpen: false, remainingMicros: 3658600 });
    expect(o.companies.map((c) => c.companyId)).toEqual([A, B, C]);
  });
  it("refuses another contract, a missing switch, a fractional revision, a bad company id or a bad scope hash", () => {
    expect(parseOverview(null)).toBeNull();
    expect(parseOverview({ ...raw(), contract: "x" })).toBeNull();
    expect(parseOverview({ ...raw(), masterSwitchEngaged: undefined })).toBeNull();
    expect(parseOverview(raw({}, { revision: 1.5 }))).toBeNull();
    expect(parseOverview(raw({ companies: [{ companyId: "nope", name: "x", allowlisted: true, enrolledMembers: 1, syntheticScopes: [] }] }))).toBeNull();
    expect(parseOverview(raw({ companies: [{ companyId: A, name: "x", allowlisted: true, enrolledMembers: 1, syntheticScopes: [{ periodYear: 2026, compositionSha256: "zz", recordedAt: "t" }] }] }))).toBeNull();
    expect(parseOverview(raw({}, { prices: { inputMicrosPerMTok: 3 } }))).toBeNull();
  });
});

describe("opening — exactly the chosen companies, at the revision that was read", () => {
  const reason = "Open internal beta reporting for acceptance";
  it("builds the arguments with the overview's revision", () => {
    expect(buildOpenArgs(ov({}, { revision: 4 }), [A, A], reason)).toEqual({ args: { p_company_ids: [A], p_reason: reason, p_expected_revision: 4 } });
  });
  it("refuses a short reason, an empty choice, or a company without an enrolled member", () => {
    expect(buildOpenArgs(ov(), [A], "short")).toHaveProperty("error");
    expect(buildOpenArgs(ov(), [], reason)).toHaveProperty("error");
    expect(buildOpenArgs(ov(), [A, C], reason)).toHaveProperty("error");
  });
  it("close and stop need only a reason (always safe)", () => {
    expect(buildReasonArgs("Close internal beta reporting now")).toEqual({ args: { p_reason: "Close internal beta reporting now" } });
    expect(buildReasonArgs("no")).toHaveProperty("error");
  });
});

describe("synthetic scope — only for an open company, only once reporting is open", () => {
  const reason = "Synthetic acceptance data for the assistant";
  it("refused while reporting is closed", () => expect(buildSyntheticArgs(ov(), A, "2026", reason)).toHaveProperty("error"));
  it("refused for a company not on the open list, or a malformed year", () => {
    const open = ov({ reportingOpen: true, masterSwitchEngaged: false }, { reportingEnabled: true });
    expect(buildSyntheticArgs(open, B, "2026", reason)).toHaveProperty("error");
    expect(buildSyntheticArgs(open, A, "26", reason)).toHaveProperty("error");
    expect(buildSyntheticArgs(open, A, "2026", reason)).toEqual({ args: { p_company_id: A, p_period_year: 2026, p_reason: reason } });
  });
});

describe("assistant spending — prices exactly, reservation as the server requires it", () => {
  it("parses dollar prices from the digits (no binary rounding)", () => {
    expect(usdToMicros("3")).toBe(3_000_000);
    expect(usdToMicros("0.30")).toBe(300_000);
    expect(usdToMicros("3.75")).toBe(3_750_000);
    expect(usdToMicros("0.000001")).toBe(1);
    for (const bad of ["", "-1", "1e3", "0", "3.1234567", "abc", "101"]) expect(usdToMicros(bad), bad).toBeNull();
  });
  it("minimum reservation: 2 × ceil(20,000 × max(input, cache write) + 1,200 × output) / 1e6 — worked by hand", () => {
    // input $3, cache write $3.75, output $15: 20,000 × 3.75 = 75,000 + 1,200 × 15 = 18,000 → 93,000 micro-dollars ×2.
    expect(minimumReservationMicros({ maxInputTokens: 20000, maxOutputTokens: 1200 },
      { inputMicrosPerMTok: 3_000_000, cacheWriteMicrosPerMTok: 3_750_000, outputMicrosPerMTok: 15_000_000, cacheReadMicrosPerMTok: 300_000 })).toBe(186_000);
  });
  const form: AiForm = { model: "claude-test-model", inputUsd: "3", outputUsd: "15", cacheWriteUsd: "3.75", cacheReadUsd: "0.30",
    creditsConfirmed: true, pricingConfirmed: true, reason: "Switch on synthetic assistant testing" };
  const ready = () => ov({ reportingOpen: true, masterSwitchEngaged: false,
    companies: [{ companyId: A, name: "Acceptance", allowlisted: true, enrolledMembers: 1, syntheticScopes: [{ periodYear: 2026, compositionSha256: SHA, recordedAt: "2026-10-25T00:00:00Z" }] }] },
    { reportingEnabled: true, revision: 3 });
  it("builds internal_beta_configure settings with the confirmations dated now and the revision read", () => {
    const r = buildAiArgs(ready(), form, "2026-10-25T13:00:00.000Z");
    expect(r).toEqual({ reservationMicros: 186_000, args: { p_reason: "Switch on synthetic assistant testing", p_expected_revision: 3, p_settings: {
      aiEnabled: true, model: "claude-test-model", reservationMicros: 186_000, creditsConfirmedAt: "2026-10-25T13:00:00.000Z", pricingConfirmedAt: "2026-10-25T13:00:00.000Z",
      prices: { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000, cacheWriteMicrosPerMTok: 3_750_000, cacheReadMicrosPerMTok: 300_000 } } } });
  });
  it("refuses without both confirmations, without synthetic data, with reporting closed, or when one reservation exceeds what is left", () => {
    expect(buildAiArgs(ready(), { ...form, creditsConfirmed: false }, "t")).toHaveProperty("error");
    expect(buildAiArgs(ready(), { ...form, pricingConfirmed: false }, "t")).toHaveProperty("error");
    expect(buildAiArgs(ov({ reportingOpen: true }, { reportingEnabled: true }), form, "t")).toHaveProperty("error");
    expect(buildAiArgs(ov(), form, "t")).toHaveProperty("error");
    const poor = parseOverview({ ...raw({ reportingOpen: true, companies: [{ companyId: A, name: "A", allowlisted: true, enrolledMembers: 1, syntheticScopes: [{ periodYear: 2026, compositionSha256: SHA, recordedAt: "t" }] }] }, { remainingMicros: 100_000 }) })!;
    expect(buildAiArgs(poor, form, "t")).toHaveProperty("error");
  });
});

describe("outcomes — a coded database error was rolled back; no code means unconfirmed", () => {
  it("coded refusals say nothing was changed", () => {
    expect(describeWriteError("open", { code: "42501" })).toMatch(/not an active commercial administrator\. Nothing was changed/);
    expect(describeWriteError("open", { code: "PT409" })).toMatch(/Nothing was changed/);
    expect(describeWriteError("open", { code: "PT422" })).toMatch(/no enrolled member/);
    expect(describeWriteError("synthetic", { code: "PT422" })).toMatch(/not available/);
    expect(describeWriteError("close", { code: "PGRST202" })).toMatch(/not installed/);
  });
  it("no code, a non-database code, or a thrown request is UNCONFIRMED — never 'nothing changed'", () => {
    for (const e of [null, {}, { code: "PGRST301" }, { code: "" }]) expect(describeWriteError("open", e as { code?: string })).toBe(OUTCOME_UNCONFIRMED);
    expect(describeWriteOutcome("close", "thrown", true)).toEqual({ ok: false, text: OUTCOME_UNCONFIRMED });
    expect(describeWriteOutcome("close", "thrown", false).text).toMatch(/could not be read/);
    expect(describeWriteOutcome("open", { error: null }, true)).toEqual({ ok: true, text: "Internal reporting is open for the chosen companies." });
  });
});

describe("wiring (source)", () => {
  const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), "utf8");
  const panel = read("../../../components/commercial/InternalBetaActivationPanel.tsx");
  const page = read("../../../pages/commercial/CommercialAdmin.tsx");
  const sql = read("../../../../supabase/migrations/20261203100000_internal_beta_admin_activation.sql");
  it("the admin page has the Internal beta tab, reachable by ?tab=internal-beta", () => {
    expect(page).toMatch(/<TabsTrigger value="internal-beta">Internal beta<\/TabsTrigger>/);
    expect(page).toMatch(/<TabsContent value="internal-beta"><InternalBetaActivationPanel \/><\/TabsContent>/);
    expect(page).toMatch(/"internal-beta"\]/);
  });
  it("the panel calls only the audited functions and re-reads the state after every write", () => {
    for (const fn of ["internal_beta_admin_overview", "internal_beta_admin_open_reporting", "internal_beta_admin_close_reporting",
      "internal_beta_admin_record_synthetic_context", "internal_beta_admin_stop_ai", "internal_beta_configure"]) expect(panel).toContain(`"${fn}"`);
    expect(panel).toMatch(/const readBack = await load\(\);\s*const outcome = describeWriteOutcome\(action, write, readBack\);/);
    expect(panel).not.toMatch(/\.from\(/);
  });
  it("every new function refuses anybody who is not an active commercial administrator, and only authenticated may execute", () => {
    const fns = [...sql.matchAll(/CREATE FUNCTION public\.(internal_beta_admin_\w+)\(/g)].map((m) => m[1]);
    expect(fns.sort()).toEqual(["internal_beta_admin_close_reporting", "internal_beta_admin_open_reporting", "internal_beta_admin_overview",
      "internal_beta_admin_record_synthetic_context", "internal_beta_admin_stop_ai"]);
    for (const f of fns) {
      const body = sql.slice(sql.indexOf(`CREATE FUNCTION public.${f}(`)).split("\n$$;")[0];
      expect(body, f).toMatch(/public\._internal_beta_require_admin\(\)/);
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${f}\\([^)]*\\) FROM PUBLIC, anon, service_role;`));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${f}\\([^)]*\\) TO authenticated;`));
    }
    expect(sql).toMatch(/commercial_admins WHERE user_id = auth\.uid\(\) AND active/);
  });
  it("opening releases the master switch LAST; closing engages it FIRST", () => {
    const open = sql.slice(sql.indexOf("CREATE FUNCTION public.internal_beta_admin_open_reporting"), sql.indexOf("CREATE FUNCTION public.internal_beta_admin_close_reporting"));
    expect(open.lastIndexOf("SET enabled = true")).toBeLessThan(open.indexOf("SET kill_switch = false"));
    expect(open.indexOf("reporting_enabled = true")).toBeLessThan(open.indexOf("SET kill_switch = false"));
    const close = sql.slice(sql.indexOf("CREATE FUNCTION public.internal_beta_admin_close_reporting"), sql.indexOf("CREATE FUNCTION public.internal_beta_admin_stop_ai"));
    expect(close.indexOf("SET kill_switch = true")).toBeLessThan(close.indexOf("reporting_enabled = false"));
    expect(close.indexOf("reporting_enabled = false")).toBeLessThan(close.indexOf("SET enabled = false"));
  });
});
