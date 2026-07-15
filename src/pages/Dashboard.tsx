/**
 * Dashboard — Authenticated routing gateway.
 *
 * Does exactly three things:
 *   1. Guards against unauthenticated access → redirects to /auth
 *   2. Auto-accepts pending firm membership invitations
 *   3. Fetches companies and immediately routes to /workspace/:companyId/:year
 *      — even when no upload exists yet.
 *      — shows a minimal onboarding screen only when the firm has zero companies.
 *
 * Zero accounting panels. Zero upload management. Zero financial logic.
 * Those live in their respective workspace stage pages.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { CompanyManager } from "@/components/CompanyManager";
import { SaffLogo } from "@/components/SaffLogo";
import { Skeleton } from "@/components/ui/skeleton";
import { Building2 } from "lucide-react";

interface Company {
  id: string;
  name: string;
  fiscal_year_end: string | null;
}

/**
 * Return the most recently completed fiscal year for a company.
 * Accounting firms in mid-year are typically working on the prior closed year.
 * If fiscal_year_end is set, use its year (e.g. "2025-12-31" → 2025).
 * Otherwise fall back to current calendar year − 1.
 */
function resolvePeriodYear(fiscalYearEnd: string | null): number {
  if (fiscalYearEnd) {
    const year = new Date(fiscalYearEnd).getFullYear();
    if (year > 2000) return year;
  }
  return new Date().getFullYear() - 1;
}

export default function Dashboard() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [noCompanies, setNoCompanies] = useState(false);

  // ── 1. Auth guard ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/auth", { replace: true });
    }
  }, [user, authLoading, navigate]);

  // ── 2. Auto-accept firm invitation ────────────────────────────────────────
  // When an invited user logs in for the first time, accepted_at is null.
  // We set it so the user becomes active in the firm without a separate step.
  useEffect(() => {
    if (!user) return;
    supabase
      .from("firm_members")
      .update({ accepted_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .is("accepted_at", null)
      .then(({ error }) => {
        if (error) console.warn("firm_members auto-accept:", error.message);
      });
  }, [user?.id]);

  // ── 3. Fetch companies → route or show onboarding ─────────────────────────
  useEffect(() => {
    if (!user) return;

    let cancelled = false;

    const checkAndRoute = async () => {
      setLoading(true);
      setNoCompanies(false);

      const { data } = await supabase
        .from("companies")
        .select("id, name, fiscal_year_end")
        .eq("is_active", true)
        .order("created_at", { ascending: false });

      if (cancelled) return;

      if (data && data.length > 0) {
        const latest = data[0] as Company;
        const year = resolvePeriodYear(latest.fiscal_year_end);
        navigate(`/workspace/${latest.id}/${year}`, { replace: true });
        // leave loading=true — route change unmounts this component
      } else {
        setNoCompanies(true);
        setLoading(false);
      }
    };

    checkAndRoute();

    return () => { cancelled = true; };
  }, [user?.id]); // re-runs only when the authenticated user changes

  // ── Loading / redirect in flight ──────────────────────────────────────────
  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-3">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-3 w-28" />
      </div>
    );
  }

  // ── Onboarding: no companies yet ──────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border h-14 flex items-center px-6">
        <SaffLogo variant="header" className="h-7 w-auto" />
      </header>

      <main className="flex flex-col items-center justify-center min-h-[calc(100vh-3.5rem)] px-6">
        <div className="w-full max-w-sm space-y-6 text-center">
          <div className="mx-auto w-10 h-10 rounded-full bg-secondary flex items-center justify-center">
            <Building2 className="w-5 h-5 text-muted-foreground" />
          </div>

          <div>
            <h1 className="text-lg font-semibold text-foreground">
              No engagements yet
            </h1>
            <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
              Add your first client company to begin preparing financial
              statements and tax computations.
            </p>
          </div>

          {/* CompanyManager opens a dialog to create the first company.
              After creation, reload the page — the gateway will then
              find the new company and route to its workspace. */}
          <CompanyManager />

          <p className="text-xs text-muted-foreground">
            After adding a company, reload the page to open the workspace.
          </p>
        </div>
      </main>
    </div>
  );
}
