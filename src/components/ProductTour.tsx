import { ArrowRight, CheckCircle2, Clock, Zap } from "lucide-react";
import { Link } from "react-router-dom";
import {
  PRODUCT_OUTCOMES,
  outcomeAuthHref,
  rememberOutcome,
} from "@/lib/product/outcomes";

const AVAIL_ICON = {
  "Workflow available": <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" strokeWidth={2} />,
  "Data dependent":     <Clock className="h-3.5 w-3.5 text-amber-500" strokeWidth={1.5} />,
} as const;

const AVAIL_COLOUR = {
  "Workflow available": "text-emerald-600",
  "Data dependent":     "text-amber-600",
} as const;

/**
 * ProductTour — Ω∞ nuclear redesign.
 * Dense 2-col card grid. No wasted vertical space. Full-close card full-width at bottom.
 * Engine names never surface here.
 */
export function ProductTour() {
  const fullClose = PRODUCT_OUTCOMES.find((o) => o.id === "full-close")!;

  return (
    <section id="outcomes" aria-labelledby="outcomes-title" className="border-b border-border bg-background">
      <div className="mx-auto max-w-7xl px-6 py-12 lg:px-10 lg:py-16">

        {/* ── Section header ────────────────────────────────────────────── */}
        <div className="mb-8 flex flex-col gap-3 border-b border-border pb-8 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground">
              Start with the outcome
            </p>
            <h2 id="outcomes-title" className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-3xl">
              What needs to be completed?
            </h2>
          </div>
          <p className="max-w-sm text-sm text-muted-foreground">
            Select one deliverable or run the complete close. CFOClose opens only the stages required.
          </p>
        </div>

        {/* ── Standard outcome cards — 2-col grid ──────────────────────── */}
        <div className="grid grid-cols-1 gap-px border border-border bg-border sm:grid-cols-2">
          {PRODUCT_OUTCOMES.map((outcome) => outcome.id === "full-close" ? null : (
            <article
              key={outcome.id}
              className="group relative flex flex-col bg-background p-6 transition-colors hover:bg-muted/30"
            >
              {/* Number + availability */}
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-muted-foreground/45">{outcome.number}</span>
                <span className={`flex items-center gap-1.5 text-[9px] font-mono uppercase tracking-[0.14em] ${AVAIL_COLOUR[outcome.availability]}`}>
                  {AVAIL_ICON[outcome.availability]}
                  {outcome.availability}
                </span>
              </div>

              {/* Title */}
              <h3 className="mt-4 text-base font-semibold leading-snug text-foreground">
                {outcome.title}
              </h3>

              {/* Promise */}
              <p className="mt-2 text-xs leading-5 text-muted-foreground flex-1">
                {outcome.promise}
              </p>

              {/* Produces */}
              <div className="mt-5 border-t border-border pt-4">
                <p className="text-[9px] font-mono uppercase tracking-[0.18em] text-muted-foreground/50">
                  Produces
                </p>
                <p className="mt-1.5 text-xs font-medium text-foreground">
                  {outcome.deliverable}
                </p>
              </div>

              {/* Stages scope */}
              <div className="mt-3 flex items-center justify-between">
                <p className="text-[9px] font-mono uppercase tracking-[0.14em] text-muted-foreground/45">
                  {outcome.scope}
                </p>
                <Link
                  to={outcomeAuthHref(outcome.id)}
                  onClick={() => rememberOutcome(outcome.id)}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-foreground hover:text-primary transition-colors border-b border-foreground/20 pb-0.5 hover:border-primary"
                >
                  Select
                  <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </div>
            </article>
          ))}
        </div>

        {/* ── Full close — full-width hero card ────────────────────────── */}
        <article className="group relative mt-px border border-t-0 border-border bg-primary text-primary-foreground">
          <div className="grid grid-cols-1 gap-6 p-6 sm:grid-cols-12 sm:items-center sm:p-8 lg:p-10">

            {/* Badge */}
            <div className="sm:col-span-12">
              <span className="inline-flex items-center gap-1.5 rounded-sm border border-primary-foreground/20 bg-primary-foreground/10 px-2.5 py-1 text-[10px] font-mono uppercase tracking-[0.18em] text-primary-foreground/70">
                <Zap className="h-3 w-3" />
                {fullClose.number} · Complete workflow
              </span>
            </div>

            {/* Title + promise */}
            <div className="sm:col-span-7">
              <h3 className="text-xl font-semibold leading-snug sm:text-2xl">
                {fullClose.title}
              </h3>
              <p className="mt-3 text-sm leading-6 text-primary-foreground/65">
                {fullClose.promise}
              </p>
            </div>

            {/* Deliverable + CTA */}
            <div className="sm:col-span-5 sm:text-right">
              <div className="sm:border-l sm:border-primary-foreground/15 sm:pl-8">
                <p className="text-[9px] font-mono uppercase tracking-[0.18em] text-primary-foreground/40">
                  Produces
                </p>
                <p className="mt-2 text-sm font-semibold text-primary-foreground">
                  {fullClose.deliverable}
                </p>
                <p className="mt-1 text-[10px] text-primary-foreground/50">
                  {fullClose.input}
                </p>
                <Link
                  to={outcomeAuthHref(fullClose.id)}
                  onClick={() => rememberOutcome(fullClose.id)}
                  className="mt-5 inline-flex items-center gap-2 border border-primary-foreground/30 bg-primary-foreground/10 px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary-foreground/20 transition-colors"
                >
                  Start complete close
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </div>
            </div>
          </div>
        </article>

      </div>
    </section>
  );
}
