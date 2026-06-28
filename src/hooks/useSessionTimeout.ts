import { useEffect, useRef, useCallback } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";

interface UseSessionTimeoutOptions {
  /** Timeout duration in milliseconds (default: 30 minutes) */
  timeout?: number;
  /** Warning time before logout in milliseconds (default: 5 minutes) */
  warningTime?: number;
  /** Callback when session times out */
  onTimeout?: () => void;
  /** Callback when warning is shown */
  onWarning?: (remainingMs: number) => void;
}

const DEFAULT_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const DEFAULT_WARNING = 5 * 60 * 1000; // 5 minutes before timeout

const ACTIVITY_EVENTS = [
  "mousedown",
  "mousemove",
  "keydown",
  "scroll",
  "touchstart",
  "click",
];

/**
 * Hook to auto-logout users after a period of inactivity.
 * Tracks user activity and shows a warning before logging out.
 */
export function useSessionTimeout(options: UseSessionTimeoutOptions = {}) {
  const {
    timeout = DEFAULT_TIMEOUT,
    warningTime = DEFAULT_WARNING,
    onTimeout,
    onWarning,
  } = options;

  const { user, signOut } = useAuth();
  const timeoutRef = useRef<number | null>(null);
  const warningRef = useRef<number | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const warningShownRef = useRef<boolean>(false);

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

  const handleTimeout = useCallback(async () => {
    console.log("Session timeout: logging out user");
    onTimeout?.();
    toast.warning("Session expired due to inactivity. Please sign in again.");
    await signOut();
  }, [signOut, onTimeout]);

  const showWarning = useCallback(() => {
    if (!warningShownRef.current) {
      warningShownRef.current = true;
      const remainingMs = warningTime;
      onWarning?.(remainingMs);
      toast.info(
        `Your session will expire in ${Math.ceil(remainingMs / 60000)} minute(s) due to inactivity. Move your mouse or press a key to stay signed in.`,
        { duration: 10000 }
      );
    }
  }, [warningTime, onWarning]);

  const resetTimers = useCallback(() => {
    if (!user) return;

    lastActivityRef.current = Date.now();
    warningShownRef.current = false;
    clearTimers();

    // Set warning timer
    const warningDelay = timeout - warningTime;
    if (warningDelay > 0) {
      warningRef.current = window.setTimeout(showWarning, warningDelay);
    }

    // Set logout timer
    timeoutRef.current = window.setTimeout(handleTimeout, timeout);
  }, [user, timeout, warningTime, clearTimers, showWarning, handleTimeout]);

  const handleActivity = useCallback(() => {
    // Debounce activity events (only reset if more than 1 second since last activity)
    const now = Date.now();
    if (now - lastActivityRef.current > 1000) {
      resetTimers();
    }
  }, [resetTimers]);

  useEffect(() => {
    if (!user) {
      clearTimers();
      return;
    }

    // Start timers when user is authenticated
    resetTimers();

    // Add activity listeners
    ACTIVITY_EVENTS.forEach((event) => {
      document.addEventListener(event, handleActivity, { passive: true });
    });

    // Handle visibility change (resume timer when tab becomes visible)
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // Check if we should have timed out while tab was hidden
        const inactiveTime = Date.now() - lastActivityRef.current;
        if (inactiveTime >= timeout) {
          handleTimeout();
        } else if (inactiveTime >= timeout - warningTime) {
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
  }, [user, timeout, warningTime, resetTimers, handleActivity, clearTimers, handleTimeout, showWarning]);

  return {
    /** Manually reset the session timer (e.g., after important actions) */
    resetTimer: resetTimers,
    /** Get time remaining before timeout in milliseconds */
    getTimeRemaining: () => {
      if (!user) return 0;
      const elapsed = Date.now() - lastActivityRef.current;
      return Math.max(0, timeout - elapsed);
    },
  };
}
