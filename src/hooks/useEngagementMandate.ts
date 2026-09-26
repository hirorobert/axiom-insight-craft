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

import { useWorkspaceCapabilities } from "@/hooks/useWorkspaceCapabilities";
import { canExercise } from "@/lib/auth/workspaceCapabilities";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { EngagementAuthorityType, EngagementCapability, EngagementMandate } from "@/lib/workspace/mandate";
import { openEngagementWithScope, type RpcClient } from "@/lib/workspace/workspaceSetupClient";

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
  /** The person holds review_close in this workspace and the account has a current plan (never a job title). */
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
  const [loading, setLoading] = useState(true);
  const { state: capabilities } = useWorkspaceCapabilities(companyId);

  const load = useCallback(async () => {
    // `!user` is NOT the same condition as `!companyId || !periodYear`: the route params are
    // always synchronously available from useParams() the instant this component exists, so their
    // absence is a genuine, immediate "nothing to resolve" state. `user` starts null on every fresh
    // full-page load while Supabase's session restoration (async — reads and verifies a stored JWT)
    // is still in flight, and becomes non-null moments later without this hook's own knowledge —
    // this is "not yet known", not "resolved to no mandate". Setting loading=false here let
    // StageScopeGate observe loading=false with mandate still at its initial null on that one
    // stale tick and redirect away before the real fetch (triggered again once `user` populates,
    // since `user` is a dependency of this callback) ever completed — confirmed as the exact
    // mechanism behind the direct-URL-reload race to a locked stage bouncing to Overview.
    if (!user) return; // stay in the loading state; the effect reruns once `user` resolves.
    if (!companyId || !periodYear) {
      setLoading(false);
      return;
    }

    const { data: member } = await supabase
      .from("firm_members")
      .select("id")
      .eq("company_id", companyId)
      .eq("user_id", user.id)
      .not("accepted_at", "is", null)
      .maybeSingle();

    setMemberId(member?.id ?? null);

    // Reporting periods for this company; pick the one for this year.
    const { data: periods } = await supabase
      .from("fiscal_periods")
      .select("id, created_at, fiscal_year_end, reporting_end")
      .eq("company_id", companyId);

    // Deterministic: if a race ever created two periods for the year, the earliest-created is the period of record.
    const period = (periods ?? [])
      .filter(
        (p) =>
          yearOf(p.reporting_end as string | null) === periodYear ||
          yearOf(p.fiscal_year_end as string | null) === periodYear,
      )
      .sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)) || String(x.id).localeCompare(String(y.id)))[0];

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

    // The database guarantees at most ONE open engagement per reporting period (uq_engagements_one_open_per_period).
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
      if (!user) throw new Error("Sign in to choose services.");
      // Idempotent and convergent: repeated clicks, retries and concurrent requests end on ONE engagement.
      await openEngagementWithScope(supabase as unknown as RpcClient, { companyId, year: periodYear, capabilities, engagementType });
      await load();
    },
    [companyId, periodYear, user, load],
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
    canAmend: canExercise(capabilities, "review_close"),
    loading,
    refresh: load,
    createEngagement,
    grantCapability,
    revokeCapability,
  };
}