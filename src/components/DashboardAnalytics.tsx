import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  AreaChart,
  Area,
} from "recharts";
import { TrendingUp, BarChart3, PieChart as PieChartIcon, Activity } from "lucide-react";

interface Upload {
  id: string;
  file_name: string;
  uploaded_at: string;
  status: string;
  processing_result: {
    summary?: {
      totalAccounts: number;
      balanceSheetAccounts: number;
      incomeStatementAccounts: number;
      cashFlowAccounts: number;
      confidenceScore: number;
    };
  } | null;
}

interface DashboardAnalyticsProps {
  uploads: Upload[];
}

const CHART_COLORS = {
  primary: "hsl(var(--primary))",
  accent: "hsl(var(--accent))",
  secondary: "hsl(var(--secondary))",
  muted: "hsl(var(--muted))",
  balanceSheet: "#6366f1",
  incomeStatement: "#10b981",
  cashFlow: "#f59e0b",
};

export function DashboardAnalytics({ uploads }: DashboardAnalyticsProps) {
  // Process data for charts
  const analytics = useMemo(() => {
    const completedUploads = uploads.filter(
      (u) => u.status === "complete" && u.processing_result?.summary
    );

    // Upload trends over time (last 30 days)
    const uploadTrends = completedUploads
      .slice(0, 10)
      .reverse()
      .map((upload) => ({
        date: new Date(upload.uploaded_at).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        }),
        confidence: upload.processing_result?.summary?.confidenceScore || 0,
        accounts: upload.processing_result?.summary?.totalAccounts || 0,
        name: upload.file_name.slice(0, 15),
      }));

    // Account distribution (aggregate)
    const accountDistribution = completedUploads.reduce(
      (acc, upload) => {
        const summary = upload.processing_result?.summary;
        if (summary) {
          acc.balanceSheet += summary.balanceSheetAccounts || 0;
          acc.incomeStatement += summary.incomeStatementAccounts || 0;
          acc.cashFlow += summary.cashFlowAccounts || 0;
        }
        return acc;
      },
      { balanceSheet: 0, incomeStatement: 0, cashFlow: 0 }
    );

    const pieData = [
      { name: "Balance Sheet", value: accountDistribution.balanceSheet, color: CHART_COLORS.balanceSheet },
      { name: "Income Statement", value: accountDistribution.incomeStatement, color: CHART_COLORS.incomeStatement },
      { name: "Cash Flow", value: accountDistribution.cashFlow, color: CHART_COLORS.cashFlow },
    ].filter((d) => d.value > 0);

    // Confidence score comparison
    const confidenceComparison = completedUploads.slice(0, 5).map((upload) => ({
      name: upload.file_name.length > 12 
        ? upload.file_name.slice(0, 12) + "..." 
        : upload.file_name,
      confidence: upload.processing_result?.summary?.confidenceScore || 0,
      total: upload.processing_result?.summary?.totalAccounts || 0,
    }));

    // Summary stats
    const avgConfidence = completedUploads.length > 0
      ? Math.round(
          completedUploads.reduce(
            (sum, u) => sum + (u.processing_result?.summary?.confidenceScore || 0),
            0
          ) / completedUploads.length
        )
      : 0;

    const totalAccountsProcessed = completedUploads.reduce(
      (sum, u) => sum + (u.processing_result?.summary?.totalAccounts || 0),
      0
    );

    return {
      uploadTrends,
      pieData,
      confidenceComparison,
      avgConfidence,
      totalAccountsProcessed,
      completedCount: completedUploads.length,
    };
  }, [uploads]);

  const hasCompletedUploads = analytics.completedCount > 0;

  if (uploads.length === 0) {
    return null;
  }

  // Show empty state when no completed uploads
  if (!hasCompletedUploads) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="py-12">
          <div className="text-center">
            <div className="w-16 h-16 rounded-full bg-muted/50 flex items-center justify-center mx-auto mb-4">
              <Activity className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-2">Analytics Coming Soon</h3>
            <p className="text-muted-foreground text-sm max-w-md mx-auto">
              Once your trial balances finish processing, you'll see confidence scores, 
              account distributions, and trend analysis here.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="bg-card border-border">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center">
                <Activity className="w-5 h-5 text-primary" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Avg Confidence</p>
                <p className="text-2xl font-bold text-foreground">{analytics.avgConfidence}%</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-accent/20 flex items-center justify-center">
                <BarChart3 className="w-5 h-5 text-accent" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Total Accounts</p>
                <p className="text-2xl font-bold text-foreground">
                  {analytics.totalAccountsProcessed.toLocaleString()}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-card border-border">
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-secondary flex items-center justify-center">
                <TrendingUp className="w-5 h-5 text-foreground" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">Files Processed</p>
                <p className="text-2xl font-bold text-foreground">{analytics.completedCount}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Confidence Trend */}
        {analytics.uploadTrends.length > 1 && (
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-primary" />
                Confidence Score Trend
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={analytics.uploadTrends}>
                    <defs>
                      <linearGradient id="confidenceGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.primary} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={CHART_COLORS.primary} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                      axisLine={{ stroke: "hsl(var(--border))" }}
                    />
                    <YAxis
                      domain={[0, 100]}
                      tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                      axisLine={{ stroke: "hsl(var(--border))" }}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "8px",
                      }}
                      labelStyle={{ color: "hsl(var(--foreground))" }}
                    />
                    <Area
                      type="monotone"
                      dataKey="confidence"
                      stroke={CHART_COLORS.primary}
                      fill="url(#confidenceGradient)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Account Distribution Pie */}
        {analytics.pieData.length > 0 && (
          <Card className="bg-card border-border">
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <PieChartIcon className="w-4 h-4 text-accent" />
                Account Distribution
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="h-[220px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={analytics.pieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={80}
                      paddingAngle={4}
                      dataKey="value"
                    >
                      {analytics.pieData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: "8px",
                      }}
                      formatter={(value: number) => [value.toLocaleString(), "Accounts"]}
                    />
                    <Legend
                      wrapperStyle={{ fontSize: "12px" }}
                      formatter={(value) => (
                        <span style={{ color: "hsl(var(--foreground))" }}>{value}</span>
                      )}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* File Comparison Bar Chart */}
      {analytics.confidenceComparison.length > 1 && (
        <Card className="bg-card border-border">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-primary" />
              Recent Files Comparison
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={analytics.confidenceComparison} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis
                    type="number"
                    domain={[0, 100]}
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    axisLine={{ stroke: "hsl(var(--border))" }}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={100}
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    axisLine={{ stroke: "hsl(var(--border))" }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "8px",
                    }}
                    formatter={(value: number, name: string) => [
                      name === "confidence" ? `${value}%` : value,
                      name === "confidence" ? "Confidence" : "Total Accounts",
                    ]}
                  />
                  <Bar dataKey="confidence" fill={CHART_COLORS.primary} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
