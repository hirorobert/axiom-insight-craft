/**
 * ActiveFileProvenance — file name, size, upload time and state for the trial balance currently on
 * screen. Shared by WorkspaceOverview (the decision surface) and PrepareWorkspace (where Replace
 * and Remove live) so both name the SAME file the SAME way — one presentation vocabulary, not two
 * independently-formatted copies of the same record.
 *
 * Every value is read only from the stored upload row, never inferred: a missing/unusable
 * measurement is omitted rather than substituted.
 */

import { Link } from "react-router-dom";
import { FileText } from "lucide-react";

function formatFileSize(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const RELATIVE_TIME = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const RELATIVE_WINDOW_SECONDS = 7 * 24 * 60 * 60;

function describeUploadTime(uploadedAt: string, nowMs: number): { relative: string; exact: string } | null {
  const uploaded = new Date(uploadedAt);
  const uploadedMs = uploaded.getTime();
  if (Number.isNaN(uploadedMs)) return null;

  const exact = uploaded.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  const seconds = Math.round((nowMs - uploadedMs) / 1000);
  // Older than a week (or in the future, from clock skew): a date is more honest than "412 days ago".
  if (seconds < 0 || seconds > RELATIVE_WINDOW_SECONDS) {
    return { relative: uploaded.toLocaleDateString("en-GB", { dateStyle: "medium" }), exact };
  }
  if (seconds < 60) return { relative: "just now", exact };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { relative: RELATIVE_TIME.format(-minutes, "minute"), exact };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { relative: RELATIVE_TIME.format(-hours, "hour"), exact };
  return { relative: RELATIVE_TIME.format(-Math.floor(hours / 24), "day"), exact };
}

/** Upload-row `status` → a short, practitioner-facing state word. Exhaustive over the values process-trial-balance actually writes. */
const STATE_LABEL: Record<string, string> = {
  processing: "Processing",
  complete: "Complete",
  needs_review: "Needs review",
  error: "Error",
  blocked: "Blocked",
};

const STATE_TONE: Record<string, string> = {
  processing: "text-primary",
  complete: "text-success",
  needs_review: "text-amber-600 dark:text-amber-500",
  error: "text-destructive",
  blocked: "text-destructive",
};

export function uploadStateLabel(status: string | null | undefined): string {
  if (!status) return "Unknown";
  return STATE_LABEL[status] ?? status;
}

export function ActiveFileProvenance({
  fileName,
  fileSize,
  uploadedAt,
  status,
  manageHref,
}: {
  fileName: string;
  fileSize: number;
  uploadedAt: string;
  /** Upload-row status. Omit the manage link's sibling state chip entirely when not supplied. */
  status?: string | null;
  manageHref?: string;
}) {
  const size = formatFileSize(fileSize);
  const time = describeUploadTime(uploadedAt, Date.now());
  const stateLabel = status !== undefined ? uploadStateLabel(status) : null;
  const stateTone = (status && STATE_TONE[status]) || "text-muted-foreground";

  return (
    <div className="mb-3 flex items-center justify-between gap-4" data-testid="active-file-provenance">
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
        <FileText aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate font-mono text-foreground/80" title={fileName}>
          {fileName}
        </span>
        {size && (
          <>
            <span aria-hidden="true" className="text-muted-foreground/50">·</span>
            <span className="shrink-0">{size}</span>
          </>
        )}
        {time && (
          <>
            <span aria-hidden="true" className="text-muted-foreground/50">·</span>
            <time className="shrink-0" dateTime={uploadedAt} title={time.exact}>
              {time.relative}
            </time>
          </>
        )}
        {stateLabel && (
          <>
            <span aria-hidden="true" className="text-muted-foreground/50">·</span>
            <span className={`shrink-0 font-medium ${stateTone}`} data-testid="active-file-state">
              {stateLabel}
            </span>
          </>
        )}
      </p>
      {manageHref && (
        <Link
          to={manageHref}
          className="shrink-0 whitespace-nowrap text-[12px] text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          Manage file <span aria-hidden="true">→</span>
        </Link>
      )}
    </div>
  );
}
