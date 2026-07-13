import { ArrowRight, Lock, GitCommit, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { HERO, CTA, PIPELINE } from "@/constants/copy";

export function Hero() {
  const { user } = useAuth();
  const ctaHref = user ? "/dashboard" : "/auth";

  return (
    <section className="relative pt-32 pb-16 px-6 bg-background">
      <div className="max-w-5xl mx-auto">

        {/* Eyebrow */}
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground mb-6 text-center">
          {HERO.eyebrow}
        </p>

        {/* Headline */}
        <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight text-center text-primary mb-6 leading-[1.1]">
          {HERO.headline}
        </h1>

        {/* Subhead */}
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto text-center leading-relaxed mb-10">
          {HERO.subhead}
        </p>

        {/* Connected Pipeline */}
        <div className="flex flex-wrap items-stretch justify-center border border-border rounded-sm overflow-hidden mb-10 divide-x divide-border">
          {PIPELINE.map((step) => (
            <div
              key={step}
              className="px-4 py-2.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors whitespace-nowrap"
            >
              {step}
            </div>
          ))}
        </div>

        {/* CTAs */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-14">
          <Button variant="hero" size="xl" asChild>
            <a href={ctaHref}>
              {CTA.primary}
              <ArrowRight size={18} />
            </a>
          </Button>
          <Button variant="heroOutline" size="xl" asChild>
            <a href="#features">{CTA.secondary}</a>
          </Button>
        </div>

        {/* Trust signals */}
        <div className="flex flex-wrap items-center justify-center gap-8 border-t border-border/40 pt-8">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Lock size={14} className="text-primary/50 flex-shrink-0" />
            <span className="text-xs">Append-only audit records</span>
          </div>
          <div className="flex items-center gap-2 text-muted-foreground">
            <GitCommit size={14} className="text-primary/50 flex-shrink-0" />
            <span className="text-xs">Every action signed to actor identity</span>
          </div>
          <div className="flex items-center gap-2 text-muted-foreground">
            <FileText size={14} className="text-primary/50 flex-shrink-0" />
            <span className="text-xs">ITA Cap.332 · Finance Act 2026 enacted</span>
          </div>
        </div>

      </div>
    </section>
  );
}
