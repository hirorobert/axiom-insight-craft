import { ArrowDown, ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { HERO } from "@/constants/copy";

const CONTROLLED_PATH = [
  ["Source", "Trial balance and evidence"],
  ["Decisions", "Reviewed classifications and exceptions"],
  ["Outputs", "Statements, workpapers and close evidence"],
] as const;

export function Hero() {
  const { user } = useAuth();

  return (
    <section className="relative overflow-hidden border-b border-border bg-background">
      <div className="mx-auto grid max-w-7xl grid-cols-1 lg:grid-cols-12">
        <div className="px-6 pb-16 pt-28 sm:pb-20 sm:pt-36 lg:col-span-7 lg:border-r lg:border-border lg:px-10 lg:pb-24 lg:pt-44">
          <p className="mb-8 text-[10px] font-mono uppercase tracking-[0.24em] text-muted-foreground">
            {HERO.eyebrow}
          </p>
          <h1 className="max-w-3xl text-[2.75rem] font-semibold leading-[0.98] tracking-[-0.045em] text-foreground sm:text-6xl lg:text-[4.35rem]">
            {HERO.headline}
          </h1>
          <p className="mt-7 max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
            {HERO.subhead}
          </p>

          <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Button variant="hero" size="xl" asChild className="w-full sm:w-auto">
              <a href="#outcomes">
                Choose your outcome
                <ArrowDown className="h-4 w-4" />
              </a>
            </Button>
            <Button variant="outline" size="xl" asChild className="w-full sm:w-auto">
              <a href={user ? "/dashboard" : "/auth"}>
                {user ? "Open workspace" : "Sign in"}
                <ArrowRight className="h-4 w-4" />
              </a>
            </Button>
          </div>
        </div>

        <aside className="bg-primary px-6 py-12 text-primary-foreground sm:px-10 lg:col-span-5 lg:flex lg:flex-col lg:justify-end lg:py-24">
          <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-primary-foreground/55">
            Controlled engagement
          </p>
          <h2 className="mt-5 max-w-md text-2xl font-semibold leading-tight tracking-tight">
            One source. Explicit decisions. Defensible output.
          </h2>
          <dl className="mt-10 border-t border-primary-foreground/20">
            {CONTROLLED_PATH.map(([term, detail], index) => (
              <div key={term} className="grid grid-cols-[2rem_1fr] gap-4 border-b border-primary-foreground/20 py-5">
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
            Choose only the work required for the engagement. CFOClose reveals the relevant path and keeps unrelated stages out of the way.
          </p>
        </aside>
      </div>

      <div className="border-t border-border bg-muted/25">
        <div className="mx-auto grid max-w-7xl grid-cols-1 divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {[
            ["01", "Outcome first", "Begin with the deliverable—not the software."],
            ["02", "Evidence always", "Every conclusion retains its source and review state."],
            ["03", "Expand by need", "Run one job or the complete financial close."],
          ].map(([number, title, detail]) => (
            <div key={number} className="px-6 py-6 lg:px-10">
              <p className="text-[10px] font-mono text-muted-foreground/55">{number}</p>
              <p className="mt-2 text-sm font-semibold text-foreground">{title}</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
