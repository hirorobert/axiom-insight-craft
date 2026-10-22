/**
 * One unfinished plan checkout, stated once with its two ways forward: Resume it, or Choose another plan (20261119100000).
 *
 * Where the reference comes from: the provider's "back" link (/plans?unfinished=<ref>), the checkout page's refusal (409
 * OPEN_CHECKOUT_*), or — with no reference — the customer's own open order (get_my_payments, status PENDING).
 *
 * Evidence: the banner itself reads only the order's recorded state (the read-only status GET — no provider call), so it
 * says "no payment has been recorded", never "nothing was paid". Resume asks the provider at the moment it is pressed (the
 * bounded recovery POST) and opens the provider's own page only when the provider reports the session open. Choose another
 * plan is LeaveCheckout: an explicit confirm stating that the provider's page stays payable, then a server close that acts
 * only on a fresh provider answer. Nothing renders while the state is unknown, and nothing for a finished order.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { displayPlanName } from "@/lib/commercial/billingDisplay";
import { getMyPayments } from "@/lib/commercial/checkoutClient";
import { pollCheckoutStatus, requestPaymentVerificationRecovery, type CheckoutStatusResponse } from "@/lib/commercial/commercialRpc";
import { safeResumeUrl } from "@/lib/commercial/purchaseJourney";
import { LeaveCheckout } from "./LeaveCheckout";

interface Props {
  /** The unfinished order's reference, when known; otherwise the customer's own open order is looked up. */
  saffReference?: string | null;
  /** Called once nothing blocks another plan: "left" = the customer closed it just now (its provider page may still be
   *  open); "closed" = it was found already closed or paid. */
  onCleared?: (reason: "left" | "closed") => void;
  className?: string;
}

type State =
  | { kind: "unknown" }
  | { kind: "none" }
  /** A named order whose status could not be read: say so and link to it, never a silent blank. */
  | { kind: "unreadable"; ref: string }
  | { kind: "open"; ref: string; status: CheckoutStatusResponse }
  /** An earlier attempt under review (MANUAL_REVIEW): it blocks a new one until it is resolved. */
  | { kind: "review"; ref: string; status: CheckoutStatusResponse }
  /** Closed in CFOClose just now: the consequence is restated once. */
  | { kind: "left" };

const orderHref = (ref: string) => `/billing/payment/return?ref=${encodeURIComponent(ref)}`;

export function UnfinishedCheckoutBanner({ saffReference = null, onCleared, className = "" }: Props) {
  const [state, setState] = useState<State>({ kind: "unknown" });
  const [resuming, setResuming] = useState(false);
  // A close in flight or waiting: Resume is off until it ends (never both at once).
  const [closing, setClosing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const onClearedRef = useRef(onCleared);
  onClearedRef.current = onCleared;

  const load = useCallback(async () => {
    let ref = saffReference;
    if (!ref) {
      const orders = await getMyPayments();
      ref = orders?.find((o) => o.status === "PENDING")?.saff_reference ?? null;
    }
    if (!ref) { setState({ kind: "none" }); return; }
    const { data: status } = await pollCheckoutStatus(ref);
    if (!status && saffReference) { setState({ kind: "unreadable", ref }); return; }
    // A review case still blocks a new purchase and is never closed by the customer: point to the order, offer no close.
    if (status && status.found !== false && status.status === "MANUAL_REVIEW") { setState({ kind: "review", ref, status }); return; }
    if (!status || status.found === false || status.status !== "PENDING" || status.paymentRecorded) {
      setState({ kind: "none" });
      // The named checkout is no longer open (closed, paid, or unknown to this account): nothing blocks a new one.
      if (saffReference && status) onClearedRef.current?.("closed");
      return;
    }
    setState({ kind: "open", ref, status });
  }, [saffReference]);

  useEffect(() => { void load(); }, [load]);

  if (state.kind === "unreadable") {
    return (
      <section role="status" data-testid="unfinished-checkout-unreadable" className={`border border-border p-4 text-sm ${className}`}>
        <p className="font-semibold">You have an unfinished plan checkout</p>
        <p className="mt-0.5 text-xs text-muted-foreground">Its status could not be read just now. Do not pay again; open the order to resume it or choose another plan.</p>
        <Link className="mt-2 inline-block text-xs font-medium underline" to={orderHref(state.ref)}>Open the order</Link>
      </section>
    );
  }
  if (state.kind === "review") {
    const paid = state.status.paymentRecorded;
    return (
      <section role="status" data-testid="unfinished-checkout-review" data-ref={state.ref} className={`border border-border p-4 text-sm ${className}`}>
        <p className="font-semibold">{paid ? "Your payment is recorded — your plan is being set up" : "An earlier checkout is being confirmed"}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{paid
          ? "It will not be taken again. A new purchase can start once it is placed."
          : "We are confirming with the payment provider whether it was paid. Do not pay again; a new purchase can start once it is resolved."}</p>
        <Link className="mt-2 inline-block text-xs font-medium underline" to={orderHref(state.ref)}>Open the order</Link>
      </section>
    );
  }
  if (state.kind === "left") {
    return (
      <section role="status" data-testid="unfinished-checkout-left" className={`border border-border p-4 text-sm ${className}`}>
        <p className="font-semibold">Checkout closed — you can choose another plan</p>
        <p className="mt-0.5 text-xs text-muted-foreground">Its payment page may stay open until it expires. Don't pay on it.</p>
      </section>
    );
  }
  if (state.kind !== "open") return null;
  const { ref, status } = state;
  const plan = displayPlanName(status.planCode) ?? "plan";

  /** Resume: ask the provider now; open its page only when it reports the session open and unpaid. */
  const resume = async () => {
    if (resuming) return;
    setResuming(true);
    setNotice(null);
    const r = await requestPaymentVerificationRecovery(ref);
    setResuming(false);
    const pc = r.data?.providerCheckout;
    const url = pc?.state === "OPEN_UNPAID" ? safeResumeUrl(pc.resumeUrl) : null;
    if (url) { window.location.assign(url); return; }
    if (r.data && (r.data.status !== "PENDING" || r.data.paymentRecorded)) { void load(); return; }
    if (pc?.state === "PAYMENT_PROCESSING") { setNotice("This payment is being processed. Do not pay again; your plan starts once it is verified."); return; }
    // Throttled, unreachable, or no page to return to: the order page asks again and offers Resume when it can.
    setNotice(r.throttled ? `Checked moments ago — open the order to resume it (about ${r.retryAfterSeconds ?? 60} s).` : "The payment page could not be reached just now. Open the order to try again.");
  };

  return (
    <section role="status" aria-live="polite" data-testid="unfinished-checkout" data-ref={ref}
      className={`flex flex-col gap-3 border border-amber-500/60 bg-amber-50 p-4 text-sm text-amber-950 dark:bg-amber-950/30 dark:text-amber-100 ${className}`}>
      <div>
        <p className="font-semibold">Your {plan} checkout isn't finished</p>
        <p className="mt-0.5 text-xs opacity-80">No payment has been recorded for it. Resume it, or choose another plan.</p>
        {notice && <p className="mt-1 text-xs" role="alert" data-testid="unfinished-notice">{notice} <Link className="font-medium underline" to={orderHref(ref)}>Open the order</Link></p>}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <Button size="sm" onClick={() => void resume()} disabled={resuming || closing} data-testid="unfinished-resume">
          {resuming && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Resume
        </Button>
        <LeaveCheckout saffReference={ref} testIdPrefix="unfinished" onClosingChange={setClosing}
          onLeft={(reason) => {
            if (reason === "left") { setState({ kind: "left" }); onClearedRef.current?.("left"); return; }
            setState({ kind: "none" }); onClearedRef.current?.("closed");
          }}
          onStatus={(s) => { if (s.status !== "PENDING" || s.paymentRecorded) void load(); }} />
      </div>
    </section>
  );
}
