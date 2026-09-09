import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  TRUST_GUARANTEES,
  PLATFORM_TABLE,
  SECURITY_TABLE,
  SECURITY_HEADLINE,
  SECURITY_SUBHEAD,
  PRICING_TABLE,
  PRICING_SECTION,
  PRICING,
  JURISDICTION_SECTION,
} from "@/constants/copy";
import { ArrowRight } from "lucide-react";

// ── Internal: section label + rule ───────────────────────
function SectionLabel({ label }: { label: string }) {
  return (
    <div className="mb-10">
      <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground/55 mb-4">
        {label}
      </p>
      <div className="border-t border-border" />
    </div>
  );
}

export function Features() {
  return (
    <div className="bg-background">

      {/* ── 01 · PLATFORM REFERENCE ─────────────────────── */}
      <section
        id="features"
        tabIndex={-1}
        aria-label="Platform reference"
        className="px-6 py-20 border-b border-border focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset"
      >
        <div className="max-w-7xl mx-auto">
          <SectionLabel label="Platform Reference" />

          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left pb-3 pr-10 text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground/60 font-medium w-44">
                  Module
                </th>
                <th className="text-left pb-3 pr-10 text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground/60 font-medium">
                  Capability
                </th>
                <th className="text-left pb-3 text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground/60 font-medium w-64">
                  Framework
                </th>
              </tr>
            </thead>
            <tbody>
              {PLATFORM_TABLE.map((row, i) => (
                <tr
                  key={row.module}
                  className={i < PLATFORM_TABLE.length - 1 ? "border-b border-border" : ""}
                >
                  <td className="py-7 pr-10 align-top">
                    <span className="text-[11px] font-mono font-bold text-foreground tracking-widest block mb-0.5">
                      {row.module}
                    </span>
                    <span className="text-[10px] font-mono uppercase tracking-wide text-muted-foreground/55">
                      {row.name}
                    </span>
                  </td>
                  <td className="py-7 pr-10 align-top">
                    <ul className="space-y-1.5">
                      {row.functions.map((fn) => (
                        <li key={fn} className="text-xs text-muted-foreground leading-relaxed">
                          {fn}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="py-7 align-top">
                    <span className="text-[11px] font-mono text-muted-foreground leading-relaxed">
                      {row.basis}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── 02 · FINANCIAL INTEGRITY ────────────────────── */}
      <section
        id="integrity"
        tabIndex={-1}
        aria-label="Financial integrity guarantees"
        className="px-6 py-20 border-b border-border focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset"
      >
        <div className="max-w-7xl mx-auto">
          <SectionLabel label="Financial Integrity Guarantees" />

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-14 lg:gap-0">
            <div className="lg:col-span-2 lg:pr-16">
              <h2 className="text-xl font-bold text-foreground mb-4 leading-snug">
                Non-negotiable structural constraints.
              </h2>
              <p className="text-sm text-muted-foreground leading-relaxed">
                These are not configurable features. They are properties
                enforced at the database trigger and function level — not
                achievable by bypassing application code.
              </p>
            </div>
            <ol className="lg:col-span-3 lg:border-l lg:border-border lg:pl-14 space-y-4">
              {TRUST_GUARANTEES.map((g, i) => (
                <li key={i} className="flex items-start gap-5">
                  <span className="text-[10px] font-mono text-muted-foreground/35 w-6 shrink-0 mt-0.5 select-none">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="text-xs text-muted-foreground leading-relaxed">{g}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* ── 03 · SECURITY ARCHITECTURE ──────────────────── */}
      <section
        id="security"
        tabIndex={-1}
        aria-label="Security architecture"
        className="px-6 py-20 border-b border-border focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset"
      >
        <div className="max-w-7xl mx-auto">
          <SectionLabel label="Security Architecture" />

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-14 lg:gap-0">
            <div className="lg:col-span-2 lg:pr-16">
              {/* The strongest sentence on the site — given H2 weight per Iron Dome directive */}
              <h2 className="text-xl font-bold text-foreground mb-4 leading-snug">
                {SECURITY_HEADLINE}
              </h2>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {SECURITY_SUBHEAD}
              </p>
            </div>
            <div className="lg:col-span-3 lg:border-l lg:border-border lg:pl-14">
              <table className="w-full border-collapse border-t border-border">
                <tbody>
                  {SECURITY_TABLE.map((row) => (
                    <tr key={row.constraint} className="border-b border-border">
                      <td className="py-3.5 pr-8 text-[11px] font-mono font-semibold text-foreground align-top w-44">
                        {row.constraint}
                      </td>
                      <td className="py-3.5 text-xs text-muted-foreground align-top leading-relaxed">
                        {row.spec}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      {/* ── 04 · JURISDICTION COVERAGE ──────────────────── */}
      <section
        id="jurisdiction"
        tabIndex={-1}
        aria-label="Jurisdiction coverage"
        className="px-6 py-20 border-b border-border focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-inset"
      >
        <div className="max-w-7xl mx-auto">
          <SectionLabel label={JURISDICTION_SECTION.headline} />

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-14 lg:gap-0">
            <div className="lg:col-span-2 lg:pr-16">
              <h2 className="text-xl font-bold text-foreground mb-4 leading-snug">
                Global workflow.<br />Jurisdiction-aware output.
              </h2>
              <p className="text-sm text-muted-foreground leading-relaxed">
                The core financial statement workflow operates under IFRS globally.
                Jurisdiction packs add statutory compliance — activated only when
                independently validated for each jurisdiction.
              </p>
            </div>
            <div className="lg:col-span-3 lg:border-l lg:border-border lg:pl-14 space-y-8">
              {JURISDICTION_SECTION.items.map((item) => (
                <div key={item.label}>
                  <p className="text-[11px] font-mono font-semibold text-foreground mb-2 uppercase tracking-widest">
                    {item.label}
                  </p>
                  <p className="text-xs text-muted-foreground leading-relaxed">{item.detail}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── 05 · PRICING TEASER ──────────────────────────── */}
      <section id="pricing" className="px-6 py-20 border-b border-border">
        <div className="max-w-7xl mx-auto">
          <SectionLabel label="Pricing" />

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-14 lg:gap-0">
            <div className="lg:col-span-2 lg:pr-16">
              <h2 className="text-xl font-bold text-foreground mb-4 leading-snug">
                {PRICING_SECTION.headline}
              </h2>
              <p className="text-sm text-muted-foreground leading-relaxed mb-3">
                {PRICING_SECTION.subhead}
              </p>
              <p className="text-sm font-semibold text-foreground mb-8">
                {PRICING.PAID_NAME} from{" "}
                <span className="text-primary">
                  {PRICING.CURRENCY_CODE} {PRICING.ANNUAL_USD}/year
                </span>{" "}
                or {PRICING.CURRENCY_CODE} {PRICING.MONTHLY_USD}/month.
              </p>
              <Button variant="hero" size="default" asChild>
                <Link to={PRICING_SECTION.ctaHref}>
                  {PRICING_SECTION.cta}
                  <ArrowRight size={14} />
                </Link>
              </Button>
            </div>
            <div className="lg:col-span-3 lg:border-l lg:border-border lg:pl-14">
              <table className="w-full border-collapse border-t border-border">
                <tbody>
                  {PRICING_TABLE.map((row) => (
                    <tr key={row.term} className="border-b border-border">
                      <td className="py-3.5 pr-8 text-[11px] font-mono font-semibold text-foreground align-top w-44">
                        {row.term}
                      </td>
                      <td className="py-3.5 text-xs text-muted-foreground align-top leading-relaxed">
                        {row.value}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

    </div>
  );
}
