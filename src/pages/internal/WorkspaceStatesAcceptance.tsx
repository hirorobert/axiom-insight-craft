/**
 * WorkspaceStatesAcceptance — internal, development-only visual-acceptance page extending PR #30's
 * classification-states gallery (ClassificationStatesAcceptance.tsx) to the FULL canonical
 * workflow: every path deriveWorkspaceState() can produce, rendered through the real engine, the
 * real buildNextActionDecision() mapping (DecisionCard.tsx) and the real <DecisionCard>/
 * <WorkspaceGate> components — no live company, no live upload, no Supabase read or write anywhere
 * on this page, exactly the same discipline as the classification gallery.
 *
 * Explicitly includes the three fixture types requirement #8 names: "contradiction" (the exact
 * live-observed defect PR #31 fixed — classification complete, certification arithmetic-blocked),
 * "missing-certification" (the read has not resolved yet) and "stale-processing" (certification no
 * longer current for this upload) — plus a "direct-route" section: the SAME contradiction fixture's
 * locked `statements` mission, rendered through the real <WorkspaceGate>, proving what a direct URL
 * to a locked stage actually shows (the same component StatementsWorkspace/TaxWorkspace/
 * FilingWorkspace render for this exact reason — see stageLockGate.test.ts for the live-page proof).
 *
 * Fails closed outside a dev build (see classificationAcceptanceGate.ts, reused generically here)
 * and is only ever routed to from App.tsx behind the same import.meta.env.DEV check.
 */

import { isClassificationAcceptancePageRenderable } from "@/lib/workspace/classificationAcceptanceGate";
import { deriveWorkspaceState } from "@/lib/workspace/deriveWorkspaceState";
import { WORKFLOW_ACCEPTANCE_FIXTURES, WORKFLOW_FIXTURE_COMPANY_ID, WORKFLOW_FIXTURE_COMPANY_NAME, WORKFLOW_FIXTURE_PERIOD_YEAR } from "@/lib/workspace/workflowAcceptanceFixtures";
import { DecisionCard, buildNextActionDecision } from "@/components/workspace/DecisionCard";
import { WorkspaceGate } from "@/components/workspace/WorkspaceGate";

const CONTRADICTION_FIXTURE_ID = "certification-contradiction";

export default function WorkspaceStatesAcceptance() {
  // Defense in depth: even if this component were somehow mounted outside the gated route, it
  // renders nothing before reading a single fixture or calling the real engine.
  if (!isClassificationAcceptancePageRenderable(import.meta.env.DEV)) return null;

  const contradiction = WORKFLOW_ACCEPTANCE_FIXTURES.find((f) => f.id === CONTRADICTION_FIXTURE_ID);
  const contradictionState = contradiction
    ? deriveWorkspaceState(WORKFLOW_FIXTURE_COMPANY_ID, WORKFLOW_FIXTURE_COMPANY_NAME, WORKFLOW_FIXTURE_PERIOD_YEAR, contradiction.snapshot)
    : null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6" data-testid="workflow-acceptance-page">
      <div className="mb-8 border border-dashed border-amber-500 bg-amber-50 px-4 py-3 text-[13px] text-amber-900 dark:bg-amber-950/30 dark:text-amber-200" role="status" data-testid="acceptance-banner">
        <p className="font-semibold">Internal visual acceptance — fixture data</p>
        <p className="mt-1 text-[12px] leading-relaxed">
          Every card below is fed a hand-written fixture through the real deriveWorkspaceState() engine, not a live
          upload. Nothing on this page reads or writes Supabase. This route does not exist in a production build.
        </p>
      </div>

      <ul className="space-y-10">
        {WORKFLOW_ACCEPTANCE_FIXTURES.map((fixture) => {
          const workspaceState = deriveWorkspaceState(
            WORKFLOW_FIXTURE_COMPANY_ID,
            WORKFLOW_FIXTURE_COMPANY_NAME,
            WORKFLOW_FIXTURE_PERIOD_YEAR,
            fixture.snapshot,
          );
          const decision = buildNextActionDecision(workspaceState);

          return (
            <li key={fixture.id} data-testid={`workflow-fixture-${fixture.id}`}>
              <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground" data-testid="fixture-label">
                {fixture.label}
              </p>
              <DecisionCard decision={decision} manageUploadHref="#fixture-destination-not-a-real-route" />
            </li>
          );
        })}
      </ul>

      {contradictionState && (
        <section className="mt-14 border-t border-border pt-10" data-testid="direct-route-fixture">
          <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            DIRECT-ROUTE — a bookmarked/typed URL to /statements while certification is blocked (the same
            &lt;WorkspaceGate&gt; StatementsWorkspace itself renders — see stageLockGate.test.ts for the live-page proof)
          </p>
          <WorkspaceGate
            mission="Prepare Statements"
            blocker={contradictionState.missions.statements.blocker ?? "Complete prerequisites first"}
            prerequisiteHref={contradictionState.missions.prepare.href}
            prerequisiteLabel="Go to Prepare Data"
          />
        </section>
      )}
    </div>
  );
}
