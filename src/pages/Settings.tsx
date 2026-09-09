import { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, User, Building2, Save, Loader2, CreditCard, ShieldCheck, Users, ExternalLink, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { AvatarUpload } from "@/components/AvatarUpload";
import { AuditTrail } from "@/components/AuditTrail";
import { FirmManagementPanel } from "@/components/FirmManagementPanel";
import { CompanyManager } from "@/components/CompanyManager";
import { PeriodCloseManager } from "@/components/PeriodCloseManager";
import { useAuditLog } from "@/hooks/useAuditLog";
import { useBillingSummary } from "@/hooks/useBillingSummary";
import { PRICING } from "@/constants/copy";
import {
  displayPlanName,
  displayEntitlement,
  displayLicenceStatus,
  licenceBadgeVariant,
  EFFECTIVE_END_LABEL,
} from "@/lib/commercial/billingDisplay";

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
// Checkout is DISABLED during Ω3-BRAND.
// The upgrade CTA routes to /pricing only.
// Raw plan codes (e.g. "PAID") are never shown to the customer.
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
  const { summary: billing, loading: billingLoading, error: billingError } = useBillingSummary();

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
                  Add and manage client companies. Jurisdiction-specific identifiers — such as
                  the Tanzania TRA Tax Identification Number — are configured per company and
                  applied only to engagements in that jurisdiction.
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

                {billingLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading plan details…
                  </div>
                ) : billingError ? (
                  <div className="border border-border p-5 flex items-start gap-3">
                    <AlertCircle className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                    <div>
                      <p className="text-sm font-medium text-foreground mb-1">Billing service unavailable</p>
                      <p className="text-xs text-muted-foreground">
                        Your plan details couldn't be loaded. Refresh to try again or contact support if the problem persists.
                      </p>
                    </div>
                  </div>
                ) : !billing || !billing.hasBillingCustomer ? (
                  /* No billing customer — show Free state */
                  <div className="space-y-6">
                    <div className="border border-border p-6">
                      <div className="flex flex-wrap items-center gap-3 mb-4">
                        <Badge variant="secondary">{PRICING.FREE_NAME}</Badge>
                        <Badge variant="default">Active</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed mb-4">
                        You are on the free plan. Start with one company and one active reporting period.
                        Upgrade to {PRICING.PAID_NAME} for unlimited companies, periods, and the full IFRS suite.
                      </p>
                      <Button variant="outline" size="sm" asChild className="gap-2">
                        <Link to="/pricing">
                          View plans
                          <ExternalLink size={13} />
                        </Link>
                      </Button>
                    </div>
                  </div>
                ) : (
                  /* Billing customer exists */
                  <div className="space-y-6">
                    <div className="border border-border p-6">
                      <div className="flex flex-wrap items-center gap-3 mb-4">
                        {/* Display customer-facing plan name, never raw plan code */}
                        <Badge variant="secondary">
                          {displayPlanName(billing.planCode)}
                        </Badge>
                        <Badge variant={licenceBadgeVariant(billing.licenceStatus)}>
                          {displayLicenceStatus(billing.licenceStatus)}
                        </Badge>
                        {billing.effectiveEnd && (
                          <span className="text-xs text-muted-foreground">
                            {EFFECTIVE_END_LABEL} {new Date(billing.effectiveEnd).toLocaleDateString()}
                          </span>
                        )}
                      </div>

                      {/* Pricing reference */}
                      {billing.planCode === "PAID" && (
                        <p className="text-xs text-muted-foreground mb-4">
                          {PRICING.PAID_NAME} — {PRICING.CURRENCY_CODE} {PRICING.ANNUAL_USD}/year or{" "}
                          {PRICING.CURRENCY_CODE} {PRICING.MONTHLY_USD}/month.{" "}
                          {PRICING.TAX_DISCLAIMER}
                        </p>
                      )}

                      {/* Included capabilities — friendly language, no raw feature codes */}
                      {billing.entitlements.length > 0 && (
                        <div className="mb-5">
                          <p className="text-xs font-semibold text-foreground mb-2">Included capabilities</p>
                          <ul className="space-y-1">
                            {billing.entitlements.map((code) => (
                              <li key={code} className="text-xs text-muted-foreground flex items-start gap-2">
                                <span className="text-success mt-0.5">·</span>
                                {displayEntitlement(code)}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* CTA — Ω3-BRAND: "View plans" → /pricing only. No checkout. */}
                      <div className="flex flex-wrap gap-3">
                        <Button variant="outline" size="sm" asChild className="gap-2">
                          <Link to="/pricing">
                            View plans
                            <ExternalLink size={13} />
                          </Link>
                        </Button>
                      </div>
                    </div>

                    {/* Grace / expired / suspended guidance */}
                    {billing.licenceStatus === "GRACE" && (
                      <div className="border border-border p-4 flex items-start gap-3">
                        <AlertCircle className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          Your licence is in a grace period. Access is maintained temporarily.
                          Visit the plans page to ensure continuity.
                        </p>
                      </div>
                    )}
                    {(billing.licenceStatus === "EXPIRED" || billing.licenceStatus === "SUSPENDED") && (
                      <div className="border border-destructive/30 p-4 flex items-start gap-3">
                        <AlertCircle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          Your access has lapsed. Visit the plans page or contact support to restore access.
                        </p>
                      </div>
                    )}
                    {billing.licenceStatus === "PENDING" && (
                      <div className="border border-border p-4 flex items-start gap-3">
                        <AlertCircle className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          Your licence is pending activation. Contact support if this persists.
                        </p>
                      </div>
                    )}
                  </div>
                )}
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
