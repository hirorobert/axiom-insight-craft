/**
 * ClassificationStatesAcceptance — internal, development-only visual-acceptance page for the classification
 * presentation introduced by PR #29 (src/lib/workspace/classificationPresentation.ts).
 *
 * Purpose: let the owner see all 7 classification states rendered through the REAL production pipeline — the real
 * deriveClassificationPresentation(), the real buildClassificationDecision(), the real <DecisionCard> — fed
 * deterministic fixture inputs, with no live company, no live upload, and no Supabase read or write anywhere on
 * this page. It is not a second implementation of the decision card: it imports and renders exactly the same
 * functions and component WorkspaceOverview.tsx uses.
 *
 * Fails closed outside a dev build (see classificationAcceptanceGate.ts) and is only ever routed to from App.tsx
 * behind the same import.meta.env.DEV check — the route itself does not exist in a production build.
 */

import { isClassificationAcceptancePageRenderable } from "@/lib/workspace/classificationAcceptanceGate";
import { deriveClassificationPresentation } from "@/lib/workspace/classificationPresentation";
import { CLASSIFICATION_ACCEPTANCE_FIXTURES } from "@/lib/workspace/classificationAcceptanceFixtures";
import { buildClassificationDecision, DecisionCard } from "@/components/workspace/DecisionCard";

// Fixture-only stand-ins for the two real routes a Decision's button normally points at. This page never has a real
// companyId/periodYear/uploadId, so it never calls buildPrepareReviewRoute/buildPrepareUploadRoute — those builders
// exist for the live workspace, not for fixture data.
const FIXTURE_HREF = "/internal/acceptance/classification-states#fixture-destination-not-a-real-route";

export default function ClassificationStatesAcceptance() {
  // Defense in depth: even if this component were somehow mounted outside the gated route (a direct import, a
  // stale bookmark surviving a redeploy), it renders nothing before reading a single fixture or calling the real
  // presentation pipeline.
  if (!isClassificationAcceptancePageRenderable(import.meta.env.DEV)) return null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6" data-testid="classification-acceptance-page">
      <div className="mb-8 border border-dashed border-amber-500 bg-amber-50 px-4 py-3 text-[13px] text-amber-900 dark:bg-amber-950/30 dark:text-amber-200" role="status" data-testid="acceptance-banner">
        <p className="font-semibold">Internal visual acceptance — fixture data</p>
        <p className="mt-1 text-[12px] leading-relaxed">
          Every card below is fed a hand-written fixture, not a live upload. Nothing on this page reads or writes Supabase. This route does not exist in a production build.
        </p>
      </div>

      <ul className="space-y-10">
        {CLASSIFICATION_ACCEPTANCE_FIXTURES.map((fixture) => {
          // The REAL production function, fed only the fixture — no live data, no side effect.
          const classification = deriveClassificationPresentation(fixture.uploadStatus, fixture.processingResult);
          // The REAL production mapping — the same one WorkspaceOverview.tsx calls. onRetry is inert: this page
          // never contacts Supabase or an Edge Function, so the FAILED fixture's "Retry processing" button does
          // nothing but exists to show the real control it renders in production.
          const decision = buildClassificationDecision(classification, {
            retrying: false,
            onRetry: () => undefined,
            prepareHref: FIXTURE_HREF,
            reviewHref: FIXTURE_HREF,
          });

          return (
            <li key={fixture.expectedState} data-testid={`classification-fixture-${fixture.expectedState}`}>
              <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground" data-testid="fixture-label">
                {fixture.label}
              </p>
              {/* The REAL production component — not duplicated markup. */}
              <DecisionCard decision={decision} manageUploadHref={FIXTURE_HREF} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
