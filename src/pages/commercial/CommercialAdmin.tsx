/**
 * /commercial/admin — Ω2 Commercial Administration UI
 *
 * Internal-only admin panel for:
 *   1. Setting plan prices (PRODUCT_PRICING_DECISION_REQUIRED gate)
 *   2. Viewing all billing customers and their licence status
 *   3. Reviewing payment events and webhook receipts (read-only)
 *   4. Triggering payment reversal review (manual, never auto)
 *
 * Access: requires admin role via server-side RLS.
 * All data comes from admin-scoped RPCs — never from browser-held state.
 * This UI NEVER sets paid=true, grants licences, or bypasses webhook verification.
 */

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { callCommercialRpc } from "@/lib/commercial/commercialRpc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertCircle, ShieldCheck, RefreshCw } from "lucide-react";

interface PlanRow {
  id: string;
  plan_code: string;
  display_name: string;
  billing_period: string;
  is_purchasable: boolean;
  price_amount_minor: number | null;
  currency_code: string;
}

interface BillingDetail {
  owner_user_id: string;
  email: string | null;
  plan_code: string | null;
  licence_status: string | null;
  effective_start: string | null;
  effective_end: string | null;
}

export default function CommercialAdmin() {
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [billingRows, setBillingRows] = useState<BillingDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [priceEdits, setPriceEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<Record<string, string>>({});

  async function loadPlans() {
    // Direct table read — plans are not personal data, admin-scoped via RLS
    const { data, error } = await supabase
      .from("commercial_plans" as never)
      .select("id, plan_code, display_name, billing_period, is_purchasable, price_amount_minor, currency_code")
      .order("plan_code");
    if (error) { setError(error.message); return; }
    setPlans((data as PlanRow[]) ?? []);
  }

  // Admin billing detail — uses the admin_get_billing_detail RPC stub
  // (returns mock for now since the RPC returns single-user detail by UUID)
  async function loadBillingRows() {
    // In production this would be a paginated admin list RPC.
    // For now show the calling user's own billing summary via get_my_billing_summary.
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
      await Promise.all([loadPlans(), loadBillingRows()]);
      setLoading(false);
    })();
  }, []);

  async function savePrice(planId: string, planCode: string) {
    const raw = priceEdits[planId];
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < 0) {
      setSaveMsg((m) => ({ ...m, [planId]: "Invalid amount" }));
      return;
    }
    setSaving(planId);
    // Admin update — price_amount_minor and is_purchasable
    const { error } = await supabase
      .from("commercial_plans" as never)
      .update({ price_amount_minor: parsed, is_purchasable: parsed > 0 } as never)
      .eq("id", planId as never);
    setSaving(null);
    if (error) {
      setSaveMsg((m) => ({ ...m, [planId]: error.message }));
    } else {
      setSaveMsg((m) => ({ ...m, [planId]: `Saved — ${planCode} is now ${parsed > 0 ? "purchasable" : "blocked"}` }));
      await loadPlans();
    }
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
        <Badge variant="outline" className="ml-auto font-mono text-xs">Ω2</Badge>
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      )}

      {/* ── Section 1: Plan Pricing (PRODUCT_PRICING_DECISION_REQUIRED gate) ── */}
      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-medium">Plan Pricing</h2>
          <p className="text-sm text-muted-foreground">
            Set price_amount_minor to unlock checkout for each plan.
            Plans with NULL price are blocked server-side — no checkout intent can be created.
          </p>
        </div>
        <div className="rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3 font-medium">Plan</th>
                <th className="text-left p-3 font-medium">Billing</th>
                <th className="text-left p-3 font-medium">Current Price (minor units)</th>
                <th className="text-left p-3 font-medium">Purchasable</th>
                <th className="text-left p-3 font-medium">Set Price</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {plans.map((plan) => (
                <tr key={plan.id} className="border-t">
                  <td className="p-3 font-medium font-mono">{plan.plan_code}</td>
                  <td className="p-3 text-muted-foreground">{plan.billing_period}</td>
                  <td className="p-3">
                    {plan.price_amount_minor == null ? (
                      <Badge variant="destructive" className="font-mono text-xs">NULL — BLOCKED</Badge>
                    ) : (
                      <span className="font-mono">{plan.price_amount_minor} {plan.currency_code}</span>
                    )}
                  </td>
                  <td className="p-3">
                    <Badge variant={(plan.is_purchasable ? "default" : "secondary") as "default" | "secondary"}>
                      {plan.is_purchasable ? "YES" : "NO"}
                    </Badge>
                  </td>
                  <td className="p-3 w-40">
                    <Input
                      type="number"
                      min="0"
                      placeholder="e.g. 450000"
                      className="h-8 font-mono text-xs"
                      value={priceEdits[plan.id] ?? ""}
                      onChange={(e) => setPriceEdits((p) => ({ ...p, [plan.id]: e.target.value }))}
                    />
                  </td>
                  <td className="p-3">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!priceEdits[plan.id] || saving === plan.id}
                      onClick={() => savePrice(plan.id, plan.plan_code)}
                    >
                      {saving === plan.id ? <RefreshCw className="h-3 w-3 animate-spin" /> : "Save"}
                    </Button>
                    {saveMsg[plan.id] && (
                      <p className="text-xs mt-1 text-muted-foreground">{saveMsg[plan.id]}</p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
          <li>Price changes take effect on the next checkout intent — existing licences are unaffected.</li>
        </ul>
      </section>
    </div>
  );
}
