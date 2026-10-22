// Processing release control (admin only). Pure helpers behind the "Processing" tab of /commercial/admin.
// The server is the only authority: admin_get_processing_control / admin_set_processing_control check an active
// commercial_admins row, the expected version and that the engine floor never falls. Nothing here decides access.

export interface ProcessingControl {
  hold: boolean;
  held_at: string | null;
  canary_company_ids: string[];
  min_engine_generation: number | null;
  reason: string | null;
  version: number;
}

export type ControlOperation = "pause" | "canary" | "resume";

export interface SetControlArgs {
  p_hold: boolean;
  p_canary_company_ids: string[];
  p_min_engine_generation: number;
  p_reason: string;
  p_expected_version: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const RELEASE_FLOOR = 7;

export function parseControl(v: unknown): ProcessingControl | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.hold !== "boolean" || typeof o.version !== "number" || !Array.isArray(o.canary_company_ids)) return null;
  return {
    hold: o.hold,
    held_at: typeof o.held_at === "string" ? o.held_at : null,
    canary_company_ids: o.canary_company_ids.filter((x): x is string => typeof x === "string"),
    min_engine_generation: typeof o.min_engine_generation === "number" ? o.min_engine_generation : null,
    reason: typeof o.reason === "string" ? o.reason : null,
    version: o.version,
  };
}

/** Builds the exact RPC arguments, or an error message. Never lowers the floor; a pause keeps floor and canaries. */
export function buildControlArgs(
  op: ControlOperation,
  current: ProcessingControl,
  reason: string,
  canaryId = "",
): { args: SetControlArgs } | { error: string } {
  const r = reason.trim();
  if (r.length < 3 || r.length > 300) return { error: "Give a reason (3 to 300 characters)." };
  const floor = current.min_engine_generation ?? RELEASE_FLOOR;
  const base = { p_reason: r, p_expected_version: current.version };
  if (op === "pause") {
    return { args: { ...base, p_hold: true, p_canary_company_ids: current.canary_company_ids, p_min_engine_generation: floor } };
  }
  const releaseFloor = Math.max(floor, RELEASE_FLOOR);
  if (op === "canary") {
    if (!current.hold) return { error: "Pause processing before admitting a canary." };
    const id = canaryId.trim();
    if (!UUID.test(id)) return { error: "Enter the canary company's ID." };
    return { args: { ...base, p_hold: true, p_canary_company_ids: [id], p_min_engine_generation: releaseFloor } };
  }
  if ((current.min_engine_generation ?? 0) < RELEASE_FLOOR) return { error: `Resume is only offered once the floor is ${RELEASE_FLOOR} (after the canary).` };
  return { args: { ...base, p_hold: false, p_canary_company_ids: [], p_min_engine_generation: releaseFloor } };
}

export const OUTCOME_UNCONFIRMED =
  "The result could not be confirmed: the change may or may not have been saved. Refresh the state before trying again.";

/** "Nothing was changed" is said only for the server's known atomic refusals; anything else is unconfirmed. */
export function describeControlError(e: { message?: string; code?: string } | null | undefined): string {
  const m = e?.message ?? "";
  const code = e?.code;
  if (code === "42501" || /NOT_A_COMMERCIAL_ADMIN/.test(m)) return "Your account is not an active commercial administrator. Nothing was changed.";
  if (code === "28000" || /UNAUTHENTICATED/.test(m)) return "Your session has ended. Sign in again. Nothing was changed.";
  if (/CONTROL_VERSION_CONFLICT/.test(m)) return "Someone changed the control since you loaded it. Check the current state and try again. Nothing was changed.";
  if (/ENGINE_GENERATION_FLOOR_CANNOT_DECREASE/.test(m)) return "The engine floor can only rise. Nothing was changed.";
  if (/REASON_REQUIRED/.test(m)) return "A reason is required. Nothing was changed.";
  return OUTCOME_UNCONFIRMED;
}

/** Text after a write attempt, given the write outcome and whether the authoritative re-read succeeded. */
export function describeSubmitOutcome(write: { error: { message?: string; code?: string } | null } | "thrown", readBack: boolean): { ok: boolean; text: string } {
  const after = readBack ? " The state shown was re-read from the server." : " The current state could not be read; refresh before doing anything else.";
  if (write === "thrown") return { ok: false, text: OUTCOME_UNCONFIRMED + after };
  if (write.error) return { ok: false, text: describeControlError(write.error) + after };
  return { ok: true, text: "Saved." + after };
}
