import { PORTFOLIO_PAGE_SIZE } from "./portfolioClient";

/** Supplemental display metadata for this visible page only. RLS stays in force; never filters or authorises a row. */
export async function readPortfolioFrameworks(companyIds: readonly string[]): Promise<Record<string, string | null>> {
  const ids = [...new Set(companyIds)].slice(0, PORTFOLIO_PAGE_SIZE);
  if (!ids.length) return {};
  const { supabase } = await import("@/integrations/supabase/client");
  const { data, error } = await supabase.from("companies").select("id, reporting_framework").in("id", ids).limit(PORTFOLIO_PAGE_SIZE);
  if (error) return {};
  return Object.fromEntries((data ?? []).filter((r) => ids.includes(r.id)).map((r) => [r.id, r.reporting_framework]));
}
