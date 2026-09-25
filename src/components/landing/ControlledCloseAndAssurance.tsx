/**
 * ControlledCloseAndAssurance — the three-step controlled-close process and the Close Assurance
 * control layer, presented together in one section because they describe the same thing from two
 * directions: what the work does, and what the workspace holds constant while it happens.
 *
 * Close Assurance is stated as the baseline present throughout, never as a paid module and never
 * as assurance over the financial information itself. Control wording is fixed in landingContent.ts.
 */

import {
  CLOSE_ASSURANCE_CONTROLS,
  CLOSE_ASSURANCE_INTRO,
  LANDING_PROCESS,
} from "@/content/landing/landingContent";

export function ControlledCloseAndAssurance() {
  return (
    <section
      id="process"
      aria-labelledby="process-title"
      className="border-b border-border bg-muted/25"
    >
      <div className="mx-auto max-w-7xl px-6 py-12 lg:px-10 lg:py-16">

        {/* ── Process ──────────────────────────────────────────────────────── */}
        <div className="max-w-2xl">
          <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground">
            Controlled close
          </p>
          <h2
            id="process-title"
            className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-3xl"
          >
            How an engagement progresses.
          </h2>
        </div>

        <ol className="mt-8 grid grid-cols-1 gap-px border border-border bg-border sm:grid-cols-3">
          {LANDING_PROCESS.map((step) => (
            <li key={step.index} className="bg-background p-5 lg:p-6">
              <p className="text-[10px] font-mono tracking-[0.16em] text-muted-foreground">
                {step.index}
              </p>
              <h3 className="mt-4 text-sm font-semibold text-foreground">{step.title}</h3>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{step.description}</p>
            </li>
          ))}
        </ol>

        {/* ── Close Assurance ──────────────────────────────────────────────── */}
        <div className="mt-12 border-t border-border pt-10 lg:mt-14">
          <div className="max-w-2xl">
            <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground">
              Close Assurance
            </p>
            <h3 className="mt-2 text-xl font-semibold tracking-[-0.025em] text-foreground sm:text-2xl">
              The control layer applied on every plan.
            </h3>
            <p className="mt-3 text-xs leading-5 text-muted-foreground sm:text-sm sm:leading-6">
              {CLOSE_ASSURANCE_INTRO}
            </p>
          </div>

          <dl className="mt-8 grid grid-cols-1 gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
            {CLOSE_ASSURANCE_CONTROLS.map((control) => (
              <div key={control.title} className="bg-background p-5">
                <dt className="text-sm font-semibold text-foreground">{control.title}</dt>
                <dd className="mt-1.5 text-xs leading-5 text-muted-foreground">
                  {control.description}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}
