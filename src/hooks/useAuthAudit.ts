import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { AuthChangeEvent, Session } from "@supabase/supabase-js";

/**
 * Hook to log authentication events (login, logout) to audit_logs.
 * Must be used within AuthProvider after session is established.
 */
export function useAuthAudit() {
  const previousSessionRef = useRef<Session | null>(null);
  const isInitializedRef = useRef(false);

  useEffect(() => {
    const logAuthEvent = async (
      action: "login" | "logout",
      userId: string,
      metadata?: Record<string, unknown>
    ) => {
      try {
        const insertData = {
          user_id: userId,
          action: action as "login" | "logout",
          entity_type: "auth",
          metadata: (metadata || {}) as import("@/integrations/supabase/types").Json,
          user_agent: navigator.userAgent,
        };
        await supabase.from("audit_logs").insert(insertData);
        console.log(`Audit: ${action} logged for user ${userId}`);
      } catch (err) {
        console.error(`Failed to log ${action} event:`, err);
      }
    };

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event: AuthChangeEvent, session: Session | null) => {
        const previousSession = previousSessionRef.current;

        // Handle login events
        if (
          (event === "SIGNED_IN" || event === "TOKEN_REFRESHED") &&
          session?.user &&
          !previousSession
        ) {
          // Only log on actual sign-in, not token refresh when already logged in
          if (event === "SIGNED_IN" && isInitializedRef.current) {
            logAuthEvent("login", session.user.id, {
              email: session.user.email,
              provider: session.user.app_metadata?.provider || "email",
              timestamp: new Date().toISOString(),
            });
          }
        }

        // Handle logout events
        if (event === "SIGNED_OUT" && previousSession?.user) {
          logAuthEvent("logout", previousSession.user.id, {
            timestamp: new Date().toISOString(),
          });
        }

        // Update previous session reference
        previousSessionRef.current = session;
        isInitializedRef.current = true;
      }
    );

    // Initialize with current session
    supabase.auth.getSession().then(({ data: { session } }) => {
      previousSessionRef.current = session;
      isInitializedRef.current = true;
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);
}
