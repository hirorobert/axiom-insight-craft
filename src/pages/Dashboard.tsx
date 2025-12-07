import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  FileSpreadsheet,
  ArrowLeft,
  CheckCircle,
  Clock,
  AlertCircle,
  TrendingUp,
  BarChart3,
  PieChart,
  RefreshCw,
} from "lucide-react";

interface TrialBalanceUpload {
  id: string;
  file_name: string;
  file_size: number;
  status: string;
  uploaded_at: string;
  processed_at: string | null;
  processing_result: {
    mapping?: {
      balanceSheet?: {
        assets?: { current?: any[]; nonCurrent?: any[] };
        liabilities?: { current?: any[]; nonCurrent?: any[] };
        equity?: any[];
      };
      incomeStatement?: {
        revenue?: any[];
        costOfGoodsSold?: any[];
        operatingExpenses?: any[];
        otherIncome?: any[];
        taxes?: any[];
      };
      cashFlow?: {
        operating?: any[];
        investing?: any[];
        financing?: any[];
      };
      overallConfidence?: number;
      notes?: string[];
    };
    summary?: {
      totalAccounts: number;
      balanceSheetAccounts: number;
      incomeStatementAccounts: number;
      cashFlowAccounts: number;
      unmappedAccounts: number;
      confidenceScore: number;
    };
    statements?: string[];
    notes?: string[];
  } | null;
}

export default function Dashboard() {
  const [uploads, setUploads] = useState<TrialBalanceUpload[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedUpload, setSelectedUpload] = useState<TrialBalanceUpload | null>(null);

  const fetchUploads = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("trial_balance_uploads")
      .select("*")
      .order("uploaded_at", { ascending: false });

    if (!error && data) {
      setUploads(data as TrialBalanceUpload[]);
      if (data.length > 0 && !selectedUpload) {
        setSelectedUpload(data[0] as TrialBalanceUpload);
      }
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchUploads();
  }, []);

  const formatDate = (date: string) => {
    return new Date(date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "complete":
        return <CheckCircle className="w-4 h-4 text-accent" />;
      case "processing":
        return <Clock className="w-4 h-4 text-primary animate-pulse" />;
      case "error":
        return <AlertCircle className="w-4 h-4 text-destructive" />;
      default:
        return <Clock className="w-4 h-4 text-muted-foreground" />;
    }
  };

  const result = selectedUpload?.processing_result;
  const summary = result?.summary;
  const mapping = result?.mapping;

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border/50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="sm" asChild>
              <Link to="/" className="gap-2">
                <ArrowLeft className="w-4 h-4" />
                Back
              </Link>
            </Button>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center text-primary-foreground font-bold text-sm shadow-lg">
                AX
              </div>
              <div>
                <h1 className="text-base font-semibold text-foreground">Results Dashboard</h1>
                <p className="text-xs text-muted-foreground">AI-Generated Financial Mappings</p>
              </div>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={fetchUploads} className="gap-2">
            <RefreshCw className="w-4 h-4" />
            Refresh
          </Button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-center">
              <RefreshCw className="w-8 h-8 text-primary animate-spin mx-auto mb-4" />
              <p className="text-muted-foreground">Loading results...</p>
            </div>
          </div>
        ) : uploads.length === 0 ? (
          <div className="text-center py-16">
            <FileSpreadsheet className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
            <h2 className="text-xl font-semibold text-foreground mb-2">No uploads yet</h2>
            <p className="text-muted-foreground mb-6">
              Upload a trial balance to see AI-generated financial statement mappings.
            </p>
            <Button variant="hero" asChild>
              <Link to="/#upload">Upload Trial Balance</Link>
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            {/* Sidebar - Upload List */}
            <div className="lg:col-span-1 space-y-3">
              <h2 className="text-sm font-semibold text-foreground mb-4">Recent Uploads</h2>
              {uploads.map((upload) => (
                <button
                  key={upload.id}
                  onClick={() => setSelectedUpload(upload)}
                  className={`w-full text-left p-4 rounded-xl border transition-all ${
                    selectedUpload?.id === upload.id
                      ? "bg-primary/10 border-primary/30"
                      : "bg-card border-border hover:border-primary/20"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <FileSpreadsheet className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        {upload.file_name}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        {formatDate(upload.uploaded_at)}
                      </p>
                      <div className="flex items-center gap-2 mt-2">
                        {getStatusIcon(upload.status)}
                        <span className="text-xs text-muted-foreground capitalize">
                          {upload.status}
                        </span>
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>

            {/* Main Content */}
            <div className="lg:col-span-3 space-y-6">
              {selectedUpload ? (
                <>
                  {/* File Info */}
                  <Card className="bg-card border-border">
                    <CardHeader className="pb-3">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-lg flex items-center gap-2">
                          <FileSpreadsheet className="w-5 h-5 text-primary" />
                          {selectedUpload.file_name}
                        </CardTitle>
                        <div className="flex items-center gap-2">
                          {getStatusIcon(selectedUpload.status)}
                          <span className="text-sm text-muted-foreground capitalize">
                            {selectedUpload.status}
                          </span>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                        <div>
                          <p className="text-muted-foreground">File Size</p>
                          <p className="font-medium text-foreground">
                            {formatFileSize(selectedUpload.file_size)}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Uploaded</p>
                          <p className="font-medium text-foreground">
                            {formatDate(selectedUpload.uploaded_at)}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Processed</p>
                          <p className="font-medium text-foreground">
                            {selectedUpload.processed_at
                              ? formatDate(selectedUpload.processed_at)
                              : "—"}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Total Accounts</p>
                          <p className="font-medium text-foreground">
                            {summary?.totalAccounts || "—"}
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  {/* Confidence Score */}
                  {summary && (
                    <Card className="bg-card border-border">
                      <CardHeader className="pb-3">
                        <CardTitle className="text-lg flex items-center gap-2">
                          <TrendingUp className="w-5 h-5 text-accent" />
                          AI Confidence Score
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="flex items-center gap-4">
                          <div className="flex-1">
                            <Progress
                              value={summary.confidenceScore}
                              className="h-3"
                            />
                          </div>
                          <span className="text-2xl font-bold text-accent">
                            {summary.confidenceScore}%
                          </span>
                        </div>
                        <p className="text-sm text-muted-foreground mt-3">
                          MapNet AI analyzed {summary.totalAccounts} accounts with high confidence in account classification accuracy.
                        </p>
                      </CardContent>
                    </Card>
                  )}

                  {/* Statement Breakdown */}
                  {summary && (
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <Card className="bg-card border-border">
                        <CardContent className="pt-6">
                          <div className="flex items-center gap-3 mb-4">
                            <div className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center">
                              <BarChart3 className="w-5 h-5 text-primary" />
                            </div>
                            <div>
                              <p className="text-sm text-muted-foreground">Balance Sheet</p>
                              <p className="text-2xl font-bold text-foreground">
                                {summary.balanceSheetAccounts}
                              </p>
                            </div>
                          </div>
                          <p className="text-xs text-muted-foreground">accounts mapped</p>
                        </CardContent>
                      </Card>

                      <Card className="bg-card border-border">
                        <CardContent className="pt-6">
                          <div className="flex items-center gap-3 mb-4">
                            <div className="w-10 h-10 rounded-xl bg-accent/20 flex items-center justify-center">
                              <TrendingUp className="w-5 h-5 text-accent" />
                            </div>
                            <div>
                              <p className="text-sm text-muted-foreground">Income Statement</p>
                              <p className="text-2xl font-bold text-foreground">
                                {summary.incomeStatementAccounts}
                              </p>
                            </div>
                          </div>
                          <p className="text-xs text-muted-foreground">accounts mapped</p>
                        </CardContent>
                      </Card>

                      <Card className="bg-card border-border">
                        <CardContent className="pt-6">
                          <div className="flex items-center gap-3 mb-4">
                            <div className="w-10 h-10 rounded-xl bg-secondary flex items-center justify-center">
                              <PieChart className="w-5 h-5 text-foreground" />
                            </div>
                            <div>
                              <p className="text-sm text-muted-foreground">Cash Flow</p>
                              <p className="text-2xl font-bold text-foreground">
                                {summary.cashFlowAccounts}
                              </p>
                            </div>
                          </div>
                          <p className="text-xs text-muted-foreground">accounts mapped</p>
                        </CardContent>
                      </Card>
                    </div>
                  )}

                  {/* Detailed Mapping */}
                  {mapping && (
                    <Card className="bg-card border-border">
                      <CardHeader>
                        <CardTitle className="text-lg">Account Classifications</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-6">
                        {/* Balance Sheet Section */}
                        <div>
                          <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                            <BarChart3 className="w-4 h-4 text-primary" />
                            Balance Sheet
                          </h3>
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div className="p-4 rounded-xl bg-secondary/30 border border-border">
                              <p className="text-xs text-muted-foreground mb-2">Assets</p>
                              <p className="text-lg font-semibold text-foreground">
                                {(mapping.balanceSheet?.assets?.current?.length || 0) +
                                  (mapping.balanceSheet?.assets?.nonCurrent?.length || 0)}
                              </p>
                              <div className="mt-2 text-xs text-muted-foreground">
                                <span>{mapping.balanceSheet?.assets?.current?.length || 0} current</span>
                                <span className="mx-1">•</span>
                                <span>{mapping.balanceSheet?.assets?.nonCurrent?.length || 0} non-current</span>
                              </div>
                            </div>
                            <div className="p-4 rounded-xl bg-secondary/30 border border-border">
                              <p className="text-xs text-muted-foreground mb-2">Liabilities</p>
                              <p className="text-lg font-semibold text-foreground">
                                {(mapping.balanceSheet?.liabilities?.current?.length || 0) +
                                  (mapping.balanceSheet?.liabilities?.nonCurrent?.length || 0)}
                              </p>
                              <div className="mt-2 text-xs text-muted-foreground">
                                <span>{mapping.balanceSheet?.liabilities?.current?.length || 0} current</span>
                                <span className="mx-1">•</span>
                                <span>{mapping.balanceSheet?.liabilities?.nonCurrent?.length || 0} non-current</span>
                              </div>
                            </div>
                            <div className="p-4 rounded-xl bg-secondary/30 border border-border">
                              <p className="text-xs text-muted-foreground mb-2">Equity</p>
                              <p className="text-lg font-semibold text-foreground">
                                {mapping.balanceSheet?.equity?.length || 0}
                              </p>
                              <div className="mt-2 text-xs text-muted-foreground">accounts</div>
                            </div>
                          </div>
                        </div>

                        {/* Income Statement Section */}
                        <div>
                          <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                            <TrendingUp className="w-4 h-4 text-accent" />
                            Income Statement
                          </h3>
                          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                            <div className="p-3 rounded-xl bg-accent/10 border border-accent/20">
                              <p className="text-xs text-muted-foreground">Revenue</p>
                              <p className="text-lg font-semibold text-foreground">
                                {mapping.incomeStatement?.revenue?.length || 0}
                              </p>
                            </div>
                            <div className="p-3 rounded-xl bg-secondary/30 border border-border">
                              <p className="text-xs text-muted-foreground">COGS</p>
                              <p className="text-lg font-semibold text-foreground">
                                {mapping.incomeStatement?.costOfGoodsSold?.length || 0}
                              </p>
                            </div>
                            <div className="p-3 rounded-xl bg-secondary/30 border border-border">
                              <p className="text-xs text-muted-foreground">OpEx</p>
                              <p className="text-lg font-semibold text-foreground">
                                {mapping.incomeStatement?.operatingExpenses?.length || 0}
                              </p>
                            </div>
                            <div className="p-3 rounded-xl bg-secondary/30 border border-border">
                              <p className="text-xs text-muted-foreground">Other</p>
                              <p className="text-lg font-semibold text-foreground">
                                {mapping.incomeStatement?.otherIncome?.length || 0}
                              </p>
                            </div>
                            <div className="p-3 rounded-xl bg-secondary/30 border border-border">
                              <p className="text-xs text-muted-foreground">Taxes</p>
                              <p className="text-lg font-semibold text-foreground">
                                {mapping.incomeStatement?.taxes?.length || 0}
                              </p>
                            </div>
                          </div>
                        </div>

                        {/* Cash Flow Section */}
                        <div>
                          <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
                            <PieChart className="w-4 h-4" />
                            Cash Flow Statement
                          </h3>
                          <div className="grid grid-cols-3 gap-3">
                            <div className="p-3 rounded-xl bg-secondary/30 border border-border">
                              <p className="text-xs text-muted-foreground">Operating</p>
                              <p className="text-lg font-semibold text-foreground">
                                {mapping.cashFlow?.operating?.length || 0}
                              </p>
                            </div>
                            <div className="p-3 rounded-xl bg-secondary/30 border border-border">
                              <p className="text-xs text-muted-foreground">Investing</p>
                              <p className="text-lg font-semibold text-foreground">
                                {mapping.cashFlow?.investing?.length || 0}
                              </p>
                            </div>
                            <div className="p-3 rounded-xl bg-secondary/30 border border-border">
                              <p className="text-xs text-muted-foreground">Financing</p>
                              <p className="text-lg font-semibold text-foreground">
                                {mapping.cashFlow?.financing?.length || 0}
                              </p>
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  )}

                  {/* AI Notes */}
                  {result?.notes && result.notes.length > 0 && (
                    <Card className="bg-card border-border">
                      <CardHeader>
                        <CardTitle className="text-lg">AI Processing Notes</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <ul className="space-y-2">
                          {result.notes.map((note, index) => (
                            <li key={index} className="flex items-start gap-2 text-sm">
                              <CheckCircle className="w-4 h-4 text-accent flex-shrink-0 mt-0.5" />
                              <span className="text-muted-foreground">{note}</span>
                            </li>
                          ))}
                        </ul>
                      </CardContent>
                    </Card>
                  )}
                </>
              ) : (
                <div className="text-center py-16">
                  <p className="text-muted-foreground">Select an upload to view results</p>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
