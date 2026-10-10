/**
 * /billing/orders — the signed-in customer's own orders (get_my_payments, owner-scoped on the server): what was bought,
 * the amount, the payment state, the references for their records, the term each payment bought, and any refund.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { AccountOrPublicFrame } from "@/components/account/AccountShell";
import { useAuth } from "@/contexts/AuthContext";
import { getMyPayments, type MyPayment } from "@/lib/commercial/checkoutClient";
import { formatLicenceDate } from "@/lib/commercial/billingDisplay";
import { formatMoney } from "@/lib/commercial/planOffers";

const STATE: Record<string, string> = {
  SUCCEEDED: "Paid", PENDING: "Awaiting payment", CREATING: "Being prepared", PROVIDER_CREATING: "Being prepared",
  MANUAL_REVIEW: "Being confirmed", FAILED: "Not paid", CANCELLED: "Cancelled", EXPIRED: "Expired",
};

export default function Orders() {
  const { user, loading } = useAuth();
  const [orders, setOrders] = useState<MyPayment[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (loading || !user) return;
    getMyPayments().then((r) => (r ? setOrders(r) : setFailed(true)));
  }, [user, loading]);

  return (
    <AccountOrPublicFrame publicMainClassName="mx-auto w-full max-w-4xl flex-1 px-4 pb-16 pt-28 sm:px-6" accountMainClassName="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
        <h1 className="text-2xl font-semibold">Your orders</h1>
        {!loading && !user && <p className="mt-4 text-sm">Sign in to see your orders. <Link className="underline" to="/auth">Sign in</Link></p>}
        {user && !orders && !failed && <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading…</p>}
        {failed && <p className="mt-4 text-sm text-destructive" role="alert">Your orders could not be loaded. <button type="button" className="underline" data-testid="orders-retry" onClick={() => { setFailed(false); setOrders(null); getMyPayments().then((r) => (r ? setOrders(r) : setFailed(true))); }}>Try again</button></p>}
        {orders && orders.length === 0 && <p className="mt-4 text-sm text-muted-foreground" data-testid="orders-empty">No online orders yet. <Link className="underline" to="/plans">See the plans</Link></p>}
        {orders && orders.length > 0 && (
          <ul className="mt-6 divide-y divide-border border border-border" data-testid="orders-list">
            {orders.map((o) => (
              <li key={o.saff_reference} className="grid gap-1 p-4 text-sm sm:grid-cols-4 sm:items-center">
                <span className="font-medium">{o.plan_name} · 12 months<span className="block text-xs font-normal text-muted-foreground">{formatLicenceDate(o.created_at)}</span></span>
                <span>{formatMoney(Number(o.amount_minor), o.currency_code, o.currency_exponent)}<span className="block text-xs text-muted-foreground">{o.provider === "POLAR" ? "Card (Polar)" : o.provider === "SNIPPE" ? "Mobile money (Snippe)" : o.provider}</span></span>
                <span>{o.reversal_type ? (o.reversal_type === "CHARGEBACK" ? "Disputed" : "Refunded") : STATE[o.status] ?? o.status}
                  {o.licence_start && o.licence_end && <span className="block text-xs text-muted-foreground">{formatLicenceDate(o.licence_start)} – {formatLicenceDate(o.licence_end)}</span>}</span>
                <span className="sm:text-right"><Link className="underline underline-offset-4" to={`/billing/payment/return?ref=${encodeURIComponent(o.saff_reference)}`}>Details</Link>
                  <span className="block break-all font-mono text-[11px] text-muted-foreground">{o.saff_reference}</span></span>
              </li>
            ))}
          </ul>
        )}
    </AccountOrPublicFrame>
  );
}
