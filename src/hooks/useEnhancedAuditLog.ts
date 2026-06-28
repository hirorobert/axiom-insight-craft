import { useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { Database } from "@/integrations/supabase/types";

type AuditAction = Database["public"]["Enums"]["audit_action"];

interface LogActionParams {
  action: AuditAction;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}

interface ExportLogParams {
  fileName: string;
  format: "pdf" | "csv" | "xlsx";
  statements: string[];
  recordCount?: number;
}

interface FailedAuthLogParams {
  email: string;
  reason: string;
  attemptNumber?: number;
  isLocked?: boolean;
}

/**
 * Enhanced audit logging hook with specialized methods for common actions.
 */
export function useEnhancedAuditLog() {
  const { user, session } = useAuth();

  const logAction = useCallback(
    async ({ action, entityType, entityId, metadata }: LogActionParams) => {
      if (!user) {
        console.warn("Cannot log action: no authenticated user");
        return { error: new Error("Not authenticated") };
      }

      try {
        const { error } = await supabase.from("audit_logs").insert({
          action,
          user_id: user.id,
          entity_type: entityType || null,
          entity_id: entityId || null,
          metadata: (metadata || {}) as Database["public"]["Tables"]["audit_logs"]["Insert"]["metadata"],
          user_agent: navigator.userAgent,
        });

        if (error) {
          console.error("Failed to log audit action:", error);
          return { error };
        }

        return { error: null };
      } catch (err) {
        console.error("Unexpected error logging audit action:", err);
        return { error: err instanceof Error ? err : new Error("Unknown error") };
      }
    },
    [user]
  );

  /**
   * Log when a user exports financial statements
   */
  const logExport = useCallback(
    async ({ fileName, format, statements, recordCount }: ExportLogParams) => {
      return logAction({
        action: "export_statements",
        entityType: "export",
        metadata: {
          fileName,
          format,
          statements,
          recordCount,
          exportedAt: new Date().toISOString(),
        },
      });
    },
    [logAction]
  );

  /**
   * Log profile updates
   */
  const logProfileUpdate = useCallback(
    async (changes: Record<string, unknown>) => {
      return logAction({
        action: "update_profile",
        entityType: "profile",
        entityId: user?.id,
        metadata: {
          fieldsUpdated: Object.keys(changes),
          updatedAt: new Date().toISOString(),
        },
      });
    },
    [logAction, user]
  );

  /**
   * Log avatar uploads
   */
  const logAvatarUpload = useCallback(
    async (avatarUrl: string) => {
      return logAction({
        action: "upload_avatar",
        entityType: "profile",
        entityId: user?.id,
        metadata: {
          avatarUrl,
          uploadedAt: new Date().toISOString(),
        },
      });
    },
    [logAction, user]
  );

  /**
   * Log trial balance uploads
   */
  const logTrialBalanceUpload = useCallback(
    async (uploadId: string, fileName: string, fileSize: number) => {
      return logAction({
        action: "upload_trial_balance",
        entityType: "trial_balance_upload",
        entityId: uploadId,
        metadata: {
          fileName,
          fileSize,
          uploadedAt: new Date().toISOString(),
        },
      });
    },
    [logAction]
  );

  /**
   * Log trial balance processing
   */
  const logTrialBalanceProcessing = useCallback(
    async (uploadId: string, success: boolean, accountCount?: number) => {
      return logAction({
        action: "process_trial_balance",
        entityType: "trial_balance_upload",
        entityId: uploadId,
        metadata: {
          success,
          accountCount,
          processedAt: new Date().toISOString(),
        },
      });
    },
    [logAction]
  );

  /**
   * Log disclosure note generation
   */
  const logDisclosureNoteGeneration = useCallback(
    async (uploadId: string, noteCount: number) => {
      return logAction({
        action: "generate_disclosure_notes",
        entityType: "trial_balance_upload",
        entityId: uploadId,
        metadata: {
          noteCount,
          generatedAt: new Date().toISOString(),
        },
      });
    },
    [logAction]
  );

  /**
   * Log Policy Compass queries
   */
  const logPolicyQuery = useCallback(
    async (question: string, hasFinancialContext: boolean) => {
      return logAction({
        action: "policy_compass_query",
        entityType: "policy_compass",
        metadata: {
          questionLength: question.length,
          hasFinancialContext,
          queriedAt: new Date().toISOString(),
        },
      });
    },
    [logAction]
  );

  /**
   * Log account mapping corrections
   */
  const logAccountCorrection = useCallback(
    async (uploadId: string, accountCode: string, originalCategory: string, newCategory: string) => {
      return logAction({
        action: "correct_account_mapping",
        entityType: "account_correction",
        entityId: uploadId,
        metadata: {
          accountCode,
          originalCategory,
          newCategory,
          correctedAt: new Date().toISOString(),
        },
      });
    },
    [logAction]
  );

  /**
   * Log company operations
   */
  const logCompanyOperation = useCallback(
    async (
      operation: "create_company" | "update_company" | "delete_company",
      companyId: string,
      companyName: string,
      changes?: Record<string, unknown>
    ) => {
      return logAction({
        action: operation,
        entityType: "company",
        entityId: companyId,
        metadata: {
          companyName,
          changes,
          operationAt: new Date().toISOString(),
        },
      });
    },
    [logAction]
  );

  return {
    logAction,
    logExport,
    logProfileUpdate,
    logAvatarUpload,
    logTrialBalanceUpload,
    logTrialBalanceProcessing,
    logDisclosureNoteGeneration,
    logPolicyQuery,
    logAccountCorrection,
    logCompanyOperation,
  };
}
