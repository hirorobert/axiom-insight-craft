/**
 * SyntheticClosePreview — a static, illustrative rendering of a close engagement's preparation
 * status. It is product proof, not product behaviour.
 *
 * Deliberately inert, and asserted so by syntheticClosePreview.test.tsx:
 *   - no Supabase client, no Edge Function call, no fetch, no react-query;
 *   - no authentication, workspace, engagement or entitlement import;
 *   - no localStorage, sessionStorage, cookie or IndexedDB access;
 *   - no timer, no animation, no random value, no clock read.
 *
 * Every string comes from SYNTHETIC_PREVIEW / SYNTHETIC_PREVIEW_STEPS. The entity is fictional
 * and the notice saying so is rendered unconditionally.
 */

import { Check } from "lucide-react";
import { SYNTHETIC_PREVIEW, SYNTHETIC_PREVIEW_STEPS } from "@/content/landing/landingContent";

export function SyntheticClosePreview() {
  return (
    <figure
      className="m-0 border border-border bg-card"
      aria-labelledby="sample-close-caption"
      data-testid="synthetic-close-preview"
    >
      {/* ── Engagement identity ───────────────────────────────────────────── */}
      <div className="border-b border-border bg-muted/40 px-4 py-3 sm:px-5">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-3">
          {[
            [SYNTHETIC_PREVIEW.entityLabel, SYNTHETIC_PREVIEW.entity],
            [SYNTHETIC_PREVIEW.periodLabel, SYNTHETIC_PREVIEW.period],
            [SYNTHETIC_PREVIEW.frameworkLabel, SYNTHETIC_PREVIEW.framework],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-[9px] font-mono uppercase tracking-[0.18em] text-muted-foreground">
                {label}
              </dt>
              <dd className="mt-0.5 truncate text-[13px] font-semibold text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* ── Status rows ───────────────────────────────────────────────────── */}
      <figcaption
        id="sample-close-caption"
        className="border-b border-border px-4 py-2.5 text-[9px] font-mono uppercase tracking-[0.18em] text-muted-foreground sm:px-5"
      >
        {SYNTHETIC_PREVIEW.caption}
      </figcaption>

      <ol className="divide-y divide-border">
        {SYNTHETIC_PREVIEW_STEPS.map((step) => {
          const isCurrent = step.state === "current";
          return (
            <li
              key={step.index}
              aria-current={isCurrent ? "step" : undefined}
              className={`flex items-start gap-3 px-4 py-3 sm:px-5 ${isCurrent ? "bg-secondary/60" : ""}`}
            >
              {/* Status marker — shape and text carry the meaning, never colour alone. */}
              <span
                aria-hidden="true"
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border ${
                  isCurrent
                    ? "border-foreground bg-background"
                    : "border-border bg-muted text-muted-foreground"
                }`}
              >
                {isCurrent ? (
                  <span className="h-1.5 w-1.5 bg-foreground" />
                ) : (
                  <Check className="h-3 w-3" strokeWidth={2.5} />
                )}
              </span>

              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium leading-5 text-foreground">
                  {step.title}
                </span>
                <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                  {step.detail}
                </span>
              </span>

              <span className="shrink-0 pt-0.5 text-[9px] font-mono uppercase tracking-[0.16em] text-muted-foreground">
                {isCurrent ? "Current" : "Completed"}
              </span>
            </li>
          );
        })}
      </ol>

      {/* ── Mandatory synthetic-data notice ──────────────────────────────── */}
      <p className="border-t border-border bg-muted/40 px-4 py-2.5 text-[10px] leading-4 text-muted-foreground sm:px-5">
        {SYNTHETIC_PREVIEW.notice}
      </p>
    </figure>
  );
}
