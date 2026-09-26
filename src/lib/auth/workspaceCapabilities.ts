/**
 * Workspace capabilities (20260925140000_workspace_capability_authorization.sql) — what the signed-in person may do in
 * one workspace. The database is the authority (has_workspace_capability / workspace_capability_allowed in every
 * policy and write function); this module only parses get_my_workspace_capabilities() so the UI can show or hide an
 * action. A job title (firm_members.role) is display metadata here and is never read to decide anything.
 *
 * Fail closed: anything malformed, missing or unknown means "not allowed".
 */

export const WORKSPACE_CAPABILITIES = ["prepare_close", "review_close", "approve_certification", "issue_reporting_pack", "manage_members"] as const;
export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITIES)[number];

export interface MyWorkspaceCapabilities {
  readonly access: boolean;
  /** Capabilities the person holds in this workspace. */
  readonly held: readonly WorkspaceCapability[];
  /** Capabilities the person may exercise now (held, and the account has a current plan where one is needed). */
  readonly allowed: readonly WorkspaceCapability[];
  /** Whether the workspace's account has a current plan; null when unknown. */
  readonly hasCurrentPlan: boolean | null;
  /** The billing account holder (manage_billing is account-scoped). */
  readonly manageBilling: boolean;
}

const isCapability = (v: unknown): v is WorkspaceCapability => typeof v === "string" && (WORKSPACE_CAPABILITIES as readonly string[]).includes(v);

/** Strict parse of get_my_workspace_capabilities(); malformed → null. */
export function parseMyWorkspaceCapabilities(raw: unknown): MyWorkspaceCapabilities | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.access !== "boolean" || !Array.isArray(r.capabilities) || !Array.isArray(r.allowed)) return null;
  if (!r.access) return { access: false, held: [], allowed: [], hasCurrentPlan: null, manageBilling: false };
  const held = r.capabilities.filter(isCapability);
  return {
    access: true,
    held,
    // Only a capability that is also held can be exercised.
    allowed: r.allowed.filter(isCapability).filter((c) => held.includes(c)),
    hasCurrentPlan: typeof r.has_current_plan === "boolean" ? r.has_current_plan : null,
    manageBilling: r.manage_billing === true,
  };
}

/** May the person exercise this capability now? Unknown → false. */
export function canExercise(state: MyWorkspaceCapabilities | null | undefined, capability: WorkspaceCapability): boolean {
  return !!state && state.access && state.allowed.includes(capability);
}

/** The capability each sign-off tier needs (preparer → prepare_close, reviewer → review_close, approver / lock → approve_certification). */
export type SignOffTier = "preparer" | "reviewer" | "approver";
export const SIGN_OFF_TIER_CAPABILITY: Readonly<Record<SignOffTier, WorkspaceCapability>> = {
  preparer: "prepare_close",
  reviewer: "review_close",
  approver: "approve_certification",
};

export const CAPABILITY_LABELS: Readonly<Record<WorkspaceCapability, string>> = {
  prepare_close: "Prepare the close",
  review_close: "Review the close",
  approve_certification: "Approve certification",
  issue_reporting_pack: "Issue Reporting Pack outputs",
  manage_members: "Manage members",
};

/**
 * What an invitation carries, in words, from invite-firm-member's structured answer: the capabilities the person holds
 * on acceptance and each capability the title would suggest but the invitation does NOT carry, with the reason —
 * EXPLICITLY_REVOKED (a revocation still in force; only an explicit grant restores it, never a re-invitation or a
 * title) or NOT_GRANTED (a title never adds a capability). Unknown codes are ignored; nothing is inferred from the title.
 */
export function describeInvitationCapabilities(raw: unknown): string {
  const r = (raw && typeof raw === "object" ? raw : {}) as { capabilities?: unknown; withheld?: unknown };
  const known = (c: unknown): c is WorkspaceCapability => typeof c === "string" && c in CAPABILITY_LABELS;
  const held = (Array.isArray(r.capabilities) ? r.capabilities : []).filter(known).map((c) => CAPABILITY_LABELS[c]);
  const withheld = (Array.isArray(r.withheld) ? r.withheld : [])
    .map((w) => (w && typeof w === "object" ? (w as { capability?: unknown; reason?: unknown }) : { capability: w, reason: "NOT_GRANTED" }))
    .filter((w) => known(w.capability));
  const byReason = (reason: string) => withheld.filter((w) => (w.reason === "EXPLICITLY_REVOKED" ? "EXPLICITLY_REVOKED" : "NOT_GRANTED") === reason).map((w) => CAPABILITY_LABELS[w.capability as WorkspaceCapability]);
  const revoked = byReason("EXPLICITLY_REVOKED");
  const notGranted = byReason("NOT_GRANTED");
  const parts = [held.length > 0 ? `On acceptance: ${held.join(", ")}.` : "On acceptance: no capabilities (view only)."];
  if (revoked.length > 0) parts.push(`Withheld — explicitly revoked earlier; only an explicit grant restores it: ${revoked.join(", ")}.`);
  if (notGranted.length > 0) parts.push(`Not granted by this invitation (a title never adds a capability): ${notGranted.join(", ")}.`);
  return parts.join(" ");
}
