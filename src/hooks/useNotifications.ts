/**
 * useNotifications.ts
 * Sprint 6 Item 2 — Iron Dome Nuclear Design
 *
 * Queries real DB state to produce categorised alert counts.
 * All counts from live data — no fabricated numbers.
 * Refreshes every 60 seconds while mounted.
 */

import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface NotificationCategory {
  key: string;
  label: string;
  count: number;
  items: NotificationItem[];
  severity: "critical" | "warn" | "info";
}

export interface NotificationItem {
  id: string;
  title: string;
  detail: string;
  companyName?: string;
  href?: string;
}

export interface NotificationState {
  totalCount: number;
  categories: NotificationCategory[];
  loading: boolean;
  refresh: () => void;
}

export function useNotifications(userId: string | undefined): NotificationState {
  const [state, setState] = useState<Omit<NotificationState, "refresh">>({
    totalCount: 0,
    categories: [],
    loading: true,
  });

  const fetch = useCallback(async () => {
    if (!userId) {
      setState({ totalCount: 0, categories: [], loading: false });
      return;
    }

    // ── 1. Open / in-progress findings ────────────────────────────────────
    const { data: findings } = await supabase
      .from("findings")
      .select("id, title, finding_category, exposure_amount_tzs, companies(name)")
      .in("status", ["open", "in_progress"])
      .order("exposure_amount_tzs", { ascending: false })
      .limit(20);

    const findingItems: NotificationItem[] = (findings ?? []).map(f => ({
      id: f.id,
      title: f.title,
      detail: `TZS ${Number(f.exposure_amount_tzs ?? 0).toLocaleString("en-TZ", { maximumFractionDigits: 0 })} exposure`,
      companyName: (f.companies as any)?.name,
      href: "/dashboard",
    }));

    // ── 2. Draft AJEs awaiting approval ───────────────────────────────────
    const { data: ajeData } = await supabase
      .from("adjusting_journal_entries")
      .select("id, aje_number, description, companies(name)")
      .eq("status", "draft")
      .order("created_at", { ascending: true })
      .limit(20);

    const ajeItems: NotificationItem[] = (ajeData ?? []).map(a => ({
      id: a.id,
      title: `${a.aje_number}: ${a.description}`,
      detail: "Draft — awaiting partner/owner approval",
      companyName: (a.companies as any)?.name,
      href: "/dashboard",
    }));

    // ── 3. Pending period sign-offs ────────────────────────────────────────
    const { data: signOffs } = await supabase
      .from("statement_sign_offs")
      .select("id, period_year, status, companies(name)")
      .not("status", "eq", "locked")
      .order("period_year", { ascending: false })
      .limit(20);

    const signOffItems: NotificationItem[] = (signOffs ?? []).map(s => {
      const statusLabel: Record<string, string> = {
        draft: "No signatures yet",
        preparer_signed: "Awaiting reviewer",
        reviewer_signed: "Awaiting approver",
        approved: "Approved — not yet locked",
      };
      return {
        id: s.id,
        title: `FY${s.period_year} — ${(s.companies as any)?.name ?? "Unknown"}`,
        detail: statusLabel[s.status] ?? s.status,
        companyName: (s.companies as any)?.name,
        href: "/settings",
      };
    });

    // ── 4. Overdue obligations (findings past period_end + 30 day grace) ──
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const { data: overdue } = await supabase
      .from("findings")
      .select("id, title, period_end, companies(name)")
      .in("status", ["open", "in_progress"])
      .lt("period_end", cutoff.toISOString().split("T")[0])
      .order("period_end", { ascending: true })
      .limit(20);

    const overdueItems: NotificationItem[] = (overdue ?? []).map(f => ({
      id: f.id,
      title: f.title,
      detail: `Due date passed: ${f.period_end ? new Date(f.period_end).toLocaleDateString("en-GB") : "unknown"}`,
      companyName: (f.companies as any)?.name,
      href: "/dashboard",
    }));

    // ── Assemble ──────────────────────────────────────────────────────────
    const categories: NotificationCategory[] = [
      {
        key: "overdue",
        label: "Overdue Obligations",
        count: overdueItems.length,
        items: overdueItems,
        severity: "critical" as const,
      },
      {
        key: "findings",
        label: "Open Findings",
        count: findingItems.length,
        items: findingItems,
        severity: "warn" as const,
      },
      {
        key: "ajes",
        label: "Draft AJEs",
        count: ajeItems.length,
        items: ajeItems,
        severity: "warn" as const,
      },
      {
        key: "signoffs",
        label: "Pending Sign-offs",
        count: signOffItems.length,
        items: signOffItems,
        severity: "info" as const,
      },
    ].filter(c => c.count > 0);

    const totalCount = overdueItems.length + ajeItems.length + signOffItems.length;
    // Note: open findings not counted in total badge (too noisy) — only overdue+AJE+signoff

    setState({ totalCount, categories, loading: false });
  }, [userId]);

  useEffect(() => {
    fetch();
    const interval = setInterval(fetch, 60_000);
    return () => clearInterval(interval);
  }, [fetch]);

  return { ...state, refresh: fetch };
}
