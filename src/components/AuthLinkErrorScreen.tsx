import { useState } from "react";
import { Link } from "react-router-dom";
import { MailX, ArrowRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CFOCloseWordmark } from "@/components/CFOCloseWordmark";
import { translateAuthError } from "@/lib/auth/translateAuthError";

export interface AuthLinkError {
  error: string;
  errorCode: string | null;
  errorDescription: string | null;
}

/**
 * Reads Supabase Auth error fragments from the URL hash, e.g. the redirect a
 * user lands on after clicking an already-consumed or expired email link:
 *   /#error=access_denied&error_code=otp_expired&error_description=...
 * Returns null when no auth error is present.
 */
export function getAuthLinkError(hash: string = window.location.hash): AuthLinkError | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const error = params.get("error");
  if (!error) return null;
  return {
    error,
    errorCode: params.get("error_code"),
    errorDescription: params.get("error_description"),
  };
}

/**
 * Friendly screen shown when a repeat/expired confirmation-link click lands on
 * "/". Single-use links report otp_expired on second use — explain that calmly
 * and offer a controlled resend instead of leaving the user on a bare URL.
 */
export function AuthLinkErrorScreen({ linkError }: { linkError: AuthLinkError }) {
  const isUsedOrExpired = linkError.errorCode === "otp_expired";
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);

  const handleResend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sending) return; // in-flight guard — one controlled resend at a time
    setResendError(null);
    setSending(true);
    try {
      const { error } = await supabase.auth.resend({
        type: "signup",
        email,
        options: { emailRedirectTo: `${window.location.origin}/` },
      });
      if (error) {
        setResendError(translateAuthError(error).message);
      } else {
        setSentTo(email);
      }
    } catch {
      setResendError("We couldn't complete that request right now. Please try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6">
      <div className="mb-8">
        <CFOCloseWordmark />
      </div>
      <Card className="max-w-md w-full bg-card border-border">
        <CardHeader className="text-center pb-2">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
            <MailX className="w-8 h-8 text-primary" />
          </div>
          <CardTitle className="text-xl text-foreground">
            {isUsedOrExpired
              ? "This confirmation link has already been used"
              : "That link didn't work"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <p className="text-muted-foreground text-center text-sm">
            {isUsedOrExpired
              ? "Confirmation links work once. If you already confirmed your email, you can sign in now. If you haven't confirmed yet, request a fresh link below."
              : "The link may have expired or already been used. You can request a fresh confirmation link below."}
          </p>

          {sentTo ? (
            <p className="text-sm text-center text-foreground bg-muted/50 rounded-lg p-3">
              A new confirmation email is on its way to <span className="font-medium">{sentTo}</span>. Please check your inbox.
            </p>
          ) : (
            <form onSubmit={handleResend} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="resend-email">Email address</Label>
                <Input
                  id="resend-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                />
              </div>
              {resendError && (
                <p className="text-sm text-destructive">{resendError}</p>
              )}
              <Button type="submit" variant="outline" className="w-full" disabled={sending}>
                {sending ? "Sending…" : "Email me a new confirmation link"}
              </Button>
            </form>
          )}

          <Button asChild className="w-full gap-2">
            <Link to="/auth">
              Go to sign in
              <ArrowRight className="w-4 h-4" />
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
