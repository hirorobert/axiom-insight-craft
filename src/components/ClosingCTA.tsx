import { ArrowRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { CTA, PRICING } from "@/constants/copy";

// ─── Full-bleed conversion band ─────────────────────────────────────────────
// One consequential action. No hedging. No secondary preamble.

export function ClosingCTA() {
  return (
    <section className="border-b border-border bg-primary text-primary-foreground">
      <div className="mx-auto max-w-7xl px-6 lg:px-10">
        <div className="grid grid-cols-1 items-center gap-8 py-14 lg:grid-cols-12 lg:py-16">

          {/* Left — statement */}
          <div className="lg:col-span-8">
            <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-primary-foreground/40">
              Ready to close
            </p>
            <h2 className="mt-3 max-w-2xl text-2xl font-semibold leading-snug tracking-[-0.03em] sm:text-3xl lg:text-[2rem]">
              Your next close starts with one trial balance
              and a workspace that keeps the rest in order.
            </h2>
            <p className="mt-4 text-sm text-primary-foreground/55">
              From {PRICING.CURRENCY_CODE} {PRICING.MONTHLY_USD}/month. No card required to start.
              Cancel anytime.
            </p>
          </div>

          {/* Right — CTAs */}
          <div className="flex flex-col gap-3 lg:col-span-4 lg:items-end">
            <Button
              variant="hero"
              size="xl"
              asChild
              className="w-full border border-primary-foreground/20 bg-primary-foreground text-primary hover:bg-primary-foreground/90 lg:w-auto lg:min-w-[180px]"
            >
              <Link to={CTA.primaryHref}>
                {CTA.primary}
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="xl"
              asChild
              className="w-full border border-primary-foreground/20 text-primary-foreground hover:bg-primary-foreground/10 lg:w-auto"
            >
              <Link to="/pricing">
                Review plan
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <p className="text-center text-[10px] text-primary-foreground/35 lg:text-right">
              Professional plan · {PRICING.CURRENCY_CODE} {PRICING.ANNUAL_USD}/yr saves USD {PRICING.ANNUAL_SAVING_USD}
            </p>
          </div>

        </div>
      </div>
    </section>
  );
}
