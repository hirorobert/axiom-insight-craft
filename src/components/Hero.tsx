import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { HERO, HERO_LEDGER, HERO_FOOTING, CTA } from "@/constants/copy";

export function Hero() {
  const { user } = useAuth();
  const ctaHref = user ? "/dashboard" : "/auth";

  return (
    <section className="relative bg-background border-b border-border">
      {/* ── Statement ─────────────────────────────────────────── */}
      <div className="px-6 pt-28 sm:pt-32 lg:pt-36 pb-12 sm:pb-14">
        <div className="max-w-3xl mx-auto text-center">
          <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-muted-foreground/60 mb-7">
            {HERO.eyebrow}
          </p>
          <h1 className="text-[2rem] sm:text-5xl lg:text-[3.5rem] font-bold tracking-tight text-primary mb-5 leading-[1.06]">
            {HERO.headline}
          </h1>
          <p className="text-sm sm:text-lg text-muted-foreground max-w-xl mx-auto leading-relaxed mb-9">
            {HERO.subhead}
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 sm:gap-6">
            <Button variant="hero" size="xl" asChild className="w-full sm:w-auto">
              <a href={ctaHref}>
                {CTA.primary}
                <ArrowRight size={18} />
              </a>
            </Button>
            <a
              href="#tour"
              className="text-[11px] font-mono uppercase tracking-[0.18em] text-muted-foreground hover:text-foreground transition-colors underline-offset-4 hover:underline"
            >
              {CTA.secondary}
            </a>
          </div>
        </div>
      </div>

      {/* ── Proof ledger: the eye's resting place ─────────────── */}
      <div className="border-t border-border">
        <dl className="max-w-7xl mx-auto grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-border">
          {HERO_LEDGER.map((item) => (
            <div key={item.key} className="px-6 py-8 sm:py-10 lg:px-10">
              <dt className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground/55 mb-3">
                {item.key}
              </dt>
              <dd>
                <p className="text-base font-semibold text-foreground leading-snug mb-2">
                  {item.value}
                </p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {item.detail}
                </p>
              </dd>
            </div>
          ))}
        </dl>
      </div>

      {/* ── Statutory footing ─────────────────────────────────── */}
      <div className="border-t border-border bg-muted/20">
        <p className="max-w-7xl mx-auto px-6 py-4 text-[10px] font-mono leading-relaxed text-muted-foreground/70">
          {HERO_FOOTING}
        </p>
      </div>
    </section>
  );
}
