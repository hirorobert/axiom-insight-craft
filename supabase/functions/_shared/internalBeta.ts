/** INTERNAL_BETA changes only the reservation namespace, never financial writers or approval fields. */
import { handleAssistant, type AssistantDeps, type AssistantHttp } from "./assistantHandler.ts";

export const INTERNAL_BETA_LIMITS = Object.freeze({ totalMicros: 5_000_000, priorReservedMicros: 1_341_400,
  maxInputTokens: 20_000, maxOutputTokens: 1_200, maxRequestSeconds: 30 });

export function remainingBetaMicros(committedOrReservedMicros: number): number {
  if (!Number.isSafeInteger(committedOrReservedMicros) || committedOrReservedMicros < 0) return 0;
  return Math.max(0, INTERNAL_BETA_LIMITS.totalMicros - INTERNAL_BETA_LIMITS.priorReservedMicros - committedOrReservedMicros);
}

export async function handleInternalBeta(userId: string, body: unknown, deps: AssistantDeps): Promise<AssistantHttp> {
  return handleAssistant(userId, body, {
    ...deps,
    // The database re-derives enrollment, membership, exact synthetic composition, and GLOBAL budget under one lock.
    rpc: (name, args) => {
      if (name === "ai_assistant_reserve") return deps.rpc("internal_beta_assistant_reserve", args);
      if (name === "ai_assistant_complete") return deps.rpc("internal_beta_assistant_complete", args);
      return Promise.resolve({ data: null, error: { code: "BETA_RPC_NOT_ALLOWED" } });
    },
  });
}