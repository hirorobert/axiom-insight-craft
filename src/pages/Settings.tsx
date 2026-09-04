import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, User, Building2, Save, Loader2, CreditCard } from "lucide-react";
import { toast } from "sonner";
import { AvatarUpload } from "@/components/AvatarUpload";
import { AuditTrail } from "@/components/AuditTrail";
import { FirmManagementPanel } from "@/components/FirmManagementPanel";
import { CompanyManager } from "@/components/CompanyManager";
import { PeriodCloseManager } from "@/components/PeriodCloseManager";
import { useAuditLog } from "@/hooks/useAuditLog";
import { Badge } from "@/components/ui/badge";
import { useBillingSummary } from "@/hooks/useBillingSummary";
import { FEATURE_DESCRIPTIONS, isFeatureCode } from "@/lib/commercial/featureRegistry";

export default function Settings() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const { logAction } = useAuditLog();
  const { summary: billing, loading: billingLoading } = useBillingSummary();

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth");
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (user) {
      fetchProfile();
    }
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
      // Check if profile exists
      const { data: existing } = await supabase
        .from("profiles")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (existing) {
        // Update existing profile
        const { error } = await supabase
          .from("profiles")
          .update({
            display_name: displayName.trim() || null,
            company_name: companyName.trim() || null,
          })
          .eq("user_id", user.id);

        if (error) throw error;
      } else {
        // Create new profile
        const { error } = await supabase
          .from("profiles")
          .insert({
            user_id: user.id,
            display_name: displayName.trim() || null,
            company_name: companyName.trim() || null,
          });

        if (error) throw error;
      }

      logAction({
        action: "update_profile",
        metadata: { displayName: displayName.trim(), companyName: companyName.trim() },
      });
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
      <div className="max-w-2xl mx-auto px-6 py-12 space-y-8">
        <Button
          variant="ghost"
          onClick={() => navigate("/dashboard")}
          className="mb-8 gap-2"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Dashboard
        </Button>

        <div className="space-y-2 mb-8">
          <h1 className="text-3xl font-bold text-foreground">Profile Settings</h1>
          <p className="text-muted-foreground">
            Manage your account information and preferences
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <User className="w-5 h-5" />
              Personal Information
            </CardTitle>
            <CardDescription>
              Update your profile details that appear across the platform
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex justify-center pb-4 border-b border-border">
              <AvatarUpload
                userId={user!.id}
                currentAvatarUrl={avatarUrl}
                displayName={displayName}
                onAvatarChange={setAvatarUrl}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email Address</Label>
              <Input
                id="email"
                type="email"
                value={user?.email || ""}
                disabled
                className="bg-muted"
              />
              <p className="text-xs text-muted-foreground">
                Email cannot be changed
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="displayName">Display Name</Label>
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  id="displayName"
                  placeholder="Enter your name"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="companyName">Company Name</Label>
              <div className="relative">
                <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  id="companyName"
                  placeholder="Enter your company name"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>

            <Button
              onClick={handleSave}
              disabled={saving}
              className="w-full gap-2"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              Save Changes
            </Button>
          </CardContent>
        </Card>

        {/* Plan & Billing — Ω1 commercial foundation. Read-only summary of
            server-authoritative state (get_my_billing_summary RPC). The
            upgrade action below is an explicit placeholder — no payment
            provider or checkout exists yet; see PRICING_SECTION copy. */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CreditCard className="w-5 h-5" />
              Plan & Billing
            </CardTitle>
            <CardDescription>
              Your current plan, licence status, and included capabilities
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {billingLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading plan details…
              </div>
            ) : !billing || !billing.hasBillingCustomer || !billing.planCode ? (
              <p className="text-sm text-muted-foreground">
                No plan information is available yet for this account.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <Badge variant="secondary" className="text-sm">
                    {billing.planCode} plan
                  </Badge>
                  <Badge
                    variant={billing.licenceStatus === "ACTIVE" || billing.licenceStatus === "GRACE" ? "default" : "outline"}
                    className="text-sm"
                  >
                    {billing.licenceStatus ?? "UNKNOWN"}
                  </Badge>
                  {billing.effectiveEnd && (
                    <span className="text-xs text-muted-foreground">
                      Effective through {new Date(billing.effectiveEnd).toLocaleDateString()}
                    </span>
                  )}
                </div>

                <div>
                  <p className="text-xs font-semibold text-foreground mb-2">Included capabilities</p>
                  <ul className="space-y-1">
                    {billing.entitlements.map((code) => (
                      <li key={code} className="text-sm text-muted-foreground">
                        • {isFeatureCode(code) ? FEATURE_DESCRIPTIONS[code] : code}
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}

            <Button variant="outline" disabled className="w-full gap-2">
              Upgrade — coming soon
            </Button>
            <p className="text-xs text-muted-foreground">
              Self-service upgrade is not yet available. Contact us to activate a
              firm licence.
            </p>
          </CardContent>
        </Card>

        {/* Team & Access — Firm Member Management */}
        <FirmManagementPanel />

        {/* Companies & TRA TIN — the entry point the TIN warnings point to */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="w-5 h-5" />
              Companies & TRA TIN
            </CardTitle>
            <CardDescription>
              Add clients and set each company's TRA Tax Identification Number. A TIN is required
              before trial balances can be uploaded or TRA documents produced.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CompanyManager />
          </CardContent>
        </Card>

        {/* Period Close Manager — 3-tier sign-off across all companies */}
        <PeriodCloseManager userId={user?.id ?? ""} />

        {/* Audit Trail — admin-level action log */}
        <AuditTrail />
      </div>
    </div>
  );
}
