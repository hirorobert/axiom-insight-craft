import { useActivity } from "@/components/feedback/useActivity";
/**
 * "Choose another plan" for an unfinished checkout (20261119100000) — one control for the plans banner and the order page.
 *
 * What it does, stated before the customer confirms: it closes CFOClose's record of this checkout so that another plan can
 * be bought. It does NOT close the provider's payment page (no provider allows that); that page stays payable until it
 * expires. A payment still made there is recorded (20261102100000): placed normally when nothing replaced it, otherwise
 * held for a commercial administrator to resolve (a refund at the provider, or the extra term with the customer's
 * agreement) — never a second plan applied automatically. Nothing here promises a refund or credit.
 *
 * The server acts only on a fresh answer from the provider; when it asked moments ago it answers RETRY_LATER and this
 * control waits out that time, visibly, then asks again (bounded).
 */
import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { abandonUnfinishedCheckout, type CheckoutStatusResponse } from "@/lib/commercial/commercialRpc";
import { LEAVE_CHECKOUT_DISCLOSURE } from "@/lib/commercial/purchaseJourney";

/** Automatic re-asks after a RETRY_LATER answer, before the customer is asked to try again themselves. */
const MAX_AUTO_RETRIES = 2;

export function LeaveCheckout({ saffReference, onLeft, onStatus, onClosingChange, testIdPrefix = "leave-checkout" }: {
  saffReference: string;
  /** Another plan can now be bought: "left" = closed in CFOClose just now (its provider page may still be open);
   *  "closed" = it had already ended unpaid. */
  onLeft: (reason: "left" | "closed") => void;
  /** The order's latest server state, when an answer carried one (e.g. the provider had already completed it). */
  onStatus?: (s: CheckoutStatusResponse) => void;
  /** True while a close is being asked or waited for: the caller disables Resume so the two never run together. */
  onClosingChange?: (closing: boolean) => void;
  testIdPrefix?: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const retries = useRef(0);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const closing = busy || wait !== null;
  useActivity(closing, "Confirming the unfinished checkout…");
  const onClosingRef = useRef(onClosingChange);
  onClosingRef.current = onClosingChange;
  useEffect(() => { onClosingRef.current?.(closing); }, [closing]);
  useEffect(() => () => onClosingRef.current?.(false), []);

  const sending = useRef(false);
  const leave = async () => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setNotice(null);
    let r: Awaited<ReturnType<typeof abandonUnfinishedCheckout>>;
    try { r = await abandonUnfinishedCheckout(saffReference); }
    catch { setBusy(false); setWait(null); setNotice("Could not confirm this checkout’s status. Check the order before trying again."); return; }
    finally { sending.current = false; }
    if (!live.current) return;
    if (r.status && r.outcome !== "ABANDONED" && r.outcome !== "NOT_PENDING") onStatus?.(r.status);
    if (r.outcome === "RETRY_LATER" && retries.current < MAX_AUTO_RETRIES) {
      retries.current += 1;
      setWait(r.retryAfterSeconds ?? 30);
      return;
    }
    setBusy(false);
    setWait(null);
    if (r.outcome === "ABANDONED") { onLeft("left"); return; }
    // Not open any more. Only a checkout that ended unpaid clears the way; a paid order or a review case is shown as it is
    // (never reported as closed by the customer).
    if (r.outcome === "NOT_PENDING" && r.status && ["EXPIRED", "FAILED", "CANCELLED"].includes(r.status.status ?? "") && !r.status.paymentRecorded) { onLeft("closed"); return; }
    setConfirming(false);
    if (r.outcome === "NOT_PENDING") { if (r.status) onStatus?.(r.status); setNotice("This order can no longer be closed here; its current status is shown."); return; }
    if (r.outcome === "SETTLED") { setNotice("The payment provider has already completed this order, so it was not closed. Its result is shown here."); return; }
    if (r.outcome === "PAYMENT_PROCESSING") { setNotice("This payment is being processed, so the checkout cannot be closed now. Do not pay again."); return; }
    setNotice("We could not confirm with the payment provider that this checkout is unpaid, so nothing was changed. Try again in a moment.");
  };

  // The visible wait after RETRY_LATER, then one more fresh ask.
  useEffect(() => {
    if (wait === null) return;
    if (wait <= 0) { setWait(null); void leave(); return; }
    const t = setTimeout(() => setWait((w) => (w === null ? null : w - 1)), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wait]);

  if (!confirming) {
    return (
      <div className="space-y-1">
        <Button variant="outline" size="sm" className="w-full sm:w-auto" onClick={() => { retries.current = 0; setConfirming(true); }} data-testid={`${testIdPrefix}-choose-another`}>
          Choose another plan
        </Button>
        {notice && <p className="text-xs" role="alert" data-testid={`${testIdPrefix}-notice`}>{notice}</p>}
      </div>
    );
  }
  return (
    <div className="space-y-3 border border-border bg-background p-3 text-sm text-foreground" role="group" aria-label="Close this checkout" data-testid={`${testIdPrefix}-confirm`}>
      <p className="text-xs leading-5 text-muted-foreground">{LEAVE_CHECKOUT_DISCLOSURE}</p>
      {wait !== null
        ? <p className="flex items-center gap-2 text-xs" role="status" data-testid={`${testIdPrefix}-waiting`}><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Confirming with the payment provider that nothing was paid — about {wait} s.</p>
        : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void leave()} disabled={busy} data-testid={`${testIdPrefix}-confirm-close`}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Close this checkout
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={busy} data-testid={`${testIdPrefix}-keep`}>Keep it</Button>
          </div>
        )}
    </div>
  );
}
