import type { ReactNode } from "react";
import { Link, useLocation, useOutletContext } from "react-router-dom";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import type { WorkbenchNavModel } from "@/lib/workbench/routes";
import { parseReportVersion, withContext } from "@/lib/workbench/context";
import { ManagementLink } from "@/components/account/ManagementNavigation";

export type CompanyHomeNavigation = { model: WorkbenchNavModel; next: { label: string; href: string } | null };
/** Uses the very same authorised navigation as the rail. This is a task chooser, never a permission or readiness authority. */
export function CompanyWorkspaceHome({ children }: { children?: ReactNode }) {
  const { company, companyId, periodYear } = useWorkspace();
  const { search } = useLocation();
  const context = { reportVersion: parseReportVersion(search) };
  const navigation = useOutletContext<CompanyHomeNavigation | undefined>();
  const groups = navigation?.model.groups.filter(g => g.id !== "overview") ?? [];
  const modules = navigation?.model.modules ?? [];
  return <section className="max-w-3xl" data-testid="company-workspace-home">
    <header className="mb-6"><h1 className="text-2xl font-semibold">{company?.name ?? "Company workspace"}</h1>
      <p className="mt-2 text-sm text-muted-foreground">FY{periodYear} · Select a task for this reporting period.</p></header>
    {children}
    {navigation?.next && <div className="mb-6 border border-border p-4"><p className="mb-2 text-xs font-medium text-muted-foreground">Continue saved work</p><Link className="inline-flex min-h-11 items-center bg-primary px-4 text-sm font-medium text-primary-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" to={withContext(navigation.next.href, context)}>{navigation.next.label}</Link></div>}
    <ul className="divide-y divide-border border border-border" aria-label="Company tasks">
      <li><ManagementLink to={`/settings?section=companies&company=${encodeURIComponent(companyId)}`} className="flex min-h-14 items-center justify-between gap-3 p-4 text-sm font-medium hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">Company details<span aria-hidden="true">→</span></ManagementLink></li>
      {groups.map(group => <li key={group.id}><Link to={withContext(group.href, context)} className="flex min-h-14 items-center justify-between gap-3 p-4 text-sm font-medium hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">{group.label}<span aria-hidden="true">→</span></Link></li>)}
      {modules.map(item => <li key={item.id}>{item.disabled ? <div className="p-4 text-sm text-muted-foreground">{item.label}<span className="block text-xs">{item.reason}</span></div> : <Link to={withContext(item.href, context)} className="flex min-h-14 items-center justify-between gap-3 p-4 text-sm font-medium hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">{item.label}<span aria-hidden="true">→</span></Link>}</li>)}
    </ul>
    <p className="mt-4 text-xs text-muted-foreground">Your saved work stays with this company and reporting period.</p>
  </section>;
}
