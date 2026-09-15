import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import {
  PRODUCT_OUTCOMES,
  outcomeAuthHref,
  rememberOutcome,
} from "@/lib/product/outcomes";

/**
 * ProductTour is retained as the public component boundary, but the former
 * autoplay demonstration has been replaced with a deterministic outcome
 * selector. Customers choose the work they need; internal engine names remain
 * implementation provenance, never information architecture.
 *
 * Each row shows exactly: number, outcome, one-sentence purpose, starts
 * with, produces, and an explicit action label (outcome.ctaLabel — never a
 * generic "Select"). No repeated availability/status text, no internal
 * stage strings, no letter-spaced metadata beyond the two small field
 * labels every row already needs.
 */
export function ProductTour() {
  return (
    <section id="outcomes" aria-labelledby="outcomes-title" className="border-b border-border bg-background">
      <div className="mx-auto max-w-5xl px-6 py-20 lg:px-10 lg:py-28">
        <div className="border-b border-border pb-10">
          <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground">
            Start with the outcome
          </p>
          <h2 id="outcomes-title" className="mt-4 max-w-2xl text-3xl font-semibold tracking-[-0.03em] text-foreground sm:text-4xl">
            What needs to be completed?
          </h2>
          <p className="mt-5 max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
            Select one deliverable or run the complete close. CFOClose opens only the stages and controls required for that engagement.
          </p>
        </div>

        <ol className="divide-y divide-border border-b border-border">
          {PRODUCT_OUTCOMES.map((outcome) => {
            const isCompleteClose = outcome.id === "full-close";
            return (
              <li
                key={outcome.id}
                className={[
                  "grid grid-cols-1 gap-5 py-8 sm:grid-cols-[auto_1fr] sm:gap-x-6",
                  isCompleteClose ? "bg-primary text-primary-foreground -mx-6 px-6 lg:-mx-10 lg:px-10" : "",
                ].join(" ")}
              >
                <span
                  aria-hidden="true"
                  className={`text-sm font-mono sm:pt-1 ${isCompleteClose ? "text-primary-foreground/50" : "text-muted-foreground/60"}`}
                >
                  {outcome.number}
                </span>

                <div className="min-w-0 space-y-4">
                  <div>
                    <h3 className="text-xl font-semibold leading-snug">{outcome.title}</h3>
                    <p className={`mt-2 max-w-2xl text-sm leading-6 ${isCompleteClose ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                      {outcome.promise}
                    </p>
                  </div>

                  <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:max-w-xl">
                    <div>
                      <dt className={`text-[11px] uppercase tracking-wide ${isCompleteClose ? "text-primary-foreground/45" : "text-muted-foreground/70"}`}>
                        Starts with
                      </dt>
                      <dd className={`mt-1 text-sm leading-5 ${isCompleteClose ? "text-primary-foreground/85" : "text-foreground"}`}>
                        {outcome.input}
                      </dd>
                    </div>
                    <div>
                      <dt className={`text-[11px] uppercase tracking-wide ${isCompleteClose ? "text-primary-foreground/45" : "text-muted-foreground/70"}`}>
                        Produces
                      </dt>
                      <dd className={`mt-1 text-sm leading-5 ${isCompleteClose ? "text-primary-foreground/85" : "text-foreground"}`}>
                        {outcome.deliverable}
                      </dd>
                    </div>
                  </dl>

                  <Link
                    to={outcomeAuthHref(outcome.id)}
                    onClick={() => rememberOutcome(outcome.id)}
                    aria-label={`${outcome.ctaLabel}: ${outcome.title}`}
                    className={[
                      "inline-flex min-h-[44px] items-center gap-2 border-b pb-1 text-sm font-semibold transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm",
                      isCompleteClose
                        ? "border-primary-foreground/40 text-primary-foreground hover:border-primary-foreground"
                        : "border-foreground/25 text-foreground hover:border-foreground",
                    ].join(" ")}
                  >
                    {outcome.ctaLabel}
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}
