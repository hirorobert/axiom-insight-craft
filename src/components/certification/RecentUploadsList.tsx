import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { CertUpload, fmtDateTime, fmtNum } from "./types";

interface Props {
  uploads: CertUpload[];
  selectedId: string | null;
  onSelect: (u: CertUpload) => void;
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

export function RecentUploadsList({ uploads, selectedId, onSelect }: Props) {
  const groups = new Map<string, CertUpload[]>();
  for (const u of uploads) {
    const arr = groups.get(u.file_name) ?? [];
    arr.push(u);
    groups.set(u.file_name, arr);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime());
  }

  const groupList = Array.from(groups.entries()).sort(
    ([, a], [, b]) =>
      new Date(b[0].uploaded_at).getTime() - new Date(a[0].uploaded_at).getTime()
  );

  if (groupList.length === 0) return null;

  return (
    <div className="border border-border bg-card">
      <header className="border-b border-border px-4 py-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Trial Balances
        </h2>
      </header>
      <ul className="divide-y divide-border">
        {groupList.map(([fileName, versions]) => (
          <FileGroup
            key={fileName}
            fileName={fileName}
            versions={versions}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </div>
  );
}

function FileGroup({
  fileName,
  versions,
  selectedId,
  onSelect,
}: {
  fileName: string;
  versions: CertUpload[];
  selectedId: string | null;
  onSelect: (u: CertUpload) => void;
}) {
  const [open, setOpen] = useState(false);
  const latest = versions[0];
  const older = versions.slice(1);

  return (
    <li>
      <UploadRow upload={latest} selected={latest.id === selectedId} onSelect={onSelect} fileName={fileName} />
      {older.length > 0 && (
        <div className="border-t border-border bg-muted/30">
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
          >
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {older.length} older version{older.length === 1 ? "" : "s"}
          </button>
          {open && (
            <ul>
              {older.map((u) => (
                <UploadRow
                  key={u.id}
                  upload={u}
                  selected={u.id === selectedId}
                  onSelect={onSelect}
                  compact
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function UploadRow({
  upload,
  selected,
  onSelect,
  fileName,
  compact,
}: {
  upload: CertUpload;
  selected: boolean;
  onSelect: (u: CertUpload) => void;
  fileName?: string;
  compact?: boolean;
}) {
  const { tone, label } = toneFor(upload);
  const when = fmtDateTime(upload.uploaded_at);
  const tb = upload.processing_result?.validation_report?.tb_balance_check;
  const debits  = fmtNum(tb?.total_debits, 2);
  const credits = fmtNum(tb?.total_credits, 2);

  return (
    <button
      onClick={() => onSelect(upload)}
      className={`block w-full border-l-2 px-4 text-left transition-colors ${
        compact ? "py-2.5" : "py-3.5"
      } ${
        selected
          ? "border-l-foreground bg-muted/50"
          : "border-l-transparent hover:bg-muted/30"
      }`}
    >
      {fileName && (
        <p className="truncate text-sm font-medium text-foreground" title={fileName}>
          {fileName}
        </p>
      )}
      <div className={`flex items-center gap-2 ${fileName ? "mt-1.5" : ""}`}>
        <span
          className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${toneClasses[tone]}`}
        >
          {label}
        </span>
        {when && <span className="text-[11px] tabular-nums text-muted-foreground">{when}</span>}
      </div>
      {(debits || credits) && (
        <p className="mt-1 text-[11px] tabular-nums text-muted-foreground">
          {debits && <>Dr {debits}</>}
          {debits && credits && <span className="mx-1.5 text-muted-foreground/60">·</span>}
          {credits && <>Cr {credits}</>}
        </p>
      )}
    </button>
  );
}