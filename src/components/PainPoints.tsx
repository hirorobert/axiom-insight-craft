import { X, CheckCircle2 } from "lucide-react";

// ─── Before / After contrast strip ─────────────────────────────────────────
// Shows the exact professional friction CFOClose eliminates.
// No engine names. No jargon. Specific, defensible, honest.

const PAIN_PAIRS: readonly [before: string, after: string][] = [
  [
    "Trial balance in a spreadsheet shared by email — version unknown",
    "Single ingestion event with hash-verified source and duplicate detection",
  ],
  [
    "Account classifications guessed from description strings",
    "Confidence-graded classification with exception queue and professional sign-off",
  ],
  [
    "Tax computation in a separate workbook, reconciled manually to statements",
    "Structured tax workpapers derived from the same reviewed source — no reconciliation step",
  ],
  [
    "Compliance checklist in a Word document updated by hand",
    "Findings and readiness checks generated from the computation evidence already in the engagement",
  ],
  [
    "\"Who approved this?\" answered by checking email threads",
    "Every transition carries actor identity from the authenticated server session — no name supplied by the browser",
  ],
  [
    "Prior-year comparatives copy-pasted and reformatted each cycle",
    "Comparative movement and variance analysis from a closed prior-period close file",
  ],
] as const;

export function PainPoints() {
  return (
    <section className="border-b border-border bg-muted/10">
      <div className="mx-auto max-w-7xl px-6 py-12 lg:px-10 lg:py-16">

        {/* Section label */}
        <div className="mb-8 border-b border-border pb-8">
          <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground">
            Why professionals switch
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-3xl">
            The close you have now vs the close CFOClose gives you.
          </h2>
        </div>

        {/* Column headers */}
        <div className="mb-4 grid grid-cols-2 gap-px">
          <div className="flex items-center gap-2 px-1">
            <X className="h-3.5 w-3.5 shrink-0 text-destructive/70" strokeWidth={2.5} />
            <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground/60">
              Current state
            </p>
          </div>
          <div className="flex items-center gap-2 px-1">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" strokeWidth={2} />
            <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground/60">
              With CFOClose
            </p>
          </div>
        </div>

        {/* Pain pairs */}
        <div className="divide-y divide-border border-y border-border">
          {PAIN_PAIRS.map(([before, after], i) => (
            <div key={i} className="grid grid-cols-2 gap-px">
              {/* Before */}
              <div className="flex items-start gap-3 bg-destructive/[0.03] px-4 py-4">
                <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive/50" strokeWidth={2} />
                <p className="text-xs leading-5 text-muted-foreground">{before}</p>
              </div>
              {/* After */}
              <div className="flex items-start gap-3 bg-success/[0.04] px-4 py-4">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" strokeWidth={2} />
                <p className="text-xs leading-5 text-foreground">{after}</p>
              </div>
            </div>
          ))}
        </div>

      </div>
    </section>
  );
}
