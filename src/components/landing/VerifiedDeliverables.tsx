/**
 * VerifiedDeliverables — only outputs a user can reach in the current interface, with how they
 * are reached and in which formats.
 *
 * Structured regulatory filing formats are deliberately absent: the generator exists in the
 * repository but is not reachable from the interface, so advertising it would be a claim about
 * code rather than about the product.
 *
 * A table on wide screens; a definition list on narrow ones, so nothing is horizontally crushed.
 */

import {
  LANDING_DELIVERABLES,
  LANDING_DELIVERABLES_NOTE,
} from "@/content/landing/landingContent";

export function VerifiedDeliverables() {
  return (
    <section
      id="deliverables"
      aria-labelledby="deliverables-title"
      className="border-b border-border bg-background"
    >
      <div className="mx-auto max-w-7xl px-6 py-12 lg:px-10 lg:py-16">
        <div className="max-w-2xl">
          <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground">
            Deliverables
          </p>
          <h2
            id="deliverables-title"
            className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground sm:text-3xl"
          >
            Outputs you can reach today.
          </h2>
        </div>

        {/* ── Wide screens: table ──────────────────────────────────────────── */}
        <div className="mt-8 hidden border border-border md:block">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                {["Output", "How it is reached", "Formats", "Note"].map((heading) => (
                  <th
                    key={heading}
                    scope="col"
                    className="px-4 py-3 text-[9px] font-mono uppercase tracking-[0.18em] text-muted-foreground"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {LANDING_DELIVERABLES.map((item) => (
                <tr key={item.name} className="border-b border-border last:border-b-0">
                  <th scope="row" className="px-4 py-3 align-top text-xs font-semibold text-foreground">
                    {item.name}
                  </th>
                  <td className="px-4 py-3 align-top text-xs text-muted-foreground">{item.access}</td>
                  <td className="whitespace-nowrap px-4 py-3 align-top text-xs text-muted-foreground">
                    {item.formats}
                  </td>
                  <td className="px-4 py-3 align-top text-xs leading-5 text-muted-foreground">
                    {item.note}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ── Narrow screens: stacked list ─────────────────────────────────── */}
        <dl className="mt-8 divide-y divide-border border-y border-border md:hidden">
          {LANDING_DELIVERABLES.map((item) => (
            <div key={item.name} className="py-4">
              <dt className="text-xs font-semibold text-foreground">{item.name}</dt>
              <dd className="mt-1.5 text-[11px] leading-5 text-muted-foreground">
                <span className="block">{item.access} · {item.formats}</span>
                <span className="mt-1 block">{item.note}</span>
              </dd>
            </div>
          ))}
        </dl>

        <p className="mt-6 max-w-3xl text-[11px] leading-5 text-muted-foreground">
          {LANDING_DELIVERABLES_NOTE}
        </p>
      </div>
    </section>
  );
}
