import { useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { Database } from "@/integrations/supabase/types";

export type AuditAction = Database["public"]["Enums"]["audit_action"];

interface LogAuditParams {
  action: AuditAction;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

export function useAuditLog() {
  const { user } = useAuth();

  const logAction = useCallback(
    async ({ action, entityType, entityId, metadata }: LogAuditParams) => {
      if (!user) return;

      try {
        await supabase.from("audit_logs").insert({
          action,
          user_id: user.id,
          entity_type: entityType || null,
          entity_id: entityId || null,
          metadata: (metadata || {}) as Database["public"]["Tables"]["audit_logs"]["Insert"]["metadata"],
          user_agent: navigator.userAgent,
        });
      } catch (err) {
        console.error("Audit log error:", err);
      }
    },
    [user]
  );

  return { logAction };
}
