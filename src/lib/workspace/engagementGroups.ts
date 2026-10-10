/**
 * engagementGroups — the account home's grouping of open engagements: by company, each company's periods with their
 * dates, and test or training workspaces apart from client work. Pure.
 *
 * A workspace's purpose is explicit, recorded metadata (workspace_purpose_events, 20261027100000) — never inferred from a
 * company name, a code or an account number. No recorded purpose is "not stated" and is listed with client work.
 * Companies with the same name are told apart by their code, else by when they were created; nothing is merged.
 */

export type WorkspacePurpose = "client" | "test" | "training";

export const PURPOSE_WORDS: Readonly<Record<WorkspacePurpose, string>> = { client: "Client work", test: "Test workspace", training: "Training workspace" };

export interface GroupableEngagement {
  readonly engagementId: string;
  readonly companyId: string;
  readonly companyName: string;
  readonly companyCode?: string | null;
  readonly companyCreatedAt?: string | null;
  readonly periodYear: number;
  readonly periodStart?: string | null;
  readonly periodEnd?: string | null;
  readonly workspacePurpose?: WorkspacePurpose | null;
}

export interface CompanyGroup<E extends GroupableEngagement> {
  readonly companyId: string;
  readonly companyName: string;
  /** Shown only when another listed company has the same name: its code, else its creation date. */
  readonly distinguisher: string | null;
  readonly purpose: WorkspacePurpose | null;
  /** Latest period first. */
  readonly periods: readonly E[];
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function groupEngagements<E extends GroupableEngagement>(entries: readonly E[]): { client: CompanyGroup<E>[]; test: CompanyGroup<E>[] } {
  const byCompany = new Map<string, E[]>();
  for (const e of entries) byCompany.set(e.companyId, [...(byCompany.get(e.companyId) ?? []), e]);
  const nameCount = new Map<string, number>();
  for (const list of byCompany.values()) nameCount.set(norm(list[0].companyName), (nameCount.get(norm(list[0].companyName)) ?? 0) + 1);
  const groups: CompanyGroup<E>[] = [...byCompany.entries()].map(([companyId, list]) => {
    const first = list[0];
    const duplicate = (nameCount.get(norm(first.companyName)) ?? 0) > 1;
    const distinguisher = !duplicate ? null : first.companyCode ? `code ${first.companyCode}` : first.companyCreatedAt ? `created ${first.companyCreatedAt.slice(0, 10)}` : `workspace ${companyId.slice(0, 8)}`;
    const periods = [...list].sort((a, b) => (b.periodEnd ?? `${b.periodYear}`).localeCompare(a.periodEnd ?? `${a.periodYear}`) || b.periodYear - a.periodYear);
    return { companyId, companyName: first.companyName, distinguisher, purpose: first.workspacePurpose ?? null, periods };
  });
  const byName = (a: CompanyGroup<E>, b: CompanyGroup<E>) => a.companyName.localeCompare(b.companyName) || (a.distinguisher ?? "").localeCompare(b.distinguisher ?? "");
  return {
    client: groups.filter((g) => g.purpose !== "test" && g.purpose !== "training").sort(byName),
    test: groups.filter((g) => g.purpose === "test" || g.purpose === "training").sort(byName),
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };

/** "1 Jul 2024 – 30 Jun 2025", "ended 30 Jun 2025", or null when the dates are not recorded (never guessed). */
export function periodDates(start: string | null | undefined, end: string | null | undefined): string | null {
  const ok = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}/.test(s);
  if (ok(start) && ok(end)) return `${day(start)} – ${day(end)}`;
  if (ok(end)) return `ended ${day(end)}`;
  return null;
}
