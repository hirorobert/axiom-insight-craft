// Types for reportingPackSeal.mjs (the official Reporting Pack handler shared by the Edge Function, the unit tests and
// the real-PostgreSQL proof).
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
export interface SealDeps {
  readonly rpc: Rpc;
  /** Store without overwrite; an existing object is an error. */
  readonly put: (path: string, bytes: Uint8Array, contentType: string) => Promise<{ error: unknown }>;
  readonly remove: (path: string) => Promise<unknown>;
  readonly get: (path: string) => Promise<Uint8Array | null>;
  readonly sha256Hex: (bytes: Uint8Array) => Promise<string>;
}
export interface IssueResult {
  readonly httpStatus: number;
  readonly body: {
    readonly outcome: string;
    readonly issuance_id?: string;
    readonly content_sha256?: string;
    /** The exact sealed document (UTF-8 text), for the caller to save as the official file. */
    readonly document?: string;
    readonly file_name?: string;
  };
}
export declare const OFFICIAL_CONTENT_TYPE: "application/json";
export declare function parseSealRequest(contentType: string | null, body: unknown): { readonly action: "issue" | "verify"; readonly issuanceId: string } | null;
export declare function issueOfficialPack(deps: SealDeps, input: { readonly userId: string; readonly issuanceId: string }): Promise<IssueResult>;
export declare function verifyOfficialPack(deps: SealDeps, userId: string, issuanceId: string): Promise<{ readonly outcome: string; readonly official: boolean }>;
export declare function verifyStoredPack(deps: SealDeps, issuanceId: string): Promise<{ readonly outcome: string; readonly company_id?: string }>;
