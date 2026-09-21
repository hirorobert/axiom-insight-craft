// The card frame shared by the two expert-led workflow tiles. It matches the visual language of the existing outcome cards
// (number, state badge, title, promise, "Produces", action) without introducing another visual system. The state is a word AND
// an icon, never colour alone, and the action is a real button with a 44px touch target and a unique accessible name.

import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";

interface Props {
  number: string;
  stateLabel: string;
  stateIcon: ReactNode;
  stateClassName: string;
  title: string;
  description: string;
  producesLabel: string;
  produces: string;
  /** The button's visible text, including its trailing arrow. */
  actionLabel: string;
  /** Unique accessible name for the action, in the same "action: title" form as the other cards. */
  actionAriaLabel: string;
  onAction: () => void;
  testId: string;
}

export function ExpertTileFrame({ number, stateLabel, stateIcon, stateClassName, title, description, producesLabel, produces, actionLabel, actionAriaLabel, onAction, testId }: Props) {
  return (
    <article className="group relative flex flex-col bg-background p-6 transition-colors hover:bg-muted/30" data-testid={testId}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono text-muted-foreground/45">{number}</span>
        <span className={`flex items-center gap-1.5 text-[9px] font-mono uppercase tracking-[0.14em] ${stateClassName}`} data-testid={`${testId}-state`}>
          {stateIcon}
          {stateLabel}
        </span>
      </div>

      <h3 className="mt-4 text-base font-semibold leading-snug text-foreground">{title}</h3>
      <p className="mt-2 flex-1 text-xs leading-5 text-muted-foreground">{description}</p>

      <div className="mt-5 border-t border-border pt-4">
        <p className="text-[9px] font-mono uppercase tracking-[0.18em] text-muted-foreground/50">{producesLabel}</p>
        <p className="mt-1.5 text-xs font-medium text-foreground">{produces}</p>
      </div>

      <div className="mt-3 flex items-center justify-end">
        <button
          type="button"
          onClick={onAction}
          aria-label={actionAriaLabel}
          data-testid={`${testId}-action`}
          className="inline-flex min-h-[44px] items-center gap-1 rounded-sm border-b border-foreground/20 pb-0.5 text-xs font-semibold text-foreground transition-colors hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <span aria-hidden="true">{actionLabel.replace(/\s*→\s*$/, "")}</span>
          <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
        </button>
      </div>
    </article>
  );
}
