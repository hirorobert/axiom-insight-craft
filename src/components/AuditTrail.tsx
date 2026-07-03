import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  History,
  Upload,
  FileText,
  Edit,
  Download,
  Compass,
  User,
  Camera,
  LogIn,
  LogOut,
  Filter,
  RefreshCw,
  ChevronDown,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { useAuth } from "@/contexts/AuthContext";
import { format, formatDistanceToNow } from "date-fns";

interface AuditLog {
  id: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: unknown;
  created_at: string;
}

const ACTION_CONFIG: Record<string, { icon: typeof Upload; label: string; color: string }> = {
  upload_trial_balance: { icon: Upload, label: "Upload Trial Balance", color: "bg-blue-500/10 text-blue-600 border-blue-500/20" },
  process_trial_balance: { icon: FileText, label: "Process Trial Balance", color: "bg-purple-500/10 text-purple-600 border-purple-500/20" },
  correct_account_mapping: { icon: Edit, label: "Correct Mapping", color: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20" },
  generate_disclosure_notes: { icon: FileText, label: "Generate Notes", color: "bg-green-500/10 text-green-600 border-green-500/20" },
  export_statements: { icon: Download, label: "Export Statements", color: "bg-cyan-500/10 text-cyan-600 border-cyan-500/20" },
  policy_compass_query: { icon: Compass, label: "Policy Query", color: "bg-orange-500/10 text-orange-600 border-orange-500/20" },
  update_profile: { icon: User, label: "Update Profile", color: "bg-slate-500/10 text-slate-600 border-slate-500/20" },
  upload_avatar: { icon: Camera, label: "Upload Avatar", color: "bg-pink-500/10 text-pink-600 border-pink-500/20" },
  login: { icon: LogIn, label: "Login", color: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20" },
  logout: { icon: LogOut, label: "Logout", color: "bg-red-500/10 text-red-600 border-red-500/20" },
};

export function AuditTrail() {
  const { user } = useAuth();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [showMore, setShowMore] = useState(false);

  const fetchLogs = async () => {
    if (!user) return;
    
    setLoading(true);
    try {
      let query = supabase
        .from("audit_logs")
        .select("id, action, entity_type, entity_id, metadata, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(showMore ? 100 : 20);

      if (filter !== "all") {
        query = query.eq("action", filter as Database["public"]["Enums"]["audit_action"]);
      }

      const { data, error } = await query;

      if (error) throw error;
      setLogs((data as AuditLog[]) || []);
    } catch (error) {
      console.error("Error fetching audit logs:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, [user, filter, showMore]);

  const formatMetadata = (metadata: unknown) => {
    if (!metadata || typeof metadata !== "object") return null;
    const entries = Object.entries(metadata as Record<string, unknown>).filter(([_, v]) => v != null && v !== "");
    if (entries.length === 0) return null;
    
    return entries.map(([key, value]) => (
      <span key={key} className="inline-flex items-center gap-1 text-xs">
        <span className="text-muted-foreground">{key.replace(/_/g, " ")}:</span>
        <span className="font-medium">{String(value)}</span>
      </span>
    ));
  };

  return (
    <Card className="border-border/50">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            <History className="w-5 h-5 text-primary" />
            Audit Trail
          </CardTitle>
          <CardDescription>Track all actions and AI-generated recommendations</CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-[180px] h-9">
              <Filter className="w-4 h-4 mr-2" />
              <SelectValue placeholder="Filter actions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Actions</SelectItem>
              <SelectItem value="upload_trial_balance">Uploads</SelectItem>
              <SelectItem value="process_trial_balance">Processing</SelectItem>
              <SelectItem value="correct_account_mapping">Corrections</SelectItem>
              <SelectItem value="generate_disclosure_notes">Notes</SelectItem>
              <SelectItem value="export_statements">Exports</SelectItem>
              <SelectItem value="policy_compass_query">Policy Queries</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="ghost" size="icon" onClick={fetchLogs} className="h-9 w-9">
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-[400px] pr-4">
          {loading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="flex items-start gap-3 p-3 rounded-lg border border-border">
                  <Skeleton className="w-10 h-10 rounded-lg" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                  <Skeleton className="h-3 w-20" />
                </div>
              ))}
            </div>
          ) : logs.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <History className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>No audit logs found</p>
              <p className="text-sm mt-1">Actions you take will appear here</p>
            </div>
          ) : (
            <div className="space-y-2">
              {logs.map((log) => {
                const config = ACTION_CONFIG[log.action] || {
                  icon: FileText,
                  label: log.action,
                  color: "bg-muted text-muted-foreground",
                };
                const Icon = config.icon;

                return (
                  <div
                    key={log.id}
                    className="flex items-start gap-3 p-3 rounded-lg border border-border bg-card hover:bg-secondary/30 transition-colors"
                  >
                    <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${config.color}`}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-foreground">{config.label}</span>
                        {log.entity_type && (
                          <Badge variant="outline" className="text-xs">
                            {log.entity_type}
                          </Badge>
                        )}
                      </div>
                      {log.metadata && typeof log.metadata === "object" && Object.keys(log.metadata as object).length > 0 && (
                        <div className="flex flex-wrap gap-2 mt-1">
                          {formatMetadata(log.metadata)}
                        </div>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(log.created_at), { addSuffix: true })}
                      </p>
                      <p className="text-xs text-muted-foreground/60">
                        {format(new Date(log.created_at), "HH:mm")}
                      </p>
                    </div>
                  </div>
                );
              })}
              
              {logs.length >= 20 && !showMore && (
                <Button
                  variant="ghost"
                  className="w-full mt-2"
                  onClick={() => setShowMore(true)}
                >
                  <ChevronDown className="w-4 h-4 mr-2" />
                  Show More
                </Button>
              )}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
