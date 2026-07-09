import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  XCircle,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  GitCommit,
  Clock,
} from "lucide-react";


type Upload = {
  id: string;
  file_name: string;
  status: string;
  uploaded_at: string;
  processed_at: string | null;
  company_name: string | null;
  processing_result: string | null;
  accounting_errors: string | null;
  validation_report: string | null;
};

type Bucket = "processing" | "succeeded" | "failed";

function bucketFor(status: string): Bucket {
  const s = status.toLowerCase();
  if (["complete", "valid", "succeeded", "success"].includes(s)) return "succeeded";
  if (["error", "failed", "blocked"].includes(s)) return "failed";
  return "processing";
}

function StatusBadge({ status }: { status: string }) {
  const b = bucketFor(status);
  if (b === "succeeded")
    return (
      <Badge className="bg-green-600 hover:bg-green-600 text-white gap-1">
        <CheckCircle2 className="h-3 w-3" /> Succeeded
      </Badge>
    );
  if (b === "failed")
    return (
      <Badge variant="destructive" className="gap-1">
        <XCircle className="h-3 w-3" /> Failed
      </Badge>
    );
  return (
    <Badge variant="secondary" className="gap-1">
      <Loader2 className="h-3 w-3 animate-spin" /> Processing
    </Badge>
  );
}

export default function UploadStatus() {
  const { user } = useAuth();
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("trial_balance_uploads")
      .select(
        "id,file_name,status,uploaded_at,processed_at,company_name,processing_result,accounting_errors,validation_report"
      )
      .order("uploaded_at", { ascending: false });
    if (!error && data) setUploads(data as Upload[]);
    setLoading(false);
  };

  useEffect(() => {
    load();
    if (!user) return;
    const channel = supabase
      .channel("upload-status")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "trial_balance_uploads" },
        () => load()
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const counts = uploads.reduce(
    (acc, u) => {
      acc[bucketFor(u.status)]++;
      return acc;
    },
    { processing: 0, succeeded: 0, failed: 0 } as Record<Bucket, number>
  );

  const gitSha = import.meta.env.VITE_GIT_SHA ?? "unknown";
  const buildTimestamp = import.meta.env.VITE_BUILD_TIMESTAMP ?? "unknown";
  const shortSha = gitSha === "unknown" ? "unknown" : gitSha.slice(0, 7);

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button asChild variant="ghost" size="sm">
              <Link to="/dashboard">
                <ArrowLeft className="h-4 w-4 mr-1" /> Back
              </Link>
            </Button>
            <h1 className="text-2xl font-semibold">Upload Status</h1>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        <Card>
          <CardContent className="p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <GitCommit className="h-4 w-4" />
                <span>Latest synced commit</span>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-foreground">
                  {shortSha}
                </code>
                {gitSha !== "unknown" && (
                  <span className="hidden text-xs text-muted-foreground sm:inline">
                    {gitSha}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="h-4 w-4" />
                <span>Preview generated</span>
                <span className="text-foreground">
                  {buildTimestamp === "unknown"
                    ? "unknown"
                    : new Date(buildTimestamp).toLocaleString()}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-3 gap-4">

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Processing</CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-semibold">{counts.processing}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Succeeded</CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-semibold text-green-600">
              {counts.succeeded}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-muted-foreground">Failed</CardTitle>
            </CardHeader>
            <CardContent className="text-3xl font-semibold text-destructive">
              {counts.failed}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Trial Balance Uploads</CardTitle>
          </CardHeader>
          <CardContent>
            {loading && uploads.length === 0 ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : uploads.length === 0 ? (
              <p className="text-sm text-muted-foreground">No uploads yet.</p>
            ) : (
              <div className="divide-y">
                {uploads.map((u) => {
                  const isFailed = bucketFor(u.status) === "failed";
                  const isExpanded = expanded.has(u.id);
                  return (
                    <div key={u.id} className="py-3">
                      <div
                        className={`flex items-center justify-between gap-4 ${
                          isFailed ? "cursor-pointer" : ""
                        }`}
                        onClick={() => isFailed && toggleExpanded(u.id)}
                      >
                        <div className="min-w-0 flex items-center gap-2">
                          {isFailed &&
                            (isExpanded ? (
                              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                            ))}
                          <div className="min-w-0">
                            <p className="font-medium truncate">{u.file_name}</p>
                            <p className="text-xs text-muted-foreground">
                              {u.company_name ? `${u.company_name} · ` : ""}
                              Uploaded {new Date(u.uploaded_at).toLocaleString()}
                              {u.processed_at
                                ? ` · Processed ${new Date(u.processed_at).toLocaleString()}`
                                : ""}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-xs text-muted-foreground">{u.status}</span>
                          <StatusBadge status={u.status} />
                        </div>
                      </div>

                      {isFailed && isExpanded && (
                        <div className="mt-3 ml-6 rounded-md bg-destructive/10 p-4 text-sm">
                          <div className="mb-2 font-medium text-destructive">
                            Error details
                          </div>
                          <div className="space-y-2">
                            {u.processed_at && (
                              <p className="text-xs text-muted-foreground">
                                Failed at {new Date(u.processed_at).toLocaleString()}
                              </p>
                            )}
                            {u.processing_result && (
                              <p className="text-foreground">{u.processing_result}</p>
                            )}
                            {u.accounting_errors && (
                              <p className="text-foreground">{u.accounting_errors}</p>
                            )}
                            {u.validation_report && (
                              <p className="text-foreground">{u.validation_report}</p>
                            )}
                            {!u.processing_result && !u.accounting_errors && !u.validation_report && (
                              <p className="text-muted-foreground">No error message recorded.</p>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
