/**
 * CoreCapabilities — the four customer-facing capabilities, as structured rows rather than a
 * card grid. Availability is stated plainly: "Available on every plan", or "Proposed for paid
 * capacity" where the commercial structure is still under enforcement verification.
 *
 * Internal engine names never appear here; the copy lives in landingContent.ts.
 */

import { LANDING_CAPABILITIES } from "@/content/landing/landingContent";

export function CoreCapabilities() {
  return (
    <section
      id="capabilities"
      aria-labelledby="capabilities-title"
      className="border-b border-border bg-background"
    >
      <div className="mx-auto max-w-7xl px-6 py-12 lg:px-10 lg:py-16">
        <div className="max-w-2xl">
          <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground">
            Capabilities
          </p>
          <h2
            id="capabilities-title"
            className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-3xl"
          >
            What the workspace does.
          </h2>
        </div>

        <ul className="mt-8 divide-y divide-border border-y border-border">
          {LANDING_CAPABILITIES.map((capability) => (
            <li
              key={capability.index}
              className="grid grid-cols-1 gap-2 py-5 sm:grid-cols-12 sm:gap-6"
            >
              <p className="text-[10px] font-mono tracking-[0.16em] text-muted-foreground sm:col-span-1 sm:pt-1">
                {capability.index}
              </p>
              <h3 className="text-sm font-semibold text-foreground sm:col-span-3 sm:pt-0.5">
                {capability.title}
              </h3>
              <p className="text-xs leading-5 text-muted-foreground sm:col-span-6">
                {capability.description}
              </p>
              <p className="text-[10px] font-mono uppercase tracking-[0.14em] text-muted-foreground sm:col-span-2 sm:pt-1 sm:text-right">
                {capability.availability}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
