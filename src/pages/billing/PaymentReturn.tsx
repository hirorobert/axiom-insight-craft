/**
 * /billing/payment/return — Ω2 Payment Return Page
 *
 * SECURITY INVARIANTS (enforced here):
 *   - NEVER: browser callback → premium entitlement
 *   - NEVER: URL params → trusted as payment proof
 *   - Server-side state is polled via owner-scoped Edge Function.
 *   - UI reflects authoritative server state ONLY.
 *   - Redirect from Flutterwave carries saffReference — no amount, no status.
 *
 * Flow:
 *   1. Read ?ref= from URL (our own saff_reference — NOT provider tx id)
 *   2. Poll commercial-payment-status until SUCCEEDED / FAILED / timeout
 *   3. Show result — upgrade entitlements only appear when server confirms
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { pollCheckoutStatus, type CheckoutStatusResponse } from "@/lib/commercial/commercialRpc";
import { AlertCircle, CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

type PollPhase = "POLLING" | "CONFIRMED" | "FAILED" | "CANCELLED" | "TIMEOUT" | "NO_REF";

const POLL_INTERVAL_MS = 3_000;
const MAX_POLLS = 40; // 2 minutes

export default function PaymentReturn() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const saffRef = searchParams.get("ref");

  const [phase, setPhase] = useState<PollPhase>(saffRef ? "POLLING" : "NO_REF");
  const [status, setStatus] = useState<CheckoutStatusResponse | null>(null);
  const [pollCount, setPollCount] = useState(0);
  const pollCountRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!saffRef) return;

    const poll = async () => {
      pollCountRef.current += 1;
      setPollCount(pollCountRef.current);
      const { data, error } = await pollCheckoutStatus(saffRef);
      if (error || !data) return; // keep polling

      setStatus(data);

      if (data.status === "SUCCEEDED") {
        clearInterval(timerRef.current!);
        setPhase("CONFIRMED");
      } else if (data.status === "FAILED") {
        clearInterval(timerRef.current!);
        setPhase("FAILED");
      } else if (data.status === "CANCELLED") {
        clearInterval(timerRef.current!);
        setPhase("CANCELLED");
      }
    };

    poll(); // immediate first poll
    timerRef.current = setInterval(async () => {
      if (pollCount >= MAX_POLLS) {
        clearInterval(timerRef.current!);
        setPhase("TIMEOUT");
        return;
      }
      await poll();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timerRef.current!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saffRef]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="max-w-md w-full rounded-2xl border bg-card shadow-sm p-8 space-y-6 text-center">

        {phase === "NO_REF" && (
          <>
            <AlertCircle className="mx-auto h-12 w-12 text-destructive" />
            <h1 className="text-xl font-semibold">Invalid payment link</h1>
            <p className="text-muted-foreground text-sm">
              No payment reference found. If you completed a payment, please
              check your billing settings — your plan will be activated once
              our server verifies the transaction.
            </p>
            <Button onClick={() => navigate("/settings")} className="w-full">
              Go to Settings
            </Button>
          </>
        )}

        {phase === "POLLING" && (
          <>
            <Loader2 className="mx-auto h-12 w-12 text-primary animate-spin" />
            <h1 className="text-xl font-semibold">Verifying your payment</h1>
            <p className="text-muted-foreground text-sm">
              We are confirming your payment with our payment provider.
              This usually takes a few seconds.
            </p>
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>Checking… ({pollCount})</span>
            </div>
            <p className="text-xs text-muted-foreground">
              You can safely close this tab. Your subscription will activate
              automatically once verified — no need to stay on this page.
            </p>
          </>
        )}

        {phase === "CONFIRMED" && (
          <>
            <CheckCircle2 className="mx-auto h-12 w-12 text-green-500" />
            <h1 className="text-xl font-semibold">Payment confirmed</h1>
            {status?.planCode && (
              <p className="text-muted-foreground text-sm">
                Your <strong>{status.planCode}</strong> plan is now active.
                {status.effectiveEnd && (
                  <> Licensed through{" "}
                    <strong>{new Date(status.effectiveEnd).toLocaleDateString()}</strong>.
                  </>
                )}
              </p>
            )}
            <Button onClick={() => navigate("/settings")} className="w-full">
              Go to Billing Settings
            </Button>
            <Button variant="outline" onClick={() => navigate("/")} className="w-full">
              Return to Dashboard
            </Button>
          </>
        )}

        {phase === "FAILED" && (
          <>
            <XCircle className="mx-auto h-12 w-12 text-destructive" />
            <h1 className="text-xl font-semibold">Payment not completed</h1>
            <p className="text-muted-foreground text-sm">
              Your payment did not complete successfully. No charge has been
              applied to your account. Please try again or contact support.
            </p>
            <Button onClick={() => navigate("/settings")} className="w-full">
              Try again
            </Button>
          </>
        )}

        {phase === "CANCELLED" && (
          <>
            <XCircle className="mx-auto h-12 w-12 text-muted-foreground" />
            <h1 className="text-xl font-semibold">Payment cancelled</h1>
            <p className="text-muted-foreground text-sm">
              You cancelled the payment. No charge has been applied.
            </p>
            <Button onClick={() => navigate("/settings")} className="w-full">
              Return to Settings
            </Button>
          </>
        )}

        {phase === "TIMEOUT" && (
          <>
            <Clock className="mx-auto h-12 w-12 text-muted-foreground" />
            <h1 className="text-xl font-semibold">Still processing</h1>
            <p className="text-muted-foreground text-sm">
              Verification is taking longer than usual. Your payment is still
              being processed — check your billing settings in a few minutes.
              Do not pay again.
            </p>
            <Button onClick={() => navigate("/settings")} className="w-full">
              Check Billing Settings
            </Button>
          </>
        )}

        {/* Ref display — for support reference only, not shown in success state as it looks like a receipt */}
        {saffRef && phase !== "CONFIRMED" && (
          <p className="text-xs text-muted-foreground/50 pt-2 font-mono">
            ref: {saffRef}
          </p>
        )}
      </div>
    </div>
  );
}
