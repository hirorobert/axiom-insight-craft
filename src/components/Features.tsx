import { FileCheck, Calculator, BarChart3, GitCompare, ArrowRight, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CTA, FEATURES } from "@/constants/copy";

const icons = [FileCheck, Calculator, BarChart3, GitCompare];

export function Features() {
  return (
    <section id="features" className="pt-10 pb-20 px-6">
      <div className="max-w-7xl mx-auto">

        <div className="text-center mb-14">
          <h2 className="text-3xl sm:text-4xl font-bold mb-3">
            {FEATURES.sectionKicker}
          </h2>
          <p className="text-muted-foreground max-w-xl mx-auto">
            {FEATURES.sectionSub}
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {FEATURES.items.map((feature, idx) => {
            const Icon = icons[idx];
            return (
              <div
                key={feature.title}
                className="p-7 rounded-2xl bg-card border border-border hover:border-primary/40 transition-colors duration-200"
              >
                <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center mb-5">
                  <Icon size={22} className="text-primary" />
                </div>

                <h3 className="text-lg font-bold text-foreground mb-2">
                  {feature.title}
                </h3>

                {/* summary — plain English, full visual weight */}
                <p className="text-sm text-foreground/60 mb-4 leading-relaxed">
                  {feature.summary}
                </p>

                {/* detail — technical/secondary, collapsed */}
                <details className="group">
                  <summary className="flex items-center gap-1 text-xs text-muted-foreground cursor-pointer select-none list-none hover:text-foreground/70 transition-colors">
                    <ChevronDown
                      size={13}
                      className="transition-transform group-open:rotate-180"
                    />
                    Technical details
                  </summary>
                  <p className="mt-2 text-xs text-muted-foreground leading-relaxed pl-4 border-l border-border">
                    {feature.detail}
                  </p>
                </details>
              </div>
            );
          })}
        </div>

        {/* CTA after features */}
        <div className="mt-12 text-center">
          <p className="text-muted-foreground mb-4">
            Ready to process your first trial balance?
          </p>
          <Button variant="hero" size="lg" asChild>
            <a href="#upload">
              {CTA.primary}
              <ArrowRight size={16} />
            </a>
          </Button>
        </div>

      </div>
    </section>
  );
}
