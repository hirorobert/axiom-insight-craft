/**
 * Ask CFOClose (Release 0.1) — the gateway's decisions, independent of Deno so tests and the database proof run the same code.
 *
 *   1. Validate the request (action, company, period, line, request id, an optional ENUMERATED draft refinement — there is
 *      no free-form prompt in Release 0.1, so no user text reaches the model).
 *   2. No provider configured → refused before anything is read.
 *   3. Read the composed statements WITH THE PERSON'S OWN CREDENTIALS (the database decides access), build the envelope.
 *      A composition that is not available is answered without any model call.
 *   4. Reserve in the database (service role): access re-derived, workspace enabled under current terms, quota, per-user
 *      and per-workspace concurrency, pessimistic monthly cost, idempotency (same request id + same payload replays).
 *   5. At most two provider calls: the request and ONE correction if validation refused the first answer, both inside the
 *      configured time bound. Ambiguous outcomes are recorded as such and never retried.
 *   6. Before anything is returned the composition is read again as the person: access lost → nothing is disclosed;
 *      figures changed → a stale-context answer asking for a refresh.
 *   7. The answer is recorded first; only a recorded answer is returned. Figures are rendered from fact records.
 */
import { canonicalJson, sha256Hex } from "./hash.ts";
import { ACTIONS, buildEnvelope, envelopeDigest, type AssistantAction } from "./assistantFacts.ts";
import { parseModelJson, renderResponse, validateResponse, type RenderedAnswer } from "./assistantResponse.ts";
import {
  buildUserMessage, correctionMessage, costMicros, estimateTokens, MAX_QUOTED_ANSWER_CHARS, ProviderError, REFINEMENTS, SYSTEM_PROMPT,
  type AssistantProvider, type Prices, type ProviderMessage, type Refinement, type Usage,
} from "./assistantProvider.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LINE_ID = /^[a-z0-9_.]{1,200}$/;

export interface AssistantRequest { action: AssistantAction; companyId: string; periodYear: number; lineId: string; requestId: string; refinement: Refinement | null }
export type RpcAnswer = { data: unknown; error: { code?: string; message?: string } | null };
export interface AssistantDeps {
  /** null = no provider configured: every request is refused before anything is read. */
  provider: AssistantProvider | null;
  /** fs_statement_composition, called with the PERSON'S credentials (never the service role). */
  readComposition(companyId: string, periodYear: number): Promise<unknown>;
  /** Service-role RPC (reserve / complete only). */
  rpc(name: string, args: Record<string, unknown>): PromiseLike<RpcAnswer>;
  now(): number;
}
export interface AssistantHttp { status: number; body: Record<string, unknown> }

const refused = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): AssistantHttp =>
  ({ status, body: { status: "refused", code, message, ...extra } });

const MESSAGES: Record<string, [number, string]> = {
  INVALID_REQUEST: [400, "The request was not understood."],
  PROVIDER_DISABLED: [503, "Ask CFOClose is switched off. Your statements and reports are unaffected."],
  FORBIDDEN: [403, "You do not have access to these statements."],
  ASSISTANT_NOT_ENABLED: [503, "Ask CFOClose has not been enabled for this workspace."],
  REQUEST_ID_REUSED: [409, "This request was already used for a different question. Ask again."],
  AI_BUDGET_EXCEEDED: [429, "This workspace's assistant allowance is used up for this month. Everything else keeps working."],
  QUOTA_EXCEEDED: [429, "You have reached today's assistant limit. Everything else keeps working."],
  USER_BUSY: [409, "Your previous request is still running."],
  CONCURRENCY_LIMIT: [429, "The assistant is busy for this workspace. Try again shortly."],
};
const refusedCode = (code: string) => { const [s, m] = MESSAGES[code] ?? [503, "The assistant is unavailable."]; return refused(s, code, m); };

export function parseRequest(body: unknown): AssistantRequest | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.some((k) => !["action", "companyId", "periodYear", "lineId", "requestId", "refinement"].includes(k))) return null;
  if (!ACTIONS.includes(b.action as AssistantAction)) return null;
  if (typeof b.companyId !== "string" || !UUID.test(b.companyId)) return null;
  if (!Number.isInteger(b.periodYear) || (b.periodYear as number) < 2000 || (b.periodYear as number) > 2100) return null;
  if (typeof b.lineId !== "string" || !LINE_ID.test(b.lineId)) return null;
  if (typeof b.requestId !== "string" || !UUID.test(b.requestId)) return null;
  const refinement = b.refinement ?? null;
  if (refinement !== null && (b.action !== "draft_commentary" || !REFINEMENTS.includes(refinement as Refinement))) return null;
  return { action: b.action as AssistantAction, companyId: b.companyId, periodYear: b.periodYear as number, lineId: b.lineId, requestId: b.requestId, refinement: refinement as Refinement | null };
}

const addUsage = (a: Usage, b: Usage): Usage => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens, cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens });
const ZERO: Usage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };

export async function handleAssistant(userId: string, body: unknown, deps: AssistantDeps): Promise<AssistantHttp> {
  const req = parseRequest(body);
  if (!req) return refusedCode("INVALID_REQUEST");
  if (!deps.provider) return refusedCode("PROVIDER_DISABLED");
  const started = deps.now();

  // ── 3. The facts, as the person may see them ─────────────────────────────────────────────────────────────────
  const built = buildEnvelope(await deps.readComposition(req.companyId, req.periodYear), req);
  if (!built.ok) {
    if (built.code === "UNKNOWN_LINE") return refused(404, "UNKNOWN_LINE", "This line is not in the composed statements for this period.");
    if (built.code === "COMPOSITION_INVALID") throw new Error(`composition payload refused: ${built.reason}`);
    return { status: 200, body: { status: "unavailable", code: "STATEMENTS_UNAVAILABLE", reason: built.reason,
      message: "The statements for this period are not available yet, so there is nothing to explain. No assistant request was made." } };
  }
  const env = built.envelope;
  const digest = await envelopeDigest(env);
  const payloadSha256 = await sha256Hex(canonicalJson({ action: req.action, companyId: req.companyId, periodYear: req.periodYear, lineId: req.lineId, refinement: req.refinement }));

  // ── 4. Reservation ───────────────────────────────────────────────────────────────────────────────────────────
  const { data, error } = await deps.rpc("ai_assistant_reserve", {
    p_user_id: userId, p_company_id: req.companyId, p_period_year: req.periodYear, p_line_id: req.lineId, p_action: req.action,
    p_request_id: req.requestId, p_payload_sha256: payloadSha256, p_context_sha256: digest, p_composition_sha256: env.compositionSha256,
  });
  if (error) throw new Error(`ai_assistant_reserve failed: ${error.code ?? "unknown"}`);
  const r = (data ?? {}) as Record<string, unknown>;
  if (r.outcome === "refused") return refusedCode(String(r.code ?? ""));
  if (r.outcome === "replay") return replay(r, env.compositionSha256);
  if (r.outcome !== "reserved" || typeof r.runId !== "string") throw new Error("ai_assistant_reserve: unexpected answer");
  const runId = r.runId;
  const prices = r.prices as Prices;
  const maxInput = Number(r.maxInputTokens), maxOutput = Number(r.maxOutputTokens), maxSeconds = Number(r.maxRequestSeconds);
  const model = String(r.model);

  let usage = ZERO;
  let attempts = 0;
  const complete = async (state: string, cost: number | null, extra: { response?: RenderedAnswer; sourceRefs?: string[]; validation?: unknown; failureCode?: string | null } = {}) => {
    const { data: c, error: e } = await deps.rpc("ai_assistant_complete", {
      p_run_id: runId, p_state: state, p_actual_cost_micros: cost, p_usage: usage, p_attempts: attempts,
      p_duration_ms: Math.max(0, Math.round(deps.now() - started)), p_response: extra.response ?? null, p_source_refs: extra.sourceRefs ?? null,
      p_validation: extra.validation ?? null, p_failure_code: extra.failureCode ?? null,
    });
    if (e) throw new Error(`ai_assistant_complete failed: ${e.code ?? "unknown"}`);
    return ((c ?? {}) as Record<string, unknown>).outcome === "completed";
  };

  // ── 5. The provider ─────────────────────────────────────────────────────────────────────────────────────────
  const user = buildUserMessage(env, digest, req.refinement);
  const deadline = started + maxSeconds * 1000;
  const messages: ProviderMessage[] = [{ role: "user", content: user }];
  // The input bound is checked before EVERY call, the correction included (an estimate: see estimateTokens).
  const inputEstimate = () => estimateTokens(SYSTEM_PROMPT + messages.map((m) => m.content).join(""));
  if (inputEstimate() > maxInput) {
    await complete("rejected", 0, { failureCode: "INPUT_TOO_LARGE" });
    return refused(422, "INPUT_TOO_LARGE", "This line has more detail than the assistant can take in one request. Nothing was sent.");
  }
  let lastErrors: string[] = [];
  let stopCode: string | null = null;
  let answer: RenderedAnswer | null = null;
  while (attempts < 2) {
    const remaining = deadline - deps.now();
    if (remaining < 2000) { stopCode = "TIME_EXHAUSTED"; break; }
    if (inputEstimate() > maxInput) { stopCode = "CORRECTION_INPUT_TOO_LARGE"; break; }
    attempts++;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), remaining);
    let raw: string;
    try {
      const out = await deps.provider.complete({ model, system: SYSTEM_PROMPT, messages: [...messages], maxTokens: maxOutput, signal: ctl.signal });
      usage = addUsage(usage, out.usage);
      raw = out.text;
    } catch (e) {
      const kind = e instanceof ProviderError ? e.kind : "ambiguous";
      // Known-uncharged refusals keep the cost of earlier attempts; unknown outcomes are recorded at the reserved ceiling
      // (an estimate — the true charge of an unknown outcome is not reported to us).
      const known = kind === "rejected" || kind === "rate_limited";
      await complete(kind === "rate_limited" ? "rejected" : kind, known ? costMicros(usage, prices) : null,
        { failureCode: kind === "rate_limited" ? "RATE_LIMITED" : kind === "rejected" ? "PROVIDER_REJECTED" : kind === "failed" ? "PROVIDER_FAILED" : "PROVIDER_AMBIGUOUS" });
      if (kind === "rate_limited") return refused(429, "RATE_LIMITED", "The assistant service is busy. Try again in a minute. Nothing else was affected.");
      if (kind === "ambiguous") return { status: 504, body: { status: "failed", code: "PROVIDER_AMBIGUOUS",
        message: "The assistant did not answer in time. It was not retried automatically; ask again if you still need it." } };
      return { status: 502, body: { status: "failed", code: kind === "rejected" ? "PROVIDER_REJECTED" : "PROVIDER_FAILED", message: "The assistant could not answer. Nothing was changed." } };
    } finally { clearTimeout(timer); }
    const v = validateResponse(parseModelJson(raw) ?? raw, env, digest);
    if (v.ok) { answer = renderResponse(v.response, env); break; }
    lastErrors = v.errors;
    if (attempts < 2) messages.push({ role: "assistant", content: raw.slice(0, MAX_QUOTED_ANSWER_CHARS) }, { role: "user", content: correctionMessage(v.errors) });
  }
  const cost = costMicros(usage, prices);
  if (!answer) {
    await complete("invalid", cost, { validation: { errors: lastErrors.slice(0, 20) }, failureCode: stopCode ?? "ANSWER_INVALID" });
    return { status: 502, body: { status: "failed", code: "ANSWER_INVALID",
      message: "The assistant's answer did not pass CFOClose's checks, so it is not shown. Nothing was changed." } };
  }

  // ── 6. Freshness and access, again, as the person ───────────────────────────────────────────────────────────
  const again = buildEnvelope(await deps.readComposition(req.companyId, req.periodYear), req);
  if (!again.ok) {
    await complete("stale", cost, { failureCode: "CONTEXT_UNAVAILABLE" });
    return { status: 409, body: { status: "stale", code: "STALE_CONTEXT", message: "The statements are no longer available as they were. Refresh and ask again." } };
  }
  if (again.envelope.compositionSha256 !== env.compositionSha256) {
    await complete("stale", cost, { failureCode: "STALE_CONTEXT" });
    return { status: 409, body: { status: "stale", code: "STALE_CONTEXT", message: "The figures changed while the assistant was answering. Refresh and ask again." } };
  }

  // ── 7. Record, then return ──────────────────────────────────────────────────────────────────────────────────
  const sourceRefs = [...new Set(answer.blocks.flatMap((b) => b.sources.map((s) => s.id)))];
  if (!(await complete("succeeded", cost, { response: answer, sourceRefs, validation: { attempts } }))) {
    return { status: 500, body: { status: "failed", code: "NOT_RECORDED", message: "The answer could not be recorded, so it is not shown. Ask again." } };
  }
  return { status: 200, body: { status: "answered", runId, replay: false, answer } };
}

function replay(r: Record<string, unknown>, currentComposition: string): AssistantHttp {
  const state = String(r.state ?? "");
  if (state === "reserved") return refused(409, "IN_PROGRESS", "This request is still running.");
  if (state === "succeeded" && r.response && !r.purged) {
    if (r.compositionSha256 !== currentComposition) {
      return { status: 409, body: { status: "stale", code: "STALE_CONTEXT", message: "The figures changed since this answer was given. Ask again for a current answer." } };
    }
    return { status: 200, body: { status: "answered", runId: r.runId, replay: true, answer: r.response } };
  }
  if (state === "succeeded") return refused(410, "ANSWER_EXPIRED", "This answer is past its retention period. Ask again.");
  return { status: 409, body: { status: "failed", code: `PREVIOUS_${state.toUpperCase()}`, message: "This request already finished without an answer. Ask again to start a new request." } };
}
