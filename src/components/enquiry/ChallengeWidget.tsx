// The anti-abuse challenge widget for anonymous submissions. It reports the provider's response token to the form; the SERVER
// verifies it. `resetKey` re-renders the widget (a token is single-use, so every failed or completed attempt needs a fresh one).

import { useEffect, useRef, useState } from "react";
import { ENQUIRY_FORM_COPY } from "@/lib/serviceEnquiry/copy";
import { CHALLENGE_ACTION, loadTurnstile, type TurnstileApi } from "@/lib/serviceEnquiry/challenge";

interface Props {
  siteKey: string;
  resetKey: number;
  onToken: (token: string | null) => void;
}

export function ChallengeWidget({ siteKey, resetKey, onToken }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    let cancelled = false;
    let widgetId: string | null = null;
    let api: TurnstileApi | null = null;
    setState("loading");
    onTokenRef.current(null);
    loadTurnstile()
      .then((t) => {
        if (cancelled || !container.current) return;
        api = t;
        widgetId = t.render(container.current, {
          sitekey: siteKey,
          action: CHALLENGE_ACTION,
          theme: "auto",
          callback: (token: unknown) => onTokenRef.current(typeof token === "string" && token !== "" ? token : null),
          "expired-callback": () => onTokenRef.current(null),
          "error-callback": () => {
            onTokenRef.current(null);
            if (!cancelled) setState("failed");
          },
        });
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("failed");
      });
    return () => {
      cancelled = true;
      if (api && widgetId) {
        try {
          api.remove(widgetId);
        } catch {
          /* the widget is already gone */
        }
      }
    };
  }, [siteKey, resetKey]);

  return (
    <div className="space-y-1.5" data-testid="challenge-widget" data-state={state}>
      <p className="text-sm font-medium text-foreground">{ENQUIRY_FORM_COPY.challengeLabel}</p>
      <div ref={container} className="min-h-[65px]" />
      {state === "loading" && (
        <p role="status" className="text-xs text-muted-foreground">
          {ENQUIRY_FORM_COPY.challengeLoading}
        </p>
      )}
      {state === "failed" && (
        <p role="alert" className="text-sm text-destructive">
          {ENQUIRY_FORM_COPY.challengeLoadFailed}
        </p>
      )}
    </div>
  );
}
