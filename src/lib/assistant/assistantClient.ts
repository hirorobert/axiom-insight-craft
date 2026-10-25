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
export interface RenderedBlock { kind: "observation" | "limitation" | "missing" | "next_step" | "draft"; author: "assistant" | "application"; parts: RenderedPart[]; sources: { id: string; label: string }[] }
export interface RenderedAnswer {
  schemaVersion: "cfoclose-assistant-response/2";
  action: AssistantAction;
  label: "Explanation" | "Draft — not reviewed";
  contextDigest: string;
  asOf: { compositionSha256: string; periodYear: number; lineId: string; lineLabel: string; currency: string };
  blocks: RenderedBlock[];
  draftText: string | null;
}

/**
 * `uncertain` = the request may or may not have reached the server and run (a transport failure, a relay or gateway error,
 * an unreadable response). Its request id is KEPT: retrying resumes the same request, and the server replays its recorded
 * outcome instead of starting a second paid generation. Every other kind is a settled server answer.
 */
export type AssistantOutcome =
  | { kind: "answered"; answer: RenderedAnswer; replay: boolean }
  | { kind: "unavailable"; message: string }
  | { kind: "stale"; message: string }
  | { kind: "refused"; code: string; message: string }
  | { kind: "failed"; code: string; message: string }
  | { kind: "not_deployed"; message: string }
  | { kind: "uncertain"; message: string };

export type AssistantInvoke = (name: "assistant-explain", options: { body: Record<string, unknown> }) => Promise<{ data: unknown; error: unknown }>;

const NOT_DEPLOYED = "Ask CFOClose is not available here. Your statements and reports are unaffected.";
const GENERIC = "The assistant could not answer. Nothing was changed.";
const UNCERTAIN = "The answer did not arrive. Try again — the same request will be resumed, not started again.";

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
  return !!a && a.schemaVersion === "cfoclose-assistant-response/2" && Array.isArray(a.blocks)
    && a.blocks.every((b) => Array.isArray(b.parts) && b.parts.every((p) => typeof p.text === "string") && Array.isArray(b.sources));
};
const SETTLED = new Set(["answered", "unavailable", "stale", "refused", "failed"]);

/**
 * Maps one result of the function call — whether the transport returned the error (supabase-js FunctionsClient.invoke
 * returns FunctionsFetchError / FunctionsRelayError / FunctionsHttpError in `error`; it does not throw) or threw it.
 * Only a structured server body (`status` ∈ answered | unavailable | stale | refused | failed) or a bodiless 404 (the function
 * is not deployed: nothing ran) settles an attempt. Anything else is `uncertain`.
 */
export async function interpretAssistant(result: { data: unknown; error: unknown }): Promise<AssistantOutcome> {
  let body = result.data as Record<string, unknown> | null;
  if (result.error) {
    const { status, body: errBody } = await errorBody(result.error);
    if (status === 404 && !(typeof errBody?.status === "string" && SETTLED.has(errBody.status))) return { kind: "not_deployed", message: NOT_DEPLOYED };
    body = errBody;
  }
  if (!body || typeof body !== "object" || typeof body.status !== "string" || !SETTLED.has(body.status)) return { kind: "uncertain", message: UNCERTAIN };
  const message = typeof body.message === "string" ? body.message : GENERIC;
  const code = typeof body.code === "string" ? body.code : "ASSISTANT_FAILED";
  switch (body.status) {
    case "answered": return isAnswer(body.answer) ? { kind: "answered", answer: body.answer, replay: body.replay === true } : { kind: "uncertain", message: UNCERTAIN };
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
        outcome = { kind: "uncertain", message: UNCERTAIN };
      }
      // Only a settled server answer releases the id; an uncertain outcome keeps it, so a retry resumes the same request.
      // A request the server reports as still running (IN_PROGRESS) is the same request: its id is kept too.
      if (outcome.kind !== "uncertain" && !(outcome.kind === "refused" && outcome.code === "IN_PROGRESS")) pending = null;
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
    case "synthetic_scope_required": return "Live beta AI can only receive a specifically authorized synthetic statement context. These records have not been authorized for sending.";
    default: return "Ask CFOClose is not available for this workspace.";
  }
}

export const BLOCK_TITLES: Readonly<Record<RenderedBlock["kind"], string>> = {
  observation: "What the figures show", limitation: "What the records do not establish", missing: "Not available",
  next_step: "What you could check next", draft: "Draft commentary",
};
