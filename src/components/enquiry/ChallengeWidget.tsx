// The anti-abuse challenge widget for anonymous submissions. It reports the provider's response token to the form; the SERVER
// verifies it. `resetKey` re-renders the widget (a token is single-use, so every failed or completed attempt needs a fresh one).

import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ENQUIRY_FORM_COPY } from "@/lib/serviceEnquiry/copy";
import {
  CHALLENGE_ACTION,
  CHALLENGE_AUTO_RETRY_DELAY_MS,
  loadTurnstile,
  shouldAutoRetryChallenge,
  type TurnstileApi,
} from "@/lib/serviceEnquiry/challenge";

interface Props {
  siteKey: string;
  resetKey: number;
  onToken: (token: string | null) => void;
}

export function ChallengeWidget({ siteKey, resetKey, onToken }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [attempt, setAttempt] = useState(0);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    setAttempt(0);
  }, [siteKey, resetKey]);

  useEffect(() => {
    let cancelled = false;
    let widgetId: string | null = null;
    let api: TurnstileApi | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    setState("loading");
    onTokenRef.current(null);
    const fail = () => {
      onTokenRef.current(null);
      if (cancelled) return;
      setState("failed");
      if (shouldAutoRetryChallenge(attempt, navigator.onLine)) {
        retryTimer = setTimeout(() => {
          if (!cancelled) setAttempt((current) => current + 1);
        }, CHALLENGE_AUTO_RETRY_DELAY_MS);
      }
    };
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
            fail();
          },
        });
        setState("ready");
      })
      .catch(fail);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (api && widgetId) {
        try {
          api.remove(widgetId);
        } catch {
          /* the widget is already gone */
        }
      }
    };
  }, [siteKey, resetKey, attempt]);

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
        <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">{ENQUIRY_FORM_COPY.challengeLoadFailed}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => setAttempt((current) => current + 1)}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {ENQUIRY_FORM_COPY.challengeRetry}
          </Button>
        </div>
      )}
    </div>
  );
}
