import { ArrowRight, ArrowDown, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { HERO, CTA } from "@/constants/copy";

// ─── Honest controlled-path description (no fake live data) ────────────────
const CONTROLLED_PATH = [
  ["Source",    "Trial balance and supporting evidence"],
  ["Decisions", "Reviewed classifications and recorded exceptions"],
  ["Outputs",   "Statements, workpapers and close evidence"],
] as const;

// ─── Trust metrics — all factual product properties ────────────────────────
const TRUST_METRICS = [
  { value: "7-stage",  label: "accounting workflow" },
  { value: "IFRS",     label: "framework-aware"     },
  { value: "H-01–12",  label: "assurance checks"    },
  { value: "WCAG AA",  label: "accessible"          },
] as const;

export function Hero() {
  const { user } = useAuth();

  return (
    <section className="relative overflow-hidden border-b border-border bg-background">

      {/* ── Main grid ─────────────────────────────────────────────────── */}
      <div className="mx-auto grid max-w-7xl grid-cols-1 lg:grid-cols-12">

        {/* ── Left: Headline + CTAs + trust strip ───────────────────── */}
        <div className="flex flex-col justify-center px-6 pb-12 pt-24 sm:pt-32 lg:col-span-7 lg:border-r lg:border-border lg:px-10 lg:pb-16 lg:pt-36">

          <p className="mb-6 text-[10px] font-mono uppercase tracking-[0.24em] text-muted-foreground">
            {HERO.eyebrow}
          </p>

          <h1 className="text-[2.6rem] font-semibold leading-[1.00] tracking-[-0.04em] text-foreground sm:text-5xl lg:text-[3.75rem] xl:text-[4.25rem]">
            {HERO.headline}
          </h1>

          <p className="mt-6 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
            {HERO.subhead}
          </p>

          {/* ── Primary CTAs ────────────────────────────────────────── */}
          <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Button
              variant="hero"
              size="xl"
              asChild
              className="w-full text-base sm:w-auto sm:min-w-[160px]"
            >
              <a href={user ? "/dashboard" : "/auth"}>
                {user ? "Open workspace" : CTA.primary}
                <ArrowRight className="h-4 w-4" />
              </a>
            </Button>
            <Button
              variant="outline"
              size="xl"
              asChild
              className="w-full sm:w-auto"
            >
              <a href="#outcomes">
                See how it works
                <ArrowDown className="h-4 w-4" />
              </a>
            </Button>
          </div>

          {/* ── Trust metrics strip — factual product properties ──── */}
          <div className="mt-10 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-8 sm:grid-cols-4">
            {TRUST_METRICS.map(({ value, label }) => (
              <div key={label}>
                <p className="text-lg font-semibold tracking-tight text-foreground">{value}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">{label}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ── Right: Honest controlled-path description ─────────────── */}
        <aside className="bg-primary px-6 py-12 text-primary-foreground sm:px-10 lg:col-span-5 lg:flex lg:flex-col lg:justify-end lg:py-24">
          <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-primary-foreground/55">
            Controlled engagement
          </p>
          <h2 className="mt-5 max-w-md text-2xl font-semibold leading-tight tracking-tight">
            One source. Explicit decisions. Defensible output.
          </h2>
          <dl className="mt-10 border-t border-primary-foreground/20">
            {CONTROLLED_PATH.map(([term, detail], index) => (
              <div
                key={term}
                className="grid grid-cols-[2rem_1fr] gap-4 border-b border-primary-foreground/20 py-5"
              >
                <div className="flex h-6 w-6 items-center justify-center border border-primary-foreground/35">
                  <Check className="h-3 w-3" />
                </div>
                <div>
                  <dt className="text-[10px] font-mono uppercase tracking-[0.18em] text-primary-foreground/50">
                    {String(index + 1).padStart(2, "0")} · {term}
                  </dt>
                  <dd className="mt-1 text-sm leading-6 text-primary-foreground/90">{detail}</dd>
                </div>
              </div>
            ))}
          </dl>
          <p className="mt-8 max-w-md text-xs leading-5 text-primary-foreground/55">
            Choose only the work required for the engagement. CFOClose reveals the relevant path
            and keeps unrelated stages out of the way.
          </p>
        </aside>
      </div>

      {/* ── Below-fold: 3 principles strip ───────────────────────────── */}
      <div className="border-t border-border bg-muted/25">
        <div className="mx-auto grid max-w-7xl grid-cols-1 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {[
            ["01", "Outcome first",   "Choose the deliverable — the workspace opens only the stages required."],
            ["02", "Evidence always", "Every conclusion retains its source document, reviewer, and decision state."],
            ["03", "Expand by need",  "Run a single job or the complete financial close. No locked-in workflow."],
          ].map(([n, title, detail]) => (
            <div key={n} className="px-6 py-5 lg:px-10">
              <p className="text-[10px] font-mono text-muted-foreground/45">{n}</p>
              <p className="mt-1.5 text-sm font-semibold text-foreground">{title}</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
