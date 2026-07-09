import { Button } from "@/components/ui/button";
import { ArrowRight, FileCheck, ShieldCheck } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { BRAND, CTA, HERO } from "@/constants/copy";

export function Hero() {
  const { user } = useAuth();
  const ctaHref = user ? "/dashboard" : "/auth";

  return (
    <section className="relative pt-28 pb-8 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="max-w-3xl mx-auto text-center">

          {/* Eyebrow */}
          <p className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-4">
            {HERO.eyebrow}
          </p>

          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight mb-6">
            Tanzania Tax Compliance,{" "}
            <span className="text-[#0E1D30]">Automated</span>
          </h1>

          <p className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-10">
            {HERO.subhead}
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-10">
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

          <div className="flex flex-wrap items-center justify-center gap-8 text-muted-foreground">
            <div className="flex items-center gap-2">
              <FileCheck size={18} className="text-accent" />
              <span className="text-sm">ITA Cap.332 R.E.2023 compliant</span>
            </div>
            <div className="flex items-center gap-2">
              <ShieldCheck size={18} className="text-accent" />
              <span className="text-sm">Deterministic validation — no guessing</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
