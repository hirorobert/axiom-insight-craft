/**
 * PeriodCloseManager.tsx
 * Sprint 5 Item 3 — Iron Dome Nuclear Design
 *
 * Cross-company period close status dashboard.
 * Reads statement_sign_offs for all accessible companies.
 *
 * Sign-off flow (immutable once locked):
 *   draft → preparer_signed → reviewer_signed → approved → locked
 *
 * Rules (Iron Dome):
 *   - No silent status changes.
 *   - Locked periods are immutable — DB RLS enforces this.
 *   - Sign-off buttons only visible to users with the correct firm_members role.
 *   - Preparer signs first; reviewer signs second; approver locks.
 *   - Once locked_at IS NOT NULL → new TB uploads for that company+year are BLOCKED by DB trigger.
 */

import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { toast } from "sonner";
import {
  Lock,
  LockOpen,
  CheckCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  Loader2,
  Building2,
  UserCheck,
  Shield,
  ShieldCheck,
  AlertTriangle,
  Pen,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type SignOffStatus = "draft" | "preparer_signed" | "reviewer_signed" | "approved" | "locked";

interface SignOff {
  id: string;
  company_id: string;
  period_year: number;
  upload_id: string;
  statements_hash: string | null;
  preparer_id: string | null;
  preparer_signed_at: string | null;
  preparer_note: string | null;
  reviewer_id: string | null;
  reviewer_signed_at: string | null;
  reviewer_note: string | null;
  approver_id: string | null;
  approver_signed_at: string | null;
  approver_note: string | null;
  status: SignOffStatus;
  locked_at: string | null;
  locked_by: string | null;
  created_at: string;
  updated_at: string;
}

interface CompanyRow {
  id: string;
  name: string;
  tin: string | null;
  signOff: SignOff | null;
  userRole: "owner" | "partner" | "preparer" | "viewer" | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_META: Record<SignOffStatus, { label: string; color: string; step: number }> = {
  draft:            { label: "Draft",            color: "bg-slate-100 text-slate-700 border-slate-200",     step: 0 },
  preparer_signed:  { label: "Preparer Signed",  color: "bg-blue-100 text-blue-800 border-blue-200",       step: 1 },
  reviewer_signed:  { label: "Reviewer Signed",  color: "bg-indigo-100 text-indigo-800 border-indigo-200", step: 2 },
  approved:         { label: "Approved",          color: "bg-amber-100 text-amber-800 border-amber-200",    step: 3 },
  locked:           { label: "Period Locked",     color: "bg-emerald-100 text-emerald-800 border-emerald-200", step: 4 },
};

const STEPS = [
  { key: "preparer_signed",  role: ["preparer", "partner", "owner"], label: "Preparer",  icon: Pen },
  { key: "reviewer_signed",  role: ["partner", "owner"],             label: "Reviewer",  icon: UserCheck },
  { key: "approved",         role: ["partner", "owner"],             label: "Approver",  icon: Shield },
  { key: "locked",           role: ["partner", "owner"],             label: "Locked",    icon: Lock },
];

function stepDone(status: SignOffStatus, stepKey: string): boolean {
  const statusOrder: SignOffStatus[] = ["draft", "preparer_signed", "reviewer_signed", "approved", "locked"];
  return statusOrder.indexOf(status) >= statusOrder.indexOf(stepKey as SignOffStatus);
}

// ── Sign action payloads ──────────────────────────────────────────────────────

function nextStatusPayload(currentStatus: SignOffStatus, userId: string, note: string): Record<string, unknown> | null {
  switch (currentStatus) {
    case "draft":
      return { status: "preparer_signed", preparer_id: userId, preparer_signed_at: new Date().toISOString(), preparer_note: note || null };
    case "preparer_signed":
      return { status: "reviewer_signed", reviewer_id: userId, reviewer_signed_at: new Date().toISOString(), reviewer_note: note || null };
    case "reviewer_signed":
      return { status: "approved", approver_id: userId, approver_signed_at: new Date().toISOString(), approver_note: note || null };
    case "approved":
      return { status: "locked", locked_by: userId, locked_at: new Date().toISOString() };
    default:
      return null;
  }
}

function nextActionLabel(status: SignOffStatus): string {
  switch (status) {
    case "draft":           return "Sign as Preparer";
    case "preparer_signed": return "Sign as Reviewer";
    case "reviewer_signed": return "Approve Statements";
    case "approved":        return "Lock Period";
    default:                return "";
  }
}

function canUserAct(status: SignOffStatus, role: string | null): boolean {
  if (!role || status === "locked") return false;
  if (status === "draft" && ["preparer", "partner", "owner"].includes(role)) return true;
  if (status === "preparer_signed" && ["partner", "owner"].includes(role)) return true;
  if (status === "reviewer_signed" && ["partner", "owner"].includes(role)) return true;
  if (status === "approved" && ["partner", "owner"].includes(role)) return true;
  return false;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  userId: string;
}

export function PeriodCloseManager({ userId }: Props) {
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Sign dialog state
  const [signDialogCompany, setSignDialogCompany] = useState<CompanyRow | null>(null);
  const [signNote, setSignNote] = useState("");
  const [signing, setSigning] = useState(false);

  // ── Fetch data ────────────────────────────────────────────────────────────
  const fetchAll = async () => {
    setLoading(true);
    const { data: companyList } = await supabase
      .from("companies")
      .select("id, name, tin")
      .order("name", { ascending: true });

    if (!companyList || companyList.length === 0) {
      setCompanies([]);
      setLoading(false);
      return;
    }

    const companyIds = companyList.map(c => c.id);

    // Fetch latest sign-off per company (one row per company+year, take latest year)
    const { data: signOffs } = await supabase
      .from("statement_sign_offs")
      .select("*")
      .in("company_id", companyIds)
      .order("period_year", { ascending: false });

    // Fetch user roles
    const { data: memberships } = await supabase
      .from("firm_members")
      .select("company_id, role")
      .eq("user_id", userId)
      .in("company_id", companyIds);

    // Build maps
    const signOffMap = new Map<string, SignOff>();
    (signOffs ?? []).forEach(s => {
      if (!signOffMap.has(s.company_id)) signOffMap.set(s.company_id, s);
    });

    const roleMap = new Map<string, string>();
    (memberships ?? []).forEach(m => roleMap.set(m.company_id, m.role));

    const rows: CompanyRow[] = companyList.map(c => ({
      id: c.id,
      name: c.name,
      tin: c.tin,
      signOff: signOffMap.get(c.id) ?? null,
      userRole: (roleMap.get(c.id) as CompanyRow["userRole"]) ?? null,
    }));

    // Sort: non-locked first, then by status step ascending
    rows.sort((a, b) => {
      const aStep = a.signOff ? STATUS_META[a.signOff.status].step : -1;
      const bStep = b.signOff ? STATUS_META[b.signOff.status].step : -1;
      if (a.signOff?.status === "locked" && b.signOff?.status !== "locked") return 1;
      if (b.signOff?.status === "locked" && a.signOff?.status !== "locked") return -1;
      return aStep - bStep;
    });

    setCompanies(rows);
    setLoading(false);
  };

  useEffect(() => { fetchAll(); }, [userId]);

  // ── Sign / lock action ────────────────────────────────────────────────────
  const handleSign = async () => {
    if (!signDialogCompany?.signOff) return;
    setSigning(true);

    const payload = nextStatusPayload(signDialogCompany.signOff.status, userId, signNote);
    if (!payload) { toast.error("Invalid sign-off state"); setSigning(false); return; }

    const { error } = await supabase
      .from("statement_sign_offs")
      .update(payload)
      .eq("id", signDialogCompany.signOff.id);

    if (error) {
      toast.error("Sign-off failed: " + error.message);
    } else {
      const newStatus = payload.status as string;
      toast.success(newStatus === "locked"
        ? `Period locked for ${signDialogCompany.name} — new uploads are now blocked`
        : `${signDialogCompany.name} signed successfully`
      );
      setSignDialogCompany(null);
      setSignNote("");
      fetchAll();
    }
    setSigning(false);
  };

  // ── Portfolio summary ─────────────────────────────────────────────────────
  const lockedCount = companies.filter(c => c.signOff?.status === "locked").length;
  const pendingCount = companies.filter(c => c.signOff && c.signOff.status !== "locked").length;
  const noSignOffCount = companies.filter(c => !c.signOff).length;

  return (
    <>
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-lg bg-slate-900 flex items-center justify-center">
                <Lock className="w-5 h-5 text-white" />
              </div>
              <div>
                <CardTitle className="text-base font-semibold text-foreground">
                  Period Close Manager
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  3-tier CPA sign-off — Preparer → Reviewer → Approver → Lock
                </p>
              </div>
            </div>
            {!loading && (
              <div className="flex items-center gap-1.5">
                {lockedCount > 0 && (
                  <Badge className="bg-emerald-100 text-emerald-800 border border-emerald-200 text-xs">
                    <Lock className="w-3 h-3 mr-1" />{lockedCount} Locked
                  </Badge>
                )}
                {pendingCount > 0 && (
                  <Badge className="bg-amber-100 text-amber-800 border border-amber-200 text-xs">
                    <Clock className="w-3 h-3 mr-1" />{pendingCount} In Progress
                  </Badge>
                )}
                {noSignOffCount > 0 && (
                  <Badge className="bg-slate-100 text-slate-600 border border-slate-200 text-xs">
                    {noSignOffCount} Not Started
                  </Badge>
                )}
              </div>
            )}
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          {loading ? (
            <div className="flex items-center justify-center py-10 gap-2 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">Loading sign-off status…</span>
            </div>
          ) : companies.length === 0 ? (
            <div className="text-center py-10">
              <Building2 className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No companies found.</p>
            </div>
          ) : (
            companies.map((company) => {
              const so = company.signOff;
              const status: SignOffStatus = so?.status ?? "draft";
              const meta = STATUS_META[status];
              const isExpanded = expandedId === company.id;
              const canAct = canUserAct(status, company.userRole);
              const isLocked = status === "locked";

              return (
                <Collapsible
                  key={company.id}
                  open={isExpanded}
                  onOpenChange={(open) => setExpandedId(open ? company.id : null)}
                >
                  <div className={`border rounded-xl overflow-hidden ${isLocked ? "border-emerald-200" : "border-border"}`}>
                    {/* Company row */}
                    <CollapsibleTrigger asChild>
                      <div className={`flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/20 transition-colors ${isLocked ? "bg-emerald-50/50" : ""}`}>
                        <div className="flex-shrink-0">
                          {isLocked
                            ? <Lock className="w-4 h-4 text-emerald-600" />
                            : so
                              ? <LockOpen className="w-4 h-4 text-amber-500" />
                              : <LockOpen className="w-4 h-4 text-muted-foreground" />
                          }
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-semibold text-foreground truncate">{company.name}</span>
                            {company.tin && (
                              <span className="text-xs text-muted-foreground font-mono hidden sm:inline">TIN: {company.tin}</span>
                            )}
                            {so?.period_year && (
                              <span className="text-xs text-muted-foreground">FY{so.period_year}</span>
                            )}
                          </div>

                          {/* Progress steps */}
                          {so && (
                            <div className="flex items-center gap-1 mt-1.5">
                              {STEPS.map((step, i) => {
                                const done = stepDone(status, step.key);
                                return (
                                  <div key={step.key} className="flex items-center gap-1">
                                    <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${
                                      done
                                        ? "bg-emerald-500 text-white"
                                        : STATUS_META[status].step === i
                                          ? "bg-amber-400 text-white"
                                          : "bg-muted border border-border text-muted-foreground"
                                    }`}>
                                      {done ? "✓" : i + 1}
                                    </div>
                                    <span className={`text-[10px] ${done ? "text-emerald-600" : "text-muted-foreground"}`}>
                                      {step.label}
                                    </span>
                                    {i < STEPS.length - 1 && (
                                      <div className={`w-4 h-px mx-1 ${done ? "bg-emerald-400" : "bg-border"}`} />
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        <div className="flex items-center gap-2 flex-shrink-0">
                          {so ? (
                            <Badge className={`text-xs border ${meta.color}`}>{meta.label}</Badge>
                          ) : (
                            <Badge className="text-xs border bg-slate-100 text-slate-500 border-slate-200">No sign-off</Badge>
                          )}
                          {isExpanded ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
                        </div>
                      </div>
                    </CollapsibleTrigger>

                    {/* Detail panel */}
                    <CollapsibleContent>
                      <div className="border-t border-border px-4 py-3 space-y-3 bg-background">
                        {!so ? (
                          <div className="flex items-start gap-2 text-sm text-muted-foreground">
                            <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                            No sign-off record found for this company. Complete a tax computation and commit it to generate a sign-off record automatically.
                          </div>
                        ) : (
                          <>
                            {/* Sign-off history */}
                            <div className="space-y-2">
                              <p className="text-xs font-medium text-muted-foreground">Sign-off history</p>
                              {[
                                { tier: "Preparer", id: so.preparer_id, at: so.preparer_signed_at, note: so.preparer_note },
                                { tier: "Reviewer", id: so.reviewer_id, at: so.reviewer_signed_at, note: so.reviewer_note },
                                { tier: "Approver", id: so.approver_id, at: so.approver_signed_at, note: so.approver_note },
                                so.locked_at ? { tier: "Locked",   id: so.locked_by,   at: so.locked_at,          note: null } : null,
                              ].filter(Boolean).map((entry) => (
                                entry && (
                                  <div key={entry.tier} className={`flex items-start gap-3 text-xs rounded-lg px-3 py-2 ${entry.at ? "bg-emerald-50 border border-emerald-100" : "bg-muted/30 border border-border/50"}`}>
                                    <div className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${entry.at ? "bg-emerald-500" : "bg-muted-foreground/30"}`} />
                                    <div className="flex-1">
                                      <span className="font-medium text-foreground">{entry.tier}:</span>
                                      {entry.at
                                        ? <span className="text-muted-foreground ml-1">Signed {new Date(entry.at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}</span>
                                        : <span className="text-muted-foreground ml-1">Pending</span>
                                      }
                                      {entry.note && <p className="text-muted-foreground/80 mt-0.5 italic">"{entry.note}"</p>}
                                    </div>
                                    {entry.at && <CheckCircle className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-0.5" />}
                                  </div>
                                )
                              ))}
                            </div>

                            {/* Locked notice */}
                            {isLocked && (
                              <div className="flex items-start gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs">
                                <ShieldCheck className="w-4 h-4 text-emerald-600 flex-shrink-0 mt-0.5" />
                                <div>
                                  <p className="font-medium text-emerald-800">Period is locked and immutable.</p>
                                  <p className="text-emerald-700/80 mt-0.5">New trial balance uploads for FY{so.period_year} are blocked by the database. Unlock requires direct DB admin access (TAA 2015 s.29 audit trail preserved).</p>
                                </div>
                              </div>
                            )}

                            {/* Role notice */}
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Shield className="w-3.5 h-3.5" />
                              Your role: <span className="font-medium text-foreground capitalize">{company.userRole ?? "none"}</span>
                              {!company.userRole && " — not a member of this firm"}
                            </div>
                          </>
                        )}

                        {/* Action button */}
                        {so && canAct && !isLocked && (
                          <div className="pt-1">
                            {status === "approved" ? (
                              // Lock requires extra confirmation dialog
                              <AlertDialog>
                                <AlertDialogTrigger asChild>
                                  <Button size="sm" className="gap-1.5 bg-emerald-700 hover:bg-emerald-800 text-white">
                                    <Lock className="w-3.5 h-3.5" />
                                    Lock Period
                                  </Button>
                                </AlertDialogTrigger>
                                <AlertDialogContent>
                                  <AlertDialogHeader>
                                    <AlertDialogTitle className="flex items-center gap-2">
                                      <Lock className="w-4 h-4 text-emerald-600" />
                                      Lock FY{so.period_year} for {company.name}?
                                    </AlertDialogTitle>
                                    <AlertDialogDescription className="space-y-2">
                                      <p>This is an <strong>irreversible action</strong>. Once locked:</p>
                                      <ul className="list-disc ml-4 space-y-1 text-sm">
                                        <li>All statements for FY{so.period_year} become immutable</li>
                                        <li>New trial balance uploads for this period are blocked</li>
                                        <li>The DB enforces immutability via RLS — no user can override</li>
                                        <li>Statements hash is preserved for non-repudiation</li>
                                      </ul>
                                      <p className="text-xs text-muted-foreground">TAA 2015 s.29 requires audit trail preservation. Unlock requires database admin intervention.</p>
                                    </AlertDialogDescription>
                                  </AlertDialogHeader>
                                  <AlertDialogFooter>
                                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                                    <AlertDialogAction
                                      className="bg-emerald-700 hover:bg-emerald-800"
                                      onClick={() => {
                                        setSignDialogCompany(company);
                                        setSignNote("");
                                      }}
                                    >
                                      Confirm Lock
                                    </AlertDialogAction>
                                  </AlertDialogFooter>
                                </AlertDialogContent>
                              </AlertDialog>
                            ) : (
                              <Button
                                size="sm"
                                variant="outline"
                                className="gap-1.5 border-indigo-300 text-indigo-700 hover:bg-indigo-50"
                                onClick={() => { setSignDialogCompany(company); setSignNote(""); }}
                              >
                                <Pen className="w-3.5 h-3.5" />
                                {nextActionLabel(status)}
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    </CollapsibleContent>
                  </div>
                </Collapsible>
              );
            })
          )}

          {companies.length > 0 && (
            <div className="pt-2 border-t border-border/40 text-xs text-muted-foreground/70">
              Sign-off chain enforced per IAS 1 / IFRS for SMEs. Period lock triggers DB immutability — TAA 2015 s.29 audit trail preserved.
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Sign dialog ─────────────────────────────────────────────────────── */}
      <Dialog
        open={!!signDialogCompany && signDialogCompany.signOff?.status !== "approved"}
        onOpenChange={(open) => { if (!open) { setSignDialogCompany(null); setSignNote(""); } }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserCheck className="w-4 h-4 text-indigo-600" />
              {signDialogCompany ? nextActionLabel(signDialogCompany.signOff?.status ?? "draft") : "Sign"}
            </DialogTitle>
            <DialogDescription>
              {signDialogCompany?.name} — FY{signDialogCompany?.signOff?.period_year}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
              By signing, you confirm that the financial statements and tax computations for this period have been reviewed and are accurate under ITA Cap.332 R.E.2023 and IFRS for SMEs.
            </div>
            <div>
              <Label className="text-xs font-medium">Reviewer note (optional)</Label>
              <Textarea
                className="mt-1 text-sm resize-none"
                rows={3}
                placeholder="Add any notes, qualifications, or conditions…"
                value={signNote}
                onChange={(e) => setSignNote(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setSignDialogCompany(null); setSignNote(""); }}>
              Cancel
            </Button>
            <Button
              disabled={signing}
              onClick={handleSign}
              className="bg-indigo-600 hover:bg-indigo-700 text-white gap-1.5"
            >
              {signing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Pen className="w-3.5 h-3.5" />}
              Confirm Signature
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Lock confirmation dialog (separate, triggered from AlertDialogAction) */}
      {signDialogCompany?.signOff?.status === "approved" && (
        <Dialog
          open={true}
          onOpenChange={(open) => { if (!open) { setSignDialogCompany(null); setSignNote(""); } }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Lock className="w-4 h-4 text-emerald-600" />
                Locking FY{signDialogCompany.signOff.period_year} — {signDialogCompany.name}
              </DialogTitle>
              <DialogDescription>
                This action is irreversible. The period will be immutably sealed.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => { setSignDialogCompany(null); setSignNote(""); }}>
                Cancel
              </Button>
              <Button
                disabled={signing}
                onClick={handleSign}
                className="bg-emerald-700 hover:bg-emerald-800 text-white gap-1.5"
              >
                {signing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Lock className="w-3.5 h-3.5" />}
                Lock Period
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
