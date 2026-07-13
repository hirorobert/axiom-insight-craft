import { ArrowRight, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CTA, FEATURES, PIPELINE, TRUST_GUARANTEES } from "@/constants/copy";

export function Features() {
  return (
    <section id="features" className="pt-4 pb-24 px-6 bg-background">
      <div className="max-w-7xl mx-auto">

        {/* ── One Continuous Pipeline ────────────────────── */}
        <div className="mb-20">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-4 text-center">
            One Continuous Pipeline
          </p>
          <div className="flex items-stretch border border-border rounded-sm overflow-hidden">
            {PIPELINE.map((step, i) => (
              <div
                key={step}
                className="flex-1 flex flex-col items-center justify-center py-4 px-2 text-center border-r border-border last:border-r-0 hover:bg-muted/30 transition-colors group cursor-default"
              >
                <div className="text-[10px] font-semibold text-muted-foreground/50 mb-0.5">
                  {String(i + 1).padStart(2, "0")}
                </div>
                <div className="text-xs font-medium text-foreground whitespace-nowrap">
                  {step}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Financial Missions ─────────────────────────── */}
        <div className="mb-4">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-3">
            {FEATURES.sectionKicker}
          </p>
          <h2 className="text-3xl font-bold text-foreground mb-3">
            Every mission has an engine.
          </h2>
          <p className="text-muted-foreground max-w-xl text-sm leading-relaxed">
            {FEATURES.sectionSub}
          </p>
        </div>

        {/* ── Mission Cards ──────────────────────────────── */}
        <div className="grid md:grid-cols-2 gap-px bg-border mb-20 mt-10">
          {FEATURES.items.map((feature) => (
            <div
              key={feature.title}
              className="p-8 bg-background hover:bg-muted/20 transition-colors"
            >
              <div className="mb-4">
                <span className="inline-block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground border border-border px-2 py-1 rounded-sm">
                  {feature.engine}
                </span>
              </div>
              <h3 className="text-lg font-bold text-foreground mb-3">
                {feature.title}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                {feature.summary}
              </p>
              <details className="group">
                <summary className="text-xs text-muted-foreground cursor-pointer select-none list-none hover:text-foreground transition-colors">
                  Technical specifications
                </summary>
                <p className="mt-2 text-xs text-muted-foreground leading-relaxed pl-3 border-l-2 border-border">
                  {feature.detail}
                </p>
              </details>
            </div>
          ))}
        </div>

        {/* ── Financial Integrity Guarantees ─────────────── */}
        <div className="border border-border rounded-sm p-8 mb-12">
          <div className="mb-8">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-2">
              Financial Integrity Guarantees
            </p>
            <h3 className="text-xl font-bold text-foreground mb-2">
              Built on non-negotiable constraints.
            </h3>
            <p className="text-sm text-muted-foreground max-w-xl">
              These are not configurable features. They are structural properties of the platform — enforced at the database and function level.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {TRUST_GUARANTEES.map((guarantee, i) => (
              <div key={i} className="flex items-start gap-3">
                <CheckCircle size={14} className="text-primary mt-0.5 flex-shrink-0" />
                <span className="text-xs text-muted-foreground leading-relaxed">
                  {guarantee}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* ── CTA ───────────────────────────────────────── */}
        <div className="text-center">
          <Button variant="hero" size="lg" asChild>
            <a href="/auth">
              {CTA.primary}
              <ArrowRight size={16} />
            </a>
          </Button>
        </div>

      </div>
    </section>
  );
}
