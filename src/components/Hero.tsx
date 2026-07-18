import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { HERO, CTA } from "@/constants/copy";

export function Hero() {
  const { user } = useAuth();
  const ctaHref = user ? "/dashboard" : "/auth";

  return (
    <section className="relative pt-40 pb-28 px-6 bg-background">
      <div className="max-w-3xl mx-auto text-center">
        <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-muted-foreground/60 mb-8">
          {HERO.eyebrow}
        </p>
        <h1 className="text-4xl sm:text-5xl lg:text-[3.5rem] font-bold tracking-tight text-primary mb-6 leading-[1.05]">
          {HERO.headline}
        </h1>
        <p className="text-base sm:text-lg text-muted-foreground max-w-xl mx-auto leading-relaxed mb-10">
          {HERO.subhead}
        </p>
        <Button variant="hero" size="xl" asChild>
          <a href={ctaHref}>
            {CTA.primary}
            <ArrowRight size={18} />
          </a>
        </Button>
      </div>
    </section>
  );
}
