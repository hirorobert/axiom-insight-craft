/**
 * /commercial/admin — the commercial administrator's screen. It replaces the identity-claim SQL workaround: every action
 * runs as the administrator's own signed-in session through an existing, audited, server-authorised RPC. The server
 * decides who may act (an active commercial_admins row); owning a company confers nothing here.
 *
 *   Payments      orders that need a person: unconfirmed outcomes, paid terms waiting for placement, refunds and disputes.
 *                 "Check with the provider" asks the provider again (the same throttled recovery customers use) — it
 *                 never charges. A paid term is placed with admin_place_paid_licence; an attempt is closed as uncharged
 *                 only after the provider's own dashboard shows no payment (the server refuses it when a payment exists).
 *   Accounts      find an account by sign-in email; manual activation (admin_ensure_billing_customer +
 *                 admin_grant_commercial_licence — it never shortens a paid term); end, cancel a not-yet-started licence,
 *                 additional named users.
 *   Offers        the approved prices: an offer made purchasable is what the public pages show as a price and what checkout
 *                 charges. Editing an offer never changes an existing order.
 *   Online payment the platform state (read through the checkout options) and its audited transition — opening payments to
 *                 customers is an owner decision recorded with a reason.
 *
 * Nothing here writes a table directly, sets a payment as paid, or grants accounting authority.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/contexts/AuthContext";
import { callCommercialRpc, requestPaymentVerificationRecovery } from "@/lib/commercial/commercialRpc";
import { getCheckoutOptions } from "@/lib/commercial/checkoutClient";
import { formatMoney } from "@/lib/commercial/planOffers";

type Rpc = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
async function rpc(fn: string, args: Record<string, unknown> = {}) {
  const { supabase } = await import("@/integrations/supabase/client");
  return (supabase.rpc as unknown as Rpc)(fn, args);
}
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");
const plusMonths = (d: string, n: number) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };
const today = () => new Date().toISOString().slice(0, 10);

interface AttentionIntent {
  intent_id: string; saff_reference: string; status: string; provider: string; provider_environment: string; plan_code: string;
  amount_minor: number; currency_code: string; currency_exponent: number; created_at: string; expires_at: string;
  billing_customer_id: string; owner_email: string | null; reason: string | null; payment_recorded: boolean;
}
interface Reversal { event_id: string; reversal_type: string; provider: string; amount_minor: number; currency_code: string; event_time: string; saff_reference: string | null; licence_id: string | null; owner_email: string | null }
interface Account { found: boolean; owner_user_id?: string; email?: string; billing_customer_id?: string | null; companies?: number;
  licences?: { licence_id: string; plan_code: string; status: string; source: string; effective_start: string; effective_end: string | null; additional_seats: number | null }[] }

const REASONS: Record<string, string> = {
  PAID_LICENCE_PLACEMENT_REQUIRED: "Paid — the term needs placing",
  PENDING_AFTER_EXPIRY: "Checkout expired without a confirmed outcome",
  PENDING_CHECKOUT_NOT_REUSABLE: "Superseded by a new attempt; outcome to confirm",
  PROVIDER_CREATE_THROWN_UNCERTAIN: "Provider did not answer when the payment was created",
  PROVIDER_RESULT_PERSISTENCE_UNCERTAIN: "Payment created but not recorded locally",
  PROVIDER_REQUEST_LEASE_EXPIRED: "Payment creation interrupted",
};

export default function CommercialAdmin() {
  const { user, loading } = useAuth();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [intents, setIntents] = useState<AttentionIntent[]>([]);
  const [reversals, setReversals] = useState<Reversal[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadAttention = useCallback(async () => {
    const { data, error } = await rpc("admin_list_payment_attention");
    if (error) { setAllowed(error.code === "42501" || /NOT_A_COMMERCIAL_ADMIN/.test(error.message) ? false : null); if (!/NOT_A_COMMERCIAL_ADMIN/.test(error.message)) setMessage(error.message); return; }
    setAllowed(true);
    const d = data as { intents: AttentionIntent[]; reversals: Reversal[] };
    setIntents(d.intents ?? []); setReversals(d.reversals ?? []);
  }, []);

  useEffect(() => { if (!loading && user) loadAttention(); }, [loading, user, loadAttention]);

  const act = async (key: string, run: () => Promise<{ error: { message: string } | null } | void>, done: string) => {
    setBusy(key); setMessage(null);
    const r = await run();
    setBusy(null);
    if (r && r.error) { setMessage(r.error.message.split("\n")[0]); return; }
    setMessage(done);
    await loadAttention();
  };

  if (loading) return <Centered><Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" /></Centered>;
  if (!user) return <Centered><p className="text-sm">Sign in with your administrator account. <Link className="underline" to="/auth">Sign in</Link></p></Centered>;
  if (allowed === false) return <Centered><p className="max-w-md text-center text-sm" data-testid="admin-forbidden">This page is for CFOCLOSE commercial administrators. Your account is not one; owning a workspace or company does not make it one.</p></Centered>;
  if (allowed === null) return <Centered>{message ? <p className="text-sm text-destructive" role="alert">{message}</p> : <Loader2 className="h-6 w-6 animate-spin" aria-label="Loading" />}</Centered>;

  return (
    <div className="mx-auto max-w-6xl space-y-6 bg-background px-4 py-8 sm:px-6">
      <div className="flex items-center gap-3">
        <ShieldCheck className="h-6 w-6 text-primary" aria-hidden="true" />
        <h1 className="text-2xl font-semibold">Commercial administration</h1>
        <Button size="sm" variant="outline" className="ml-auto" onClick={loadAttention}><RefreshCw className="h-4 w-4" aria-hidden="true" />Refresh</Button>
      </div>
      {message && <p className="border-l-2 border-foreground pl-3 text-sm" role="status" data-testid="admin-message">{message}</p>}

      <Tabs defaultValue="payments">
        <TabsList className="flex-wrap">
          <TabsTrigger value="payments">Payments needing attention ({intents.length + reversals.length})</TabsTrigger>
          <TabsTrigger value="accounts">Accounts and manual activation</TabsTrigger>
          <TabsTrigger value="offers">Prices</TabsTrigger>
          <TabsTrigger value="platform">Online payment</TabsTrigger>
        </TabsList>

        <TabsContent value="payments" className="space-y-6">
          <section aria-labelledby="attention-orders">
            <h2 id="attention-orders" className="text-lg font-medium">Orders</h2>
            {intents.length === 0 && <p className="mt-2 text-sm text-muted-foreground" data-testid="no-attention">Nothing needs attention.</p>}
            <ul className="mt-3 space-y-3">
              {intents.map((i) => <IntentRow key={i.intent_id} i={i} busy={busy} act={act} />)}
            </ul>
          </section>
          <section aria-labelledby="attention-reversals">
            <h2 id="attention-reversals" className="text-lg font-medium">Refunds and disputes</h2>
            <p className="text-sm text-muted-foreground">A refund or dispute never changes a licence by itself. Decide, and if access should end, end the licence under Accounts first.</p>
            {reversals.length === 0 && <p className="mt-2 text-sm text-muted-foreground">None waiting for a decision.</p>}
            <ul className="mt-3 space-y-3">
              {reversals.map((r) => <ReversalRow key={r.event_id} r={r} busy={busy} act={act} />)}
            </ul>
          </section>
        </TabsContent>

        <TabsContent value="accounts"><Accounts act={act} busy={busy} /></TabsContent>
        <TabsContent value="offers"><Offers act={act} busy={busy} /></TabsContent>
        <TabsContent value="platform"><Platform act={act} busy={busy} /></TabsContent>
      </Tabs>
    </div>
  );
}

type Act = (key: string, run: () => Promise<{ error: { message: string } | null } | void>, done: string) => Promise<void>;

function IntentRow({ i, busy, act }: { i: AttentionIntent; busy: string | null; act: Act }) {
  const [start, setStart] = useState(today());
  const [reason, setReason] = useState("");
  return (
    <li className="border border-border p-4 text-sm" data-testid={`attention-${i.saff_reference}`}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-mono text-xs">{i.saff_reference}</span>
        <Badge variant="outline">{i.status}</Badge>
        <span>{i.plan_code} · {formatMoney(Number(i.amount_minor), i.currency_code, i.currency_exponent)} · {i.provider}{i.provider_environment === "sandbox" ? " (sandbox)" : ""}</span>
        <span className="text-muted-foreground">{i.owner_email ?? "—"} · {day(i.created_at)}</span>
      </div>
      <p className="mt-1 text-muted-foreground">{REASONS[i.reason ?? ""] ?? i.reason ?? "—"}{i.payment_recorded ? " · payment recorded" : ""}</p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => act(`check-${i.intent_id}`, async () => {
          const r = await requestPaymentVerificationRecovery(i.saff_reference);
          return r.error ? { error: { message: r.error } } : undefined;
        }, "Checked with the provider. The list shows the result.")}>Check with the provider</Button>
        <Input className="h-8 w-56" placeholder="Reason (recorded)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label={`Reason for ${i.saff_reference}`} />
        {i.payment_recorded && i.status === "MANUAL_REVIEW" && (
          <>
            <label className="text-xs">Term starts<Input type="date" className="h-8 w-40" value={start} onChange={(e) => setStart(e.target.value)} /></label>
            <Button size="sm" disabled={busy !== null || !reason.trim()} onClick={() => act(`place-${i.intent_id}`,
              () => rpc("admin_place_paid_licence", { p_checkout_intent_id: i.intent_id, p_effective_start: new Date(`${start}T00:00:00Z`).toISOString(), p_reason: reason.trim() }),
              `12-month term placed from ${start}.`)}>Place the paid 12-month term</Button>
          </>
        )}
        {!i.payment_recorded && i.status === "MANUAL_REVIEW" && (
          <Button size="sm" variant="destructive" disabled={busy !== null || !reason.trim()} onClick={() => {
            if (!window.confirm("Only confirm after the provider's own dashboard shows this attempt was NOT paid. Close it as uncharged?")) return;
            void act(`close-${i.intent_id}`, () => rpc("admin_resolve_manual_review_intent", { p_checkout_intent_id: i.intent_id, p_resolution: "CONFIRMED_UNCHARGED_CANCEL", p_reason: reason.trim() }), "Closed as uncharged. The customer can start a new payment.");
          }}>Close as uncharged</Button>
        )}
      </div>
    </li>
  );
}

function ReversalRow({ r, busy, act }: { r: Reversal; busy: string | null; act: Act }) {
  const [reason, setReason] = useState("");
  return (
    <li className="border border-border p-4 text-sm">
      <div className="flex flex-wrap gap-x-4">
        <Badge variant="outline">{r.reversal_type}</Badge>
        <span>{formatMoney(Number(r.amount_minor), (r.currency_code ?? "").toUpperCase(), r.currency_code === "TZS" ? 0 : 2)} · {r.provider}</span>
        <span className="text-muted-foreground">{r.owner_email ?? "—"} · {day(r.event_time)} · {r.saff_reference ?? ""}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input className="h-8 w-56" placeholder="Reason (recorded)" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason for the decision" />
        {(["LICENCE_ENDED", "LICENCE_KEPT"] as const).map((d) => (
          <Button key={d} size="sm" variant="outline" disabled={busy !== null || !reason.trim()} onClick={() => act(`rev-${r.event_id}`,
            () => rpc("admin_record_reversal_review", { p_reversal_event_id: r.event_id, p_decision: d, p_reason: reason.trim() }), "Decision recorded.")}>
            {d === "LICENCE_ENDED" ? "Record: licence ended" : "Record: licence kept"}
          </Button>
        ))}
      </div>
    </li>
  );
}

function Accounts({ act, busy }: { act: Act; busy: string | null }) {
  const [email, setEmail] = useState("");
  const [account, setAccount] = useState<Account | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [plan, setPlan] = useState("SOLO");
  const [start, setStart] = useState(today());
  const [end, setEnd] = useState(plusMonths(today(), 12));
  const [reason, setReason] = useState("");
  const [seats, setSeats] = useState<Record<string, string>>({});
  // One idempotency key per future-licence cancellation, generated once and reused on every retry of that request.
  const [cancelKeys] = useState<Record<string, string>>({});

  const find = async () => {
    setErr(null);
    const { data, error } = await rpc("admin_find_billing_account", { p_email: email.trim() });
    if (error) { setErr(error.message); return; }
    setAccount(data as Account);
  };
  const reload = () => (account?.email ? rpc("admin_find_billing_account", { p_email: account.email }).then(({ data }) => setAccount(data as Account)) : undefined);
  const wrap: Act = async (key, run, done) => { await act(key, run, done); await reload(); };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">Sign-in email<Input className="mt-1 w-72" type="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="admin-find-email" /></label>
        <Button onClick={find} disabled={!email.includes("@")} data-testid="admin-find">Find account</Button>
      </div>
      {err && <p className="text-sm text-destructive" role="alert">{err}</p>}
      {account && !account.found && <p className="text-sm text-muted-foreground">No account signs in with that email. The customer must create an account first.</p>}
      {account?.found && (
        <section className="space-y-4" data-testid="admin-account">
          <p className="text-sm"><strong>{account.email}</strong> · {account.companies} workspace{account.companies === 1 ? "" : "s"} · {account.billing_customer_id ? "billing record exists" : "no billing record yet"}</p>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-muted-foreground"><th className="py-1">Plan</th><th>Status</th><th>Source</th><th>Period</th><th>Extra users</th><th /></tr></thead>
            <tbody>
              {(account.licences ?? []).map((l) => {
                const future = new Date(l.effective_start).getTime() > Date.now();
                return (
                  <tr key={l.licence_id} className="border-t align-top">
                    <td className="py-2">{l.plan_code}</td><td>{l.status}</td><td className="text-xs">{l.source}</td>
                    <td>{day(l.effective_start)} – {l.effective_end ? day(l.effective_end) : "open-ended"}</td>
                    <td><Input className="h-8 w-20" type="number" min={0} value={seats[l.licence_id] ?? String(l.additional_seats ?? 0)} onChange={(e) => setSeats((s) => ({ ...s, [l.licence_id]: e.target.value }))} aria-label="Additional named users" /></td>
                    <td className="space-x-1 whitespace-nowrap">
                      <Button size="sm" variant="outline" disabled={busy !== null || !reason.trim()} onClick={() => wrap(`seats-${l.licence_id}`,
                        () => rpc("admin_set_licence_additional_seats", { p_licence_id: l.licence_id, p_quantity: Number(seats[l.licence_id] ?? l.additional_seats ?? 0), p_reason: reason.trim() }), "Additional named users updated.")}>Save users</Button>
                      {["ACTIVE", "GRACE", "PENDING"].includes(l.status) && (future
                        ? <Button size="sm" variant="outline" disabled={busy !== null || !/^[A-Z][A-Z0-9_]{2,127}$/.test(reason.trim())} title="Reason must be an UPPER_SNAKE code, e.g. CUSTOMER_REQUEST"
                            onClick={() => { cancelKeys[l.licence_id] ??= crypto.randomUUID(); void wrap(`cancel-${l.licence_id}`, async () => {
                              const { data, error } = await rpc("admin_cancel_future_licence", { p_licence_id: l.licence_id, p_reason: reason.trim(), p_idempotency_key: cancelKeys[l.licence_id] });
                              const outcome = (data as { outcome?: string } | null)?.outcome;
                              return error ? { error } : outcome === "cancelled" || outcome === "already_cancelled" ? undefined : { error: { message: `Not cancelled: ${outcome}` } };
                            }, "Licence cancelled before it started."); }}>Cancel (not started)</Button>
                        : <Button size="sm" variant="outline" disabled={busy !== null || !reason.trim()} onClick={() => { if (window.confirm("End this licence now? Access under it stops immediately.")) void wrap(`end-${l.licence_id}`,
                            () => rpc("admin_transition_licence_status", { p_licence_id: l.licence_id, p_new_status: "EXPIRED", p_reason: reason.trim() }), "Licence ended."); }}>End now</Button>)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <fieldset className="space-y-3 border border-border p-4">
            <legend className="px-1 text-sm font-medium">Manual activation (by agreement)</legend>
            <p className="text-xs text-muted-foreground">For a customer who agreed terms with us. A paid term is never shortened: start on or after its end.</p>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm">Plan<select className="mt-1 block h-9 border bg-background px-2" value={plan} onChange={(e) => setPlan(e.target.value)}>{["SOLO", "PRACTICE", "FIRM", "ENTERPRISE"].map((p) => <option key={p}>{p}</option>)}</select></label>
              <label className="text-sm">Starts<Input className="mt-1 w-40" type="date" value={start} onChange={(e) => { setStart(e.target.value); setEnd(plusMonths(e.target.value, 12)); }} /></label>
              <label className="text-sm">Ends<Input className="mt-1 w-40" type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></label>
            </div>
            <Button disabled={busy !== null || !reason.trim() || !end} data-testid="admin-activate" onClick={() => wrap("activate", async () => {
              if (!account.billing_customer_id) {
                const e1 = await rpc("admin_ensure_billing_customer", { p_owner_user_id: account.owner_user_id, p_reason: reason.trim() });
                if (e1.error) return e1;
              }
              const fresh = (await rpc("admin_find_billing_account", { p_email: account.email })).data as Account;
              return rpc("admin_grant_commercial_licence", { p_billing_customer_id: fresh.billing_customer_id, p_plan_code: plan,
                p_effective_start: new Date(`${start}T00:00:00Z`).toISOString(), p_effective_end: new Date(`${end}T00:00:00Z`).toISOString(), p_reason: reason.trim() });
            }, `${plan} activated from ${start} to ${end}.`)}>Activate the plan</Button>
          </fieldset>
          <label className="block text-sm">Reason for any change on this account (recorded in the audit log)<Input className="mt-1" value={reason} onChange={(e) => setReason(e.target.value)} data-testid="admin-reason" /></label>
        </section>
      )}
    </div>
  );
}

interface OfferRow { id: string; offer_code: string; plan_code: string; market_code: string; currency_code: string; amount_minor: number; currency_exponent: number; billing_interval: string; billing_interval_count: number; is_active: boolean; is_purchasable: boolean }

function Offers({ act, busy }: { act: Act; busy: string | null }) {
  const [offers, setOffers] = useState<OfferRow[] | null>(null);
  const [form, setForm] = useState({ plan: "SOLO", market: "TZ", currency: "TZS", amount: "", exponent: "0" });
  const [reason, setReason] = useState("");
  const load = useCallback(async () => { const { data } = await callCommercialRpc("admin_list_commercial_offers", {}); setOffers((data ?? []) as OfferRow[]); }, []);
  useEffect(() => { void load(); }, [load]);
  const save = (o: { code: string; plan: string; market: string; currency: string; amount: number; exponent: number; purchasable: boolean; active?: boolean }) =>
    act(`offer-${o.code}`, async () => {
      const r = await callCommercialRpc("admin_upsert_commercial_offer", { p_offer_code: o.code, p_plan_code: o.plan, p_market_code: o.market, p_currency_code: o.currency,
        p_amount_minor: o.amount, p_currency_exponent: o.exponent, p_billing_interval: "ANNUAL", p_billing_interval_count: 1, p_is_active: o.active ?? true,
        p_is_purchasable: o.purchasable, p_reason: reason.trim() });
      await load();
      return r.error ? { error: { message: r.error.message } } : undefined;
    }, "Price saved.");
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">An annual offer marked purchasable is an approved price: the public pages show it, and checkout charges exactly it once online payment is open. Every change is recorded with its reason; existing orders keep the price they were created with.</p>
      <label className="block text-sm">Reason (recorded)<Input className="mt-1 max-w-md" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-muted-foreground"><th>Offer</th><th>Plan</th><th>Market</th><th>Price</th><th>Term</th><th>Approved (purchasable)</th><th /></tr></thead>
        <tbody>
          {(offers ?? []).filter((o) => o.is_active).map((o) => (
            <tr key={o.id} className="border-t">
              <td className="py-2 font-mono text-xs">{o.offer_code}</td><td>{o.plan_code}</td><td>{o.market_code}</td>
              <td>{formatMoney(Number(o.amount_minor), o.currency_code, o.currency_exponent)}</td><td>{o.billing_interval}</td>
              <td><Badge variant={o.is_purchasable ? "default" : "secondary"}>{o.is_purchasable ? "Yes" : "No"}</Badge></td>
              <td><Button size="sm" variant="outline" disabled={busy !== null || !reason.trim()} onClick={() => {
                if (!o.is_purchasable && !window.confirm(`Approve ${formatMoney(Number(o.amount_minor), o.currency_code, o.currency_exponent)} per year for ${o.plan_code} (${o.market_code})? It becomes the public price and what checkout charges.`)) return;
                void save({ code: o.offer_code, plan: o.plan_code, market: o.market_code, currency: o.currency_code, amount: Number(o.amount_minor), exponent: o.currency_exponent, purchasable: !o.is_purchasable });
              }}>{o.is_purchasable ? "Withdraw" : "Approve"}</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <fieldset className="space-y-3 border border-border p-4">
        <legend className="px-1 text-sm font-medium">Add an annual price for another market (for example TZS for mobile money)</legend>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">Plan<select className="mt-1 block h-9 border bg-background px-2" value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })}>{["SOLO", "PRACTICE", "FIRM"].map((p) => <option key={p}>{p}</option>)}</select></label>
          <label className="text-sm">Market<select className="mt-1 block h-9 border bg-background px-2" value={form.market} onChange={(e) => setForm({ ...form, market: e.target.value, currency: e.target.value === "TZ" ? "TZS" : "USD", exponent: e.target.value === "TZ" ? "0" : "2" })}><option>TZ</option><option>GLOBAL</option></select></label>
          <label className="text-sm">Amount per year ({form.currency}{form.exponent === "2" ? ", in cents" : ""})<Input className="mt-1 w-40" type="number" min={1} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
        </div>
        <Button size="sm" disabled={busy !== null || !reason.trim() || !(Number(form.amount) > 0)} onClick={() => save({ code: `CFOCLOSE_${form.plan}_${form.market}_${form.currency}_ANNUAL`, plan: form.plan, market: form.market,
          currency: form.currency, amount: Number(form.amount), exponent: Number(form.exponent), purchasable: false })}>Save (not yet approved)</Button>
      </fieldset>
    </div>
  );
}

function Platform({ act, busy }: { act: Act; busy: string | null }) {
  const [state, setState] = useState<{ platform: string | null; routes: string[] } | null>(null);
  const [target, setTarget] = useState("SANDBOX_ONLY");
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const load = useCallback(async () => {
    const { data } = await getCheckoutOptions("SOLO");
    setState(data ? { platform: data.platformState, routes: data.options.filter((o) => o.provider).map((o) => `${o.paymentRoute === "CARD" ? "Card" : "Mobile money"}: ${o.provider} (${o.environment}${o.available ? "" : `, ${o.reason}`})`) } : { platform: null, routes: [] });
  }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <div className="space-y-4 text-sm">
      <p>Online payment state: <strong data-testid="platform-state">{state?.platform ?? "unknown"}</strong></p>
      <p className="text-muted-foreground">Configured payment routes (from the server): {state?.routes.length ? state.routes.join(" · ") : "none — no provider has its complete settings, or no purchasable price exists"}</p>
      <div className="flex items-start gap-2 border border-amber-500 p-3 text-amber-900"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />Opening payments to customers is an owner decision. Follow the launch checklist: sandbox first, then live acceptance with allow-listed testers, then customers.</div>
      <div className="flex flex-wrap items-end gap-3">
        <label>New state<select className="mt-1 block h-9 border bg-background px-2" value={target} onChange={(e) => setTarget(e.target.value)}>{["PAYMENTS_DISABLED", "SANDBOX_ONLY", "LIVE_ACCEPTANCE", "CUSTOMER_PAYMENTS_ENABLED"].map((s) => <option key={s}>{s}</option>)}</select></label>
        <label>Type the state to confirm<Input className="mt-1 w-64" value={typed} onChange={(e) => setTyped(e.target.value)} /></label>
        <label>Reason (recorded)<Input className="mt-1 w-64" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <Button disabled={busy !== null || typed !== target || !reason.trim()} onClick={() => act("platform", async () => {
          const r = await rpc("admin_transition_platform_state", { p_new_state: target, p_reason: reason.trim() });
          await load();
          return r;
        }, `Online payment state is now ${target}.`)}>Change state</Button>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center px-4">{children}</div>;
}
