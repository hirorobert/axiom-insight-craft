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
//   logs in, Dashboard.tsx auto-updates their accepted_at.
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
  const [loading, setLoading]           = useState(true);
  const [showInvite, setShowInvite]     = useState(false);
  const [inviting, setInviting]         = useState(false);
  const [removing, setRemoving]         = useState<string | null>(null);
  const [inviteForm, setInviteForm]     = useState({ email: "", role: "preparer" as MemberRole });

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
        .select("id, company_id, user_id, role, invited_by, invited_email, accepted_at, created_at")
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

      const enriched: FirmMember[] = (rows ?? []).map((r) => ({
        id:           r.id,
        companyId:    r.company_id,
        userId:       r.user_id,
        role:         r.role as MemberRole,
        invitedBy:    r.invited_by,
        invitedEmail: r.invited_email,
        acceptedAt:   r.accepted_at,
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
  useEffect(() => { if (selectedCompany) fetchMembers(selectedCompany); }, [selectedCompany]);

  // ── Invite ────────────────────────────────────────────────────

  const handleInvite = async () => {
    if (!inviteForm.email.trim() || !selectedCompany) return;
    setInviting(true);
    try {
      const { data, error } = await supabase.functions.invoke("invite-firm-member", {
        body: {
          email:      inviteForm.email.trim().toLowerCase(),
          company_id: selectedCompany,
          role:       inviteForm.role,
        },
      });

      if (error) throw error;

      if (data?.ok === false && data?.alreadyMember) {
        toast.warning(data.message);
      } else {
        toast.success(data?.message ?? "Invitation sent.");
        setShowInvite(false);
        setInviteForm({ email: "", role: "preparer" });
        await fetchMembers(selectedCompany);
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
  };

  // ── Remove member ─────────────────────────────────────────────

  const handleRemove = async (memberId: string) => {
    setRemoving(memberId);
    try {
      const { error } = await supabase
        .from("firm_members")
        .delete()
        .eq("id", memberId);
      if (error) throw error;
      toast.success("Member removed");
      await fetchMembers(selectedCompany);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Remove failed: ${msg}`);
    } finally {
      setRemoving(null);
    }
  };

  // ── Render ────────────────────────────────────────────────────

  const selectedCo = companies.find((c) => c.id === selectedCompany);

  return (
    <Card>
      <CardHeader className="pb-3">
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
                onClick={() => setShowInvite(true)}
                className="gap-1.5"
              >
                <UserPlus className="w-3.5 h-3.5" />
                Invite Member
              </Button>
            )}
          </div>
        </div>

        {/* Company selector */}
        {companies.length > 1 && (
          <div className="pt-2">
            <Select value={selectedCompany} onValueChange={setSelected}>
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

      <CardContent className="pt-0">
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
                    TIN: {selectedCo.tin}
                  </span>
                )}
                <span className="text-xs text-muted-foreground ml-auto">
                  {members.length} member{members.length !== 1 ? "s" : ""}
                </span>
              </div>
            )}

            {members.map((m) => {
              const isPending = !m.acceptedAt;
              const isOwner   = m.role === "owner";
              const isSelf    = m.userId === user?.id;

              const displayLabel = m.displayName
                || m.email
                || m.invitedEmail
                || m.userId.slice(0, 8) + "…";

              return (
                <div
                  key={m.id}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${
                    isPending ? "bg-amber-500/5 border-amber-500/20" : "bg-card border-border"
                  }`}
                >
                  {/* Avatar placeholder */}
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                    isOwner ? "bg-[#0E1D30]" : "bg-primary/10"
                  }`}>
                    {isOwner
                      ? <Crown className="w-3.5 h-3.5 text-white" />
                      : <Shield className="w-3.5 h-3.5 text-primary" />
                    }
                  </div>

                  {/* Name + email */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className="text-xs font-semibold text-foreground">
                        {displayLabel}
                        {isSelf && <span className="ml-1 text-muted-foreground font-normal">(you)</span>}
                      </p>
                      <Badge className={`text-[10px] ${ROLE_COLORS[m.role]}`}>
                        {ROLE_LABELS[m.role]}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {isPending ? (
                        <>
                          <Clock className="w-2.5 h-2.5 text-amber-500" />
                          <span className="text-[10px] text-amber-700">Invitation pending</span>
                        </>
                      ) : (
                        <>
                          <CheckCircle className="w-2.5 h-2.5 text-green-600" />
                          <span className="text-[10px] text-muted-foreground">
                            Active since {new Date(m.acceptedAt!).toLocaleDateString("en-GB")}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Role change + remove — only for non-owners and non-self */}
                  {!isOwner && (
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <Select
                        value={m.role}
                        onValueChange={(v) => handleRoleChange(m.id, v as MemberRole)}
                        disabled={isSelf}
                      >
                        <SelectTrigger className="h-7 text-[11px] w-28">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(["partner", "preparer", "viewer"] as MemberRole[]).map((r) => (
                            <SelectItem key={r} value={r} className="text-xs">
                              {ROLE_LABELS[r]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-red-600"
                            disabled={removing === m.id || isSelf}
                          >
                            {removing === m.id
                              ? <RefreshCw className="w-3 h-3 animate-spin" />
                              : <Trash2 className="w-3 h-3" />
                            }
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Remove member?</AlertDialogTitle>
                            <AlertDialogDescription>
                              Remove <strong>{displayLabel}</strong> from <strong>{selectedCo?.name}</strong>?
                              They will lose all access immediately. This cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => handleRemove(m.id)}
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            >
                              Remove
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Role legend */}
            <div className="pt-3 border-t border-border space-y-1">
              <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wide mb-1.5">
                Role permissions
              </p>
              {(Object.entries(ROLE_DESCRIPTIONS) as [MemberRole, string][]).map(([r, desc]) => (
                <div key={r} className="flex items-center gap-2">
                  <Badge className={`text-[9px] w-16 justify-center ${ROLE_COLORS[r]}`}>
                    {ROLE_LABELS[r]}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground">{desc}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>

      {/* ── Invite Dialog ──────────────────────────────────────── */}
      <Dialog open={showInvite} onOpenChange={(o) => { if (!inviting) setShowInvite(o); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <UserPlus className="w-4 h-4 text-primary" />
              Invite Team Member
            </DialogTitle>
          </DialogHeader>

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
              <p className="text-[10px] text-muted-foreground">
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
              <p className="text-[10px] text-muted-foreground">
                Inviting to: <span className="font-semibold text-foreground">{selectedCo?.name}</span>
                {selectedCo?.tin && (
                  <span className="ml-1.5 font-mono">(TIN: {selectedCo.tin})</span>
                )}
              </p>
            </div>
          </div>

          <DialogFooter className="pt-2 gap-2">
            <Button
              variant="outline"
              onClick={() => setShowInvite(false)}
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
        </DialogContent>
      </Dialog>
    </Card>
  );
}
