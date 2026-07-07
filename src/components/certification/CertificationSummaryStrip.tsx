import { CertUpload, fmtNum } from "./types";

interface Props { upload: CertUpload }

export function CertificationSummaryStrip({ upload }: Props) {
  const pr = upload.processing_result;
  if (!pr) return null;

  const summary = pr.summary ?? {};
  const mc = pr.validation_report?.mapping_completeness ?? {};
  const nra: unknown[] = Array.isArray(pr.needs_review_accounts) ? pr.needs_review_accounts : [];

  const total   = summary.total_accounts ?? mc.total_accounts;
  const mapped  = mc.mapped_accounts;
  const auto    = summary.auto_classified ?? mc.auto_classified;
  const review  = nra.length > 0 ? nra.length : undefined;

  const items: Array<{ label: string; value: string }> = [];
  const totalS  = fmtNum(total);
  const mappedS = fmtNum(mapped);
  const autoS   = fmtNum(auto);
  const reviewS = fmtNum(review);

  if (totalS)  items.push({ label: "Accounts",         value: totalS  });
  if (mappedS) items.push({ label: "Mapped",           value: mappedS });
  if (autoS)   items.push({ label: "Auto-classified",  value: autoS   });
  if (reviewS) items.push({ label: "Needs review",     value: reviewS });

  if (items.length === 0) return null;

  return (
    <div className="border border-border border-t-0 bg-card">
      <div className="flex flex-wrap divide-x divide-border">
        {items.map((i) => (
          <div key={i.label} className="min-w-[10rem] flex-1 px-6 py-4">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{i.label}</p>
            <p className="mt-1 text-lg font-semibold text-foreground tabular-nums">{i.value}</p>
          </div>
        ))}
      </div>
    </div>
  );
}