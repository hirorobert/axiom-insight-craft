/**
 * TrialBalanceTemplateGuide — the file contract, stated once, next to the
 * upload form.
 *
 * Presentation only. The files and rules come from lib/ingestion/trialBalanceTemplate, which is tested against the
 * server's ingestion core; nothing here parses, validates or writes anything. The downloads are the same for every
 * workspace — no company name or year in the file or its name.
 */

import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  EXAMPLE_FILE_NAME, FILE_FIELDS, FILE_RULES, TEMPLATE_FILE_NAME, exampleCsv, templateCsv,
} from "@/lib/ingestion/trialBalanceTemplate";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

function saveCsv(text: string, fileName: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function TrialBalanceTemplateGuide() {
  const [open, setOpen] = useState(false);
  const downloadTemplate = () => saveCsv(templateCsv(), TEMPLATE_FILE_NAME);
  const downloadExample = () => saveCsv(exampleCsv(), EXAMPLE_FILE_NAME);

  const required = FILE_FIELDS.filter((f) => f.requirement === "Required").map((f) => f.column);

  return (
    <aside data-testid="tb-template-guide" className="border border-border bg-card">
      <header className="border-b border-border px-5 py-3">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          File requirements
        </h2>
      </header>

      {/* Quiet by design: four columns, one line of reassurance, two actions.
          Everything else lives one click away so the eye stays on the upload. */}
      <div className="space-y-3 px-5 py-4">
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          One row per ledger account. CSV, XLSX or XLS.
        </p>
        <ul className="flex flex-wrap gap-1.5">
          {required.map((c) => (
            <li
              key={c}
              className="border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-foreground"
            >
              {c}
            </li>
          ))}
        </ul>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Header names are matched automatically — an export from your accounting
          system usually needs no editing.
        </p>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={downloadTemplate} className="gap-1.5">
            <Download className="h-3.5 w-3.5" />
            CSV template
          </Button>
          <Button variant="ghost" size="sm" onClick={downloadExample} className="gap-1.5 text-muted-foreground">
            <Download className="h-3.5 w-3.5" />
            Example
          </Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="sm" className="text-muted-foreground">
                Full specification
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Trial balance file specification</DialogTitle>
                <DialogDescription>
                  Every column the importer reads, and what it does with it.
                </DialogDescription>
              </DialogHeader>

              <ul className="divide-y divide-border border-t border-border">
                {FILE_FIELDS.map((f) => (
                  <li key={f.column} className="py-3">
                    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                      <span className="text-sm font-medium text-foreground">{f.column}</span>
                      <span
                        className={`font-mono text-[10px] uppercase tracking-[0.16em] ${
                          f.requirement === "Required" ? "text-foreground" : "text-muted-foreground"
                        }`}
                      >
                        {f.requirement}
                      </span>
                    </div>
                    <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{f.rule}</p>
                    <p className="mt-1 font-mono text-[11px] text-muted-foreground/80">
                      Accepted headers: {f.accepted}
                    </p>
                  </li>
                ))}
              </ul>

              <div className="border-t border-border pt-3">
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                  How the file is checked
                </p>
                <ul className="mt-2 space-y-1 text-[12px] leading-relaxed text-muted-foreground">
                  {FILE_RULES.map((rule) => (
                    <li key={rule}>{rule}</li>
                  ))}
                </ul>
              </div>

              <div className="pt-2">
                <Button variant="outline" size="sm" onClick={downloadTemplate} className="gap-1.5">
                  <Download className="h-3.5 w-3.5" />
                  Download CSV template
                </Button>
                <Button variant="ghost" size="sm" onClick={downloadExample} className="ml-2 gap-1.5">
                  <Download className="h-3.5 w-3.5" />
                  Download example
                </Button>
                <p className="mt-2 text-[12px] text-muted-foreground">
                  The example is for reference only — it is refused if uploaded unchanged.
                </p>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </aside>
  );
}
