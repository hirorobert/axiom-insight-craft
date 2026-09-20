import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { PRICING, BRAND } from "@/constants/copy";
import {
  CheckoutUpgradeButton,
  derivePricingVerificationState,
  type PricingVerificationState,
  type ResolvedOfferData,
} from "@/components/commercial/CheckoutUpgradeButton";

// ─────────────────────────────────────────────────────────────
// /pricing — CFOClose Pricing Page
// Ω3-CHECKOUT: the interval-aware server resolver (resolve_commercial_offer
// with a mandatory explicit billing interval) is now live, so
// CheckoutUpgradeButton replaces the earlier static "checkout disabled"
// panel. The button itself still fails closed to "not yet available"
// whenever the server's own resolution is anything other than AVAILABLE —
// including while commercial_platform_state remains PAYMENTS_DISABLED,
// its current live value — so this page change alone does not make
// checkout usable; that requires a separate, explicit platform-state
// transition outside this codebase's authority. No amount, interval, or
// currency is ever sent to any payment function from here — only the
// selected billing interval (MONTHLY/ANNUAL), exactly as the trust
// boundary requires.
// ─────────────────────────────────────────────────────────────

type BillingInterval = "monthly" | "annual";

const FREE_TAGLINE = "Create a workspace and evaluate the core reporting workflow";
const PAID_TAGLINE = "Complete professional reporting and review workflow";

const FREE_FEATURES = [
  "Full IFRS-oriented classification workflow",
  "Statement of Financial Position and Comprehensive Income",
  "Confidence-graded account mapping",
  "Recorded workspace activity and review decisions",
  "Review the full workflow before upgrading",
];

const PAID_FEATURES = [
  "Full IFRS statement suite — IAS 1, IAS 7, disclosure notes",
  "Configured jurisdiction tax and compliance workflow",
  "Bank reconciliation with evidence verification",
  "Comparative financial statements — current vs prior period",
  "Variance analysis with configurable materiality thresholds",
  "Cash outlook when a completed analysis run is available",
  "Filing-readiness checklist and prepared output package",
  "Firm members with role-based access control",
  "Implementation support included",
];

export default function Pricing() {
  const [interval, setInterval] = useState<BillingInterval>("annual");
  // Ω∞ A+ closure HIGH-3 fix: this page's own PRICING constants are
  // marketing copy, not authority — resolve_commercial_offer (via
  // CheckoutUpgradeButton's onOfferResolved) is the sole source of truth
  // for what checkout will actually charge. `null` means "not yet proven
  // either way" (still loading, or the offer is genuinely UNAVAILABLE/
  // AMBIGUOUS/UNKNOWN for a reason CheckoutUpgradeButton already surfaces
  // on its own) and now MUST NOT render the checkout action — only an
  // explicit `true` does. This closes the prior gap where `null` fell
  // through to the same branch as `true` and correctness depended on
  // React's own batching order between this state and the child's.
  const [pricingVerification, setPricingVerification] = useState<PricingVerificationState>("VERIFYING");

  const monthlyDisplay = `${PRICING.CURRENCY_CODE} ${PRICING.MONTHLY_USD}/month`;
  const annualDisplay  = `${PRICING.CURRENCY_CODE} ${PRICING.ANNUAL_USD}/year`;
  const annualSavingDisplay = `Save ${PRICING.CURRENCY_CODE} ${PRICING.ANNUAL_SAVING_USD}`;
  const annualFullDisplay   = `${PRICING.CURRENCY_CODE} ${PRICING.ANNUAL_FULL_USD}/year`;

  const expectedBillingInterval = interval === "annual" ? "ANNUAL" : "MONTHLY";
  const expectedAmountMinor = Math.round(
    (interval === "annual" ? PRICING.ANNUAL_USD : PRICING.MONTHLY_USD) * 100,
  );

  function handleIntervalChange(next: BillingInterval) {
    // A parity verdict for the PREVIOUS interval must never be displayed
    // against the NEW one — reset to "not yet proven" until the resolver
    // responds again for this interval.
    setPricingVerification("VERIFYING");
    setInterval(next);
  }

  function handleOfferResolved(data: ResolvedOfferData | null) {
    setPricingVerification(derivePricingVerificationState(data, {
      amountMinor: expectedAmountMinor,
      currencyCode: PRICING.CURRENCY_CODE,
      currencyExponent: 2,
      billingInterval: expectedBillingInterval,
      billingIntervalCount: 1,
      marketCode: "GLOBAL",
    }));
  }

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
              One professional licence supports your firm-wide reporting workflow.
              No per-module fees.
            </p>
          </div>

          {/* ── Billing interval toggle ───────────────── */}
          <div className="flex justify-center mb-10">
            <div className="inline-flex border border-border" role="group" aria-label="Billing interval">
              <button
                onClick={() => handleIntervalChange("monthly")}
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
                onClick={() => handleIntervalChange("annual")}
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
                <p className="text-sm text-foreground mb-4">{FREE_TAGLINE}</p>
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

            {/* Professional — spotlight treatment: this is the plan almost
                every visitor should land on, so it needs to visually win
                the comparison at a glance, not just carry a thin outline. */}
            <div className="bg-foreground text-background p-8 flex flex-col relative">
              <div className="absolute top-0 right-0 bg-primary px-3 py-1">
                <span className="text-[10px] font-mono uppercase tracking-widest text-primary-foreground">
                  Recommended
                </span>
              </div>

              <div className="mb-6">
                <p className="text-[10px] font-mono uppercase tracking-widest text-background/60 mb-3">
                  {PRICING.PAID_NAME}
                </p>
                <p className="text-sm text-background mb-4">{PAID_TAGLINE}</p>
                <p className="text-3xl font-bold text-background mb-1" aria-live="polite">
                  {interval === "annual" ? annualDisplay : monthlyDisplay}
                </p>
                {interval === "annual" && (
                  <p className="text-xs text-success font-medium">{annualSavingDisplay} vs monthly</p>
                )}
                {interval === "monthly" && (
                  <p className="text-xs text-background/60">or {annualDisplay} — {annualSavingDisplay}</p>
                )}
              </div>

              <ul className="space-y-3 mb-8 flex-1">
                {PAID_FEATURES.map((f) => (
                  <li key={f} className="flex items-start gap-3">
                    <Check size={14} className="text-background mt-0.5 shrink-0" />
                    <span className="text-xs text-background/70 leading-relaxed">{f}</span>
                  </li>
                ))}
              </ul>

              {/* Ω3-CHECKOUT: server-authoritative checkout entry point.
                  Fails closed to "not yet available" on its own if the
                  server hasn't yet resolved a purchasable offer for this
                  plan/interval (including while platform_state remains
                  PAYMENTS_DISABLED) — never a client-side guess.
                  Audit HIGH fix (pricing parity): this page's own PRICING
                  copy above is never itself the checkout authority — if the
                  server-resolved offer's economics explicitly DISAGREE with
                  that copy, checkout is disabled here rather than letting a
                  customer pay an amount that doesn't match what they were
                  shown. */}
              {/* Ω∞ A+ closure HIGH-3: the checkout action is reachable
                  ONLY once parity is explicitly proven true. CheckoutUpgradeButton
                  must stay MOUNTED regardless (it is the thing that
                  performs the server resolution and fires onOfferResolved
                  in the first place — unmounting it until parity is known
                  would make parity unknowable), but the native `hidden`
                  attribute removes it from layout, pointer-event targeting,
                  AND the tab order while parity is not `true` — there is no
                  intermediate render in which the button is clickable or
                  focusable before parity is confirmed. `null` (loading, or
                  the offer hasn't resolved yet) and `false` (explicit
                  mismatch) are both non-actionable. */}
              <div hidden={pricingVerification !== "VERIFIED"}>
                <CheckoutUpgradeButton
                  billingStatus={null}
                  planCode="PAID"
                  billingInterval={expectedBillingInterval}
                  onOfferResolved={handleOfferResolved}
                />
              </div>
              {pricingVerification === "VERIFYING" && (
                <p className="text-xs text-background/60 text-center py-2 border border-background/20">
                  Verifying pricing…
                </p>
              )}
              {pricingVerification === "UNAVAILABLE" && (
                <div className="text-xs text-background/60 text-center py-2 px-3 border border-background/20 space-y-1.5">
                  <p>Online checkout is temporarily unavailable. Contact support for billing assistance.</p>
                  <p>
                    <Link to="/auth" className="underline hover:text-background">Start free</Link>
                    {" "}while you wait.
                  </p>
                </div>
              )}
              {pricingVerification === "MISMATCH" && (
                <p className="text-xs text-background/60 text-center py-2 border border-background/20">
                  Pricing verification issue — please contact support to upgrade.
                </p>
              )}
              <p className="text-[10px] text-background/50 text-center mt-2">
                Start with a free workspace to explore the platform first.{" "}
                <Link to="/auth" className="underline hover:text-background">Start free</Link>
              </p>
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
                  label: "Firm-wide workflow",
                  detail: "Manage multiple companies, reporting periods, and firm members in one governed workspace.",
                },
                {
                  label: "Jurisdiction pack",
                  detail:
                    "Jurisdiction compliance pack included. Additional jurisdictions added as validated.",
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
