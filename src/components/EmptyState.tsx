import { ReactNode } from "react";
import { LucideIcon, FileSpreadsheet, Users, FolderOpen, Search, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description: string;
  action?: {
    label: string;
    onClick: () => void;
    icon?: LucideIcon;
  };
  secondaryAction?: {
    label: string;
    onClick: () => void;
  };
  children?: ReactNode;
  size?: "sm" | "md" | "lg";
}

/**
 * Reusable empty state component for various contexts.
 */
export function EmptyState({
  icon: Icon = FolderOpen,
  title,
  description,
  action,
  secondaryAction,
  children,
  size = "md",
}: EmptyStateProps) {
  const iconSizes = {
    sm: "w-12 h-12",
    md: "w-16 h-16",
    lg: "w-20 h-20",
  };

  const containerSizes = {
    sm: "py-8",
    md: "py-12",
    lg: "py-20",
  };

  const iconWrapperSizes = {
    sm: "w-16 h-16",
    md: "w-20 h-20",
    lg: "w-24 h-24",
  };

  const titleSizes = {
    sm: "text-lg",
    md: "text-xl",
    lg: "text-2xl",
  };

  return (
    <Card className="bg-card border-border">
      <CardContent className={containerSizes[size]}>
        <div className="text-center max-w-md mx-auto">
          <div
            className={`${iconWrapperSizes[size]} rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-6`}
          >
            <Icon className={`${iconSizes[size]} text-primary`} />
          </div>
          
          <h3 className={`${titleSizes[size]} font-semibold text-foreground mb-2`}>
            {title}
          </h3>
          
          <p className="text-muted-foreground mb-6 text-sm leading-relaxed">
            {description}
          </p>

          {children}

          {(action || secondaryAction) && (
            <div className="flex flex-col sm:flex-row gap-3 justify-center mt-6">
              {action && (
                <Button 
                  variant="hero" 
                  onClick={action.onClick}
                  className="gap-2"
                >
                  {action.icon && <action.icon className="w-4 h-4" />}
                  {action.label}
                </Button>
              )}
              {secondaryAction && (
                <Button 
                  variant="outline" 
                  onClick={secondaryAction.onClick}
                >
                  {secondaryAction.label}
                </Button>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// Pre-configured empty states for common scenarios

interface PresetEmptyStateProps {
  onAction?: () => void;
}

export function NoUploadsEmptyState({ onAction }: PresetEmptyStateProps) {
  return (
    <EmptyState
      icon={FileSpreadsheet}
      title="No Trial Balances Yet"
      description="Upload your first trial balance file to see AI-generated financial statement mappings, analytics, and disclosure notes."
      action={
        onAction
          ? {
              label: "Upload Trial Balance",
              onClick: onAction,
              icon: Plus,
            }
          : undefined
      }
      size="lg"
    >
      <p className="text-xs text-muted-foreground">
        Supports CSV, XLS, and XLSX files
      </p>
    </EmptyState>
  );
}

export function NoCompaniesEmptyState({ onAction }: PresetEmptyStateProps) {
  return (
    <EmptyState
      icon={Users}
      title="No Companies Created"
      description="Create your first company to organize trial balances and financial data by entity."
      action={
        onAction
          ? {
              label: "Create Company",
              onClick: onAction,
              icon: Plus,
            }
          : undefined
      }
      size="md"
    />
  );
}

export function NoSearchResultsEmptyState({ query, onClear }: { query: string; onClear?: () => void }) {
  return (
    <EmptyState
      icon={Search}
      title="No Results Found"
      description={`We couldn't find anything matching "${query}". Try adjusting your search terms.`}
      action={
        onClear
          ? {
              label: "Clear Search",
              onClick: onClear,
            }
          : undefined
      }
      size="sm"
    />
  );
}

export function NoAuditLogsEmptyState() {
  return (
    <EmptyState
      icon={FolderOpen}
      title="No Activity Yet"
      description="Your audit trail will appear here once you start using the application."
      size="sm"
    />
  );
}
