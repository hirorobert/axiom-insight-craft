import { CertUpload, fmtDateTime } from "./types";

interface Props {
  upload: CertUpload;
  action?: React.ReactNode;
}

type Tone = "valid" | "review" | "blocked" | "processing";

function toneFor(u: CertUpload): { tone: Tone; label: string } {
  if (u.is_valid === false || u.status === "blocked" || u.status === "error" || u.status === "invalid") {
    return { tone: "blocked", label: "Blocked" };
  }
  if (u.status === "needs_review") return { tone: "review", label: "Review Required" };
  if (u.status === "complete" || u.is_valid === true) return { tone: "valid", label: "Certified" };
  return { tone: "processing", label: "Processing" };
}

const toneClasses: Record<Tone, string> = {
  valid:      "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900/50",
  review:     "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:border-amber-900/50",
  blocked:    "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900/50",
  processing: "bg-muted text-muted-foreground border-border",
};

export function CertificationHeader({ upload, action }: Props) {
  const { tone, label } = toneFor(upload);
  const processed = fmtDateTime(upload.processed_at) ?? fmtDateTime(upload.uploaded_at);

  return (
    <div className="border border-border bg-card">
      <div className="flex flex-col gap-4 p-6 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="mb-3 flex items-center gap-3">
            <span
              className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${toneClasses[tone]}`}
            >
              {label}
            </span>
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              Certification Console
            </span>
          </div>
          <h1 className="truncate text-xl font-semibold text-foreground">
            {upload.company_name ?? "Unassigned company"}
          </h1>
          <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-1 text-sm md:grid-cols-3">
            <div className="flex gap-2">
              <dt className="text-muted-foreground">File</dt>
              <dd className="truncate font-medium text-foreground" title={upload.file_name}>
                {upload.file_name}
              </dd>
            </div>
            {processed && (
              <div className="flex gap-2">
                <dt className="text-muted-foreground">Processed</dt>
                <dd className="font-medium text-foreground tabular-nums">{processed}</dd>
              </div>
            )}
            <div className="flex gap-2">
              <dt className="text-muted-foreground">Status</dt>
              <dd className="font-medium text-foreground">{label}</dd>
            </div>
          </dl>
        </div>
        {action && <div className="flex-shrink-0">{action}</div>}
      </div>
    </div>
  );
}