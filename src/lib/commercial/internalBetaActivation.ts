// Internal beta activation (admin only). Pure helpers behind the "Internal beta" tab of /commercial/admin.
//
// The server is the only authority. Every read and change is an audited database function run under the
// administrator's own signed-in session (migration 20261203100000 and 20261202100000), each of which refuses anybody who
// is not an active commercial administrator:
//   internal_beta_admin_overview                 the state, including the policy revision every change is checked against
//   internal_beta_admin_open_reporting           allowlist = exactly the chosen companies → beta reporting on → master
//                                                switch released LAST, in one transaction
//   internal_beta_admin_close_reporting          master switch engaged FIRST → beta reporting off → allowlist emptied
//   internal_beta_admin_record_synthetic_context records the composition hash the DATABASE computes for a company/year
//   internal_beta_admin_stop_ai                  assistant spending off
//   internal_beta_configure (unchanged)          assistant spending on: model, dated prices, reservation, confirmations
// Nothing here decides access, computes a figure the server relies on, or treats an unanswered request as "not saved".

export interface BetaCompany {
  companyId: string;
  name: string;
  allowlisted: boolean;
  enrolledMembers: number;
  syntheticScopes: { periodYear: number; compositionSha256: string; recordedAt: string }[];
}
export interface BetaPrices { inputMicrosPerMTok: number; outputMicrosPerMTok: number; cacheWriteMicrosPerMTok: number; cacheReadMicrosPerMTok: number }
export interface BetaOverview {
  revision: number;
  reportingEnabled: boolean;
  aiEnabled: boolean;
  model: string | null;
  prices: BetaPrices | null;
  reservationMicros: number | null;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRequestSeconds: number;
  totalBudgetMicros: number;
  priorUsageReservedMicros: number;
  spentMicros: number;
  openRuns: number;
  remainingMicros: number;
  masterSwitchEngaged: boolean;
  reportingOpen: boolean;
  companies: BetaCompany[];
  events: { action: string; reason: string; at: string }[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isNonNegInt = (v: unknown): v is number => isInt(v) && v >= 0;

function parsePrices(v: unknown): BetaPrices | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const keys = ["inputMicrosPerMTok", "outputMicrosPerMTok", "cacheWriteMicrosPerMTok", "cacheReadMicrosPerMTok"] as const;
  if (!keys.every((k) => isInt(o[k]) && (o[k] as number) > 0)) return undefined;
  return { inputMicrosPerMTok: o.inputMicrosPerMTok as number, outputMicrosPerMTok: o.outputMicrosPerMTok as number,
    cacheWriteMicrosPerMTok: o.cacheWriteMicrosPerMTok as number, cacheReadMicrosPerMTok: o.cacheReadMicrosPerMTok as number };
}

/** Strict: anything that is not exactly the server's overview contract is "could not be read" (null), never a default. */
export function parseOverview(v: unknown): BetaOverview | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.contract !== "internal-beta-admin-overview/1") return null;
  const p = o.policy as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return null;
  if (!isInt(p.revision) || p.revision < 1 || typeof p.reportingEnabled !== "boolean" || typeof p.aiEnabled !== "boolean") return null;
  for (const k of ["maxInputTokens", "maxOutputTokens", "maxRequestSeconds", "totalBudgetMicros", "priorUsageReservedMicros", "spentMicros", "openRuns", "remainingMicros"]) {
    if (!isNonNegInt(p[k])) return null;
  }
  const prices = parsePrices(p.prices);
  if (prices === undefined) return null;
  if (p.reservationMicros !== null && p.reservationMicros !== undefined && !(isInt(p.reservationMicros) && p.reservationMicros > 0)) return null;
  if (typeof o.masterSwitchEngaged !== "boolean" || typeof o.reportingOpen !== "boolean" || !Array.isArray(o.companies) || !Array.isArray(o.events)) return null;
  const companies: BetaCompany[] = [];
  for (const c of o.companies as Record<string, unknown>[]) {
    if (!c || typeof c.companyId !== "string" || !UUID.test(c.companyId) || typeof c.allowlisted !== "boolean" || !isNonNegInt(c.enrolledMembers)
      || !Array.isArray(c.syntheticScopes)) return null;
    const scopes = (c.syntheticScopes as Record<string, unknown>[]).map((s) => ({ periodYear: s?.periodYear, compositionSha256: s?.compositionSha256, recordedAt: s?.recordedAt }));
    if (!scopes.every((s) => isInt(s.periodYear) && typeof s.compositionSha256 === "string" && SHA.test(s.compositionSha256) && typeof s.recordedAt === "string")) return null;
    companies.push({ companyId: c.companyId, name: typeof c.name === "string" && c.name.trim() ? c.name : "(no name)", allowlisted: c.allowlisted,
      enrolledMembers: c.enrolledMembers, syntheticScopes: scopes as BetaCompany["syntheticScopes"] });
  }
  const events = (o.events as Record<string, unknown>[]).filter((e) => e && typeof e.action === "string" && typeof e.reason === "string" && typeof e.at === "string")
    .map((e) => ({ action: e.action as string, reason: e.reason as string, at: e.at as string }));
  return {
    revision: p.revision, reportingEnabled: p.reportingEnabled, aiEnabled: p.aiEnabled,
    model: typeof p.model === "string" ? p.model : null, prices, reservationMicros: isInt(p.reservationMicros) ? p.reservationMicros : null,
    maxInputTokens: p.maxInputTokens as number, maxOutputTokens: p.maxOutputTokens as number, maxRequestSeconds: p.maxRequestSeconds as number,
    totalBudgetMicros: p.totalBudgetMicros as number, priorUsageReservedMicros: p.priorUsageReservedMicros as number,
    spentMicros: p.spentMicros as number, openRuns: p.openRuns as number, remainingMicros: p.remainingMicros as number,
    masterSwitchEngaged: o.masterSwitchEngaged, reportingOpen: o.reportingOpen, companies, events,
  };
}

const reasonError = (reason: string) => {
  const r = reason.trim();
  return r.length < 10 || r.length > 300 ? "Give a reason of 10 to 300 characters. It is recorded with the change." : null;
};

/** Which companies may be offered for opening: those with at least one enrolled member who still has workspace access. */
export const selectableForOpening = (o: BetaOverview) => o.companies.filter((c) => c.enrolledMembers > 0);

export function buildOpenArgs(o: BetaOverview, selected: readonly string[], reason: string):
  { args: { p_company_ids: string[]; p_reason: string; p_expected_revision: number } } | { error: string } {
  const re = reasonError(reason);
  if (re) return { error: re };
  const ids = [...new Set(selected)];
  if (ids.length === 0) return { error: "Choose at least one company." };
  if (ids.length > 25) return { error: "Choose at most 25 companies." };
  const offered = new Set(selectableForOpening(o).map((c) => c.companyId));
  if (!ids.every((id) => offered.has(id))) return { error: "Every chosen company needs at least one enrolled member." };
  return { args: { p_company_ids: ids, p_reason: reason.trim(), p_expected_revision: o.revision } };
}

export function buildReasonArgs(reason: string): { args: { p_reason: string } } | { error: string } {
  const re = reasonError(reason);
  return re ? { error: re } : { args: { p_reason: reason.trim() } };
}

export function buildSyntheticArgs(o: BetaOverview, companyId: string, periodYear: string, reason: string):
  { args: { p_company_id: string; p_period_year: number; p_reason: string } } | { error: string } {
  const re = reasonError(reason);
  if (re) return { error: re };
  if (!o.reportingOpen) return { error: "Open internal reporting first: the statements must be readable to record their identity." };
  if (!o.companies.some((c) => c.companyId === companyId && c.allowlisted)) return { error: "Choose a company that is open for internal reporting." };
  if (!/^\d{4}$/.test(periodYear.trim()) || Number(periodYear) < 2000 || Number(periodYear) > 2100) return { error: "Enter the period year (for example 2026)." };
  return { args: { p_company_id: companyId, p_period_year: Number(periodYear), p_reason: reason.trim() } };
}

/**
 * A price per million tokens in US dollars ("3", "0.30", "3.75") → exact micro-dollars per million tokens, or null.
 * Parsed from the digits (at most six decimals), so no binary rounding can change the recorded price.
 */
export function usdToMicros(text: string): number | null {
  const m = /^(\d{1,6})(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!m) return null;
  const micros = Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0") || "0");
  return micros > 0 && micros <= 100_000_000 ? micros : null;
}

/** The smallest reservation the server accepts: two calls at the bounds, every input token at the higher input rate. */
export function minimumReservationMicros(o: Pick<BetaOverview, "maxInputTokens" | "maxOutputTokens">, p: BetaPrices): number {
  const rate = Math.max(p.inputMicrosPerMTok, p.cacheWriteMicrosPerMTok);
  return 2 * Math.ceil((o.maxInputTokens * rate + o.maxOutputTokens * p.outputMicrosPerMTok) / 1_000_000);
}

export interface AiForm {
  model: string; inputUsd: string; outputUsd: string; cacheWriteUsd: string; cacheReadUsd: string;
  creditsConfirmed: boolean; pricingConfirmed: boolean; reason: string;
}

/** internal_beta_configure arguments that switch assistant spending ON, or the reason they cannot be built. */
export function buildAiArgs(o: BetaOverview, f: AiForm, nowIso: string):
  { args: { p_settings: Record<string, unknown>; p_reason: string; p_expected_revision: number }; reservationMicros: number } | { error: string } {
  const re = reasonError(f.reason);
  if (re) return { error: re };
  if (!o.reportingOpen) return { error: "Open internal reporting first." };
  if (!o.companies.some((c) => c.allowlisted && c.syntheticScopes.length > 0)) return { error: "Record the synthetic data for an open company first." };
  if (!/^[a-z0-9][a-z0-9.-]{2,80}$/.test(f.model.trim())) return { error: "Enter the provider's exact model identifier." };
  const prices = { inputMicrosPerMTok: usdToMicros(f.inputUsd), outputMicrosPerMTok: usdToMicros(f.outputUsd),
    cacheWriteMicrosPerMTok: usdToMicros(f.cacheWriteUsd), cacheReadMicrosPerMTok: usdToMicros(f.cacheReadUsd) };
  if (Object.values(prices).some((v) => v === null)) return { error: "Enter every price in US dollars per million tokens, as shown on the provider's current price list." };
  if (!f.pricingConfirmed) return { error: "Confirm that you checked these prices on the provider's current price list today." };
  if (!f.creditsConfirmed) return { error: "Confirm that you checked the provider account's remaining credit today." };
  const reservationMicros = minimumReservationMicros(o, prices as BetaPrices);
  if (reservationMicros > o.remainingMicros) return { error: "One request's reservation is larger than the remaining allowance, so no request could run." };
  return {
    reservationMicros,
    args: {
      p_settings: { aiEnabled: true, model: f.model.trim(), prices, reservationMicros, creditsConfirmedAt: nowIso, pricingConfirmedAt: nowIso },
      p_reason: f.reason.trim(),
      p_expected_revision: o.revision,
    },
  };
}

export const OUTCOME_UNCONFIRMED =
  "The result could not be confirmed: the change may or may not have been saved. The state below was re-read; check it before trying again.";

export type BetaAction = "open" | "close" | "synthetic" | "stop_ai" | "enable_ai";

/**
 * Text for a write's error. Each function is ONE database transaction: an error carrying a database code means it was
 * refused and rolled back ("Nothing was changed"). An error without a code, or a thrown request, may have committed.
 * Decided from the structured code and the action only — never from message text.
 */
export function describeWriteError(action: BetaAction, e: { code?: string } | null | undefined): string {
  const code = e?.code;
  // PostgREST answers PGRST202 when the function does not exist on the server: nothing ran.
  if (code === "PGRST202") return "This control is not installed on the server yet. Nothing was changed.";
  if (!code || !/^[0-9A-Z]{5}$/.test(code)) return OUTCOME_UNCONFIRMED;
  if (code === "42501") return "Your account is not an active commercial administrator. Nothing was changed.";
  if (code === "PT409") return "Someone changed the beta settings since this page loaded. The current state was re-read; review it and try again. Nothing was changed.";
  if (code === "PT422" && action === "open") return "A chosen company has no enrolled member with access. Nothing was changed.";
  if (code === "PT422" && action === "synthetic") return "Those statements are not available to your account for that year, so nothing was recorded.";
  if (code === "P0002") return "A chosen company no longer exists. Nothing was changed.";
  if (code === "22023") return "The request was not accepted (check the reason and choices). Nothing was changed.";
  return "The database refused the change. Nothing was changed.";
}

export function describeWriteOutcome(action: BetaAction, write: { error: { code?: string } | null } | "thrown", readBack: boolean): { ok: boolean; text: string } {
  const after = readBack ? "" : " The current state could not be read; refresh before doing anything else.";
  if (write === "thrown") return { ok: false, text: OUTCOME_UNCONFIRMED + after };
  if (write.error) return { ok: false, text: describeWriteError(action, write.error) + after };
  const done: Record<BetaAction, string> = {
    open: "Internal reporting is open for the chosen companies.",
    close: "Internal reporting is closed. The master switch is engaged.",
    synthetic: "The synthetic data's identity is recorded for the assistant.",
    stop_ai: "Assistant spending is off.",
    enable_ai: "Assistant spending is on, within the remaining allowance.",
  };
  return { ok: true, text: done[action] + after };
}

export const usd = (micros: number) => `USD ${(micros / 1_000_000).toFixed(4)}`;
