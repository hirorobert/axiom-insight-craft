/**
 * savedDrafts — the saved (not yet checked) trial-balance files of the signed-in person, from the server
 * (list_trial_balance_drafts, 20261106100000), and their explicit removal (delete_trial_balance_draft). The stored object
 * is removed by the scheduled sweeper; a draft being committed is never removed (the server answers not_eligible).
 */
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

export interface SavedDraft { id: string; fileName: string; fileSize: number; state: "reserved" | "committing"; createdAt: string; expiresAt: string; stored: boolean }

export async function listSavedDrafts(rpc: Rpc): Promise<{ kind: "ok"; drafts: SavedDraft[] } | { kind: "unavailable" }> {
  const { data, error } = await rpc("list_trial_balance_drafts", {});
  if (error || !Array.isArray(data)) return { kind: "unavailable" };
  const drafts = data.flatMap((x): SavedDraft[] => {
    const r = x as Record<string, unknown>;
    if (typeof r.draft_id !== "string" || typeof r.file_name !== "string" || typeof r.file_size !== "number"
      || (r.state !== "reserved" && r.state !== "committing") || typeof r.created_at !== "string" || typeof r.expires_at !== "string") return [];
    return [{ id: r.draft_id, fileName: r.file_name, fileSize: r.file_size, state: r.state, createdAt: r.created_at, expiresAt: r.expires_at, stored: r.stored === true }];
  });
  return { kind: "ok", drafts };
}

const REMOVE_TEXT: Record<string, string> = {
  deleted: "Removed.",
  already_deleted: "That saved file was already removed.",
  not_found: "That saved file was not found.",
  not_eligible: "That file is being checked now, so it cannot be removed.",
};

export async function removeSavedDraft(rpc: Rpc, draftId: string): Promise<{ removed: boolean; message: string }> {
  const { data, error } = await rpc("delete_trial_balance_draft", { p_draft_id: draftId });
  if (error || typeof data !== "string") return { removed: false, message: "The saved file could not be removed. Try again." };
  return { removed: data === "deleted" || data === "already_deleted", message: REMOVE_TEXT[data] ?? "The saved file could not be removed. Try again." };
}
