import type { WorkspacePurpose } from "./engagementGroups";

export type PurposeRecord = { purpose: WorkspacePurpose; reason: string; created_at: string };
export interface PurposeClient {
  read: (companyId: string) => Promise<PurposeRecord | null>;
  write: (companyId: string, purpose: WorkspacePurpose, reason: string) => Promise<{ outcome?: string }>;
}
/** Read after every attempted write, including an uncertain response. The latest server event is the displayed truth. */
export async function saveWorkspacePurpose(client: PurposeClient, companyId: string, purpose: WorkspacePurpose, reason: string) {
  if (reason.trim().length < 3 || reason.trim().length > 500) throw new Error("Enter a reason of 3 to 500 characters.");
  let outcome: string | undefined;
  try { outcome = (await client.write(companyId, purpose, reason.trim())).outcome; } catch { /* Reconcile a lost response by reading the latest event. */ }
  if (outcome === "forbidden") throw new Error("Only the company owner can change its workspace purpose.");
  if (outcome === "invalid_request") throw new Error("The purpose was not saved. Check the selected purpose and reason.");
  const recorded = await client.read(companyId);
  if (recorded?.purpose !== purpose) throw new Error("The selected purpose could not be confirmed. Your changes are kept; try again.");
  return recorded;
}
