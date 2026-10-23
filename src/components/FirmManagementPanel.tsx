import { useManagementEditGuard } from "@/components/account/managementState";
import { useBusyState } from "@/hooks/useBusyState";
import { useActivity } from "@/components/feedback/useActivity";
// ============================================================
// FirmManagementPanel — Firm Management (Roadmap Item 8)
//
// Shows all firm_members rows for companies the current user owns.
// Actions:
//   • Invite new member (email + role) → invite-firm-member edge fn
//   • Change role of existing member (preparer ↔ partner ↔ viewer)
//   • Remove member (triggers enforce owner-safety)
//
// Acceptance flow:
//   Pending members have accepted_at = null. When an invited user
//   signs in, Dashboard.tsx accepts through accept_workspace_invitations.
//
// Named-user seats (20260925100000; unlimited on Solo, Practice and Firm since 20261110100000): every plan includes one named user;
// Practice and Firm add purchased seats. A pending invitation holds a seat.
// The database seat wall decides; this panel shows the structured state
// (get_workspace_seat_capacity) and never offers an invitation that the
// server would refuse. Each person has their own sign-in.
//
// Role definitions:
//   owner   — full access, cannot be removed via UI (DB trigger enforces)
//   partner — all read + sign-off access
//   preparer — read + data entry, no sign-off
//   viewer  — read-only (findings, reports, PDF export)
// ============================================================

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader,
  DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Users, UserPlus, RefreshCw, Clock, CheckCircle,
  Trash2, Building2, Crown, Shield,
} from "lucide-react";
import { toast } from "sonner";
import { describeInvitationCapabilities } from "@/lib/auth/workspaceCapabilities";
import { PaidActionNotice } from "@/components/commercial/PaidActionNotice";
import {
  canInviteAnother,
  functionSeatRefusal,
  parseNamedUserRoster,
  parseSeatCapacity,
  parseSelectionOutcome,
  seatCopy,
  selectableSeats,
  type NamedUserRoster,
  type SeatCapacityState,
} from "@/lib/commercial/paidActions";

// ── Types ─────────────────────────────────────────────────────

type MemberRole = "owner" | "partner" | "preparer" | "viewer";

interface Company {
  id: string;
  name: string;
  tin: string | null;
}

interface FirmMember {
  id: string;
  companyId: string;
  userId: string;
  role: MemberRole;
  invitedBy: string | null;
  invitedEmail: string | null;
  acceptedAt: string | null;
  invitationExpiresAt: string | null;
  invitationCancelledAt: string | null;
  createdAt: string;
  displayName?: string;
  email?: string;
}

// ── Helpers ───────────────────────────────────────────────────

const ROLE_LABELS: Record<MemberRole, string> = {
  owner:    "Owner",
  partner:  "Partner",
  preparer: "Preparer",
  viewer:   "Viewer",
};

const ROLE_COLORS: Record<MemberRole, string> = {
  owner:    "bg-[#0E1D30]/10 text-[#0E1D30] border-[#0E1D30]/30",
  partner:  "bg-primary/10 text-primary border-primary/30",
  preparer: "bg-blue-500/10 text-blue-700 border-blue-500/30",
  viewer:   "bg-secondary text-muted-foreground border-border",
};

const ROLE_DESCRIPTIONS: Record<MemberRole, string> = {
  owner:    "Full access. Cannot be removed.",
  partner:  "All read access + sign-off workflow.",
  preparer: "Read + data entry. No sign-off.",
  viewer:   "Read-only. Can download PDF reports.",
};

// ── Component ─────────────────────────────────────────────────

export function FirmManagementPanel() {
  const { user } = useAuth();
  const [companies, setCompanies]       = useState<Company[]>([]);
  const [members, setMembers]           = useState<FirmMember[]>([]);
  const [selectedCompany, setSelected]  = useState<string>("");
  const [changing, setChanging] = useBusyState("Updating team access…");
  const [loading, setLoading]           = useState(true);
  const [showInvite, setShowInvite]     = useState(false);
  const [discardInvite, setDiscardInvite] = useState(false);
  const [pendingCompany, setPendingCompany] = useState<string | null>(null);
  const [inviting, setInviting]         = useBusyState("Sending invitation…");
  const [removing, setRemoving]         = useState<string | null>(null);
  const [inviteForm, setInviteForm]     = useState({ email: "", role: "preparer" as MemberRole });
  const [seats, setSeats]               = useState<SeatCapacityState | null>(null);
  const [seatsLoaded, setSeatsLoaded]   = useState(false);
  const [roster, setRoster]             = useState<NamedUserRoster | null>(null);
  const [selection, setSelection]       = useState<string[]>([]);
  const [applying, setApplying]         = useBusyState("Updating active team members…");

  // The account holder's roster: who is active, suspended or pending. Only the account holder can read it, and only
  // their explicit selection ever reactivates anyone (choose_active_named_users).
  const fetchRoster = async () => {
    const { data, error } = await supabase.rpc("get_named_user_roster" as never);
    const parsed = error ? null : parseNamedUserRoster(data);
    setRoster(parsed);
    setSelection(parsed ? parsed.people.filter((p) => p.state === "active_candidate").map((p) => p.userId) : []);
  };

  // Named-user seats of the selected workspace's account (explanatory; the server decides).
  const fetchSeats = async (companyId: string) => {
    if (!companyId) return;
    setSeatsLoaded(false);
    const { data, error } = await supabase.rpc("get_workspace_seat_capacity" as never, { p_company_id: companyId } as never);
    const parsed = error ? null : parseSeatCapacity(data);
    setSeats(parsed);
    setSeatsLoaded(true);
    if (parsed?.isAccountHolder) await fetchRoster(); else setRoster(null);
  };

  // Fetch companies the user owns
  const fetchOwned = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const { data: memberRows, error } = await supabase
        .from("firm_members")
        .select("company_id")
        .eq("user_id", user.id)
        .eq("role", "owner");
      if (error) throw error;

      if (!memberRows?.length) {
        setCompanies([]);
        setLoading(false);
        return;
      }

      const ids = memberRows.map((r) => r.company_id);
      const { data: cos } = await supabase
        .from("companies")
        .select("id, name, tin")
        .in("id", ids)
        .eq("is_active", true)
        .order("name");

      const coList = (cos ?? []) as Company[];
      setCompanies(coList);
      if (coList.length > 0 && !selectedCompany) {
        setSelected(coList[0].id);
      }
    } catch (err) {
      console.error("FirmManagementPanel fetch error:", err);
      toast.error("Failed to load companies");
    } finally {
      setLoading(false);
    }
  };

  // Fetch members for the selected company
  const fetchMembers = async (companyId: string) => {
    if (!companyId) return;
    try {
      const { data: rows, error } = await supabase
        .from("firm_members")
        .select("id, company_id, user_id, role, invited_by, invited_email, accepted_at, invitation_expires_at, invitation_cancelled_at, created_at" as "*")
        .eq("company_id", companyId)
        .order("created_at", { ascending: true });
      if (error) throw error;

      // Fetch display names from profiles
      const userIds = (rows ?? []).map((r) => r.user_id);
      const { data: profiles } = userIds.length
        ? await supabase
            .from("profiles")
            .select("user_id, display_name")
            .in("user_id", userIds)
        : { data: [] };

      const profileMap = new Map((profiles ?? []).map((p) => [p.user_id, p.display_name]));

      // invitation_* columns come from 20260925110000 (not yet in the generated client types).
      const enriched: FirmMember[] = ((rows ?? []) as unknown as Array<{
        id: string; company_id: string; user_id: string; role: string; invited_by: string | null; invited_email: string | null;
        accepted_at: string | null; invitation_expires_at: string | null; invitation_cancelled_at: string | null; created_at: string;
      }>).map((r) => ({
        id:           r.id,
        companyId:    r.company_id,
        userId:       r.user_id,
        role:         r.role as MemberRole,
        invitedBy:    r.invited_by,
        invitedEmail: r.invited_email,
        acceptedAt:   r.accepted_at,
        invitationExpiresAt:   r.invitation_expires_at,
        invitationCancelledAt: r.invitation_cancelled_at,
        createdAt:    r.created_at,
        displayName:  profileMap.get(r.user_id) ?? undefined,
        email:        r.invited_email ?? undefined,
      }));

      setMembers(enriched);
    } catch (err) {
      console.error("fetchMembers error:", err);
      toast.error("Failed to load members");
    }
  };

  useEffect(() => { fetchOwned(); }, [user]);
  useEffect(() => { if (selectedCompany) { fetchMembers(selectedCompany); fetchSeats(selectedCompany); } }, [selectedCompany]);

  // ── Invite ────────────────────────────────────────────────────

  const handleInvite = async () => {
    if (!inviteForm.email.trim() || !selectedCompany) return;
    if (!setInviting(true)) return;
    try {
      const { data, error } = await supabase.functions.invoke("invite-firm-member", {
        body: {
          email:      inviteForm.email.trim().toLowerCase(),
          company_id: selectedCompany,
          role:       inviteForm.role,
        },
      });

      if (error) {
        const seatRefusal = await functionSeatRefusal(error);
        if (seatRefusal) {
          toast("No named-user seat is free", { description: "The invitation was not sent. See the seat details on this page." });
          await fetchSeats(selectedCompany);
          setShowInvite(false);
          return;
        }
        throw error;
      }

      if (data?.ok === false && data?.alreadyMember) {
        toast.warning(data.message);
      } else {
        toast.success(data?.message ?? "Invitation sent.", { description: describeInvitationCapabilities(data) });
        setShowInvite(false);
        setInviteForm({ email: "", role: "preparer" });
        await fetchMembers(selectedCompany);
        await fetchSeats(selectedCompany);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Invite failed: ${msg}`);
    } finally {
      setInviting(false);
    }
  };

  // ── Change role ───────────────────────────────────────────────

  const handleRoleChange = async (memberId: string, newRole: MemberRole) => {
    if (!setChanging(true)) return;
    try {
      const { error } = await supabase
        .from("firm_members")
        .update({ role: newRole, updated_at: new Date().toISOString() })
        .eq("id", memberId);
      if (error) throw error;
      toast.success("Role updated");
      await fetchMembers(selectedCompany);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Role update failed: ${msg}`);
    }
    finally { setChanging(false); }
  };

  // ── Remove member ─────────────────────────────────────────────

  const handleRemove = async (memberId: string) => {
    if (!setChanging(true)) return;
    setRemoving(memberId);
    try {
      const { error } = await supabase
        .from("firm_members")
        .delete()
        .eq("id", memberId);
      if (error) throw error;
      toast.success("Member removed");
      await fetchMembers(selectedCompany);
      await fetchSeats(selectedCompany);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Remove failed: ${msg}`);
    } finally {
      setRemoving(null);
      setChanging(false);
    }
  };

  // ── Cancel a pending invitation (the seat is released; the row is kept as history) ──

  const handleCancelInvitation = async (memberId: string) => {
    if (!setChanging(true)) return;
    try {
      setRemoving(memberId);
      const { data, error } = await supabase.rpc("cancel_workspace_invitation" as never, { p_member_id: memberId } as never);
      const outcome = !error && data && typeof data === "object" ? (data as { outcome?: string }).outcome : null;
      if (outcome === "cancelled" || outcome === "already_cancelled") toast("Invitation cancelled", { description: "The seat it held is free again." });
      else toast.error("The invitation could not be cancelled.");
      await fetchMembers(selectedCompany);
      await fetchSeats(selectedCompany);
    } catch { toast.error("Could not confirm the team change. Check the current team before trying again."); }
    finally { setChanging(false); setRemoving(null); }
  };

  // ── Choose who is active (the only way anyone is reactivated) ──

  const handleApplySelection = async () => {
    if (!roster) return;
    if (!setApplying(true)) return;
    try {
      const { data, error } = await supabase.rpc("choose_active_named_users" as never, { p_keep: selection, p_roster_version: roster.rosterVersion } as never);
      const outcome = error ? null : parseSelectionOutcome(data);
      if (outcome === "applied") toast("Active named users updated");
      else if (outcome === "stale_selection") toast("The team changed while you were choosing", { description: "Review the list again and re-apply." });
      else if (outcome === "selection_exceeds_allowance") toast("That selection is more than your plan's named users");
      else toast.error("The selection could not be applied.");
      await fetchMembers(selectedCompany);
      await fetchSeats(selectedCompany);
    } catch { toast.error("Could not confirm the team change. Check the current team before trying again."); }
    finally { setApplying(false); }
  };

  const inviteDirty = showInvite && (inviteForm.email !== "" || inviteForm.role !== "preparer");
  const savedSelection = roster?.people.filter((person) => person.state === "active_candidate").map((person) => person.userId) ?? [];
  const selectionDirty = !!roster?.overAllowance && [...selection].sort().join() !== [...savedSelection].sort().join();
  useManagementEditGuard(inviteDirty || selectionDirty, inviting || changing || applying || !!removing, () => {
    setShowInvite(false); setInviteForm({ email: "", role: "preparer" }); setSelection(savedSelection);
  });
  const closeInvite = () => {
    if (inviting) return;
    if (inviteDirty) { setDiscardInvite(true); return; }
    setDiscardInvite(false);
    setShowInvite(false);
    setInviteForm({ email: "", role: "preparer" });
  };
  // ── Render ────────────────────────────────────────────────────

  useActivity(loading || !!removing, loading ? "Loading the team…" : "Updating team access…");
  const selectedCo = companies.find((c) => c.id === selectedCompany);

  if (showInvite) return <section aria-label="Invite team member">
    <div className="mb-5 flex items-center justify-between gap-3"><h3 className="text-lg font-semibold">Invite team member</h3><Button variant="outline" disabled={inviting} onClick={closeInvite}>Back to team</Button></div>
    {discardInvite && <div role="alert" className="mb-5 flex flex-wrap items-center justify-between gap-3 border border-border bg-muted/30 p-4 text-sm"><p>Discard the unsent invitation?</p><div className="flex gap-2"><Button variant="outline" onClick={() => setDiscardInvite(false)}>Keep editing</Button><Button variant="destructive" onClick={() => { setShowInvite(false); setDiscardInvite(false); setInviteForm({ email: "", role: "preparer" }); }}>Discard changes</Button></div></div>}
    <fieldset disabled={inviting} className="max-w-xl">
          <div className="space-y-4 pt-1">
            <div className="space-y-1.5">
              <Label htmlFor="inviteEmail">
                Email Address <span className="text-destructive">*</span>
              </Label>
              <Input
                id="inviteEmail"
                type="email"
                value={inviteForm.email}
                onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })}
                placeholder="colleague@firm.co.tz"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                They'll receive an email with a sign-in link.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select
                value={inviteForm.role}
                onValueChange={(v) => setInviteForm({ ...inviteForm, role: v as MemberRole })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["partner", "preparer", "viewer"] as MemberRole[]).map((r) => (
                    <SelectItem key={r} value={r}>
                      <div>
                        <p className="text-sm font-medium">{ROLE_LABELS[r]}</p>
                        <p className="text-xs text-muted-foreground">{ROLE_DESCRIPTIONS[r]}</p>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="rounded-lg bg-secondary/50 border border-border px-3 py-2">
              <p className="text-xs text-muted-foreground">
                Inviting to: <span className="font-semibold text-foreground">{selectedCo?.name}</span>
                {selectedCo?.tin && (
                  <span className="ml-1.5 font-mono">(Tax identifier: {selectedCo.tin})</span>
                )}
              </p>
            </div>
          </div>

          <DialogFooter className="pt-2 gap-2">
            <Button
              variant="outline"
              onClick={closeInvite}
              disabled={inviting}
            >
              Cancel
            </Button>
            <Button
              onClick={handleInvite}
              disabled={inviting || !inviteForm.email.trim()}
              className="gap-1.5"
            >
              {inviting && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
              {inviting ? "Sending…" : "Send Invitation"}
            </Button>
          </DialogFooter>
    </fieldset>
  </section>;

  return (
    <Card className="border-0 shadow-none">
      <CardHeader className="px-0 pb-5 pt-0">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Users className="w-5 h-5 text-primary" />
              Team & Access
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">
              Manage who has access to each company's data
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { fetchOwned(); }}
              disabled={loading}
              className="gap-1.5"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            {selectedCompany && (
              <Button
                size="sm"
                onClick={() => { setDiscardInvite(false); setShowInvite(true); }}
                className="gap-1.5"
                disabled={!seatsLoaded || !canInviteAnother(seats)}
                data-testid="invite-member"
              >
                <UserPlus className="w-3.5 h-3.5" />
                Invite Member
              </Button>
            )}
          </div>
        </div>

        {pendingCompany && <div role="alert" className="mt-4 flex flex-wrap items-center justify-between gap-3 border border-border p-4 text-sm"><p>Discard the unsaved team selection?</p><div className="flex gap-2"><Button variant="outline" onClick={() => setPendingCompany(null)}>Keep editing</Button><Button variant="destructive" onClick={() => { setSelected(pendingCompany); setPendingCompany(null); }}>Discard changes</Button></div></div>}
        {/* Company selector */}
        {companies.length > 1 && (
          <div className="pt-2">
            <Select value={selectedCompany} onValueChange={(id) => { if (selectionDirty) setPendingCompany(id); else setSelected(id); }}>
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Select company…" />
              </SelectTrigger>
              <SelectContent>
                {companies.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    <div className="flex items-center gap-2">
                      <Building2 className="w-3.5 h-3.5 text-muted-foreground" />
                      <span className="text-sm">{c.name}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </CardHeader>

      <CardContent className="px-0 pt-0">
        {selectedCompany && seatsLoaded && (
          <div className="mb-3 space-y-2" data-testid="named-user-seats">
            {seats && (
              <p className="text-xs text-muted-foreground">
                {seats.unlimited ? "Team members" : "Named users"}: {seats.activeNamedUsers} active
                {seats.reservedNamedUsers > seats.activeNamedUsers ? `, ${seats.reservedNamedUsers - seats.activeNamedUsers} invited` : ""}
                {seats.unlimited ? " · unlimited on your plan" : seats.allowedNamedUsers !== null ? ` of ${seats.allowedNamedUsers}` : ""}. Each person signs in with their own account.
              </p>
            )}
            {seatCopy(seats) && <PaidActionNotice copy={seatCopy(seats)!} testId="named-user-seats-locked" />}
            {roster && seats?.isAccountHolder && (roster.overAllowance || roster.people.some((p) => p.state === "suspended")) && (
              <div className="border border-border p-3" data-testid="named-user-selection">
                <p className="text-xs font-semibold text-foreground">{roster.unlimited ? "Reactivate team members" : "Choose who is active"}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {roster.unlimited
                    ? "Your plan includes unlimited team members. Select the people to reactivate; nobody else is affected."
                    : <>Select up to {selectableSeats(roster).max} {selectableSeats(roster).max === 1 ? "person" : "people"} besides you. Everyone else keeps their
                  membership and history but has no access until you select them.</>}
                </p>
                <ul className="mt-2 space-y-1">
                  {selectableSeats(roster).choices.map((id) => {
                    const person = roster.people.find((p) => p.userId === id);
                    const member = members.find((mm) => mm.userId === id);
                    const label = member?.displayName || person?.invitedEmail || member?.invitedEmail || id.slice(0, 8) + "…";
                    const checked = selection.includes(id);
                    const full = !checked && selection.length >= selectableSeats(roster).max;
                    return (
                      <li key={id}>
                        <label className="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={full || applying}
                            onChange={() => setSelection((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))}
                          />
                          <span className="min-w-0 break-all">{label}</span>
                          {person?.state === "suspended" && <span className="text-xs text-muted-foreground">suspended</span>}
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <Button size="sm" variant="outline" className="mt-2" pending={applying} pendingLabel="Updating team…" onClick={() => void handleApplySelection()} disabled={applying || selection.length > selectableSeats(roster).max}>
                  Apply selection
                </Button>
              </div>
            )}
          </div>
        )}
        {loading ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" />
            Loading…
          </div>
        ) : companies.length === 0 ? (
          <div className="text-center py-8">
            <Building2 className="w-7 h-7 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">
              No companies found. Add a company first via the Dashboard.
            </p>
          </div>
        ) : members.length === 0 ? (
          <div className="text-center py-8">
            <Users className="w-7 h-7 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No members yet.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {/* Company header */}
            {selectedCo && (
              <div className="flex items-center gap-2 pb-2 border-b border-border mb-3">
                <Building2 className="w-4 h-4 text-primary" />
                <span className="text-sm font-semibold">{selectedCo.name}</span>
                {selectedCo.tin && (
                  <span className="text-[10px] font-mono text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
                    Tax identifier: {selectedCo.tin}
                  </span>
                )}
                <span className="text-xs text-muted-foreground ml-auto">
                  {members.length} member{members.length !== 1 ? "s" : ""}
                </span>
              </div>
            )}

            {[false, true].map((pending) => {
              const group = members.filter((member) => !member.acceptedAt === pending);
              return <section key={String(pending)} className="pt-4">
                <h3 className="mb-3 text-sm font-semibold">{pending ? "Invitations" : "Team members"} <span className="font-normal text-muted-foreground">({group.length})</span></h3>
                {group.length === 0 ? <p className="border border-border p-4 text-sm text-muted-foreground">{pending ? "No invitations." : "No active members."}</p> :
                <div className="overflow-x-auto border border-border"><table className="w-full min-w-[560px] text-left text-sm">
                  <caption className="sr-only">{pending ? "Company invitations" : "Company team members"}</caption>
                  <thead className="border-b border-border bg-muted/50 text-xs text-muted-foreground"><tr><th scope="col" className="px-4 py-3 font-medium">Name or email</th><th scope="col" className="px-4 py-3 font-medium">Role</th><th scope="col" className="px-4 py-3 font-medium">Status</th><th scope="col" className="px-4 py-3 font-medium">Actions</th></tr></thead>
                  <tbody>{group.map((m) => {
                    const isSelf = m.userId === user?.id;
                    const isOwner = m.role === "owner";
                    const closed = pending && (m.invitationCancelledAt !== null || (m.invitationExpiresAt !== null && new Date(m.invitationExpiresAt) <= new Date()));
                    const rosterState = roster?.people.find((person) => person.userId === m.userId)?.state;
                    const suspended = rosterState === "suspended";
                    const awaiting = !suspended && !pending && rosterState === "active_candidate" && roster?.overAllowance === true;
                    const name = m.displayName || m.email || m.invitedEmail || m.userId.slice(0, 8) + "…";
                    return <tr key={m.id} className="border-b border-border last:border-b-0">
                      <td className="px-4 py-3"><span className="font-medium">{name}</span>{isSelf && <span className="ml-1 text-muted-foreground">(you)</span>}{m.displayName && (m.email || m.invitedEmail) && <span className="mt-0.5 block text-xs text-muted-foreground">{m.email || m.invitedEmail}</span>}</td>
                      <td className="px-4 py-3">{ROLE_LABELS[m.role]}</td>
                      <td className="px-4 py-3 text-xs">{suspended || awaiting ? <span data-testid="member-suspended">{suspended ? "Suspended: no named-user seat. Membership and history kept." : "Waiting for your selection: no access yet."}</span> : pending ? m.invitationCancelledAt !== null ? "Invitation cancelled" : closed ? "Invitation expired" : `Pending until ${new Date(m.invitationExpiresAt ?? m.createdAt).toLocaleDateString("en-GB")}` : "Active"}</td>
                      <td className="px-4 py-3">{!isOwner && <div className="flex items-center gap-2">
                        <Select value={m.role} onValueChange={(value) => handleRoleChange(m.id, value as MemberRole)} disabled={isSelf || changing}>
                          <SelectTrigger className="h-9 w-28 text-xs" aria-label={`Role for ${name}`}><SelectValue /></SelectTrigger>
                          <SelectContent>{(["partner", "preparer", "viewer"] as MemberRole[]).map((role) => <SelectItem key={role} value={role}>{ROLE_LABELS[role]}</SelectItem>)}</SelectContent>
                        </Select>
                        <AlertDialog><AlertDialogTrigger asChild><Button variant="ghost" size="icon" aria-label={pending ? `Cancel invitation for ${name}` : `Remove ${name}`} disabled={changing || removing === m.id || isSelf || (pending && m.invitationCancelledAt !== null)}>
                          {removing === m.id ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4 text-destructive" />}
                        </Button></AlertDialogTrigger>
                          <AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{pending ? "Cancel invitation?" : "Remove member?"}</AlertDialogTitle><AlertDialogDescription>{pending ? `Cancel the invitation for ${name}? Its seat is released and the record is kept.` : `Remove ${name} from ${selectedCo?.name}? Access ends immediately. Their recorded work remains attributed to them.`}</AlertDialogDescription></AlertDialogHeader>
                            <AlertDialogFooter><AlertDialogCancel>Keep current access</AlertDialogCancel><AlertDialogAction onClick={() => pending ? void handleCancelInvitation(m.id) : void handleRemove(m.id)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">{pending ? "Cancel invitation" : "Remove"}</AlertDialogAction></AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>}</td>
                    </tr>;
                  })}</tbody>
                </table></div>}
              </section>;
            })}

            {/* Role legend */}
            <div className="pt-3 border-t border-border space-y-1">
              <p className="mb-2 text-sm font-semibold">
                Role permissions
              </p>
              {(Object.entries(ROLE_DESCRIPTIONS) as [MemberRole, string][]).map(([r, desc]) => (
                <div key={r} className="flex items-center gap-2">
                  <Badge variant="outline" className="w-20 justify-center rounded-sm text-xs font-medium">
                    {ROLE_LABELS[r]}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{desc}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>


    </Card>
  );
}
