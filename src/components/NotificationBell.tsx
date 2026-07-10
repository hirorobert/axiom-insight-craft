/**
 * NotificationBell.tsx
 * Sprint 6 Item 2 — Iron Dome Nuclear Design
 *
 * Header badge + dropdown showing categorised alerts.
 * Counts from live DB via useNotifications hook.
 * Refreshes every 60 seconds automatically.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { useNotifications } from "@/hooks/useNotifications";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Bell,
  AlertTriangle,
  Clock,
  BookOpen,
  UserCheck,
  CheckCircle,
  RefreshCw,
  ChevronRight,
  Loader2,
} from "lucide-react";

// ── Helpers ───────────────────────────────────────────────────────────────────

const CATEGORY_ICONS: Record<string, React.ElementType> = {
  overdue:  AlertTriangle,
  findings: BookOpen,
  ajes:     CheckCircle,
  signoffs: UserCheck,
};

const SEVERITY_COLORS = {
  critical: { dot: "bg-red-500",    text: "text-red-700",    bg: "bg-red-50 border-red-200"    },
  warn:     { dot: "bg-amber-500",  text: "text-amber-700",  bg: "bg-amber-50 border-amber-200"  },
  info:     { dot: "bg-blue-500",   text: "text-blue-700",   bg: "bg-blue-50 border-blue-200"    },
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  userId: string | undefined;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function NotificationBell({ userId }: Props) {
  const { totalCount, categories, loading, refresh } = useNotifications(userId);
  const [open, setOpen] = useState(false);

  const badgeCount = totalCount > 99 ? "99+" : totalCount > 0 ? String(totalCount) : null;
  const hasCritical = categories.some(c => c.severity === "critical" && c.count > 0);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="relative h-9 w-9 p-0 rounded-full"
          aria-label={totalCount > 0 ? `${totalCount} alerts` : "No alerts"}
        >
          <Bell className={`w-4 h-4 ${totalCount > 0 ? "text-foreground" : "text-muted-foreground"}`} />
          {badgeCount && (
            <span className={`absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-0.5 rounded-full text-[10px] font-bold text-white flex items-center justify-center leading-none ${hasCritical ? "bg-red-500" : "bg-amber-500"}`}>
              {badgeCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        className="w-80 p-0 shadow-xl border border-border"
        align="end"
        sideOffset={8}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
          <div className="flex items-center gap-2">
            <Bell className="w-4 h-4 text-foreground" />
            <span className="text-sm font-semibold text-foreground">Alerts</span>
            {totalCount > 0 && (
              <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${hasCritical ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                {totalCount} pending
              </span>
            )}
          </div>
          <button
            onClick={() => refresh()}
            className="p-1 rounded hover:bg-muted/50 transition-colors"
            aria-label="Refresh"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-muted-foreground ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[420px] overflow-y-auto">
          {loading && categories.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Checking alerts…
            </div>
          ) : categories.length === 0 ? (
            <div className="py-8 text-center">
              <CheckCircle className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
              <p className="text-sm font-medium text-foreground">All clear</p>
              <p className="text-xs text-muted-foreground mt-0.5">No pending alerts</p>
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {categories.map(category => {
                const Icon = CATEGORY_ICONS[category.key] ?? Bell;
                const colors = SEVERITY_COLORS[category.severity];
                return (
                  <div key={category.key} className="p-0">
                    {/* Category header */}
                    <div className={`flex items-center gap-2 px-4 py-2 border-b border-border/30 ${colors.bg} border-l-2 ${colors.dot.replace("bg-", "border-l-")}`}>
                      <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${colors.dot}`} />
                      <Icon className={`w-3.5 h-3.5 ${colors.text}`} />
                      <span className={`text-xs font-semibold ${colors.text}`}>{category.label}</span>
                      <span className={`ml-auto text-xs font-bold px-1.5 py-0.5 rounded-full ${colors.bg.includes("red") ? "bg-red-100 text-red-700" : colors.bg.includes("amber") ? "bg-amber-100 text-amber-700" : "bg-blue-100 text-blue-700"}`}>
                        {category.count}
                      </span>
                    </div>

                    {/* Items */}
                    {category.items.slice(0, 5).map(item => (
                      <div
                        key={item.id}
                        className="flex items-start gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors"
                      >
                        <div className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${colors.dot} opacity-60`} />
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-foreground truncate">{item.title}</p>
                          <p className="text-[10px] text-muted-foreground">{item.detail}</p>
                          {item.companyName && (
                            <p className="text-[10px] text-muted-foreground/70">{item.companyName}</p>
                          )}
                        </div>
                        {item.href && (
                          <Link
                            to={item.href}
                            onClick={() => setOpen(false)}
                            className="flex-shrink-0 mt-0.5 text-muted-foreground hover:text-foreground"
                          >
                            <ChevronRight className="w-3.5 h-3.5" />
                          </Link>
                        )}
                      </div>
                    ))}

                    {category.items.length > 5 && (
                      <p className="text-[10px] text-muted-foreground text-center pb-2">
                        +{category.items.length - 5} more
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        {categories.length > 0 && (
          <div className="border-t border-border px-4 py-2.5 flex items-center justify-between bg-muted/20">
            <span className="text-[10px] text-muted-foreground">Refreshes every 60s</span>
            <Link
              to="/dashboard"
              onClick={() => setOpen(false)}
              className="text-xs font-medium text-primary hover:text-primary/80 flex items-center gap-1"
            >
              Open Dashboard <ChevronRight className="w-3 h-3" />
            </Link>
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
