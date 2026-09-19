/**
 * Supabase adapter for EngagementPort. Every call is an ordinary user-level call: RLS and the SECURITY DEFINER
 * grant command remain the authority. Nothing here writes to a financial table.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { EngagementCapability } from "./mandate";
import type { EngagementPort } from "./engagementSetup";

const yearOf = (v: string | null | undefined) => {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.getFullYear();
};

export function supabaseEngagementPort(supabase: SupabaseClient, userId: string): EngagementPort {
  return {
    async memberOf(companyId) {
      const { data } = await supabase
        .from("firm_members")
        .select("id, role")
        .eq("company_id", companyId)
        .eq("user_id", userId)
        .not("accepted_at", "is", null)
        .limit(1)
        .maybeSingle();
      return data ? { id: data.id as string, role: data.role as string } : null;
    },
    async periodsFor(companyId, year) {
      const { data } = await supabase.from("fiscal_periods").select("id, created_at, fiscal_year_end, reporting_end").eq("company_id", companyId);
      return (data ?? [])
        .filter((p) => yearOf(p.reporting_end as string | null) === year || yearOf(p.fiscal_year_end as string | null) === year)
        .map((p) => ({ id: p.id as string, created_at: p.created_at as string }));
    },
    async createPeriod(companyId, year) {
      const { data, error } = await supabase
        .from("fiscal_periods")
        .insert({ company_id: companyId, fiscal_year_end: `${year}-12-31`, reporting_start: `${year}-01-01`, reporting_end: `${year}-12-31`, period_label: `FY${year}`, created_by: userId })
        .select("id")
        .single();
      if (error) throw error;
      return { id: data.id as string };
    },
    async openEngagements(periodId) {
      const { data, error } = await supabase.from("engagements").select("id, opened_at").eq("fiscal_period_id", periodId).eq("status", "open");
      if (error) throw error;
      return (data ?? []).map((e) => ({ id: e.id as string, opened_at: e.opened_at as string }));
    },
    async createEngagement(periodId, companyId, memberId, engagementType) {
      const { data, error } = await supabase
        .from("engagements")
        .insert({ fiscal_period_id: periodId, company_id: companyId, engagement_type: engagementType, created_by_member_id: memberId })
        .select("id")
        .single();
      if (error) throw error;
      return { id: data.id as string };
    },
    async closeEngagement(engagementId) {
      const { error } = await supabase.from("engagements").update({ status: "closed", closed_at: new Date().toISOString() }).eq("id", engagementId).eq("status", "open");
      if (error) throw error;
    },
    async granted(engagementId) {
      const { data, error } = await supabase.rpc("fold_engagement_mandate", { p_engagement_id: engagementId });
      if (error) throw error;
      return ((data ?? []) as { capability: string; granted: boolean }[]).filter((r) => r.granted).map((r) => r.capability as EngagementCapability);
    },
    async grant(engagementId, capability, reason) {
      const { error } = await supabase.rpc("grant_engagement_capability", { p_engagement_id: engagementId, p_capability: capability, p_reason: reason });
      if (error) throw error;
    },
  };
}
