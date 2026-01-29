import React, { useState, useEffect } from "react";
import { AlertTriangle, CheckCircle, ChevronDown, ChevronUp, Loader2, PieChart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface MappingCoverageIndicatorProps {
  uploadId: string;
  processingResult?: {
    accounts?: Array<{
      accountCode: string;
      accountName: string;
    }>;
  } | null;
  onOpenMappingManager?: () => void;
}

interface CoverageData {
  totalAccounts: number;
  mappedAccounts: number;
  unmappedAccounts: Array<{ code: string; name: string }>;
  coveragePercent: number;
}

export const MappingCoverageIndicator: React.FC<MappingCoverageIndicatorProps> = ({
  uploadId,
  processingResult,
  onOpenMappingManager,
}) => {
  const [coverage, setCoverage] = useState<CoverageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [isExpanded, setIsExpanded] = useState(false);
  const { user } = useAuth();

  useEffect(() => {
    const calculateCoverage = async () => {
      if (!user || !processingResult?.accounts) {
        setLoading(false);
        return;
      }

      try {
        // Get all user's account mappings
        const { data: mappings, error } = await supabase
          .from("account_mappings")
          .select("account_code")
          .eq("user_id", user.id);

        if (error) throw error;

        const mappedCodes = new Set(
          (mappings || []).map((m) => m.account_code.toLowerCase().trim())
        );

        const trialBalanceAccounts = processingResult.accounts;
        const unmapped: Array<{ code: string; name: string }> = [];

        trialBalanceAccounts.forEach((account) => {
          const normalizedCode = account.accountCode.toLowerCase().trim();
          if (!mappedCodes.has(normalizedCode)) {
            unmapped.push({
              code: account.accountCode,
              name: account.accountName,
            });
          }
        });

        const total = trialBalanceAccounts.length;
        const mapped = total - unmapped.length;

        setCoverage({
          totalAccounts: total,
          mappedAccounts: mapped,
          unmappedAccounts: unmapped,
          coveragePercent: total > 0 ? Math.round((mapped / total) * 100) : 0,
        });
      } catch (err) {
        console.error("Error calculating coverage:", err);
      } finally {
        setLoading(false);
      }
    };

    calculateCoverage();
  }, [user, processingResult, uploadId]);

  if (loading) {
    return (
      <Card className="border-border/50 bg-card/50">
        <CardContent className="py-4">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Checking mapping coverage...</span>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!coverage || coverage.totalAccounts === 0) {
    return null;
  }

  const isFullyCovered = coverage.coveragePercent === 100;
  const isCritical = coverage.coveragePercent < 50;
  const isWarning = coverage.coveragePercent >= 50 && coverage.coveragePercent < 100;

  return (
    <Card
      className={`border transition-colors ${
        isFullyCovered
          ? "border-accent/30 bg-accent/5"
          : isCritical
          ? "border-destructive/30 bg-destructive/5"
          : "border-warning/30 bg-warning/5"
      }`}
    >
      <CardHeader className="py-3 px-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {isFullyCovered ? (
              <CheckCircle className="w-5 h-5 text-accent" />
            ) : (
              <AlertTriangle
                className={`w-5 h-5 ${isCritical ? "text-destructive" : "text-warning"}`}
              />
            )}
            <div>
              <CardTitle className="text-sm font-medium">
                Mapping Coverage
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                {coverage.mappedAccounts} of {coverage.totalAccounts} accounts mapped
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Progress
                value={coverage.coveragePercent}
                className={`w-24 h-2 ${
                  isFullyCovered
                    ? "[&>div]:bg-accent"
                    : isCritical
                    ? "[&>div]:bg-destructive"
                    : "[&>div]:bg-warning"
                }`}
              />
              <Badge
                variant={isFullyCovered ? "default" : "secondary"}
                className={`text-xs ${
                  isFullyCovered
                    ? "bg-accent text-accent-foreground"
                    : isCritical
                    ? "bg-destructive/10 text-destructive border-destructive/20"
                    : "bg-warning/10 text-warning border-warning/20"
                }`}
              >
                {coverage.coveragePercent}%
              </Badge>
            </div>
          </div>
        </div>
      </CardHeader>

      {coverage.unmappedAccounts.length > 0 && (
        <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="w-full rounded-none border-t border-border/50 justify-between px-4 py-2 h-auto"
            >
              <span className="text-xs text-muted-foreground">
                {coverage.unmappedAccounts.length} unmapped account
                {coverage.unmappedAccounts.length !== 1 ? "s" : ""}
              </span>
              {isExpanded ? (
                <ChevronUp className="w-4 h-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-4 h-4 text-muted-foreground" />
              )}
            </Button>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <CardContent className="pt-0 pb-3 px-4">
              <div className="max-h-40 overflow-y-auto space-y-1 mb-3">
                {coverage.unmappedAccounts.slice(0, 20).map((account, idx) => (
                  <div
                    key={`${account.code}-${idx}`}
                    className="flex items-center gap-2 text-xs py-1 px-2 rounded bg-secondary/50"
                  >
                    <code className="font-mono text-primary font-medium">
                      {account.code}
                    </code>
                    <span className="text-muted-foreground truncate">
                      {account.name}
                    </span>
                  </div>
                ))}
                {coverage.unmappedAccounts.length > 20 && (
                  <p className="text-xs text-muted-foreground text-center py-1">
                    +{coverage.unmappedAccounts.length - 20} more...
                  </p>
                )}
              </div>

              {onOpenMappingManager && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onOpenMappingManager}
                  className="w-full gap-2"
                >
                  <PieChart className="w-4 h-4" />
                  Open Mapping Manager
                </Button>
              )}
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      )}

      {isFullyCovered && (
        <CardContent className="pt-0 pb-3 px-4">
          <p className="text-xs text-accent flex items-center gap-1.5">
            <CheckCircle className="w-3.5 h-3.5" />
            All accounts are mapped. Ready for deterministic processing.
          </p>
        </CardContent>
      )}
    </Card>
  );
};
