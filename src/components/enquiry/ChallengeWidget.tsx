// The anti-abuse challenge widget for anonymous submissions. It reports the provider's response token to the form; the SERVER
// verifies it. `resetKey` re-renders the widget (a token is single-use, so every failed or completed attempt needs a fresh one).
//
// Two independent legs, so one unreachable provider cannot take the only public form down:
//   1. the third-party widget (preferred; bounded automatic retries, plus a manual retry);
//   2. a first-party server-signed attestation, started automatically the moment the widget fails.
// Both tokens travel in the same field and are verified server-side. If BOTH legs fail the form stays refused — never sent
// unprotected.

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ENQUIRY_FORM_COPY } from "@/lib/serviceEnquiry/copy";
import { runAttestation } from "@/lib/serviceEnquiry/attestation";
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

type WidgetState = "loading" | "ready" | "failed" | "backup_running" | "backup_ready";

export function ChallengeWidget({ siteKey, resetKey, onToken }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<WidgetState>("loading");
  const [attempt, setAttempt] = useState(0);
  const [backupRun, setBackupRun] = useState(0);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    setAttempt(0);
    setBackupRun(0);
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
      // The backup leg starts immediately — the visitor never waits on a provider that is already unreachable.
      setBackupRun((current) => current + 1);
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
          callback: (token: unknown) => {
            if (typeof token === "string" && token !== "") {
              onTokenRef.current(token);
              if (!cancelled) setState("ready");
            } else {
              onTokenRef.current(null);
            }
          },
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

  // The first-party leg. It only ever runs after the widget leg has failed, and a failure here leaves the form refused.
  useEffect(() => {
    if (backupRun === 0) return;
    let cancelled = false;
    setState("backup_running");
    runAttestation().then((token) => {
      if (cancelled) return;
      if (token) {
        onTokenRef.current(token);
        setState("backup_ready");
      } else {
        onTokenRef.current(null);
        setState("failed");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [backupRun]);

  const retry = useCallback(() => {
    setAttempt((current) => current + 1);
    setBackupRun((current) => current + 1);
  }, []);

  return (
    <div className="space-y-1.5" data-testid="challenge-widget" data-state={state}>
      <p className="text-sm font-medium text-foreground">{ENQUIRY_FORM_COPY.challengeLabel}</p>
      <div ref={container} className={state === "backup_ready" ? "hidden" : "min-h-[65px]"} />
      {state === "loading" && (
        <p role="status" className="text-xs text-muted-foreground">
          {ENQUIRY_FORM_COPY.challengeLoading}
        </p>
      )}
      {state === "backup_running" && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="challenge-backup-running">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {ENQUIRY_FORM_COPY.challengeBackupRunning}
        </p>
      )}
      {state === "backup_ready" && (
        <p role="status" className="flex items-center gap-2 text-sm text-foreground" data-testid="challenge-backup-ready">
          <CheckCircle2 className="h-4 w-4 text-primary" aria-hidden="true" />
          {ENQUIRY_FORM_COPY.challengeBackupReady}
        </p>
      )}
      {state === "failed" && (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">{ENQUIRY_FORM_COPY.challengeBackupFailed}</p>
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            {ENQUIRY_FORM_COPY.challengeRetry}
          </Button>
        </div>
      )}
    </div>
  );
}
