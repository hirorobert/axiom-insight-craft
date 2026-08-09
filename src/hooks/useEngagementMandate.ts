/**
 * useEngagementMandate — authoritative read of the engagement mandate.
 *
 * Compatibility routing: the URL still carries (companyId, periodYear). That
 * pair resolves to the reporting period, and the reporting period resolves to
 * its open engagement. `engagement.id` is the canonical internal identity from
 * here on; the year is presentation metadata only.
 *
 * Reads only. Every mutation goes through the validated append-only commands
 * (grant/revoke), never a direct insert into an event table.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { EngagementAuthorityType, EngagementCapability, EngagementMandate } from "@/lib/workspace/mandate";

export interface EngagementRecord {
  id: string;
  fiscal_period_id: string;
  company_id: string;
  engagement_type: string;
  status: string;
  opened_at: string;
  closed_at: string | null;
}

export interface AuthorityGrant {
  authority_type: EngagementAuthorityType;
  granted: boolean;
  jurisdiction: string | null;
  filing_type: string | null;
  effective_from: string | null;
  expires_at: string | null;
}

export interface MandateEventRow {
  id: string;
  capability: EngagementCapability;
  action: "GRANT" | "REVOKE";
  sequence_no: number;
  occurred_at: string;
  reason: string | null;
}

export interface UseEngagementMandateReturn {
  engagement: EngagementRecord | null;
  /** null = no mandate declared yet. Never treat null as "nothing in scope". */
  mandate: EngagementMandate | null;
  authorities: AuthorityGrant[];
  events: MandateEventRow[];
  /** Owner / partner / manager may amend scope. */
  canAmend: boolean;
  loading: boolean;
  refresh: () => void;
  createEngagement: (
    capabilities: EngagementCapability[],
    engagementType?: string,
  ) => Promise<void>;
  grantCapability: (cap: EngagementCapability, reason?: string) => Promise<void>;
  revokeCapability: (cap: EngagementCapability, reason?: string) => Promise<void>;
}

const SENIOR_ROLES = ["owner", "partner", "manager"];

function yearOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d.getFullYear();
}

export function useEngagementMandate(
  companyId: string,
  periodYear: number,
): UseEngagementMandateReturn {
  const { user } = useAuth();
  const [engagement, setEngagement] = useState<EngagementRecord | null>(null);
  const [granted, setGranted] = useState<EngagementCapability[] | null>(null);
  const [authorities, setAuthorities] = useState<AuthorityGrant[]>([]);
  const [events, setEvents] = useState<MandateEventRow[]>([]);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user || !companyId || !periodYear) {
      setLoading(false);
      return;
    }

    const { data: member } = await supabase
      .from("firm_members")
      .select("id, role")
      .eq("company_id", companyId)
      .eq("user_id", user.id)
      .not("accepted_at", "is", null)
      .maybeSingle();

    setMemberId(member?.id ?? null);
    setRole(member?.role ?? null);

    // Reporting periods for this company; pick the one for this year.
    const { data: periods } = await supabase
      .from("fiscal_periods")
      .select("id, fiscal_year_end, reporting_end")
      .eq("company_id", companyId);

    const period = (periods ?? []).find(
      (p) =>
        yearOf(p.reporting_end as string | null) === periodYear ||
        yearOf(p.fiscal_year_end as string | null) === periodYear,
    );

    if (!period) {
      setEngagement(null);
      setGranted(null);
      setAuthorities([]);
      setEvents([]);
      setLoading(false);
      return;
    }

    const { data: engagements } = await supabase
      .from("engagements")
      .select("id, fiscal_period_id, company_id, engagement_type, status, opened_at, closed_at")
      .eq("fiscal_period_id", period.id)
      .order("opened_at", { ascending: false });

    // Compatibility resolution: the open engagement of record for this period.
    const open = (engagements ?? []).find((e) => e.status === "open") ?? null;
    setEngagement((open as EngagementRecord | null) ?? null);

    if (!open) {
      setGranted(null);
      setAuthorities([]);
      setEvents([]);
      setLoading(false);
      return;
    }

    const [foldRes, authRes, eventRes] = await Promise.all([
      supabase.rpc("fold_engagement_mandate", { p_engagement_id: open.id }),
      supabase.rpc("fold_engagement_authority", { p_engagement_id: open.id }),
      supabase
        .from("engagement_mandate_events")
        .select("id, capability, action, sequence_no, occurred_at, reason")
        .eq("engagement_id", open.id)
        .order("sequence_no", { ascending: false }),
    ]);

    const fold = (foldRes.data ?? []) as { capability: string; granted: boolean }[];
    setGranted(fold.filter((r) => r.granted).map((r) => r.capability as EngagementCapability));
    setAuthorities((authRes.data ?? []) as unknown as AuthorityGrant[]);
    setEvents((eventRes.data ?? []) as unknown as MandateEventRow[]);
    setLoading(false);
  }, [user, companyId, periodYear]);

  useEffect(() => {
    load();
  }, [load]);

  const createEngagement = useCallback(
    async (capabilities: EngagementCapability[], engagementType = "composite") => {
      if (!memberId) throw new Error("You are not an accepted member of this company.");
      if (capabilities.length === 0) throw new Error("Choose at least one outcome.");

      // Reporting period of record for this year, created on first use.
      const { data: periods } = await supabase
        .from("fiscal_periods")
        .select("id, fiscal_year_end, reporting_end")
        .eq("company_id", companyId);

      let periodId = (periods ?? []).find(
        (p) =>
          yearOf(p.reporting_end as string | null) === periodYear ||
          yearOf(p.fiscal_year_end as string | null) === periodYear,
      )?.id;

      if (!periodId) {
        const { data: created, error } = await supabase
          .from("fiscal_periods")
          .insert({
            company_id: companyId,
            fiscal_year_end: `${periodYear}-12-31`,
            reporting_start: `${periodYear}-01-01`,
            reporting_end: `${periodYear}-12-31`,
            period_label: `FY${periodYear}`,
          })
          .select("id")
          .single();
        if (error) throw error;
        periodId = created.id;
      }

      const { data: eng, error: engErr } = await supabase
        .from("engagements")
        .insert({
          fiscal_period_id: periodId,
          company_id: companyId,
          engagement_type: engagementType,
          created_by_member_id: memberId,
        })
        .select("id")
        .single();
      if (engErr) throw engErr;

      for (const cap of capabilities) {
        const { error } = await supabase.rpc("grant_engagement_capability", {
          p_engagement_id: eng.id,
          p_capability: cap,
          p_reason: "Declared when the engagement was opened",
        });
        if (error) throw error;
      }

      await load();
    },
    [companyId, periodYear, memberId, load],
  );

  const grantCapability = useCallback(
    async (cap: EngagementCapability, reason?: string) => {
      if (!engagement) throw new Error("No open engagement for this period.");
      const { error } = await supabase.rpc("grant_engagement_capability", {
        p_engagement_id: engagement.id,
        p_capability: cap,
        p_reason: reason ?? null,
      });
      if (error) throw error;
      await load();
    },
    [engagement, load],
  );

  const revokeCapability = useCallback(
    async (cap: EngagementCapability, reason?: string) => {
      if (!engagement) throw new Error("No open engagement for this period.");
      const { error } = await supabase.rpc("revoke_engagement_capability", {
        p_engagement_id: engagement.id,
        p_capability: cap,
        p_reason: reason ?? null,
      });
      if (error) throw error;
      await load();
    },
    [engagement, load],
  );

  const mandate = useMemo<EngagementMandate | null>(
    () => (engagement && granted ? { engagementId: engagement.id, granted } : null),
    [engagement, granted],
  );

  return {
    engagement,
    mandate,
    authorities,
    events,
    canAmend: !!role && SENIOR_ROLES.includes(role),
    loading,
    refresh: load,
    createEngagement,
    grantCapability,
    revokeCapability,
  };
}