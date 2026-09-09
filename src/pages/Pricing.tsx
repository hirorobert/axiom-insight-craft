import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, ArrowRight, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { PRICING, BRAND } from "@/constants/copy";

// ─────────────────────────────────────────────────────────────
// /pricing — CFOClose Pricing Page
// Ω3-BRAND: presentation only. Paid checkout is disabled during
// this sprint — "Secure self-service checkout is being activated."
// No amount, interval, or currency is sent to any payment function.
// Checkout will be enabled in Ω3-CHECKOUT once the interval-aware
// server resolver (resolve_commercial_offer with explicit billing
// interval) is completed.
// ─────────────────────────────────────────────────────────────

type BillingInterval = "monthly" | "annual";

const FREE_FEATURES = [
  "One company, one active reporting period",
  "Full IFRS-oriented classification workflow",
  "Statement of Financial Position and Comprehensive Income",
  "Confidence-graded account mapping",
  "Audit trail for all actions",
  "Review the full workflow before upgrading",
];

const PAID_FEATURES = [
  "Unlimited companies and reporting periods",
  "Full IFRS statement suite — IAS 1, IAS 7, disclosure notes",
  "Jurisdiction pack (Tanzania compliance included)",
  "Bank reconciliation with evidence verification",
  "Comparative financial statements — current vs prior period",
  "Variance analysis with configurable materiality thresholds",
  "Cash flow forecast and board-pack PDF",
  "XBRL instance document generation",
  "Filing readiness checklist and submission package",
  "Unlimited firm members with role-based access control",
  "Implementation support included",
];

export default function Pricing() {
  const [interval, setInterval] = useState<BillingInterval>("annual");

  const monthlyDisplay = `${PRICING.CURRENCY_CODE} ${PRICING.MONTHLY_USD}/month`;
  const annualDisplay  = `${PRICING.CURRENCY_CODE} ${PRICING.ANNUAL_USD}/year`;
  const annualSavingDisplay = `Save ${PRICING.CURRENCY_CODE} ${PRICING.ANNUAL_SAVING_USD}`;
  const annualFullDisplay   = `${PRICING.CURRENCY_CODE} ${PRICING.ANNUAL_FULL_USD}/year`;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <Header />

      <main className="flex-1 px-6 pt-32 pb-20">
        <div className="max-w-5xl mx-auto">

          {/* ── Header ──────────────────────────────────── */}
          <div className="text-center mb-14">
            <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-muted-foreground/60 mb-4">
              {BRAND.name} · Pricing
            </p>
            <h1 className="text-3xl sm:text-4xl font-bold text-foreground mb-4 leading-tight">
              Simple, transparent pricing.
            </h1>
            <p className="text-sm text-muted-foreground max-w-lg mx-auto leading-relaxed">
              One professional licence covers your entire firm. No per-module fees.
              No per-company limits.
            </p>
          </div>

          {/* ── Billing interval toggle ───────────────── */}
          <div className="flex justify-center mb-10">
            <div className="inline-flex border border-border" role="group" aria-label="Billing interval">
              <button
                onClick={() => setInterval("monthly")}
                aria-pressed={interval === "monthly"}
                className={`px-6 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
                  interval === "monthly"
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                }`}
              >
                Monthly
              </button>
              <button
                onClick={() => setInterval("annual")}
                aria-pressed={interval === "annual"}
                className={`px-6 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 border-l border-border ${
                  interval === "annual"
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                }`}
              >
                Annual
                {interval === "annual" && (
                  <span className="ml-2 text-[10px] font-mono text-success">
                    {annualSavingDisplay}
                  </span>
                )}
              </button>
            </div>
          </div>

          {/* ── Annual saving callout ─────────────────── */}
          {interval === "annual" && (
            <p className="text-center text-xs text-muted-foreground mb-10" aria-live="polite">
              Annual billing: {annualDisplay} instead of {annualFullDisplay} — {annualSavingDisplay} annually.
            </p>
          )}

          {/* ── Plan cards ───────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

            {/* Free */}
            <div className="border border-border p-8 flex flex-col">
              <div className="mb-6">
                <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/60 mb-3">
                  {PRICING.FREE_NAME}
                </p>
                <p className="text-3xl font-bold text-foreground mb-1">
                  {PRICING.CURRENCY_CODE} 0
                </p>
                <p className="text-xs text-muted-foreground">Free, no credit card required.</p>
              </div>

              <ul className="space-y-3 mb-8 flex-1">
                {FREE_FEATURES.map((f) => (
                  <li key={f} className="flex items-start gap-3">
                    <Check size={14} className="text-success mt-0.5 shrink-0" />
                    <span className="text-xs text-muted-foreground leading-relaxed">{f}</span>
                  </li>
                ))}
              </ul>

              <Button variant="outline" size="default" asChild className="w-full">
                <Link to="/auth">
                  Start free
                  <ArrowRight size={14} />
                </Link>
              </Button>
            </div>

            {/* Professional */}
            <div className="border-2 border-primary p-8 flex flex-col relative">
              <div className="absolute top-0 right-0 bg-primary px-3 py-1">
                <span className="text-[10px] font-mono uppercase tracking-widest text-primary-foreground">
                  Professional
                </span>
              </div>

              <div className="mb-6">
                <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground/60 mb-3">
                  {PRICING.PAID_NAME}
                </p>
                <p className="text-3xl font-bold text-foreground mb-1" aria-live="polite">
                  {interval === "annual" ? annualDisplay : monthlyDisplay}
                </p>
                {interval === "annual" && (
                  <p className="text-xs text-success font-medium">{annualSavingDisplay} vs monthly</p>
                )}
                {interval === "monthly" && (
                  <p className="text-xs text-muted-foreground">or {annualDisplay} — {annualSavingDisplay}</p>
                )}
              </div>

              <ul className="space-y-3 mb-8 flex-1">
                {PAID_FEATURES.map((f) => (
                  <li key={f} className="flex items-start gap-3">
                    <Check size={14} className="text-primary mt-0.5 shrink-0" />
                    <span className="text-xs text-muted-foreground leading-relaxed">{f}</span>
                  </li>
                ))}
              </ul>

              {/* Checkout disabled during Ω3-BRAND — enabled in Ω3-CHECKOUT */}
              <div className="border border-border p-4 flex flex-col items-center gap-3 text-center">
                <Lock size={16} className="text-muted-foreground" />
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {PRICING.CHECKOUT_DISABLED_MSG}
                </p>
                <p className="text-[10px] text-muted-foreground/60">
                  Start with a free workspace to explore the platform.
                </p>
                <Button variant="outline" size="sm" asChild className="w-full mt-1">
                  <Link to="/auth">Start free first</Link>
                </Button>
              </div>
            </div>

          </div>

          {/* ── Tax disclaimer ────────────────────────── */}
          <p className="text-center text-xs text-muted-foreground mt-8">
            {PRICING.TAX_DISCLAIMER}
          </p>

          {/* ── What's included note ─────────────────── */}
          <div className="mt-14 border-t border-border pt-10">
            <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground/55 mb-6">
              What the Professional licence includes
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
              {[
                {
                  label: "Unlimited scope",
                  detail: "No limits on companies, reporting periods, or firm members.",
                },
                {
                  label: "Jurisdiction pack",
                  detail:
                    "Tanzania compliance pack included. Additional jurisdictions added as validated.",
                },
                {
                  label: "Audit-grade security",
                  detail:
                    "Identity, isolation, append-only records, and privileged operations enforced at the database boundary.",
                },
                {
                  label: "Full workflow",
                  detail:
                    "Upload through reconciliation, statements, tax computation, and filing — all seven stages.",
                },
                {
                  label: "Evidence trail",
                  detail:
                    "Every action is attributed and timestamped. Append-only records. No silent changes.",
                },
                {
                  label: "Implementation support",
                  detail:
                    "Included — no separate support tier required for onboarding or configuration.",
                },
              ].map((item) => (
                <div key={item.label} className="border border-border p-5">
                  <p className="text-[11px] font-mono font-semibold text-foreground mb-2 uppercase tracking-widest">
                    {item.label}
                  </p>
                  <p className="text-xs text-muted-foreground leading-relaxed">{item.detail}</p>
                </div>
              ))}
            </div>
          </div>

        </div>
      </main>

      <Footer />
    </div>
  );
}
