import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, User, Building2, Save, Loader2, CreditCard, ShieldCheck, Users } from "lucide-react";
import { toast } from "sonner";
import { AvatarUpload } from "@/components/AvatarUpload";
import { AuditTrail } from "@/components/AuditTrail";
import { FirmManagementPanel } from "@/components/FirmManagementPanel";
import { CompanyManager } from "@/components/CompanyManager";
import { PeriodCloseManager } from "@/components/PeriodCloseManager";
import { useAuditLog } from "@/hooks/useAuditLog";
import { useBillingSummary } from "@/hooks/useBillingSummary";
import { useMyEntityCapacity } from "@/hooks/useMyEntityCapacity";
import { CurrentPlanPanel } from "@/components/commercial/CurrentPlanPanel";
// ─────────────────────────────────────────────────────────────
// Settings — CFOClose Ω3-BRAND
//
// Five sections:
//   1. Profile
//   2. Firm & Team
//   3. Companies
//   4. Plan & Billing
//   5. Security & Audit
//
// Plan & Billing uses server-authoritative reads. Account plan status never authorizes writes.
// ─────────────────────────────────────────────────────────────

type SettingsSection = "profile" | "firm" | "companies" | "billing" | "security";

const SECTIONS: { id: SettingsSection; label: string; icon: React.FC<{ className?: string }> }[] = [
  { id: "profile",   label: "Profile",         icon: User },
  { id: "firm",      label: "Firm & Team",      icon: Users },
  { id: "companies", label: "Companies",        icon: Building2 },
  { id: "billing",   label: "Plan & Billing",   icon: CreditCard },
  { id: "security",  label: "Security & Audit", icon: ShieldCheck },
];

function SectionDivider({ title }: { title: string }) {
  return (
    <div className="mb-8">
      <div className="border-t border-border mb-1" />
      <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground/55 pt-4">
        {title}
      </p>
    </div>
  );
}

export default function Settings() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = useState<SettingsSection>("profile");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const { logAction } = useAuditLog();
  const { summary: billing, loading: billingLoading, error: billingError, retry: retryBilling } = useBillingSummary();
  const { capacity, loading: capacityLoading, error: capacityError, retry: retryCapacity } = useMyEntityCapacity(!!user);
  useEffect(() => {
    if (!authLoading && !user) navigate("/auth");
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (user) fetchProfile();
    // fetchProfile is defined in component scope and stable — intentionally omitted
    // from deps to avoid infinite re-fetch. Same pattern as pre-existing Settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const fetchProfile = async () => {
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("display_name, company_name, avatar_url")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (error) throw error;
      if (data) {
        setDisplayName(data.display_name || "");
        setCompanyName(data.company_name || "");
        setAvatarUrl(data.avatar_url);
      }
    } catch (error) {
      console.error("Error fetching profile:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const { data: existing } = await supabase
        .from("profiles").select("id").eq("user_id", user.id).maybeSingle();
      if (existing) {
        const { error } = await supabase.from("profiles")
          .update({ display_name: displayName.trim() || null, company_name: companyName.trim() || null })
          .eq("user_id", user.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("profiles")
          .insert({ user_id: user.id, display_name: displayName.trim() || null, company_name: companyName.trim() || null });
        if (error) throw error;
      }
      logAction({ action: "update_profile", metadata: { displayName: displayName.trim(), companyName: companyName.trim() } });
      toast.success("Profile updated successfully");
    } catch (error) {
      console.error("Error saving profile:", error);
      toast.error("Failed to update profile");
    } finally {
      setSaving(false);
    }
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12">

        {/* ── Back + title ── */}
        <Button variant="ghost" onClick={() => navigate("/dashboard")} className="mb-8 gap-2">
          <ArrowLeft className="w-4 h-4" />
          Back to Dashboard
        </Button>

        <div className="mb-10">
          <h1 className="text-3xl font-bold text-foreground">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your profile, firm, companies, billing and security.
          </p>
        </div>

        <div className="flex flex-col lg:flex-row gap-8">

          {/* ── Section nav ── */}
          <nav
            aria-label="Settings sections"
            className="lg:w-48 shrink-0"
          >
            {/* Mobile: horizontally scrollable tabs */}
            <div className="flex lg:flex-col gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden pb-2 lg:pb-0">
              {SECTIONS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  onClick={() => setActiveSection(id)}
                  aria-current={activeSection === id ? "page" : undefined}
                  className={`flex items-center gap-2.5 px-3 py-2.5 text-sm font-medium transition-colors whitespace-nowrap rounded-none lg:w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
                    activeSection === id
                      ? "bg-muted text-foreground border-l-2 border-primary"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/50 border-l-2 border-transparent"
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  {label}
                </button>
              ))}
            </div>
          </nav>

          {/* ── Section content ── */}
          <div className="flex-1 min-w-0">

            {/* 1. PROFILE */}
            {activeSection === "profile" && (
              <div>
                <SectionDivider title="Profile" />

                <div className="flex justify-center pb-6 border-b border-border mb-6">
                  <AvatarUpload
                    userId={user!.id}
                    currentAvatarUrl={avatarUrl}
                    displayName={displayName}
                    onAvatarChange={setAvatarUrl}
                  />
                </div>

                <div className="space-y-5 max-w-md">
                  <div className="space-y-1.5">
                    <Label htmlFor="email">Email address</Label>
                    <Input id="email" type="email" value={user?.email || ""} disabled className="bg-muted" />
                    <p className="text-xs text-muted-foreground">Email cannot be changed here.</p>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="displayName">Display name</Label>
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input id="displayName" placeholder="Enter your name" value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)} className="pl-10" />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="companyName">Company / firm name</Label>
                    <div className="relative">
                      <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                      <Input id="companyName" placeholder="Enter your firm name" value={companyName}
                        onChange={(e) => setCompanyName(e.target.value)} className="pl-10" />
                    </div>
                  </div>

                  <Button onClick={handleSave} disabled={saving} className="gap-2">
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    Save changes
                  </Button>
                </div>
              </div>
            )}

            {/* 2. FIRM & TEAM */}
            {activeSection === "firm" && (
              <div>
                <SectionDivider title="Firm & Team" />
                <FirmManagementPanel />
              </div>
            )}

            {/* 3. COMPANIES */}
            {activeSection === "companies" && (
              <div>
                <SectionDivider title="Companies" />
                <p className="text-xs text-muted-foreground mb-6 leading-relaxed">
                  Add and manage client companies. Jurisdiction-specific identifiers, such as the
                  tax identifier, are configured per company and applied only where the
                  filing jurisdiction requires them.
                </p>
                <CompanyManager />

                {/* Period Close is operational workflow, not account configuration.
                    Preserved here until a dedicated workspace entry point exists. */}
                <div className="mt-10 pt-8 border-t border-border">
                  <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground/55 mb-4">
                    Period Controls
                  </p>
                  <PeriodCloseManager userId={user?.id ?? ""} />
                </div>
              </div>
            )}

            {/* 4. PLAN & BILLING */}
            {activeSection === "billing" && (
              <div>
                <SectionDivider title="Plan & Billing" />
                <CurrentPlanPanel billing={billing} capacity={capacity} loading={billingLoading || capacityLoading} error={!!billingError || capacityError} onRetry={() => { retryBilling(); retryCapacity(); }} archiveOnly={!!billing && (billing.licenceStatus === "EXPIRED" || billing.licenceStatus === "CANCELLED" || !billing.licenceStatus) && (capacity?.used ?? 0) > 0} />


              </div>
            )}

            {/* 5. SECURITY & AUDIT */}
            {activeSection === "security" && (
              <div>
                <SectionDivider title="Security & Audit" />

                <div className="mb-8">
                  <p className="text-sm text-muted-foreground leading-relaxed max-w-lg">
                    Identity, tenant isolation, append-only records, and privileged operations
                    are enforced at the database and server boundary — not merely hidden
                    behind application controls.
                  </p>
                </div>

                {/* Audit trail — promoted from footer footnote to first-class section */}
                <div>
                  <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground/55 mb-4">
                    Audit trail
                  </p>
                  <p className="text-xs text-muted-foreground mb-6 leading-relaxed">
                    Every action taken under your account is recorded with the actor identity,
                    timestamp, and affected area. Records are append-only — no entry can be
                    deleted or silently altered.
                  </p>
                  <AuditTrail />
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}
