/**
 * Ask CFOClose (Release 0.1) — the ONLY browser path to the assistant-explain function, and the panel's pure decisions.
 *
 *   · The browser sends only the action, the company, the period, the line, a request id and an optional enumerated
 *     refinement. It never sends a question, facts or figures: the server reads the statements itself.
 *   · A retry of the SAME attempt (a lost response, a double click) reuses its request id, so the server replays the one
 *     answer instead of starting a second generation; a new question gets a new id.
 *   · Every response is bound to the context it was asked in (company · period · line) and to the newest request on its
 *     channel: an answer that arrives after the person moved to another company, period or line is discarded.
 *   · Answers are rendered as text (never HTML). Figures were rendered by the server from fact records.
 */
import { createRequestGuard, type RequestGuard, type RequestTicket } from "@/lib/workbench/requestSequence";

export type AssistantAction = "explain_movement" | "draft_commentary";
export type Refinement = "shorter" | "more_formal" | "plain_language";
export interface RenderedPart { kind: "text" | "fact"; text: string; factId?: string; status?: "composed" | "no_records" | "not_computed" }
export interface RenderedBlock { kind: "observation" | "limitation" | "missing" | "next_step" | "draft"; parts: RenderedPart[]; sources: { id: string; label: string }[] }
export interface RenderedAnswer {
  schemaVersion: "cfoclose-assistant-response/1";
  action: AssistantAction;
  label: "Explanation" | "Draft — not reviewed";
  contextDigest: string;
  asOf: { compositionSha256: string; periodYear: number; lineId: string; lineLabel: string; currency: string };
  blocks: RenderedBlock[];
  draftText: string | null;
}

export type AssistantOutcome =
  | { kind: "answered"; answer: RenderedAnswer; replay: boolean }
  | { kind: "unavailable"; message: string }
  | { kind: "stale"; message: string }
  | { kind: "refused"; code: string; message: string }
  | { kind: "failed"; code: string; message: string }
  | { kind: "not_deployed"; message: string };

export type AssistantInvoke = (name: "assistant-explain", options: { body: Record<string, unknown> }) => Promise<{ data: unknown; error: unknown }>;

const NOT_DEPLOYED = "Ask CFOClose is not available here. Your statements and reports are unaffected.";
const GENERIC = "The assistant could not answer. Nothing was changed.";

async function errorBody(error: unknown): Promise<{ status: number | null; body: Record<string, unknown> | null }> {
  const ctx = (error as { context?: unknown } | null)?.context;
  if (ctx && typeof (ctx as Response).json === "function") {
    const res = ctx as Response;
    try { return { status: res.status, body: (await res.clone().json()) as Record<string, unknown> }; } catch { return { status: res.status, body: null }; }
  }
  return { status: null, body: null };
}

const isAnswer = (v: unknown): v is RenderedAnswer => {
  const a = v as RenderedAnswer | null;
  return !!a && a.schemaVersion === "cfoclose-assistant-response/1" && Array.isArray(a.blocks)
    && a.blocks.every((b) => Array.isArray(b.parts) && b.parts.every((p) => typeof p.text === "string") && Array.isArray(b.sources));
};

/** Maps one answer of the function. Pure apart from reading an error response body. */
export async function interpretAssistant(result: { data: unknown; error: unknown }): Promise<AssistantOutcome> {
  let status: number | null = 200;
  let body = result.data as Record<string, unknown> | null;
  if (result.error) {
    const name = (result.error as { name?: unknown }).name;
    ({ status, body } = await errorBody(result.error));
    if (status === 404 && !body?.code) return { kind: "not_deployed", message: NOT_DEPLOYED };
    if (name === "FunctionsRelayError" || name === "FunctionsFetchError") return { kind: "not_deployed", message: NOT_DEPLOYED };
  }
  const message = typeof body?.message === "string" ? body.message : GENERIC;
  const code = typeof body?.code === "string" ? body.code : "ASSISTANT_FAILED";
  switch (body?.status) {
    case "answered": return isAnswer(body.answer) ? { kind: "answered", answer: body.answer, replay: body.replay === true } : { kind: "failed", code: "MALFORMED", message: GENERIC };
    case "unavailable": return { kind: "unavailable", message };
    case "stale": return { kind: "stale", message };
    case "refused": return { kind: "refused", code, message };
    default: return { kind: "failed", code, message };
  }
}

export const contextKeyFor = (companyId: string, periodYear: number, lineId: string) => `${companyId}|${periodYear}|${lineId}`;

/**
 * One panel's session: request ids per attempt and response binding. `attemptKey` identifies WHAT is asked; the same
 * attempt keeps its id until it settles, so a repeat click while it runs, or a retry after a lost response, replays.
 */
export function assistantSession(invoke: AssistantInvoke, newId: () => string = () => crypto.randomUUID()) {
  const guard: RequestGuard = createRequestGuard();
  let pending: { key: string; id: string } | null = null;
  return {
    guard,
    /** Sends (or re-sends) an attempt. Returns the ticket and the outcome; apply the outcome only if `accepts(ticket)`. */
    async ask(req: { action: AssistantAction; companyId: string; periodYear: number; lineId: string; refinement?: Refinement | null }):
      Promise<{ ticket: RequestTicket; outcome: AssistantOutcome }> {
      const context = contextKeyFor(req.companyId, req.periodYear, req.lineId);
      const key = `${context}|${req.action}|${req.refinement ?? ""}`;
      if (!pending || pending.key !== key) pending = { key, id: newId() };
      const ticket = guard.begin("assistant", context);
      const body = { action: req.action, companyId: req.companyId, periodYear: req.periodYear, lineId: req.lineId, requestId: pending.id,
        ...(req.refinement ? { refinement: req.refinement } : {}) };
      let outcome: AssistantOutcome;
      try {
        outcome = await interpretAssistant(await invoke("assistant-explain", { body }));
      } catch {
        // Lost response: keep the request id so a retry replays the same request.
        return { ticket, outcome: { kind: "failed", code: "NETWORK", message: "The answer did not arrive. Try again — the same request will be resumed." } };
      }
      // A settled attempt (any server answer) releases its id: asking again is a new request.
      pending = null;
      return { ticket, outcome };
    },
    accepts: (ticket: RequestTicket, activeContextKey: string) => guard.accepts(ticket, activeContextKey),
  };
}

/** Words for the panel's status line (ai_assistant_status). */
export function statusWords(state: string): string | null {
  switch (state) {
    case "available": return null;
    case "disabled": return "Ask CFOClose is switched off. Your statements and reports are unaffected.";
    case "not_enabled": return "Ask CFOClose has not been enabled for this workspace.";
    case "no_budget": return "Ask CFOClose has no allowance for this workspace.";
    default: return "Ask CFOClose is not available for this workspace.";
  }
}

export const BLOCK_TITLES: Readonly<Record<RenderedBlock["kind"], string>> = {
  observation: "What the figures show", limitation: "What the records do not establish", missing: "Not available",
  next_step: "What you could check next", draft: "Draft commentary",
};
