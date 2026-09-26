/**
 * CommercialVerification — the proposed plan structure, shown under a heading that states its
 * status plainly, with the verification notice rendered before the plans themselves.
 *
 * Every figure is prefixed "Proposed". Entity limits and named-user capacity are not enforced by
 * the system today and self-serve payment is switched off, so nothing here is presented as
 * purchasable and nothing here is emitted as structured data.
 */

import { COMMERCIAL_HEADING, COMMERCIAL_NOTICE } from "@/content/landing/landingContent";
import { PROPOSED_PLANS } from "@/content/landing/proposedPlans";

export function CommercialVerification() {
  return (
    <section
      id="commercial"
      aria-labelledby="commercial-title"
      className="border-b border-border bg-muted/25"
    >
      <div className="mx-auto max-w-7xl px-6 py-12 lg:px-10 lg:py-16">
        <div className="max-w-3xl">
          <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground">
            Commercial status
          </p>
          <h2
            id="commercial-title"
            className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-3xl"
          >
            {COMMERCIAL_HEADING}
          </h2>
        </div>

        {/* ── Verification notice — before the plans, not after ────────────── */}
        <p
          data-testid="commercial-verification-notice"
          className="mt-6 max-w-3xl border-l-2 border-foreground bg-background px-4 py-3 text-xs leading-5 text-foreground sm:text-[13px] sm:leading-6"
        >
          {COMMERCIAL_NOTICE}
        </p>

        <div className="mt-8 grid grid-cols-1 gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {PROPOSED_PLANS.map((plan) => (
            <article key={plan.name} className="flex flex-col bg-background p-5">
              <h3 className="text-sm font-semibold text-foreground">{plan.name}</h3>
              <p className="mt-3 text-xs font-medium text-foreground">{plan.proposedAmount}</p>
              <dl className="mt-4 space-y-2 border-t border-border pt-4 text-[11px] leading-5 text-muted-foreground">
                <div>
                  <dt className="sr-only">Proposed entity capacity</dt>
                  <dd>{plan.proposedEntities}</dd>
                </div>
                <div>
                  <dt className="sr-only">Proposed named-user capacity</dt>
                  <dd>{plan.proposedUsers}</dd>
                </div>
                <div>
                  <dt className="sr-only">Proposed capabilities</dt>
                  <dd>{plan.proposedCapabilities}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
