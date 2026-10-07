import { Link } from "react-router-dom";
import type { WorkbenchNavModel, WorkbenchPageId } from "@/lib/workbench/routes";
import type { StatusWord as StatusWordValue } from "@/lib/workbench/statusWords";
import { withContext } from "@/lib/workbench/context";
import { StatusWord } from "./StatusWord";

/**
 * The five-group workbench navigation. Groups come from deriveWorkbenchNavigation (only released pages of offered
 * stages); sub-pages are listed under the active group. Every link carries the selected report version.
 */
export function WorkbenchNav({ model, activePage, reportVersion, groupStatus }: {
  model: WorkbenchNavModel;
  activePage: WorkbenchPageId | null;
  reportVersion: number | null;
  groupStatus: (groupId: string) => StatusWordValue | null;
}) {
  const ctx = { reportVersion };
  return (
    <nav aria-label="Engagement" className="text-sm">
      <ul className="space-y-0.5">
        {model.groups.map((g) => {
          const active = g.pages.some((p) => p.id === activePage);
          const status = groupStatus(g.id);
          return (
            <li key={g.id}>
              <Link
                to={withContext(g.href, ctx)}
                aria-current={active ? "true" : undefined}
                className={["block rounded px-3 py-2 font-medium", active ? "bg-background shadow-[inset_3px_0_0_hsl(var(--primary))]" : "hover:bg-muted"].join(" ")}
              >
                {g.label}
                {status ? <span className="block text-xs font-normal"><StatusWord value={status} /></span> : null}
              </Link>
              {active && g.pages.length > 1 ? (
                <ul className="mb-1">
                  {g.pages.map((p) => (
                    <li key={p.id}>
                      <Link
                        to={withContext(p.href, ctx)}
                        aria-current={p.id === activePage ? "page" : undefined}
                        className={["block py-1 pl-8 pr-3", p.id === activePage ? "font-semibold text-primary" : "text-muted-foreground hover:text-foreground"].join(" ")}
                      >
                        {p.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      {model.modules.length > 0 ? (
        <ul className="mt-4 border-t border-border pt-3" aria-label="Other modules">
          {model.modules.map((m) => (
            <li key={m.id}>
              <Link to={withContext(m.href, ctx)} className="block rounded px-3 py-2 text-muted-foreground hover:bg-muted hover:text-foreground">{m.label}</Link>
            </li>
          ))}
        </ul>
      ) : null}
    </nav>
  );
}

/** The inline "Next open item" link shown on every page other than the item's own (one line, no card). */
export function NextOpenItem({ label, href, reportVersion }: { label: string; href: string; reportVersion: number | null }) {
  return (
    <p className="mb-3 text-sm" data-testid="next-open-item">
      Next open item: <Link to={withContext(href, { reportVersion })} className="text-primary underline">{label} →</Link>
    </p>
  );
}
