import { ArrowRight, CheckCircle2 } from "lucide-react";
import { Link } from "react-router-dom";
import {
  PRODUCT_OUTCOMES,
  outcomeAuthHref,
  rememberOutcome,
} from "@/lib/product/outcomes";

const AVAILABILITY_TONE = {
  "Workflow available": "text-success",
  "Tanzania workflow": "text-foreground",
  "Data dependent": "text-muted-foreground",
} as const;

/**
 * ProductTour is retained as the public component boundary, but the former
 * autoplay demonstration has been replaced with a deterministic outcome
 * selector. Customers choose the work they need; internal engine names remain
 * implementation provenance, never information architecture.
 */
export function ProductTour() {
  return (
    <section id="outcomes" aria-labelledby="outcomes-title" className="border-b border-border bg-background">
      <div className="mx-auto max-w-7xl px-6 py-20 lg:px-10 lg:py-28">
        <div className="grid grid-cols-1 gap-8 border-b border-border pb-10 lg:grid-cols-12 lg:gap-12">
          <div className="lg:col-span-4">
            <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground">
              Start with the outcome
            </p>
          </div>
          <div className="lg:col-span-8">
            <h2 id="outcomes-title" className="max-w-3xl text-3xl font-semibold tracking-[-0.03em] text-foreground sm:text-4xl">
              What needs to be completed?
            </h2>
            <p className="mt-5 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
              Select one deliverable or run the complete close. CFOClose opens only the stages and controls required for that engagement.
            </p>
          </div>
        </div>

        <div className="divide-y divide-border border-b border-border">
          {PRODUCT_OUTCOMES.map((outcome) => {
            const isCompleteClose = outcome.id === "full-close";
            return (
              <article
                key={outcome.id}
                className={[
                  "group grid grid-cols-1 gap-6 px-0 py-8 transition-colors lg:grid-cols-12 lg:items-start lg:gap-8 lg:py-9",
                  isCompleteClose ? "bg-primary text-primary-foreground -mx-6 px-6 lg:-mx-10 lg:px-10" : "hover:bg-muted/30",
                ].join(" ")}
              >
                <div className="lg:col-span-1">
                  <span className={`text-[11px] font-mono ${isCompleteClose ? "text-primary-foreground/50" : "text-muted-foreground/55"}`}>
                    {outcome.number}
                  </span>
                </div>

                <div className="lg:col-span-4">
                  <h3 className="text-lg font-semibold leading-snug">{outcome.title}</h3>
                  <p className={`mt-3 text-sm leading-6 ${isCompleteClose ? "text-primary-foreground/65" : "text-muted-foreground"}`}>
                    {outcome.promise}
                  </p>
                </div>

                <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:col-span-5">
                  <div>
                    <dt className={`text-[9px] font-mono uppercase tracking-[0.2em] ${isCompleteClose ? "text-primary-foreground/40" : "text-muted-foreground/55"}`}>
                      Starts with
                    </dt>
                    <dd className={`mt-2 text-xs leading-5 ${isCompleteClose ? "text-primary-foreground/80" : "text-foreground"}`}>
                      {outcome.input}
                    </dd>
                  </div>
                  <div>
                    <dt className={`text-[9px] font-mono uppercase tracking-[0.2em] ${isCompleteClose ? "text-primary-foreground/40" : "text-muted-foreground/55"}`}>
                      Produces
                    </dt>
                    <dd className={`mt-2 text-xs leading-5 ${isCompleteClose ? "text-primary-foreground/80" : "text-foreground"}`}>
                      {outcome.deliverable}
                    </dd>
                  </div>
                  <div className="sm:col-span-2 flex items-center gap-2">
                    <CheckCircle2 className={`h-3.5 w-3.5 ${isCompleteClose ? "text-primary-foreground/65" : AVAILABILITY_TONE[outcome.availability]}`} />
                    <span className={`text-[10px] font-mono uppercase tracking-[0.14em] ${isCompleteClose ? "text-primary-foreground/55" : AVAILABILITY_TONE[outcome.availability]}`}>
                      {outcome.availability} · {outcome.scope}
                    </span>
                  </div>
                </dl>

                <div className="lg:col-span-2 lg:text-right">
                  <Link
                    to={outcomeAuthHref(outcome.id)}
                    onClick={() => rememberOutcome(outcome.id)}
                    className={[
                      "inline-flex items-center gap-2 border-b pb-1 text-sm font-semibold transition-colors",
                      isCompleteClose
                        ? "border-primary-foreground/40 text-primary-foreground hover:border-primary-foreground"
                        : "border-foreground/25 text-foreground hover:border-foreground",
                    ].join(" ")}
                  >
                    Select
                    <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
