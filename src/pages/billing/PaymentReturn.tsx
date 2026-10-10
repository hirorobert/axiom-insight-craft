/**
 * /billing/payment/return?ref=… — the order's status page (where a provider returns the customer, and where a mobile
 * money customer waits for the prompt on their phone).
 *
 * SECURITY INVARIANTS (enforced here):
 *   - NEVER: browser callback → premium entitlement
 *   - NEVER: URL params → trusted as payment proof
 *   - Server-side state is polled via owner-scoped Edge Function.
 *   - UI reflects authoritative server state ONLY.
 *   - A provider redirect carries saffReference only — no amount, no status.
 *
 * What the customer sees, always from the server: what is being bought and the amount; whether the payment is pending,
 * received, failed, cancelled or expired; whether access is active, scheduled or still being set up; one next action
 * that never asks for a second payment while an earlier one may still be valid; and the receipt references.
 *
 * Flow:
 *   1. Read ?ref= from URL (our own saff_reference — NOT provider tx id)
 *   2. Poll commercial-payment-status (GET, read-only) every 3 s; every 20th tick, and on "Check again", ask for one
 *      bounded recovery verification (POST — the server asks the provider; durably throttled per order)
 *   3. Stop on a final state; show the result — access only when the server reports the verified order
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { pollCheckoutStatus, requestPaymentVerificationRecovery, type CheckoutStatusResponse } from "@/lib/commercial/commercialRpc";
import { AlertCircle, CheckCircle2, Clock, Loader2, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { displayPlanName, formatLicenceDate } from "@/lib/commercial/billingDisplay";
import { formatMoney } from "@/lib/commercial/planOffers";
import { activationRequestHref } from "@/lib/commercial/offerings";

type PollPhase = "POLLING" | "CONFIRMED" | "FAILED" | "CANCELLED" | "EXPIRED" | "REVIEW" | "TIMEOUT" | "NO_REF";

const POLL_INTERVAL_MS = 3_000;
const MAX_POLLS = 100; // 5 minutes — a mobile-money prompt can take a few minutes to be approved
// GET (pollCheckoutStatus) is read-only and safe at any frequency. The recovery POST is what may trigger a real provider
// call server-side, so it is fired far less often — the server's own claim_verification_attempt cooldown (60s) is the
// actual, durable authority on how often a provider call can happen; this cadence just avoids spamming a request that
// will be THROTTLED almost every time.
const RECOVERY_EVERY_N_POLLS = 20; // ~60s at POLL_INTERVAL_MS=3000

const FINAL: Record<string, PollPhase> = { SUCCEEDED: "CONFIRMED", FAILED: "FAILED", CANCELLED: "CANCELLED", EXPIRED: "EXPIRED" };

export default function PaymentReturn() {
  const [searchParams] = useSearchParams();
  const saffRef = searchParams.get("ref");

  const [phase, setPhase] = useState<PollPhase>(saffRef ? "POLLING" : "NO_REF");
  const [status, setStatus] = useState<CheckoutStatusResponse | null>(null);
  const [pollCount, setPollCount] = useState(0);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const pollCountRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const purchasedStartsInFuture = Boolean(
    status?.purchasedEffectiveStart &&
    new Date(status.purchasedEffectiveStart).getTime() > Date.now(),
  );
  const confirmedEffectiveEnd = status?.purchasedEffectiveEnd ?? status?.effectiveEnd ?? null;

  const applyStatus = useCallback((data: CheckoutStatusResponse) => {
    setStatus(data);
    const final = data.status ? FINAL[data.status] : undefined;
    if (final) {
      clearInterval(timerRef.current!);
      setPhase(final);
    } else if (data.status === "MANUAL_REVIEW") {
      setPhase("REVIEW");
    } else {
      setPhase((p) => (p === "TIMEOUT" ? p : "POLLING"));
    }
  }, []);

  useEffect(() => {
    if (!saffRef) return;

    const poll = async () => {
      pollCountRef.current += 1;
      const count = pollCountRef.current;
      setPollCount(count);

      // Every Nth tick, ask the server for one bounded recovery-verification attempt (may independently re-verify with
      // the provider and commit if a webhook never arrived). A throttled response is "no new information yet".
      if (count === 1 || count % RECOVERY_EVERY_N_POLLS === 0) {
        const recovery = await requestPaymentVerificationRecovery(saffRef);
        if (recovery.data) {
          applyStatus(recovery.data);
          return;
        }
        if (recovery.error) return; // keep polling via GET below
      }

      const { data, error } = await pollCheckoutStatus(saffRef);
      if (error || !data) return; // keep polling
      applyStatus(data);
    };

    poll(); // immediate first poll
    timerRef.current = setInterval(async () => {
      if (pollCountRef.current >= MAX_POLLS) {
        clearInterval(timerRef.current!);
        setPhase((p) => (p === "POLLING" ? "TIMEOUT" : p));
        return;
      }
      await poll();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timerRef.current!);
  }, [saffRef, applyStatus]);

  /** "Check again": one recovery request now. Never starts a payment. */
  const checkAgain = async () => {
    if (!saffRef || checking) return;
    setChecking(true);
    setNotice(null);
    const r = await requestPaymentVerificationRecovery(saffRef);
    setChecking(false);
    if (r.data) { applyStatus(r.data); setNotice("Checked with the payment provider just now."); return; }
    if (r.throttled) { setNotice(`Checked recently — try again in about ${r.retryAfterSeconds ?? 60} seconds.`); return; }
    setNotice("The payment provider could not be reached. Your order is unchanged; try again shortly.");
  };

  const planName = status ? displayPlanName(status.planCode) : null;
  const amount = status?.expectedAmountMinor != null && status.currencyCode
    ? formatMoney(status.expectedAmountMinor, status.currencyCode, status.currencyExponent ?? 0) : null;
  const retryHref = status?.purchasedPlanCode ? `/billing/checkout?plan=${status.purchasedPlanCode}` : "/plans";
  const mobileMoney = status?.provider === "SNIPPE";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <main id="main-content" className="w-full max-w-lg space-y-6 border bg-card p-6 shadow-sm sm:p-8" data-testid="payment-status" data-phase={phase}>

        {phase === "NO_REF" && (
          <div className="space-y-4 text-center">
            <AlertCircle className="mx-auto h-12 w-12 text-destructive" aria-hidden="true" />
            <h1 className="text-xl font-semibold">Order reference missing</h1>
            <p className="text-sm text-muted-foreground">This link does not name an order. Your orders, with their status, are listed on one page.</p>
            <Button asChild className="w-full"><Link to="/billing/orders">See your orders</Link></Button>
          </div>
        )}

        {saffRef && (
          <>
            <header className="text-center" aria-live="polite">
              {phase === "POLLING" && <Loader2 className="mx-auto h-12 w-12 animate-spin text-primary" aria-hidden="true" />}
              {phase === "CONFIRMED" && <CheckCircle2 className="mx-auto h-12 w-12 text-green-700" aria-hidden="true" />}
              {(phase === "FAILED" || phase === "CANCELLED" || phase === "EXPIRED") && <XCircle className="mx-auto h-12 w-12 text-destructive" aria-hidden="true" />}
              {(phase === "REVIEW" || phase === "TIMEOUT") && <Clock className="mx-auto h-12 w-12 text-amber-600" aria-hidden="true" />}
              <h1 className="mt-3 text-xl font-semibold" data-testid="payment-heading">
                {phase === "POLLING" && (mobileMoney ? "Approve the payment on your phone" : "Waiting for payment confirmation")}
                {phase === "CONFIRMED" && (status?.reversalType ? "Payment refunded" : "Payment received")}
                {phase === "FAILED" && "The payment did not go through"}
                {phase === "CANCELLED" && "The payment was cancelled"}
                {phase === "EXPIRED" && "The payment request expired"}
                {phase === "REVIEW" && (status?.paymentRecorded ? "Payment received — setting up your plan" : "Confirming this payment")}
                {phase === "TIMEOUT" && "Still waiting for confirmation"}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground" data-testid="payment-explanation">
                {phase === "POLLING" && (mobileMoney
                  ? "A prompt has been sent to your mobile money number. Enter your PIN to approve it. This page updates by itself."
                  : "We are confirming the payment with the provider. This usually takes a few seconds.")}
                {phase === "CONFIRMED" && !status?.reversalType && "The provider confirmed the payment and it was verified by CFOCLOSE."}
                {phase === "CONFIRMED" && status?.reversalType && `This payment was ${status.reversalType === "CHARGEBACK" ? "disputed" : "refunded"}. Our team reviews the plan's access and will contact you.`}
                {(phase === "FAILED" || phase === "CANCELLED" || phase === "EXPIRED") && "The provider confirmed that no payment was taken. You can start a new payment."}
                {phase === "REVIEW" && (status?.paymentRecorded
                  ? "Your payment is recorded and will not be taken again. Our team is placing the 12-month term on your account and will email you."
                  : "We could not yet confirm whether this payment completed. Do not pay again: we check with the provider, and if it was not taken, you can start a new payment.")}
                {phase === "TIMEOUT" && "The provider has not confirmed the payment yet. If you approved it, it is still being processed. Do not pay again."}
              </p>
            </header>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-4 text-sm" data-testid="order-summary">
              <dt className="text-muted-foreground">Plan</dt><dd className="text-right font-medium">{planName ?? "—"}{status?.billingInterval === "ANNUAL" ? " · 12 months" : ""}</dd>
              <dt className="text-muted-foreground">Amount</dt><dd className="text-right font-medium">{amount ?? "—"}{status?.provider === "POLAR" ? " + any sales tax" : ""}</dd>
              <dt className="text-muted-foreground">Payment method</dt><dd className="text-right">{status?.provider === "POLAR" ? "Card (Polar)" : mobileMoney ? "Mobile money (Snippe)" : "—"}</dd>
              <dt className="text-muted-foreground">Order reference</dt><dd className="break-all text-right font-mono text-xs">{saffRef}</dd>
              {status?.paymentReference && <><dt className="text-muted-foreground">Provider reference</dt><dd className="break-all text-right font-mono text-xs" data-testid="provider-reference">{status.paymentReference}</dd></>}
              {status?.paidAt && <><dt className="text-muted-foreground">Paid on</dt><dd className="text-right">{formatLicenceDate(status.paidAt)}</dd></>}
            </dl>

            {phase === "CONFIRMED" && !status?.reversalType && (
              <p className="border-l-2 border-green-700 pl-3 text-sm" data-testid="access-state">
                {purchasedStartsInFuture && status?.purchasedEffectiveStart ? (
                  <>Your {displayPlanName(status.planCode)} plan is scheduled from <strong>{formatLicenceDate(status.purchasedEffectiveStart)}</strong>
                    {confirmedEffectiveEnd && <> through <strong>{formatLicenceDate(confirmedEffectiveEnd)}</strong></>}, when your current term ends.</>
                ) : (
                  <>Your {displayPlanName(status?.planCode ?? null)} plan is active.
                    {confirmedEffectiveEnd && <> Access through <strong>{formatLicenceDate(confirmedEffectiveEnd)}</strong>.</>}</>
                )}
              </p>
            )}

            {phase === "CONFIRMED" && !status?.reversalType && (
              <p className="text-xs text-muted-foreground" data-testid="receipt-note">
                {status?.provider === "POLAR"
                  ? "Polar, our merchant of record for card payments, emails your receipt and invoice. Keep the references above for your records."
                  : "Your mobile money confirmation message is the payment receipt. Keep the references above for your records."}
              </p>
            )}

            <div className="flex flex-col gap-2">
              {phase === "CONFIRMED" && !status?.reversalType && (
                <Button asChild className="w-full" data-testid="next-start-review"><Link to="/dashboard">Start a trial balance review</Link></Button>
              )}
              {(phase === "FAILED" || phase === "CANCELLED" || phase === "EXPIRED") && (
                <Button asChild className="w-full" data-testid="next-try-again"><Link to={retryHref}>Start a new payment</Link></Button>
              )}
              {(phase === "POLLING" || phase === "TIMEOUT" || (phase === "REVIEW" && !status?.paymentRecorded)) && (
                <Button variant={phase === "POLLING" ? "outline" : "default"} className="w-full" onClick={checkAgain} disabled={checking} data-testid="next-check-again">
                  {checking ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
                  Check again
                </Button>
              )}
              {(phase === "REVIEW" || phase === "TIMEOUT" || (phase === "CONFIRMED" && status?.reversalType)) && (
                <Button asChild variant="outline" className="w-full"><Link to={activationRequestHref("plan_wall")}>Contact our team</Link></Button>
              )}
              <Link to="/billing/orders" className="text-center text-sm underline underline-offset-4">See all your orders</Link>
            </div>
            {notice && <p className="text-center text-xs text-muted-foreground" role="status">{notice}</p>}
            {phase === "POLLING" && <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground"><Clock className="h-3 w-3" aria-hidden="true" />Checked {pollCount} {pollCount === 1 ? "time" : "times"}</p>}
          </>
        )}
      </main>
    </div>
  );
}
