/**
 * The newest layout confirmation of an upload (layout-confirmation/1, 20261010100000), read with the service role.
 *
 * "unavailable" means the database has no layout authority yet (the migration is not applied): a caller that depends on
 * layouts refuses before writing anything — it never treats a missing table as "no confirmation". Any other read error
 * is thrown (a processing failure, never "no layout").
 */

export interface LayoutConfirmationRow {
  id: string;
  confirmation_no: number;
  source_file_hash: string;
  profile: unknown;
  profile_sha256: string;
  resolved_profile_sha256: string;
  template_id: string | null;
}

export type LayoutConfirmationRead =
  | { kind: "unavailable" }
  | { kind: "read"; confirmation: LayoutConfirmationRow | null };

interface QueryError { code?: string; message?: string }
export interface LayoutReadClient {
  from(table: "layout_confirmations"): {
    select(columns: string): {
      eq(column: "upload_id", value: string): {
        order(column: "confirmation_no", opts: { ascending: false }): {
          limit(n: 1): PromiseLike<{ data: unknown[] | null; error: QueryError | null }>;
        };
      };
    };
  };
}

/** PostgREST "relation not in schema cache" and Postgres "undefined table". */
export function isMissingRelation(error: QueryError | null | undefined): boolean {
  return !!error && (error.code === "PGRST205" || error.code === "42P01");
}

export const LAYOUT_COLUMNS = "id, confirmation_no, source_file_hash, profile, profile_sha256, resolved_profile_sha256, template_id";

export async function readCurrentLayoutConfirmation(client: LayoutReadClient, uploadId: string): Promise<LayoutConfirmationRead> {
  const { data, error } = await client.from("layout_confirmations").select(LAYOUT_COLUMNS)
    .eq("upload_id", uploadId).order("confirmation_no", { ascending: false }).limit(1);
  if (isMissingRelation(error)) return { kind: "unavailable" };
  if (error) throw new Error(`layout confirmation lookup failed: ${error.code ?? "unknown"}`);
  const row = (data ?? [])[0] as LayoutConfirmationRow | undefined;
  return { kind: "read", confirmation: row ?? null };
}

/** The answer when the layout authority is not available (the handler refuses before any write). */
export const LAYOUT_AUTHORITY_UNAVAILABLE = {
  status: "unavailable",
  code: "LAYOUT_AUTHORITY_UNAVAILABLE",
  message: "Trial balance checks are briefly unavailable while an update is completed. Nothing was changed; try again shortly.",
} as const;
