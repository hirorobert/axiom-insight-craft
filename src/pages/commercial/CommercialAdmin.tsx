/**
 * /commercial/admin — Ω2-G Commercial Administration UI
 *
 * Internal-only admin panel for:
 *   1. Managing commercial OFFERS (plan + market + currency + price) —
 *      never a single price field on a plan (PRODUCT_PRICING_DECISION_REQUIRED gate)
 *   2. Viewing billing state (server-authoritative, read-only)
 *   3. Authority reminder — what this UI cannot do
 *
 * Access: requires admin role via server-side RLS/RPC gating.
 * All data comes from admin-scoped RPCs — never from browser-held state.
 * This UI NEVER sets paid=true, grants licences, or bypasses webhook
 * verification. It NEVER receives accounting authority. Editing an offer
 * never rewrites historical checkout/payment evidence — every checkout
 * intent snapshots its own economic facts independently at creation time.
 */

import { useEffect, useState } from "react";
import { callCommercialRpc } from "@/lib/commercial/commercialRpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertCircle, ShieldCheck, RefreshCw, Plus } from "lucide-react";

interface OfferRow {
  id: string;
  offer_code: string;
  plan_code: string;
  plan_id: string;
  market_code: string;
  currency_code: string;
  amount_minor: number;
  currency_exponent: number;
  billing_interval: string;
  billing_interval_count: number;
  is_active: boolean;
  is_purchasable: boolean;
  effective_start: string;
  effective_end: string | null;
}

interface BillingDetail {
  owner_user_id: string;
  email: string | null;
  plan_code: string | null;
  licence_status: string | null;
  effective_start: string | null;
  effective_end: string | null;
}

interface NewOfferForm {
  offerCode: string;
  planCode: string;
  marketCode: string;
  currencyCode: string;
  amountMinor: string;
  currencyExponent: string;
  billingInterval: string;
  billingIntervalCount: string;
}

const MARKET_CODES = ["GLOBAL", "TZ", "MU", "GB", "EU"] as const;
const BILLING_INTERVALS = ["ANNUAL", "MONTHLY", "ONE_TIME"] as const;

const EMPTY_FORM: NewOfferForm = {
  offerCode: "", planCode: "PAID", marketCode: "GLOBAL", currencyCode: "USD",
  amountMinor: "", currencyExponent: "2", billingInterval: "ANNUAL", billingIntervalCount: "1",
};

export default function CommercialAdmin() {
  const [offers, setOffers] = useState<OfferRow[]>([]);
  const [billingRows, setBillingRows] = useState<BillingDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<NewOfferForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  async function loadOffers() {
    const { data, error } = await callCommercialRpc("admin_list_commercial_offers", {});
    if (error) { setError(error.message); return; }
    setOffers(data ?? []);
  }

  // Admin billing detail — shows the calling admin's own billing summary via
  // get_my_billing_summary. A full paginated cross-customer admin list is
  // deliberately out of scope for Ω2-G ("no giant admin dashboard").
  async function loadBillingRows() {
    const { data } = await callCommercialRpc("get_my_billing_summary");
    if (data) {
      setBillingRows([{
        owner_user_id: "self",
        email: null,
        plan_code: data.plan_code,
        licence_status: data.licence_status,
        effective_start: data.effective_start,
        effective_end: data.effective_end,
      }]);
    }
  }

  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([loadOffers(), loadBillingRows()]);
      setLoading(false);
    })();
  }, []);

  async function togglePurchasable(offer: OfferRow) {
    setSaving(true);
    const { error } = await callCommercialRpc("admin_upsert_commercial_offer", {
      p_offer_code: offer.offer_code,
      p_plan_code: offer.plan_code,
      p_market_code: offer.market_code,
      p_currency_code: offer.currency_code,
      p_amount_minor: offer.amount_minor,
      p_currency_exponent: offer.currency_exponent,
      p_billing_interval: offer.billing_interval,
      p_billing_interval_count: offer.billing_interval_count,
      p_is_active: offer.is_active,
      p_is_purchasable: !offer.is_purchasable,
      p_reason: `Toggled purchasable via /commercial/admin`,
    });
    setSaving(false);
    if (error) { setSaveMsg(error.message); return; }
    await loadOffers();
  }

  async function createOrUpdateOffer() {
    const amount = parseInt(form.amountMinor, 10);
    const exponent = parseInt(form.currencyExponent, 10);
    const intervalCount = parseInt(form.billingIntervalCount, 10);
    if (!form.offerCode || !form.planCode || !form.currencyCode || isNaN(amount) || amount <= 0) {
      setSaveMsg("offer code, plan code, currency, and a positive amount are required");
      return;
    }
    setSaving(true);
    const { error } = await callCommercialRpc("admin_upsert_commercial_offer", {
      p_offer_code: form.offerCode,
      p_plan_code: form.planCode,
      p_market_code: form.marketCode,
      p_currency_code: form.currencyCode.toUpperCase(),
      p_amount_minor: amount,
      p_currency_exponent: isNaN(exponent) ? 2 : exponent,
      p_billing_interval: form.billingInterval,
      p_billing_interval_count: isNaN(intervalCount) ? 1 : intervalCount,
      p_is_active: true,
      p_is_purchasable: true,
      p_reason: `Created/updated via /commercial/admin`,
    });
    setSaving(false);
    if (error) { setSaveMsg(error.message); return; }
    setSaveMsg(`Saved — ${form.offerCode} is active and purchasable`);
    setForm(EMPTY_FORM);
    await loadOffers();
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-6 space-y-8 max-w-5xl mx-auto">
      <div className="flex items-center gap-3">
        <ShieldCheck className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-semibold">Commercial Administration</h1>
        <Badge variant="outline" className="ml-auto font-mono text-xs">Ω2-G</Badge>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}

      {/* ── Section 1: Commercial Offers (PRODUCT_PRICING_DECISION_REQUIRED gate) ── */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-medium">Commercial Offers</h2>
          <p className="text-sm text-muted-foreground">
            A plan has no price of its own. Each row below is one offer:
            this plan, in this market, in this currency, at this price.
            A plan with no purchasable offer in a market cannot be checked
            out in that market — no price is ever invented here.
          </p>
        </div>
        <div className="rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3 font-medium">Offer</th>
                <th className="text-left p-3 font-medium">Plan</th>
                <th className="text-left p-3 font-medium">Market</th>
                <th className="text-left p-3 font-medium">Price</th>
                <th className="text-left p-3 font-medium">Interval</th>
                <th className="text-left p-3 font-medium">Purchasable</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {offers.length === 0 && (
                <tr><td colSpan={7} className="p-4 text-center text-muted-foreground">
                  No offers configured yet. Create one below.
                </td></tr>
              )}
              {offers.map((o) => (
                <tr key={o.id} className="border-t">
                  <td className="p-3 font-mono text-xs">{o.offer_code}</td>
                  <td className="p-3 font-mono text-xs">{o.plan_code}</td>
                  <td className="p-3"><Badge variant="outline" className="font-mono text-xs">{o.market_code}</Badge></td>
                  <td className="p-3 font-mono">{o.amount_minor} {o.currency_code}</td>
                  <td className="p-3 text-muted-foreground text-xs">
                    {o.billing_interval}{o.billing_interval_count > 1 ? ` x${o.billing_interval_count}` : ""}
                  </td>
                  <td className="p-3">
                    <Badge variant={(o.is_purchasable ? "default" : "secondary") as "default" | "secondary"}>
                      {o.is_purchasable ? "YES" : "NO"}
                    </Badge>
                  </td>
                  <td className="p-3">
                    <Button size="sm" variant="outline" disabled={saving} onClick={() => togglePurchasable(o)}>
                      {o.is_purchasable ? "Disable" : "Enable"}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ── New / update offer form ── */}
        <div className="rounded-lg border p-4 space-y-3">
          <h3 className="text-sm font-medium flex items-center gap-1"><Plus className="h-4 w-4" /> Create or update an offer</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="text-xs text-muted-foreground">Offer code</label>
              <Input className="h-8 font-mono text-xs" placeholder="PAID_GLOBAL_USD_ANNUAL"
                value={form.offerCode} onChange={(e) => setForm((f) => ({ ...f, offerCode: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Plan code</label>
              <Input className="h-8 font-mono text-xs" placeholder="PAID"
                value={form.planCode} onChange={(e) => setForm((f) => ({ ...f, planCode: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Market</label>
              <select className="h-8 w-full rounded-md border bg-background px-2 text-xs font-mono"
                value={form.marketCode} onChange={(e) => setForm((f) => ({ ...f, marketCode: e.target.value }))}>
                {MARKET_CODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Currency (ISO 4217)</label>
              <Input className="h-8 font-mono text-xs" placeholder="USD" maxLength={3}
                value={form.currencyCode} onChange={(e) => setForm((f) => ({ ...f, currencyCode: e.target.value.toUpperCase() }))} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Amount (minor units)</label>
              <Input className="h-8 font-mono text-xs" type="number" min="1" placeholder="e.g. 49900"
                value={form.amountMinor} onChange={(e) => setForm((f) => ({ ...f, amountMinor: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Currency exponent</label>
              <Input className="h-8 font-mono text-xs" type="number" min="0" max="4"
                value={form.currencyExponent} onChange={(e) => setForm((f) => ({ ...f, currencyExponent: e.target.value }))} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Billing interval</label>
              <select className="h-8 w-full rounded-md border bg-background px-2 text-xs font-mono"
                value={form.billingInterval} onChange={(e) => setForm((f) => ({ ...f, billingInterval: e.target.value }))}>
                {BILLING_INTERVALS.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Interval count</label>
              <Input className="h-8 font-mono text-xs" type="number" min="1"
                value={form.billingIntervalCount} onChange={(e) => setForm((f) => ({ ...f, billingIntervalCount: e.target.value }))} />
            </div>
          </div>
          <Button size="sm" disabled={saving} onClick={createOrUpdateOffer}>
            {saving ? <RefreshCw className="h-3 w-3 animate-spin" /> : "Save Offer"}
          </Button>
          {saveMsg && <p className="text-xs text-muted-foreground">{saveMsg}</p>}
        </div>
      </section>

      {/* ── Section 2: Billing Overview ── */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-medium">Billing Overview</h2>
          <p className="text-sm text-muted-foreground">
            Server-authoritative billing state. This reflects committed payment events only.
          </p>
        </div>
        <div className="rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3 font-medium">Customer</th>
                <th className="text-left p-3 font-medium">Plan</th>
                <th className="text-left p-3 font-medium">Licence Status</th>
                <th className="text-left p-3 font-medium">Effective</th>
                <th className="text-left p-3 font-medium">Expires</th>
              </tr>
            </thead>
            <tbody>
              {billingRows.map((row, i) => (
                <tr key={i} className="border-t">
                  <td className="p-3 font-mono text-xs">{row.email ?? row.owner_user_id}</td>
                  <td className="p-3">{row.plan_code ?? <span className="text-muted-foreground">None</span>}</td>
                  <td className="p-3">
                    <Badge variant={(row.licence_status === "ACTIVE" ? "default" : "secondary") as "default" | "secondary"}>
                      {row.licence_status ?? "UNKNOWN"}
                    </Badge>
                  </td>
                  <td className="p-3 text-muted-foreground text-xs">
                    {row.effective_start ? new Date(row.effective_start).toLocaleDateString() : "—"}
                  </td>
                  <td className="p-3 text-muted-foreground text-xs">
                    {row.effective_end ? new Date(row.effective_end).toLocaleDateString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Section 3: Authority reminder ── */}
      <section className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 p-4 space-y-2">
        <div className="flex items-center gap-2 text-amber-800 dark:text-amber-400 font-medium text-sm">
          <AlertCircle className="h-4 w-4" />
          Admin authority scope
        </div>
        <ul className="text-xs text-amber-700 dark:text-amber-300 space-y-1 list-disc list-inside">
          <li>This panel CANNOT grant or revoke licences directly.</li>
          <li>Licences are created only by <code>commit_verified_commercial_payment()</code> RPC (SECURITY DEFINER).</li>
          <li>Payment reversals return REVIEW_REQUIRED — no auto-mutations.</li>
          <li>Webhook processing is two-gate: authenticity + independent server verification.</li>
          <li>Editing an offer's price/currency takes effect on the next checkout intent — existing checkouts and licences are unaffected, because every checkout snapshots its own economic facts at creation time.</li>
          <li>Commercial admin authority never confers accounting or professional authority.</li>
        </ul>
      </section>
    </div>
  );
}
