// financialStatementsWorkspace/sourcesModel.ts — the Sources stage model:
// where each input to the statements comes from and whether it is usable.
// Every entry is derived from real workspace state; an input the product
// cannot yet accept is shown as UNAVAILABLE with the reason, never as a
// working option.

import type { ComparativeSourceState, ComparativeCandidateUpload } from "./comparativeSource";

export type SourceStatus = "AVAILABLE" | "MISSING" | "INELIGIBLE" | "UNAVAILABLE";

export interface SourceEntry {
  readonly id: "reviewed-trial-balance" | "comparative-period" | "prior-financial-statements" | "supporting-schedules" | "existing-statement-intake";
  readonly label: string;
  readonly status: SourceStatus;
  readonly detail: string;
  /** Provenance shown to the reviewer when the source is in use. */
  readonly provenance?: string;
}

export interface SourcesInput {
  readonly currentUpload: { readonly id: string; readonly file_name: string; readonly status: string; readonly is_valid: boolean | null } | null;
  readonly periodYear: number;
  readonly comparative: ComparativeSourceState<ComparativeCandidateUpload & { readonly file_name?: string }>;
  /** Source constant DOCUMENT_REVIEW_ENABLED — extraction adapters do not exist, so this only ever describes intake, never assessment. */
  readonly documentReviewEnabled: boolean;
  /** Latest version of each evidence series in the session. */
  readonly evidence?: readonly { readonly evidenceType: string; readonly periodRole: string; readonly validationStatus: string; readonly evidenceBatchId: string }[];
}

export function buildSources(input: SourcesInput): readonly SourceEntry[] {
  const { currentUpload, comparative } = input;

  const current: SourceEntry = !currentUpload
    ? { id: "reviewed-trial-balance", label: `Reviewed trial balance — ${input.periodYear}`, status: "MISSING", detail: "No trial balance has been imported for this period." }
    : currentUpload.status === "complete" && currentUpload.is_valid === true
      ? { id: "reviewed-trial-balance", label: `Reviewed trial balance — ${input.periodYear}`, status: "AVAILABLE", detail: "Imported, validated and available to prepare statements.", provenance: `${currentUpload.file_name} (upload ${currentUpload.id})` }
      : { id: "reviewed-trial-balance", label: `Reviewed trial balance — ${input.periodYear}`, status: "INELIGIBLE", detail: `The trial balance is not complete and valid yet (status "${currentUpload.status}").`, provenance: `${currentUpload.file_name} (upload ${currentUpload.id})` };

  const comparativeEntry: SourceEntry =
    comparative.state === "AVAILABLE"
      ? { id: "comparative-period", label: `Comparative-period data — ${comparative.periodYear}`, status: "AVAILABLE", detail: "Prior-year trial balance found; it feeds the comparative column.", provenance: `upload ${comparative.upload.id}` }
      : comparative.state === "INELIGIBLE"
        ? { id: "comparative-period", label: `Comparative-period data — ${comparative.periodYear}`, status: "INELIGIBLE", detail: comparative.reason, provenance: `upload ${comparative.upload.id}` }
        : { id: "comparative-period", label: `Comparative-period data — ${comparative.periodYear}`, status: "MISSING", detail: `${comparative.reason} Statements will show one period only and cannot be called comparative-ready.` };

  return [
    current,
    comparativeEntry,
    {
      id: "prior-financial-statements",
      label: "Prior financial statements",
      status: "UNAVAILABLE",
      detail: "Reading figures from previously issued statements requires document extraction, which is not available yet. Import the prior-year trial balance instead.",
    },
    (() => {
      const schedules = (input.evidence ?? []).filter((e) => e.evidenceType === "SUPPORTING_SCHEDULE");
      const usable = schedules.filter((e) => e.validationStatus === "VALID" || e.validationStatus === "VALID_WITH_WARNINGS");
      return usable.length > 0
        ? ({ id: "supporting-schedules", label: "Supporting schedules", status: "AVAILABLE", detail: `${usable.length} validated schedule file${usable.length === 1 ? "" : "s"} feed notes and movement schedules.`, provenance: usable.map((e) => e.evidenceBatchId).join(", ") } as const)
        : ({ id: "supporting-schedules", label: "Supporting schedules", status: schedules.length > 0 ? "INELIGIBLE" : "MISSING", detail: schedules.length > 0 ? "A schedule file was added but did not validate; see its diagnostics under Evidence." : "No supporting schedule has been added. Add a CSV schedule under Evidence to populate notes and movement schedules." } as const);
    })(),
    {
      id: "existing-statement-intake",
      label: "Existing-statement intake",
      status: "UNAVAILABLE",
      detail: input.documentReviewEnabled
        ? "Documents can be stored, but no extraction adapter exists: a stored document is never treated as assessed."
        : "Assessing an existing set of statements is not available yet. No document is read or stored from this workspace.",
    },
  ];
}
