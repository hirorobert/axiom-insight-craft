import { createContext, useContext, ReactNode, useEffect, useRef, useCallback, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

interface SessionContextType {
  timeRemaining: number;
  isWarning: boolean;
  isCritical: boolean;
  extendSession: () => Promise<void>;
  logoutNow: () => Promise<void>;
}

const SessionContext = createContext<SessionContextType | undefined>(undefined);

interface SessionTimeoutProviderProps {
  children: ReactNode;
  /** Session timeout in minutes (default: 30) */
  timeoutMinutes?: number;
  /** Warning before logout in minutes (default: 5) */
  warningMinutes?: number;
}

const ACTIVITY_EVENTS = [
  "mousedown",
  "mousemove",
  "keydown",
  "scroll",
  "touchstart",
  "click",
];

/**
 * Provider component that wraps the app to enable session timeout functionality.
 * Exposes session state via context. Only active when user is authenticated.
 */
export function SessionTimeoutProvider({
  children,
  timeoutMinutes = 30,
  warningMinutes = 5,
}: SessionTimeoutProviderProps) {
  const { user, signOut } = useAuth();
  
  const timeoutMs = timeoutMinutes * 60 * 1000;
  const warningMs = warningMinutes * 60 * 1000;
  const criticalMs = 2 * 60 * 1000; // 2 minutes

  const [timeRemaining, setTimeRemaining] = useState(timeoutMs);
  const lastActivityRef = useRef<number>(Date.now());
  const timeoutRef = useRef<number | null>(null);
  const warningRef = useRef<number | null>(null);
  const warningShownRef = useRef<boolean>(false);
  const intervalRef = useRef<number | null>(null);

  const isWarning = timeRemaining <= warningMs;
  const isCritical = timeRemaining <= criticalMs;

  const clearTimers = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (warningRef.current) {
      clearTimeout(warningRef.current);
      warningRef.current = null;
    }
  }, []);

  const logoutNow = useCallback(async () => {
    console.log("Session timeout: logging out user");
    toast.warning("Session expired due to inactivity. Please sign in again.");
    await signOut();
  }, [signOut]);

  const showWarning = useCallback(() => {
    // Dedupe: only show once per warning period
    if (!warningShownRef.current) {
      warningShownRef.current = true;
      toast.info(
        `Your session will expire in ${Math.ceil(warningMs / 60000)} minute(s) due to inactivity. Move your mouse or press a key to stay signed in.`,
        { duration: 10000 }
      );
    }
  }, [warningMs]);

  const resetTimers = useCallback(() => {
    if (!user) return;

    lastActivityRef.current = Date.now();
    warningShownRef.current = false;
    setTimeRemaining(timeoutMs);
    clearTimers();

    // Set warning timer
    const warningDelay = timeoutMs - warningMs;
    if (warningDelay > 0) {
      warningRef.current = window.setTimeout(showWarning, warningDelay);
    }

    // Set logout timer
    timeoutRef.current = window.setTimeout(logoutNow, timeoutMs);
  }, [user, timeoutMs, warningMs, clearTimers, showWarning, logoutNow]);

  const extendSession = useCallback(async () => {
    // Reset local timers
    resetTimers();
    
    // Refresh actual Supabase session
    try {
      const { error } = await supabase.auth.refreshSession();
      if (error) {
        console.error("Failed to refresh session:", error.message);
      }
    } catch (err) {
      console.error("Session refresh error:", err);
    }
  }, [resetTimers]);

  const handleActivity = useCallback(() => {
    // Debounce: only reset if more than 1 second since last activity
    const now = Date.now();
    if (now - lastActivityRef.current > 1000) {
      resetTimers();
    }
  }, [resetTimers]);

  // Update timeRemaining every second
  useEffect(() => {
    if (!user) {
      setTimeRemaining(timeoutMs);
      return;
    }

    intervalRef.current = window.setInterval(() => {
      const elapsed = Date.now() - lastActivityRef.current;
      setTimeRemaining(Math.max(0, timeoutMs - elapsed));
    }, 1000);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [user, timeoutMs]);

  // Set up activity listeners and timers
  useEffect(() => {
    if (!user) {
      clearTimers();
      return;
    }

    // Start timers
    resetTimers();

    // Add activity listeners
    ACTIVITY_EVENTS.forEach((event) => {
      document.addEventListener(event, handleActivity, { passive: true });
    });

    // Handle visibility change
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        const inactiveTime = Date.now() - lastActivityRef.current;
        if (inactiveTime >= timeoutMs) {
          logoutNow();
        } else if (inactiveTime >= timeoutMs - warningMs) {
          showWarning();
          resetTimers();
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearTimers();
      ACTIVITY_EVENTS.forEach((event) => {
        document.removeEventListener(event, handleActivity);
      });
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [user, timeoutMs, warningMs, resetTimers, handleActivity, clearTimers, logoutNow, showWarning]);

  return (
    <SessionContext.Provider value={{ timeRemaining, isWarning, isCritical, extendSession, logoutNow }}>
      {children}
    </SessionContext.Provider>
  );
}

/**
 * Hook to access session timeout state. Must be used within SessionTimeoutProvider.
 */
export function useSessionContext() {
  const context = useContext(SessionContext);
  if (context === undefined) {
    throw new Error("useSessionContext must be used within a SessionTimeoutProvider");
  }
  return context;
}
