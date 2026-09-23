/**
 * workspaceAccess — what the signed-in user may open in a workspace (PR #32 access bridge, 20260923130000).
 *
 * The server decides (get_workspace_access, the same owner-or-explicit-grant predicate as every PR #32 source
 * operation; never a title):
 *   owner       every stage;
 *   member      an accepted firm member: every stage under the EXISTING rules (unchanged);
 *   capability  an active manage_source_files / prepare_trial_balance grant with no ownership or membership:
 *               the Prepare stage ONLY. Reconcile, Statements, Tax, Compliance, Filing, Monitor, the Overview's
 *               service decisions, account review, sign-off and workspace administration are not included.
 * No row means no access (an unrelated user, another workspace, a revoked grant, anonymous).
 *
 * The browser only ever narrows what the server returned; it never widens it.
 */

import { supabase } from "@/integrations/supabase/client";
import type { WorkspaceMission } from "./types";

export type WorkspaceAccessKind = "owner" | "member" | "capability";

export interface WorkspaceAccess {
  kind: WorkspaceAccessKind;
  capabilities: string[];
  stages: WorkspaceMission[];
  /** Minimum workspace metadata for the shell and Prepare. No TIN, code, owner or billing data. */
  company: { id: string; name: string; fiscal_year_end: string | null; reporting_framework: string | null; currency: string | null; created_at: string | null };
}

export interface SharedWorkspace {
  id: string;
  name: string;
  capabilities: string[];
  fiscal_year_end: string | null;
  reporting_framework: string | null;
  currency: string | null;
  created_at: string | null;
}

export type WorkspaceAccessState =
  | { status: "loading" }
  | { status: "granted"; access: WorkspaceAccess }
  | { status: "denied" }
  | { status: "error" };

const STAGES: readonly WorkspaceMission[] = ["prepare", "reconcile", "statements", "tax", "compliance", "filing", "monitor"];
const KINDS: readonly WorkspaceAccessKind[] = ["owner", "member", "capability"];

interface AccessRow {
  company_id?: unknown; access?: unknown; capabilities?: unknown; stages?: unknown; name?: unknown;
  fiscal_year_end?: unknown; reporting_framework?: unknown; currency?: unknown; created_at?: unknown;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Server row → access. Malformed or unknown fails closed (null = no access). A capability never gets more than Prepare. */
export function toWorkspaceAccess(row: AccessRow | null | undefined): WorkspaceAccess | null {
  if (!row || typeof row.company_id !== "string" || !KINDS.includes(row.access as WorkspaceAccessKind)) return null;
  const kind = row.access as WorkspaceAccessKind;
  let stages = strings(row.stages).filter((s): s is WorkspaceMission => STAGES.includes(s as WorkspaceMission));
  if (kind === "capability") stages = stages.filter((s) => s === "prepare");
  if (stages.length === 0) return null;
  return {
    kind,
    capabilities: strings(row.capabilities),
    stages,
    company: {
      id: row.company_id, name: str(row.name) ?? "", fiscal_year_end: str(row.fiscal_year_end),
      reporting_framework: str(row.reporting_framework), currency: str(row.currency), created_at: str(row.created_at),
    },
  };
}

/** Is this stage open to the caller? Unknown access (loading, legacy test contexts) defers to the existing gates. */
export function canOpenStage(access: WorkspaceAccess | null | undefined, stage: WorkspaceMission): boolean {
  if (!access) return true;
  return access.stages.includes(stage);
}

/** Prepare-only access: the shell hides everything outside Prepare, and Prepare hides review/reconciliation actions. */
export function isPrepareOnly(access: WorkspaceAccess | null | undefined): boolean {
  return access?.kind === "capability";
}

type AccessRpc = {
  rpc(name: "get_workspace_access", args: { p_company_id: string }): PromiseLike<{ data: AccessRow[] | null; error: unknown }>;
  rpc(name: "list_shared_workspaces"): PromiseLike<{ data: (AccessRow & { company_id: string })[] | null; error: unknown }>;
};
// The migration is committed but not yet in the generated types; the cast is scoped to exactly these two RPCs.
const accessRpc = () => supabase as unknown as AccessRpc;

export async function fetchWorkspaceAccess(companyId: string): Promise<WorkspaceAccessState> {
  const { data, error } = await accessRpc().rpc("get_workspace_access", { p_company_id: companyId });
  if (error) return { status: "error" };
  const access = toWorkspaceAccess(data?.[0]);
  return access ? { status: "granted", access } : { status: "denied" };
}

/** Workspaces shared with the caller through an active Prepare grant (never their own). A failed read throws. */
export async function listSharedWorkspaces(): Promise<SharedWorkspace[]> {
  const { data, error } = await accessRpc().rpc("list_shared_workspaces");
  if (error) throw error;
  return (data ?? []).flatMap((r) => (typeof r.company_id === "string" ? [{
    id: r.company_id, name: str(r.name) ?? "", capabilities: strings(r.capabilities), fiscal_year_end: str(r.fiscal_year_end),
    reporting_framework: str(r.reporting_framework), currency: str(r.currency), created_at: str(r.created_at),
  }] : []));
}
