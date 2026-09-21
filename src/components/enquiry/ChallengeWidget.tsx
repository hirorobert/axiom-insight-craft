// The anti-abuse challenge widget for anonymous submissions. It reports the provider's response token to the form; the SERVER
// verifies it. `resetKey` re-renders the widget (a token is single-use, so every failed or completed attempt needs a fresh one).

import { useEffect, useReducer, useRef } from "react";
import { ENQUIRY_FORM_COPY } from "@/lib/serviceEnquiry/copy";
import {
  CHALLENGE_ACTION,
  WIDGET_INITIAL,
  challengeErrorCodeFromThrown,
  classifyChallengeError,
  loadTurnstile,
  sanitizeChallengeErrorCode,
  widgetReducer,
  type TurnstileApi,
} from "@/lib/serviceEnquiry/challenge";

interface Props {
  siteKey: string;
  resetKey: number;
  onToken: (token: string | null) => void;
}

export function ChallengeWidget({ siteKey, resetKey, onToken }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [widget, dispatch] = useReducer(widgetReducer, WIDGET_INITIAL);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    let cancelled = false;
    let widgetId: string | null = null;
    let api: TurnstileApi | null = null;
    dispatch({ type: "loading" });
    onTokenRef.current(null);
    loadTurnstile()
      .then((t) => {
        if (cancelled || !container.current) return;
        api = t;
        widgetId = t.render(container.current, {
          sitekey: siteKey,
          action: CHALLENGE_ACTION,
          theme: "auto",
          callback: (token: unknown) => {
            const usable = typeof token === "string" && token !== "" ? token : null;
            onTokenRef.current(usable);
            if (!cancelled && usable) dispatch({ type: "solved" }); // Turnstile retries some errors itself: a solve clears a stale banner
          },
          "expired-callback": () => onTokenRef.current(null),
          "error-callback": (code: unknown) => {
            // Keep Cloudflare's client error code so the cause can be identified. Only the sanitised numeric code is stored or
            // logged: never a token, a key or any page data.
            const safe = sanitizeChallengeErrorCode(code);
            onTokenRef.current(null);
            if (!cancelled) dispatch({ type: "error", code: safe });
            console.warn("[enquiry] security check error", safe ?? "unrecognised");
            return true; // handled here: the code is reported above instead of Turnstile's own console line
          },
        });
        dispatch({ type: "rendered" });
      })
      .catch((thrown: unknown) => {
        // render() and the script loader throw; the code (if any) is in the message. The form stays fail-closed either way.
        const safe = challengeErrorCodeFromThrown(thrown);
        if (!cancelled) dispatch({ type: "error", code: safe });
        console.warn("[enquiry] security check could not start", safe ?? "unrecognised");
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
    <div className="space-y-1.5" data-testid="challenge-widget" data-state={widget.phase} data-error-code={widget.errorCode ?? undefined}>
      <p className="text-sm font-medium text-foreground">{ENQUIRY_FORM_COPY.challengeLabel}</p>
      <div ref={container} className="min-h-[65px]" />
      {widget.phase === "loading" && (
        <p role="status" className="text-xs text-muted-foreground">
          {ENQUIRY_FORM_COPY.challengeLoading}
        </p>
      )}
      {widget.phase === "failed" && (
        <p role="alert" className="text-sm text-destructive" data-testid="challenge-failure">
          {ENQUIRY_FORM_COPY.challengeFailureByKind[classifyChallengeError(widget.errorCode)]}
          {widget.errorCode ? ` ${ENQUIRY_FORM_COPY.challengeReference} ${widget.errorCode}.` : ""}
        </p>
      )}
    </div>
  );
}
