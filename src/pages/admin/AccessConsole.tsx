/**
 * Administration → Access (directive §14). A minimalist console for the platform owner / commercial administrators:
 *   • Roles → permissions (the operational capability template — distinct from purchased entitlements).
 *   • Accounts & allowances (entity capacity + complimentary/admin grants — distinct from role permissions).
 *   • Grant & revoke history (the append-only ledger).
 *   • Delegate access (scoped complimentary capability / entity allowance), gated by recent reauthentication.
 *
 * The server decides who may read or write (an active commercial_admins row; platform-owner-only for grants). Owning a
 * company confers nothing here. Platform-owner GRANT/REVOKE is deliberately NOT exposed in this general console —
 * ordinary administrators must never escalate to platform-owner through an access-management screen.
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, ShieldCheck, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { callAccessRpc } from "@/lib/access/accessRpc";
import { useOwnerAccess, type AccessAccount } from "@/hooks/useOwnerAccess";
import { useReauthenticate } from "@/hooks/useReauthenticate";

const short = (id: string) => (id ? `${id.slice(0, 8)}…` : "—");
const RELEASED_CAPS = ["STATEMENT_CERTIFICATION", "REPORTING_PACK_EXPORT", "CLOSE_INSIGHTS", "CLOSE_ASSURANCE", "COMPARATIVE_REPORTING"];

function entityCapacityLabel(a: AccessAccount): string {
  const c = a.entity_capacity;
  if (c.unlimited) return "Unlimited";
  if (c.determined && c.capacity !== null) return String(c.capacity);
  return "Unavailable";
}

export default function AccessConsole({ defaultTab = "roles" }: { defaultTab?: string } = {}) {
  const { allowed, loading, matrix, accounts, history, error, reload } = useOwnerAccess();
  const { reauth, busy: reauthBusy } = useReauthenticate();

  // Delegate-access form + reauth prompt state.
  const [recipient, setRecipient] = useState("");
  const [kind, setKind] = useState<"capability" | "entity" | "unlimited">("capability");
  const [capability, setCapability] = useState(RELEASED_CAPS[0]);
  const [entityCount, setEntityCount] = useState("5");
  const [reason, setReason] = useState("");
  const [password, setPassword] = useState("");
  const [showReauth, setShowReauth] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const submitGrant = async () => {
    setMsg(null);
    setWorking(true);
    try {
      const r = await reauth(password);
      setPassword("");
      if ("error" in r) { setMsg(r.error); return; }
      const nonce = r.nonce;
      let res;
      if (kind === "capability") {
        res = await callAccessRpc("owner_grant_complimentary_access", { p_recipient_user_id: recipient.trim(), p_capability: capability, p_reason: reason.trim(), p_effective_end: null, p_reauth_nonce: nonce });
      } else {
        const unlimited = kind === "unlimited";
        res = await callAccessRpc("owner_grant_entity_allowance", { p_recipient_user_id: recipient.trim(), p_capacity: unlimited ? null : Number(entityCount), p_unlimited: unlimited, p_reason: reason.trim(), p_effective_end: null, p_reauth_nonce: nonce });
      }
      if (res.error) { setMsg(res.error.message); return; }
      setMsg("Access granted (complimentary — no payment recorded).");
      setShowReauth(false);
      setReason("");
      await reload();
    } finally {
      setWorking(false);
    }
  };

  const revoke = async (overrideId: string) => {
    const pw = window.prompt("Confirm your password to revoke this grant:");
    if (!pw) return;
    const r = await reauth(pw);
    if ("error" in r) { setMsg(r.error); return; }
    const res = await callAccessRpc("revoke_access_grant", { p_override_id: overrideId, p_reason: "revoked from Access console", p_reauth_nonce: r.nonce });
    setMsg(res.error ? res.error.message : "Grant revoked (effective immediately).");
    await reload();
  };

  if (loading) return <div className="min-h-screen bg-background p-8"><Skeleton className="h-8 w-64" /><Skeleton className="mt-4 h-48 w-full max-w-4xl" /></div>;
  if (allowed === false) return (
    <div className="min-h-screen bg-background flex items-center justify-center p-8">
      <Alert className="max-w-md"><ShieldAlert className="h-4 w-4" /><AlertDescription>You don’t have access to the Access administration console. <Link to="/dashboard" className="text-primary underline">Return</Link></AlertDescription></Alert>
    </div>
  );
  if (allowed === null) return (
    <div className="min-h-screen bg-background flex items-center justify-center p-8">
      <Alert className="max-w-md"><AlertDescription>{error ?? "Access administration is temporarily unavailable."} <Button variant="link" className="px-1" onClick={() => void reload()}>Retry</Button></AlertDescription></Alert>
    </div>
  );

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-5xl px-6 py-8">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-5">
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-6 w-6 text-primary" aria-hidden />
            <div>
              <h1 className="text-2xl font-semibold text-foreground">Access administration</h1>
              <p className="text-sm text-muted-foreground">Roles, entitlements, entity allowances and grant history — kept distinct and audited.</p>
            </div>
          </div>
          <Button variant="outline" size="sm" asChild><Link to="/settings">Settings</Link></Button>
        </header>

        {msg && <Alert className="mt-4"><AlertDescription>{msg}</AlertDescription></Alert>}

        <Tabs defaultValue={defaultTab} className="mt-6">
          <TabsList>
            <TabsTrigger value="roles">Roles → permissions</TabsTrigger>
            <TabsTrigger value="accounts">Accounts &amp; allowances</TabsTrigger>
            <TabsTrigger value="history">Grant history</TabsTrigger>
            <TabsTrigger value="delegate">Delegate access</TabsTrigger>
          </TabsList>

          {/* Role permissions — the operational capability template. Distinct from purchased service entitlements. */}
          <TabsContent value="roles" className="mt-4">
            <p className="mb-3 text-sm text-muted-foreground">Operational workspace permissions by role (the starting template; each member’s stored capabilities are authoritative). These are separate from purchased service entitlements and from entity capacity.</p>
            {matrix && (
              <div className="overflow-x-auto rounded-sm border border-border">
                <Table>
                  <TableHeader><TableRow><TableHead>Role</TableHead>{matrix.capabilities.map((c) => <TableHead key={c} className="text-center text-xs">{c.replace(/_/g, " ")}</TableHead>)}</TableRow></TableHeader>
                  <TableBody>
                    {Object.entries(matrix.roles).map(([role, caps]) => (
                      <TableRow key={role}>
                        <TableCell className="font-medium capitalize">{role}</TableCell>
                        {matrix.capabilities.map((c) => <TableCell key={c} className="text-center">{caps.includes(c) ? <span className="text-primary" aria-label="granted">●</span> : <span className="text-border" aria-label="not granted">—</span>}</TableCell>)}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          {/* Accounts: entity capacity + complimentary/admin grants. Entity capacity is distinct from role permissions. */}
          <TabsContent value="accounts" className="mt-4">
            <div className="overflow-x-auto rounded-sm border border-border">
              <Table>
                <TableHeader><TableRow><TableHead>Account (owner)</TableHead><TableHead>Platform owner</TableHead><TableHead>Entity capacity</TableHead><TableHead>Capacity source</TableHead><TableHead>Complimentary / admin grants</TableHead></TableRow></TableHeader>
                <TableBody>
                  {accounts.map((a) => (
                    <TableRow key={a.billing_customer_id}>
                      <TableCell className="font-mono text-xs">{short(a.owner_user_id)}</TableCell>
                      <TableCell>{a.is_platform_owner ? <Badge>Platform owner</Badge> : <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell className="font-medium">{entityCapacityLabel(a)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{a.entity_capacity.source ?? "—"}</TableCell>
                      <TableCell>
                        {a.active_overrides.length === 0 ? <span className="text-muted-foreground">—</span> : (
                          <ul className="space-y-1">
                            {a.active_overrides.map((o) => (
                              <li key={o.id} className="flex items-center gap-2 text-xs">
                                <span>{o.feature_code}{o.unlimited ? " · unlimited" : o.capacity_value !== null ? ` · ${o.capacity_value}` : ""}</span>
                                <Button variant="link" className="h-auto px-1 py-0 text-xs" onClick={() => void revoke(o.id)}>revoke</Button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {accounts.length === 0 && <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground">No accounts.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          <TabsContent value="history" className="mt-4">
            <div className="overflow-x-auto rounded-sm border border-border">
              <Table>
                <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Action</TableHead><TableHead>Recipient</TableHead><TableHead>Capability</TableHead><TableHead>Source</TableHead><TableHead>Actor</TableHead><TableHead>Reason</TableHead></TableRow></TableHeader>
                <TableBody>
                  {history.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{e.created_at?.slice(0, 19).replace("T", " ")}</TableCell>
                      <TableCell className="text-xs">{e.grant_kind}</TableCell>
                      <TableCell className="font-mono text-xs">{short(e.recipient_user_id)}</TableCell>
                      <TableCell className="text-xs">{e.capability ?? "—"}</TableCell>
                      <TableCell className="text-xs">{e.source}</TableCell>
                      <TableCell className="font-mono text-xs">{short(e.actor_user_id)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{e.reason}</TableCell>
                    </TableRow>
                  ))}
                  {history.length === 0 && <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground">No grants recorded.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          {/* Delegate scoped complimentary access / entity allowance. Never fabricates a payment. Reauth required. */}
          <TabsContent value="delegate" className="mt-4">
            <div className="max-w-xl space-y-4 rounded-sm border border-border p-5">
              <p className="text-sm text-muted-foreground">Grant a user scoped <strong>complimentary</strong> access or an entity allowance. No payment, subscription or revenue is recorded. A privileged grant requires confirming your password (recent reauthentication).</p>
              <div className="space-y-2"><Label htmlFor="rcpt">Recipient auth user ID</Label><Input id="rcpt" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="UUID of the user" /></div>
              <div className="space-y-2">
                <Label>Grant</Label>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant={kind === "capability" ? "default" : "outline"} size="sm" onClick={() => setKind("capability")}>Released capability</Button>
                  <Button type="button" variant={kind === "entity" ? "default" : "outline"} size="sm" onClick={() => setKind("entity")}>Entity allowance (number)</Button>
                  <Button type="button" variant={kind === "unlimited" ? "default" : "outline"} size="sm" onClick={() => setKind("unlimited")}>Unlimited entities</Button>
                </div>
              </div>
              {kind === "capability" && <div className="space-y-2"><Label htmlFor="cap">Capability</Label><select id="cap" className="h-10 w-full rounded-sm border border-input bg-background px-3 text-sm" value={capability} onChange={(e) => setCapability(e.target.value)}>{RELEASED_CAPS.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}</select></div>}
              {kind === "entity" && <div className="space-y-2"><Label htmlFor="cnt">Active entities</Label><Input id="cnt" type="number" min={1} value={entityCount} onChange={(e) => setEntityCount(e.target.value)} /></div>}
              <div className="space-y-2"><Label htmlFor="rsn">Reason (recorded)</Label><Input id="rsn" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this grant" /></div>
              <Button disabled={!recipient.trim() || !reason.trim() || working} onClick={() => { setMsg(null); setShowReauth(true); }}>Grant access</Button>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <Dialog open={showReauth} onOpenChange={setShowReauth}>
        <DialogContent>
          <DialogHeader><DialogTitle>Confirm it’s you</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">Privileged access changes require confirming your password. It is verified once and never stored.</p>
          <div className="space-y-2"><Label htmlFor="pw">Password</Label><Input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowReauth(false); setPassword(""); }}>Cancel</Button>
            <Button disabled={!password || working || reauthBusy} onClick={() => void submitGrant()}>{working || reauthBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Confirm & grant"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
