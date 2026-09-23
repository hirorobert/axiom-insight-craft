/**
 * EngagementHub — the deterministic workspace chooser.
 *
 * Rendered by Dashboard.tsx exactly when the returning-user routing decision cannot resolve to a
 * single engagement on its own: either more than one engagement is open (never guess among them),
 * or none is open and there is more than one company to choose from. Every row's "state" comes
 * straight from deriveWorkspaceState via useActiveEngagements — this page invents no second
 * readiness computation.
 *
 * "Start another service" (a company with no open engagement) is a clearly separate action from
 * resuming an existing engagement — distinct section, distinct verb — so starting one can never be
 * mistaken for, or accidentally mutate, an engagement already in progress.
 */

import { ArrowRight, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SurfaceCard } from "@/components/workspace/ui/Surface";
import { CFOCloseWordmark } from "@/components/CFOCloseWordmark";
import { STAGE_CONFIGS } from "@/lib/workspace/stageMetadata";
import { capabilityTitle } from "@/lib/workspace/mandate";
import type { ActiveEngagementEntry } from "@/hooks/useActiveEngagements";
import type { WorkspaceCompany } from "@/lib/workspace/fetchWorkspaceSnapshot";
import type { SharedWorkspace } from "@/lib/workspace/workspaceAccess";

export default function EngagementHub({
  entries,
  companiesWithoutEngagement,
  onResume,
  onStartService,
  sharedWorkspaces = [],
  onOpenShared,
}: {
  entries: ActiveEngagementEntry[];
  companiesWithoutEngagement: WorkspaceCompany[];
  onResume: (entry: ActiveEngagementEntry) => void;
  onStartService: (company: WorkspaceCompany) => void;
  /** Workspaces shared through an explicit Prepare grant (PR #32). They open into Prepare Data only. */
  sharedWorkspaces?: SharedWorkspace[];
  onOpenShared?: (workspace: SharedWorkspace) => void;
}) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border h-14 flex items-center px-6">
        <CFOCloseWordmark className="text-lg" />
      </header>

      <main className="max-w-3xl mx-auto px-5 py-10 sm:py-14">
        {entries.length > 0 && (
          <section className="mb-10">
            <h1 className="text-2xl sm:text-[1.75rem] font-semibold tracking-tight text-foreground mb-1">
              Your engagements
            </h1>
            <p className="text-[13px] text-muted-foreground mb-6">
              {entries.length} open engagement{entries.length === 1 ? "" : "s"} — choose one to resume.
            </p>

            <ul className="grid gap-3" data-testid="engagement-hub-list">
              {entries.map((entry) => {
                const stageLabel = STAGE_CONFIGS[entry.workspaceState.nextAction.mission].label;
                const serviceLabel =
                  entry.capabilities.length > 0
                    ? entry.capabilities.map((c) => capabilityTitle(c)).join(", ")
                    : "No service selected yet";

                return (
                  <li key={entry.engagementId}>
                    <SurfaceCard
                      className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-4"
                      data-testid={`engagement-row-${entry.engagementId}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className="text-[15px] font-semibold text-foreground truncate">{entry.companyName}</span>
                          <span className="text-[12px] text-muted-foreground">· {entry.periodYear}</span>
                          {entry.framework && <span className="text-[12px] text-muted-foreground">· {entry.framework}</span>}
                        </div>
                        <p className="text-[12px] text-muted-foreground mt-0.5">{serviceLabel}</p>
                        <p className="text-[13px] text-foreground mt-2">
                          <span className="font-medium">{stageLabel}:</span> {entry.workspaceState.nextAction.label}
                        </p>
                      </div>
                      <Button
                        onClick={() => onResume(entry)}
                        data-testid={`resume-${entry.engagementId}`}
                        className="h-10 px-5 text-[13px] font-semibold rounded-none shadow-none shrink-0"
                      >
                        Resume <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
                      </Button>
                    </SurfaceCard>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {companiesWithoutEngagement.length > 0 && (
          <section>
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-muted-foreground mb-3">
              Start another service
            </h2>
            <ul className="grid gap-2" data-testid="companies-without-engagement-list">
              {companiesWithoutEngagement.map((company) => (
                <li key={company.id}>
                  <button
                    type="button"
                    onClick={() => onStartService(company)}
                    data-testid={`start-service-${company.id}`}
                    className="w-full text-left p-3.5 border border-border hover:border-primary/60 transition-colors flex items-center gap-3"
                  >
                    <Building2 className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="text-[13px] font-medium text-foreground flex-1 truncate">{company.name}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        {sharedWorkspaces.length > 0 && onOpenShared && (
          <section className="mt-10">
            <h2 className="text-[13px] font-semibold uppercase tracking-[0.14em] text-muted-foreground mb-3">
              Shared with you
            </h2>
            <ul className="grid gap-2" data-testid="shared-workspaces-list">
              {sharedWorkspaces.map((workspace) => (
                <li key={workspace.id}>
                  <button
                    type="button"
                    onClick={() => onOpenShared(workspace)}
                    data-testid={`open-shared-${workspace.id}`}
                    className="w-full text-left p-3.5 border border-border hover:border-primary/60 transition-colors flex items-center gap-3"
                  >
                    <Building2 className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="text-[13px] font-medium text-foreground flex-1 truncate">{workspace.name}</span>
                    <span className="text-[12px] text-muted-foreground shrink-0">Prepare Data</span>
                    <ArrowRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </main>
    </div>
  );
}
