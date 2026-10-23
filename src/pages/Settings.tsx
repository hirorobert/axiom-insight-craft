import { useManagementSurface, useManagementEditGuard } from "@/components/account/managementState";
import { useBusyState } from "@/hooks/useBusyState";
import { PendingStatus } from "@/components/feedback/Activity";
import { useState, useEffect, useRef } from "react";
import { useNavigate, Link, useSearchParams } from "react-router-dom";
import { AccountShell } from "@/components/account/AccountShell";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { User, Building2, Save, CreditCard, ShieldCheck, Users } from "lucide-react";
import { BillingHelpLine } from "@/components/contact/ContactChannels";
import { toast } from "sonner";
import { AvatarUpload } from "@/components/AvatarUpload";
import { AuditTrail } from "@/components/AuditTrail";
import { FirmManagementPanel } from "@/components/FirmManagementPanel";
import { CompanyManager } from "@/components/CompanyManager";
import { useAuditLog } from "@/hooks/useAuditLog";
import { useBillingSummary } from "@/hooks/useBillingSummary";
import { useMyEntityCapacity } from "@/hooks/useMyEntityCapacity";
import { CurrentPlanPanel } from "@/components/commercial/CurrentPlanPanel";
import { CommercialAdminLink, useIsCommercialAdmin } from "@/components/commercial/CommercialAdminLink";
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
    <div className="mb-6 border-b border-border pb-4">
      <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
    </div>
  );
}

export default function Settings() {
  const { user, loading: authLoading, signOut } = useAuth();
  const isCommercialAdmin = useIsCommercialAdmin(user?.id);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const requested = params.get("section");
  const activeSection: SettingsSection = SECTIONS.some((s) => s.id === requested) ? requested as SettingsSection : "profile";
  const setActiveSection = (section: SettingsSection) => setParams({ section });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useBusyState("Saving profile…");
  const [displayName, setDisplayName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const { logAction } = useAuditLog();
  const management = useManagementSurface();
  const [savedProfile, setSavedProfile] = useState({ displayName: "", companyName: "" });
  const [profileError, setProfileError] = useState(false);
  const profileRead = useRef(0);
  const profileDirty = displayName !== savedProfile.displayName || companyName !== savedProfile.companyName;
  useManagementEditGuard(profileDirty, saving, () => { setDisplayName(savedProfile.displayName); setCompanyName(savedProfile.companyName); });
  const { summary: billing, loading: billingLoading, error: billingError, retry: retryBilling } = useBillingSummary();
  const { capacity, loading: capacityLoading, error: capacityError, retry: retryCapacity } = useMyEntityCapacity(!!user);
  useEffect(() => {
    if (!authLoading && !user) navigate("/auth");
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (user) { setLoading(true); void fetchProfile(); }
    return () => { ++profileRead.current; };
    // fetchProfile is defined in component scope and stable — intentionally omitted
    // from deps to avoid infinite re-fetch. Same pattern as pre-existing Settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const fetchProfile = async () => {
    setLoading(true);
    const read = ++profileRead.current;
    setProfileError(false);
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("display_name, company_name, avatar_url")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (read !== profileRead.current) return;
      if (error) throw error;
      if (data) {
        setDisplayName(data.display_name || "");
        setCompanyName(data.company_name || "");
        setAvatarUrl(data.avatar_url);
        setSavedProfile({ displayName: data.display_name || "", companyName: data.company_name || "" });
      }
    } catch (error) {
      console.error("Error fetching profile:", error);
      if (read === profileRead.current) setProfileError(true);
    } finally {
      if (read === profileRead.current) setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!user) return;
    if (!setSaving(true)) return;
    try {
      const { data: existing, error: existingError } = await supabase
        .from("profiles").select("id").eq("user_id", user.id).maybeSingle();
      if (existingError) throw existingError;
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
      setSavedProfile({ displayName, companyName });
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
      <div className={management ? "flex min-h-64 items-center justify-center" : "min-h-screen bg-background flex items-center justify-center"}>
        <PendingStatus label="Loading settings…" className="w-full max-w-3xl px-6" skeleton />
      </div>
    );
  }

  return (
    <AccountShell onSignOut={signOut} identity={{ name: displayName, email: user?.email }}>
      <div className="mx-auto w-full max-w-6xl">

        {!management && <div className="mb-10">
          <h1 className="text-3xl font-bold text-foreground">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage your profile, firm, companies, billing and security.
          </p>
        </div>}

        <div className="flex flex-col lg:flex-row gap-6">

          {/* ── Section nav ── */}
          {!management && <nav
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
          </nav>}

          {/* ── Section content ── */}
          <div className={management ? "flex-1 min-w-0" : "flex-1 min-w-0 border border-border bg-card p-5 sm:p-7"}>

            {/* 1. PROFILE */}
            {activeSection === "profile" && (
              <div>
                <SectionDivider title="Profile" />

                <div className="mb-6 flex items-center gap-5 border-b border-border pb-6">
                  <AvatarUpload compact
                    userId={user!.id}
                    currentAvatarUrl={avatarUrl}
                    displayName={displayName}
                    onAvatarChange={setAvatarUrl}
                  />
                </div>

                {profileError && <div role="alert" className="mb-5 border border-destructive/30 p-4 text-sm">Your profile could not be loaded. <Button variant="outline" size="sm" onClick={fetchProfile}>Try again</Button></div>}
                <fieldset disabled={saving || profileError} className="space-y-5 max-w-lg">
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

                  <Button onClick={handleSave} pending={saving} pendingLabel="Saving…" disabled={saving || profileError || !profileDirty} className="gap-2">
                    {!saving && <Save className="w-4 h-4" />}
                    Save changes
                  </Button>
                </fieldset>
              </div>
            )}

            {/* 2. FIRM & TEAM */}
            {activeSection === "firm" && (
              <div>
                <SectionDivider title="Practice & team" />
                <FirmManagementPanel />
              </div>
            )}

            {/* 3. COMPANIES */}
            {activeSection === "companies" && (
              <div>
                <SectionDivider title="Companies" />
                <p className="text-xs text-muted-foreground mb-6 leading-relaxed">
                  Add and manage client companies. Jurisdiction-specific identifiers, such as the
                  tax identifier, are configured per company and applied only where a
                  jurisdiction requires them.
                </p>
                <CompanyManager presentation="inline" />

                {/* Period Controls (statement sign-off) belong to the withheld statement certification
                    (src/lib/workspace/moduleAvailability.ts): PeriodCloseManager is not imported while it is withheld. Its records
                    are untouched; restore the import and this section when certification is released. */}
              </div>
            )}

            {/* 4. PLAN & BILLING */}
            {activeSection === "billing" && (
              <div>
                <SectionDivider title="Plan & Billing" />
                <BillingHelpLine className="mb-4" subject="Plan and billing" />
                <CommercialAdminLink visible={isCommercialAdmin} />
                <CurrentPlanPanel billing={billing} capacity={capacity} loading={billingLoading || capacityLoading} error={!!billingError} onRetry={() => { retryBilling(); retryCapacity(); }} archiveOnly={!!billing && (billing.licenceStatus === "EXPIRED" || billing.licenceStatus === "CANCELLED" || !billing.licenceStatus) && (capacity?.used ?? 0) > 0} />


              </div>
            )}

            {/* 5. SECURITY & AUDIT */}
            {activeSection === "security" && (
              <div>
                <SectionDivider title="Security & activity" />

                <div className="mb-8">
                  <p className="text-sm text-muted-foreground leading-relaxed max-w-lg">
                    Review the account activity available to you. Access to company records and privileged actions is controlled by your assigned permissions.
                  </p>
                </div>

                {/* Audit trail — promoted from footer footnote to first-class section */}
                <div>
                  <p className="text-sm font-semibold text-foreground mb-3">
                    Audit trail
                  </p>
                  <p className="text-xs text-muted-foreground mb-6 leading-relaxed">
                    Recorded events show the actor, time and affected area where available.
                  </p>
                  <AuditTrail />
                </div>
              </div>
            )}

          </div>
        </div>
      </div>
    </AccountShell>
  );
}
