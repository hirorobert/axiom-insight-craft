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
 *   - Read-only. statement_sign_offs is server-written only since
 *     20261221100000_financial_table_member_write_revocation.sql: this panel shows each period's sign-off status and
 *     never signs, approves or locks (it used to UPDATE the table directly from the browser).
 *   - Once locked_at IS NOT NULL → new TB uploads for that company+year are BLOCKED by DB trigger.
 */

import { parseMyWorkspaceCapabilities, type MyWorkspaceCapabilities } from "@/lib/auth/workspaceCapabilities";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { resolveActiveSession, endExpiredSession, handleIfAuthorizationFailure } from "@/lib/auth/sessionGuard";
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
  /** Display metadata only. */
  userRole: "owner" | "partner" | "preparer" | "viewer" | null;
  /** What the person may exercise in this workspace (get_my_workspace_capabilities). */
  capabilities: MyWorkspaceCapabilities | null;
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
  { key: "preparer_signed",  label: "Preparer",  icon: Pen },
  { key: "reviewer_signed",  label: "Reviewer",  icon: UserCheck },
  { key: "approved",         label: "Approver",  icon: Shield },
  { key: "locked",           label: "Locked",    icon: Lock },
];

function stepDone(status: SignOffStatus, stepKey: string): boolean {
  const statusOrder: SignOffStatus[] = ["draft", "preparer_signed", "reviewer_signed", "approved", "locked"];
  return statusOrder.indexOf(status) >= statusOrder.indexOf(stepKey as SignOffStatus);
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  userId: string;
}

export function PeriodCloseManager({ userId }: Props) {
  const [companies, setCompanies] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // ── Fetch data ────────────────────────────────────────────────────────────
  const fetchAll = async () => {
    setLoading(true);

    // Authenticated-only reads (companies, sign-offs, memberships): never query as anonymous.
    if (!(await resolveActiveSession())) {
      setLoading(false);
      await endExpiredSession();
      return;
    }

    const { data: companyList, error: companyErr } = await supabase
      .from("companies")
      .select("id, name, tin")
      .order("name", { ascending: true });

    if (companyErr) {
      setLoading(false);
      if (!(await handleIfAuthorizationFailure(companyErr))) setCompanies([]);
      return;
    }

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
      if (!signOffMap.has(s.company_id)) signOffMap.set(s.company_id, s as unknown as SignOff);
    });

    const roleMap = new Map<string, string>();
    (memberships ?? []).forEach(m => roleMap.set(m.company_id, m.role));

    // Capabilities per workspace: the authority for which step the person may take.
    const capabilityMap = new Map<string, MyWorkspaceCapabilities | null>();
    await Promise.all(companyIds.map(async (id) => {
      const { data, error } = await supabase.rpc("get_my_workspace_capabilities" as never, { p_company_id: id } as never);
      capabilityMap.set(id, error ? null : parseMyWorkspaceCapabilities(data));
    }));

    const rows: CompanyRow[] = companyList.map(c => ({
      id: c.id,
      name: c.name,
      tin: c.tin,
      signOff: signOffMap.get(c.id) ?? null,
      userRole: (roleMap.get(c.id) as CompanyRow["userRole"]) ?? null,
      capabilities: capabilityMap.get(c.id) ?? null,
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
                              <span className="text-xs text-muted-foreground font-mono hidden sm:inline">Tax identifier: {company.tin}</span>
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
                            No sign-off record found for this company yet.
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
                                  <p className="text-emerald-700/80 mt-0.5">New trial balance uploads for FY{so.period_year} are blocked by the database. Unlock requires direct DB admin access (audit trail preserved).</p>
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

                        {/* Sign-off is not recorded here: statement_sign_offs is server-written only
                            (20261221100000_financial_table_member_write_revocation.sql). This panel only shows status. */}
                        {so && !isLocked && (
                          <div className="pt-1 text-xs text-muted-foreground" data-testid="period-close-signoff-read-only">
                            Sign-off is recorded by the server-side statements workflow, not from this panel.
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
              Sign-off chain enforced per IAS 1 / IFRS for SMEs. Period lock triggers DB immutability — audit trail preserved.
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
