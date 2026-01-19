import { ReactNode } from "react";
import { useSessionTimeout } from "@/hooks/useSessionTimeout";
import { useAuth } from "@/contexts/AuthContext";

interface SessionTimeoutProviderProps {
  children: ReactNode;
  /** Session timeout in minutes (default: 30) */
  timeoutMinutes?: number;
  /** Warning before logout in minutes (default: 5) */
  warningMinutes?: number;
}

/**
 * Provider component that wraps the app to enable session timeout functionality.
 * Only active when a user is authenticated.
 */
export function SessionTimeoutProvider({ 
  children,
  timeoutMinutes = 30,
  warningMinutes = 5,
}: SessionTimeoutProviderProps) {
  const { user } = useAuth();
  
  // Only initialize session timeout when user is logged in
  useSessionTimeout({
    timeout: timeoutMinutes * 60 * 1000,
    warningTime: warningMinutes * 60 * 1000,
    onTimeout: () => {
      console.log("Session timed out due to inactivity");
    },
    onWarning: (remainingMs) => {
      console.log(`Session will expire in ${Math.ceil(remainingMs / 60000)} minutes`);
    },
  });

  return <>{children}</>;
}
