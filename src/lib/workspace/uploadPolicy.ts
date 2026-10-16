/**
 * The browser's copy of the ONE trial balance upload policy (supabase/functions/_shared/uploadPolicy.ts). There is no
 * cross-import between src/ and supabase/functions/, so this mirror is held equal to the server module — and to the
 * drafts migration's size CHECK — by uploadPolicy.test.ts. The server remains the authority; the browser only refuses
 * early what the server would refuse anyway, with the same words.
 *
 * PROVISIONAL limits (owner decision pending; measured in scripts/bench/tbUploadPolicyBench.mjs).
 */
export const TB_UPLOAD_POLICY = Object.freeze({
  version: "tb-upload-policy-1",
  extensions: Object.freeze([".csv", ".xlsx", ".xls"] as const),
  maxFileBytes: 52_428_800,
});

/** "CSV or Excel (.csv, .xlsx, .xls), up to 50 MB." */
export const UPLOAD_LIMITS_TEXT = `CSV or Excel (${TB_UPLOAD_POLICY.extensions.join(", ")}), up to ${Math.round(TB_UPLOAD_POLICY.maxFileBytes / 1_048_576)} MB.`;

/** The same refusal the server gives for an over-size file (uploadPolicy.checkSourceBytes), or null. */
export function fileTooLarge(file: { name: string; size: number }): string | null {
  return file.size > TB_UPLOAD_POLICY.maxFileBytes
    ? `“${file.name}” is larger than ${Math.round(TB_UPLOAD_POLICY.maxFileBytes / 1_048_576)} MB. Export only the trial balance (one sheet, no images) and upload it again.`
    : null;
}
