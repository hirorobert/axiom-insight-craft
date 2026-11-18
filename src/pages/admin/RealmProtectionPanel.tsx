/**
 * Platform-owner maintenance control for the one-off QuickBooks company-ID (realmID) encryption backfill (Intuit case 00232331;
 * docs/release/qbo-realm-protection-r1/README.md), and the token-key rotation (20261230400000: "Check keys" is read only; "Move to new key"
 * re-seals live rows onto QBO_TOKEN_KEY_NEXT_*). It only asks the qbo-realm-protect Edge Function to run one of its four fixed actions with
 * the signed-in session; the function and the database decide authority (an active platform owner) and do all the work. Nothing here sees a
 * company ID, an envelope or a key: the answer is counts only. Shown only inside the platform-owner rehearsal page; showing it confers nothing.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";

export type MaintenanceAction = "protect" | "verify" | "keys" | "reseal";
type Tally = { total?: number; protected?: number; already?: number; verified?: number; unprotected?: number; mismatched?: number; refused?: number };
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
type KeyTally = { total?: number; byKey?: Record<string, unknown>; resealed?: number; already?: number; none?: number; stale?: number; busy?: number; unreadable?: number; mismatched?: number; refused?: number };
const KEY_ID = /^[a-z0-9-]{1,32}$/;
const byKey = (t: KeyTally) => {
  const parts = Object.entries(t.byKey ?? {}).filter(([k]) => KEY_ID.test(k)).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}: ${n(v)}`);
  return parts.length ? parts.join(", ") : "none";
};
const keyProblems = (t: KeyTally) => n(t.unreadable) + n(t.mismatched) + n(t.refused) + n(t.stale) + n(t.busy);

/** Plain-language result for one run, from the function's status and counts-only answer. Never assumes success. */
export function describeMaintenanceAnswer(action: MaintenanceAction, status: number | null, body: unknown): { ok: boolean; text: string } {
  const b = (body && typeof body === "object" ? body : {}) as { outcome?: unknown; connections?: Tally; operations?: Tally };
  if (status === 401) return { ok: false, text: "Your session has expired. Sign in again; nothing was changed." };
  if (status === 403) return { ok: false, text: "Only the platform owner can run this. Nothing was changed." };
  if (status === 503 && b.outcome === "not_configured") return { ok: false, text: "The encryption keys are not configured on the server yet. Nothing was changed." };
  if (status === 503 && action === "reseal" && b.outcome === "unavailable") return { ok: false, text: "The key move is not installed on the server yet, or your access could not be checked. Nothing was changed." };
  if (status === 503) return { ok: false, text: "Your access could not be checked right now. Nothing was changed; try again." };
  const k = (body && typeof body === "object" ? body : {}) as { currentKeyId?: unknown; connectionRealms?: KeyTally; refreshTokens?: KeyTally; operationRealms?: KeyTally };
  if ((action === "keys" || action === "reseal") && (status === 200 || status === 409) && k.connectionRealms && k.refreshTokens && k.operationRealms) {
    const c = k.connectionRealms, t = k.refreshTokens, o = k.operationRealms;
    const current = typeof k.currentKeyId === "string" && KEY_ID.test(k.currentKeyId) ? k.currentKeyId : "unknown";
    const problems = keyProblems(c) + keyProblems(t) + keyProblems(o);
    const head = action === "keys"
      ? `Sealing key: ${current}. Connections: ${n(c.total)} company IDs readable by key (${byKey(c)}); ${n(t.total) - n(t.none)} sign-in tokens readable by key (${byKey(t)}). Disconnect records: ${n(o.total)} readable by key (${byKey(o)}).`
      : `Moved to ${current}: connections ${n(c.resealed)} now, ${n(c.already)} already; sign-in tokens ${n(t.resealed)} now, ${n(t.already)} already; disconnect records ${n(o.resealed)} now, ${n(o.already)} already.`;
    if (status === 200 && b.outcome === "complete" && problems === 0) return { ok: true, text: `${action === "keys" ? "Key check" : "Move to new key"} complete. ${head}` };
    return { ok: false, text: `Not complete: ${problems} record(s) need attention. ${head} Finished records stay finished; run it again, and if the count does not fall, stop and investigate.` };
  }
  if ((status === 200 || status === 409) && b.connections && b.operations) {
    const c = b.connections, o = b.operations;
    const problems = n(c.unprotected) + n(c.mismatched) + n(c.refused) + n(o.unprotected) + n(o.mismatched) + n(o.refused);
    const head = action === "protect"
      ? `Connections: ${n(c.protected)} encrypted now, ${n(c.already)} already encrypted (of ${n(c.total)}). Disconnect records: ${n(o.protected)} encrypted now, ${n(o.already)} already encrypted (of ${n(o.total)}).`
      : `Connections: ${n(c.verified)} of ${n(c.total)} checked. Disconnect records: ${n(o.verified)} of ${n(o.total)} checked.`;
    if (status === 200 && b.outcome === "complete" && problems === 0) return { ok: true, text: `${action === "protect" ? "Encryption" : "Check"} complete. ${head}` };
    return { ok: false, text: `Not complete: ${problems} record(s) need attention. ${head} Finished records stay finished; run it again, and if the count does not fall, stop and investigate.` };
  }
  return { ok: false, text: "The run did not finish. Records already finished stay finished; run it again." };
}

async function invoke(action: MaintenanceAction): Promise<{ status: number | null; body: unknown }> {
  const { supabase } = await import("@/integrations/supabase/client");
  const res = await supabase.functions.invoke("qbo-realm-protect", { body: { action } });
  if (!res.error) return { status: 200, body: res.data };
  const ctx = (res.error as { context?: { status?: unknown; json?: () => Promise<unknown> } }).context;
  const status = typeof ctx?.status === "number" ? ctx.status : null;
  const body = await ctx?.json?.().catch(() => null);
  return { status, body: body ?? null };
}

export default function RealmProtectionPanel({ run = invoke }: { run?: (action: MaintenanceAction) => Promise<{ status: number | null; body: unknown }> } = {}) {
  const [busy, setBusy] = useState<MaintenanceAction | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const go = async (action: MaintenanceAction) => {
    if (busy) return;
    setBusy(action); setResult(null);
    try { const r = await run(action); setResult(describeMaintenanceAnswer(action, r.status, r.body)); }
    catch { setResult(describeMaintenanceAnswer(action, null, null)); }
    finally { setBusy(null); }
  };
  return <section className="space-y-3 rounded border border-border p-4" aria-labelledby="realm-protection-heading">
    <h2 id="realm-protection-heading" className="text-lg font-semibold">Stored QuickBooks company IDs</h2>
    <p>Encrypts the QuickBooks company ID kept for each existing connection, then checks every encrypted copy. Run "Encrypt" first, then "Check". Both are safe to repeat and show counts only.</p>
    <div className="flex flex-wrap gap-2">
      <Button onClick={() => void go("protect")} disabled={busy !== null}>{busy === "protect" ? "Encrypting…" : "Encrypt stored company IDs"}</Button>
      <Button variant="outline" onClick={() => void go("verify")} disabled={busy !== null}>{busy === "verify" ? "Checking…" : "Check encryption"}</Button>
    </div>
    <p>Key rotation: "Check keys" only reads, and shows which key each stored item needs. "Move to new key" re-encrypts live items with the new key once it is configured; it is safe to repeat.</p>
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => void go("keys")} disabled={busy !== null}>{busy === "keys" ? "Checking keys…" : "Check keys"}</Button>
      <Button variant="outline" onClick={() => void go("reseal")} disabled={busy !== null}>{busy === "reseal" ? "Moving…" : "Move to new key"}</Button>
    </div>
    {result && <p role={result.ok ? "status" : "alert"}>{result.text}</p>}
  </section>;
}
