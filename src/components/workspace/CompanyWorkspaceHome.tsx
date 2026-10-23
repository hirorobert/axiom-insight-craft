import type { ReactNode } from "react";
import { Link, useLocation, useOutletContext } from "react-router-dom";
import { useWorkspace } from "@/contexts/WorkspaceContext";
import { activeWorkbenchPage, type WorkbenchNavModel, type WorkbenchGroupId } from "@/lib/workbench/routes";
import type { StatusWord as StatusValue } from "@/lib/workbench/statusWords";
import { StatusWord } from "@/components/workbench/StatusWord";
import { parseReportVersion, withContext } from "@/lib/workbench/context";
import { ManagementLink } from "@/components/account/ManagementNavigation";

export type CompanyHomeNavigation = {
  model: WorkbenchNavModel;
  next: { label: string; href: string } | null;
  groupStatus?: (groupId: string) => StatusValue | null;
};
const DETAILS: Partial<Record<WorkbenchGroupId, string>> = {
  "trial-balance": "Import your file, check balances, classify accounts and resolve findings.",
  "close-review": "Review findings, adjustments and supporting evidence before preparing statements.",
  "financial-statements": "Prepare statements, notes, schedules and comparative figures.",
  "signoff-exports": "Review the final version, complete sign-off and export the available reports.",
};
/** A readable projection of the authorised workbench. No local progress, permissions or completion inference. */
export function CompanyWorkspaceHome({ children }: { children?: ReactNode }) {
  const { company, companyId, periodYear } = useWorkspace();
  const { search } = useLocation();
  const context = { reportVersion: parseReportVersion(search) };
  const navigation = useOutletContext<CompanyHomeNavigation | undefined>();
  const groups = navigation?.model.groups.filter(g => g.id !== "overview") ?? [];
  const modules = navigation?.model.modules ?? [];
  const nextPage = navigation?.next ? activeWorkbenchPage(navigation.next.href, `/workspace/${companyId}/${periodYear}`) : null;
  const nextGroup = groups.find(g => g.pages.some(p => p.id === nextPage));
  return <section className="max-w-4xl" data-testid="company-workspace-home">
    <header className="mb-6"><h1 className="text-2xl font-semibold">{company?.name ?? "Company workspace"}</h1>
      <p className="mt-2 text-sm text-muted-foreground">FY{periodYear} · Your reporting workflow</p>
      <ManagementLink to={`/settings?section=companies&company=${encodeURIComponent(companyId)}`} className="mt-3 inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-4">Company details &amp; settings</ManagementLink>
    </header>
    {children}
    {!children && navigation?.next && <div className="mb-6 border-l-4 border-primary bg-muted/30 p-4"><p className="mb-2 text-sm font-medium">Next step</p><Link className="inline-flex min-h-11 items-center gap-3 bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" to={withContext(navigation.next.href, context)}>{navigation.next.label}<span aria-hidden="true">→</span></Link></div>}
    <h2 className="mb-3 text-base font-semibold">Reporting workflow</h2>
    <ol className="divide-y divide-border border border-border" aria-label="Company tasks">
      {groups.map((group, index) => {
        const current = nextGroup?.id === group.id;
        const status = navigation?.groupStatus?.(group.id);
        return <li key={group.id} className={current ? "border-l-4 border-l-primary bg-muted/20" : ""} aria-current={current ? "step" : undefined}>
          <div className="flex items-start gap-3 p-4 sm:gap-4 sm:p-5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center border border-border text-sm font-semibold" aria-hidden="true">{index + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2"><Link to={withContext(group.href, context)} className="text-base font-semibold text-foreground underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">{group.label}</Link>{current ? <span className="text-sm font-semibold text-primary">Next step</span> : null}</div>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{DETAILS[group.id]}</p>
              {status && <p className="mt-2 text-sm"><StatusWord value={status} /></p>}
              {group.pages.length > 1 && <details className="mt-3" open={current || undefined}><summary className="min-h-8 cursor-pointer text-sm text-primary">Tasks in this stage</summary><ul className="mt-2 flex flex-wrap gap-x-5 gap-y-2">{group.pages.map(page => <li key={page.id}><Link className="inline-flex min-h-9 items-center text-sm underline underline-offset-4" to={withContext(page.href, context)}>{page.label}</Link></li>)}</ul></details>}
            </div>
            <Link to={withContext(group.href, context)} className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline" aria-label={`Open ${group.label}`}>Open<span className="ml-2" aria-hidden="true">→</span></Link>
          </div>
        </li>;
      })}
    </ol>
    {modules.length > 0 && <section className="mt-6" aria-label="Other available tools"><h2 className="mb-2 text-base font-semibold">Other tools</h2><ul>{modules.map(item => <li key={item.id}>{item.disabled ? <p className="py-3 text-sm text-muted-foreground">{item.label} · {item.reason}</p> : <Link to={withContext(item.href, context)} className="inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-4">{item.label}</Link>}</li>)}</ul></section>}
    <p className="mt-5 text-sm text-muted-foreground">Available stages depend on this company’s access. Each stage checks its prerequisites before you can complete it. Saved work stays with this company and reporting period.</p>
  </section>;
}
