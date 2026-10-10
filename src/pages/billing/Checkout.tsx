/**
 * /billing/checkout?plan=SOLO — what is being bought, the total payable, and the one action that starts a payment.
 *
 * Authority: the server. This page shows only what commercial-create-checkout (GET) reports for the plan: the routes
 * open for it (card through Polar, mobile money through Snippe), the server's own price on each, and where the paid
 * 12-month term would start. It sends only the plan code, the chosen route and (mobile money) the payer's number. A
 * created checkout is not a payment: access appears only on the status page, once the server reports the payment
 * verified. When no route is open, the plan's activation request is offered instead (manual activation stays).
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AlertCircle, CreditCard, Loader2, Smartphone } from "lucide-react";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/contexts/AuthContext";
import { planByCode, type PlanCode } from "@/lib/commercial/pricingCatalogue";
import { activationHref } from "@/lib/commercial/offerings";
import { formatMoney, parseCheckoutPlan } from "@/lib/commercial/planOffers";
import { getCheckoutOptions, rememberCheckoutPlan, startCheckout, type CheckoutOptions, type PaymentRoute, type RouteOption } from "@/lib/commercial/checkoutClient";

const TZ_MOBILE = /^(?:\+?255|0)[67]\d{8}$/;
const formatDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

export function placementSentence(kind: string | undefined, start: string | undefined, planName: string): string {
  switch (kind) {
    case "RENEWAL": return `Your new 12-month ${planName} term starts on ${start ? formatDate(start) : "the day your current term ends"}, when your current term ends.`;
    case "AT_RENEWAL": return `${planName} starts on ${start ? formatDate(start) : "the day your current term ends"}, when your current plan's term ends. Your current plan continues until then.`;
    case "UPGRADE": return `${planName} starts as soon as the payment is verified, and your current plan ends at that moment. Unused time on your current plan is not refunded automatically; contact us if you would like it credited.`;
    default: return `${planName} starts as soon as the payment is verified and runs for 12 months.`;
  }
}

const ERROR_TEXT: Record<string, string> = {
  PAYMENT_PROVIDER_UNAVAILABLE: "Online payment is not available for this plan right now. You can ask us to activate it instead.",
  CHECKOUT_ALREADY_IN_PROGRESS: "A payment for this plan is already being prepared. Wait a moment, then check your orders.",
  NOT_SIGNED_IN: "Your session has ended. Sign in again to continue.",
};

export default function Checkout() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const plan = parseCheckoutPlan(params.get("plan"));
  const catalogue = plan ? planByCode(plan) : null;

  const [options, setOptions] = useState<CheckoutOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [route, setRoute] = useState<PaymentRoute | null>(null);
  const [phone, setPhone] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ text: string; ref: string | null; kind: string } | null>(null);

  useEffect(() => {
    if (!plan || authLoading || !user) return;
    let live = true;
    getCheckoutOptions(plan).then(({ data, error: e }) => {
      if (!live) return;
      if (e || !data) { setLoadError(e ?? "OPTIONS_UNAVAILABLE"); return; }
      setOptions(data);
      const open = data.options.filter((o) => o.available);
      setRoute(open.length === 1 ? open[0].paymentRoute : null);
    });
    return () => { live = false; };
  }, [plan, user, authLoading]);

  const open = useMemo(() => (options?.options ?? []).filter((o) => o.available), [options]);
  const chosen: RouteOption | undefined = open.find((o) => o.paymentRoute === route);
  const blocked = options?.placement.kind?.startsWith("BLOCKED") ?? false;
  const sandbox = open.some((o) => o.environment === "sandbox");

  if (!plan || !catalogue) {
    return <Shell><h1 className="text-2xl font-semibold">Choose a plan first</h1><p className="mt-2 text-sm text-muted-foreground">This link does not name a plan that can be bought online.</p><Button asChild className="mt-6"><Link to="/plans">See the plans</Link></Button></Shell>;
  }
  if (authLoading) return <Shell><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" /></Shell>;
  if (!user) {
    return (
      <Shell>
        <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">{catalogue.name} plan</p>
        <h1 className="mt-2 text-2xl font-semibold">Create an account or sign in to continue</h1>
        <p className="mt-2 text-sm text-muted-foreground">The plan is attached to the CFOCLOSE account you sign in with. You will return here afterwards.</p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Button asChild onClick={() => rememberCheckoutPlan(plan)}><Link to="/auth?mode=signup" data-testid="checkout-sign-up">Create an account</Link></Button>
          <Button asChild variant="outline" onClick={() => rememberCheckoutPlan(plan)}><Link to="/auth" data-testid="checkout-sign-in">Sign in</Link></Button>
        </div>
      </Shell>
    );
  }

  const submit = async () => {
    if (!chosen || submitting) return;
    setError(null);
    if (chosen.paymentRoute === "MOBILE_MONEY") {
      const compact = phone.replace(/[\s()-]/g, "");
      if (!TZ_MOBILE.test(compact)) { setPhoneError("Enter a mobile money number on +255, for example 0712 345 678."); return; }
      setPhoneError(null);
    }
    setSubmitting(true);
    const result = await startCheckout(plan as PlanCode, chosen.paymentRoute, chosen.paymentRoute === "MOBILE_MONEY" ? phone : null);
    if ("checkoutUrl" in result) {
      if (result.paymentRoute === "CARD" && /^https:\/\//.test(result.checkoutUrl)) { window.location.assign(result.checkoutUrl); return; }
      navigate(`/billing/payment/return?ref=${encodeURIComponent(result.saffReference)}`);
      return;
    }
    const r = result as { error: string; saffReference: string | null };
    setSubmitting(false);
    if (r.error.startsWith("PHONE_NUMBER_INVALID")) { setPhoneError("Enter a mobile money number on +255, for example 0712 345 678."); return; }
    if (r.error.startsWith("CHECKOUT_OUTCOME_UNCERTAIN") || r.error === "NETWORK") {
      setError({ kind: "uncertain", ref: r.saffReference, text: "We could not confirm whether the payment was started. Do not pay again: check this order first." });
      return;
    }
    if (r.error.startsWith("CHECKOUT_REQUIRES_SUPPORT")) {
      setError(r.saffReference
        ? { kind: "previous", ref: r.saffReference, text: "An earlier payment attempt for this plan is still being checked. Open it to see its status; a new payment can start once it is resolved." }
        : { kind: "support", ref: null, text: "This change to your plan needs to be arranged with our team. Send us a request and we will set it up." });
      return;
    }
    setError({ kind: "other", ref: null, text: ERROR_TEXT[r.error] ?? "The payment could not be started. Nothing was charged. Try again, or ask us to activate the plan." });
  };

  return (
    <Shell>
      <p className="text-xs uppercase tracking-[0.16em] text-muted-foreground">Checkout</p>
      <h1 className="mt-2 text-2xl font-semibold" data-testid="checkout-title">{catalogue.name} plan · 12 months</h1>
      <dl className="mt-6 grid gap-3 border border-border p-4 text-sm sm:grid-cols-2" data-testid="checkout-summary">
        <div><dt className="text-muted-foreground">Entities</dt><dd className="font-medium">{catalogue.entityCapacity}</dd></div>
        <div><dt className="text-muted-foreground">Named users included</dt><dd className="font-medium">{catalogue.includedSeats}</dd></div>
        <div><dt className="text-muted-foreground">Term</dt><dd className="font-medium">12 months, no automatic renewal</dd></div>
        <div><dt className="text-muted-foreground">Additional named users</dt><dd className="font-medium">{catalogue.additionalSeat ? "Arranged with our team" : "Not available on this plan"}</dd></div>
      </dl>

      {sandbox && <p className="mt-4 border border-amber-500 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="note" data-testid="checkout-test-mode">Test mode: payments here use the provider's sandbox, and no real money is charged.</p>}

      {loadError && <p className="mt-6 flex items-start gap-2 text-sm text-destructive" role="alert"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />The payment options could not be loaded. Refresh the page to try again.</p>}
      {!options && !loadError && <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading the payment options…</p>}

      {options && (blocked || open.length === 0) && (
        <div className="mt-6 border border-border p-4" data-testid="checkout-unavailable">
          <p className="text-sm font-medium">{blocked ? "This change to your plan needs to be arranged with our team." : "Online payment is not open for this plan yet."}</p>
          <p className="mt-1 text-sm text-muted-foreground">Send an activation request naming the plan. We reply by email to agree terms, then activate it on your account; nothing is charged by sending a request.</p>
          <Button asChild className="mt-4"><Link to={activationHref(plan as PlanCode, "plan_wall")} data-testid="checkout-request-activation">Request activation</Link></Button>
        </div>
      )}

      {options && !blocked && open.length > 0 && (
        <>
          <p className="mt-6 text-sm text-foreground" data-testid="checkout-placement">{placementSentence(options.placement.kind, options.placement.start, catalogue.name)}</p>
          <fieldset className="mt-6">
            <legend className="text-sm font-medium">How would you like to pay?</legend>
            <div className="mt-3 grid gap-3">
              {open.map((o) => (
                <label key={o.paymentRoute} className={`flex cursor-pointer items-start gap-3 border p-4 focus-within:ring-2 focus-within:ring-ring ${route === o.paymentRoute ? "border-foreground" : "border-border"}`} data-testid={`route-${o.paymentRoute}`}>
                  <input type="radio" name="route" className="mt-1" checked={route === o.paymentRoute} onChange={() => setRoute(o.paymentRoute)} />
                  {o.paymentRoute === "CARD" ? <CreditCard className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" /> : <Smartphone className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />}
                  <span className="text-sm">
                    <span className="block font-medium">{o.paymentRoute === "CARD" ? "Card" : "Mobile money"} · {formatMoney(o.amountMinor ?? 0, o.currencyCode ?? "", o.currencyExponent ?? 0)}</span>
                    <span className="mt-1 block text-muted-foreground">{o.paymentRoute === "CARD"
                      ? "Paid on the secure page of Polar, our merchant of record for card payments, which may add sales tax for your location before you pay. Your card details never reach CFOCLOSE."
                      : "M-Pesa, Airtel Money, Mixx by Yas or Halotel through Snippe. A payment prompt is sent to your phone; approve it with your PIN."}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {chosen?.paymentRoute === "MOBILE_MONEY" && (
            <div className="mt-4">
              <Label htmlFor="checkout-phone">Mobile money number</Label>
              <Input id="checkout-phone" inputMode="tel" autoComplete="tel" placeholder="0712 345 678" value={phone} onChange={(e) => setPhone(e.target.value)}
                aria-invalid={phoneError ? true : undefined} aria-describedby={phoneError ? "checkout-phone-error" : "checkout-phone-hint"} className="mt-1 max-w-xs" data-testid="checkout-phone" />
              {phoneError
                ? <p id="checkout-phone-error" className="mt-1 text-sm text-destructive" role="alert">{phoneError}</p>
                : <p id="checkout-phone-hint" className="mt-1 text-xs text-muted-foreground">Used only to send the payment prompt; CFOCLOSE does not store it.</p>}
            </div>
          )}

          {chosen && (
            <div className="mt-6 border-t border-border pt-4" data-testid="checkout-total">
              <p className="flex items-baseline justify-between text-sm"><span>Total payable</span><span className="text-lg font-semibold">{formatMoney(chosen.amountMinor ?? 0, chosen.currencyCode ?? "", chosen.currencyExponent ?? 0)}{chosen.paymentRoute === "CARD" ? " + any sales tax" : ""}</span></p>
              <p className="mt-1 text-xs text-muted-foreground">{chosen.paymentRoute === "CARD" ? "Polar shows the final total, including any tax, before you confirm, and emails your receipt." : "Snippe confirms the payment by message on your phone. Your order and its reference stay in your CFOCLOSE orders."}</p>
            </div>
          )}

          {error && (
            <div className="mt-4 border border-destructive/50 p-3 text-sm" role="alert" data-testid="checkout-error">
              <p>{error.text}</p>
              {error.ref && <Link className="mt-2 inline-block font-medium underline" to={`/billing/payment/return?ref=${encodeURIComponent(error.ref)}`}>Open this order</Link>}
              {!error.ref && (error.kind === "uncertain" ? <Link className="mt-2 inline-block font-medium underline" to="/billing/orders">See your orders</Link>
                : <Link className="mt-2 inline-block font-medium underline" to={activationHref(plan as PlanCode, "plan_wall")}>Request activation instead</Link>)}
            </div>
          )}

          <Button className="mt-6 w-full sm:w-auto" disabled={!chosen || submitting} onClick={submit} data-testid="checkout-continue">
            {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {chosen?.paymentRoute === "MOBILE_MONEY" ? "Send the payment prompt" : "Continue to Polar"}
          </Button>
          <p className="mt-3 text-xs text-muted-foreground">Your plan starts only once the payment is verified with the provider. Specialist services are not part of any plan.</p>
        </>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen flex-col bg-background"><Header /><main id="main-content" className="mx-auto w-full max-w-2xl flex-1 px-4 pb-16 pt-28 sm:px-6">{children}</main><Footer /></div>;
}
