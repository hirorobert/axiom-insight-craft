import { Button } from "@/components/ui/button";
import { ArrowRight, Shield, Zap, BarChart3 } from "lucide-react";

export function Hero() {
  return (
    <section className="relative pt-32 pb-20 px-6 overflow-hidden">

      <div className="relative max-w-7xl mx-auto">
        <div className="max-w-4xl mx-auto text-center">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-secondary border border-border mb-8">
            <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
            <span className="text-xs font-medium text-muted-foreground">
              Trusted by 500+ accounting firms worldwide
            </span>
          </div>

          {/* Main headline */}
          <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold tracking-tight mb-6">
            Transform Accounting Data Into{" "}
            <span className="text-primary">Strategy & Compliance</span>
          </h1>

          <p className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-10">
            Axiom automates compliance and delivers actionable insights instantly. 
            Your trial balance becomes audit-ready financial statements and an executive 
            intelligence dashboard — all in one workflow.
          </p>

          {/* CTAs */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-16">
            <Button variant="hero" size="xl" asChild>
              <a href="#demo">
                Request Private Demo
                <ArrowRight size={18} />
              </a>
            </Button>
            <Button variant="heroOutline" size="xl" asChild>
              <a href="#pricing">See Pricing</a>
            </Button>
          </div>

          {/* Trust indicators */}
          <div className="flex flex-wrap items-center justify-center gap-8 text-muted-foreground">
            <div className="flex items-center gap-2">
              <Shield size={18} className="text-accent" />
              <span className="text-sm">SOC 2 Certified</span>
            </div>
            <div className="flex items-center gap-2">
              <Zap size={18} className="text-accent" />
              <span className="text-sm">99.9% Uptime</span>
            </div>
            <div className="flex items-center gap-2">
              <BarChart3 size={18} className="text-accent" />
              <span className="text-sm">$2B+ Processed</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
