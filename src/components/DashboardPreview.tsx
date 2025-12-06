import { TrendingUp, TrendingDown, DollarSign, Users, BarChart3, PieChart, Activity, ArrowUpRight } from "lucide-react";

const metrics = [
  {
    label: "Revenue",
    value: "$2.4M",
    change: "+12.5%",
    trend: "up",
    icon: DollarSign,
  },
  {
    label: "EBITDA Margin",
    value: "23.8%",
    change: "+3.2%",
    trend: "up",
    icon: BarChart3,
  },
  {
    label: "Working Capital",
    value: "$890K",
    change: "-2.1%",
    trend: "down",
    icon: Activity,
  },
  {
    label: "Client Accounts",
    value: "147",
    change: "+8",
    trend: "up",
    icon: Users,
  },
];

const chartBars = [65, 78, 52, 89, 72, 95, 68, 82, 91, 76, 88, 94];
const trendLine = [40, 45, 42, 55, 58, 52, 68, 72, 78, 85, 82, 92];

export function DashboardPreview() {
  return (
    <section className="py-24 px-6 relative overflow-hidden">
      {/* Background glow */}
      <div className="absolute inset-0 bg-gradient-glow opacity-50" />
      
      <div className="max-w-7xl mx-auto relative">
        <div className="text-center mb-16">
          <span className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-accent/10 text-accent text-sm font-medium mb-6">
            <Activity size={16} />
            Intelligence Engine Preview
          </span>
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">
            Executive Dashboard at a Glance
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Transform raw accounting data into actionable insights with real-time 
            trend analysis, predictive alerts, and strategic recommendations.
          </p>
        </div>

        {/* Dashboard Preview Container */}
        <div className="relative rounded-2xl border border-border bg-card/80 backdrop-blur-sm p-6 shadow-glow">
          {/* Browser Chrome */}
          <div className="flex items-center gap-2 mb-6 pb-4 border-b border-border">
            <div className="flex gap-1.5">
              <div className="w-3 h-3 rounded-full bg-destructive/60" />
              <div className="w-3 h-3 rounded-full bg-yellow-500/60" />
              <div className="w-3 h-3 rounded-full bg-green-500/60" />
            </div>
            <div className="flex-1 ml-4">
              <div className="max-w-md mx-auto bg-muted rounded-lg px-4 py-1.5 text-xs text-muted-foreground text-center">
                axiom.ai/dashboard/intelligence
              </div>
            </div>
          </div>

          {/* Metrics Row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
            {metrics.map((metric, index) => (
              <div
                key={metric.label}
                className="p-4 rounded-xl bg-secondary/50 border border-border animate-fade-in"
                style={{ animationDelay: `${index * 0.1}s` }}
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="w-8 h-8 rounded-lg bg-primary/20 flex items-center justify-center">
                    <metric.icon size={16} className="text-primary" />
                  </div>
                  <div className={`flex items-center gap-1 text-xs font-medium ${
                    metric.trend === "up" ? "text-green-400" : "text-destructive"
                  }`}>
                    {metric.trend === "up" ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                    {metric.change}
                  </div>
                </div>
                <p className="text-2xl font-bold text-foreground">{metric.value}</p>
                <p className="text-xs text-muted-foreground mt-1">{metric.label}</p>
              </div>
            ))}
          </div>

          {/* Charts Row */}
          <div className="grid lg:grid-cols-3 gap-6">
            {/* Bar Chart */}
            <div className="lg:col-span-2 p-6 rounded-xl bg-secondary/30 border border-border">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h4 className="font-semibold text-foreground">Revenue Trend</h4>
                  <p className="text-xs text-muted-foreground">Last 12 months</p>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-primary" />
                    Actual
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full bg-accent" />
                    Forecast
                  </span>
                </div>
              </div>
              
              {/* Animated Bar Chart */}
              <div className="flex items-end justify-between gap-2 h-40">
                {chartBars.map((height, index) => (
                  <div key={index} className="flex-1 flex flex-col items-center gap-1">
                    <div className="w-full relative">
                      <div
                        className="w-full rounded-t-sm bg-gradient-to-t from-primary to-accent animate-grow-up"
                        style={{
                          height: `${height * 1.5}px`,
                          animationDelay: `${index * 0.05}s`,
                        }}
                      />
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      {["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"][index]}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Insights Panel */}
            <div className="p-6 rounded-xl bg-secondary/30 border border-border">
              <div className="flex items-center gap-2 mb-6">
                <PieChart size={18} className="text-accent" />
                <h4 className="font-semibold text-foreground">AI Insights</h4>
              </div>
              
              <div className="space-y-4">
                <div className="p-3 rounded-lg bg-accent/10 border border-accent/20 animate-pulse-slow">
                  <div className="flex items-start gap-2">
                    <ArrowUpRight size={14} className="text-accent mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-foreground">Revenue Acceleration</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Q4 trending 18% above forecast. Consider revising annual projections.
                      </p>
                    </div>
                  </div>
                </div>
                
                <div className="p-3 rounded-lg bg-primary/10 border border-primary/20" style={{ animationDelay: "1s" }}>
                  <div className="flex items-start gap-2">
                    <TrendingUp size={14} className="text-primary mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-foreground">Margin Improvement</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Operating costs down 4.2% YoY. Benchmark: Top quartile.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
                  <div className="flex items-start gap-2">
                    <Activity size={14} className="text-yellow-500 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-foreground">Cash Flow Alert</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        AR aging exceeds 45 days. Recommend collection review.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Trend Line Overlay */}
          <div className="mt-6 p-4 rounded-xl bg-muted/30 border border-border">
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-medium text-foreground">Predictive Cash Flow Model</span>
              <span className="text-xs text-muted-foreground">Next 12 months projection</span>
            </div>
            
            {/* SVG Trend Line */}
            <div className="h-20 relative">
              <svg className="w-full h-full" viewBox="0 0 400 80" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="lineGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="hsl(231 82% 62%)" />
                    <stop offset="100%" stopColor="hsl(199 89% 48%)" />
                  </linearGradient>
                  <linearGradient id="areaGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                    <stop offset="0%" stopColor="hsl(231 82% 62%)" stopOpacity="0.3" />
                    <stop offset="100%" stopColor="hsl(231 82% 62%)" stopOpacity="0" />
                  </linearGradient>
                </defs>
                
                {/* Area fill */}
                <path
                  d={`M0,${80 - trendLine[0] * 0.8} ${trendLine.map((v, i) => `L${(i * 400) / 11},${80 - v * 0.8}`).join(" ")} L400,80 L0,80 Z`}
                  fill="url(#areaGradient)"
                  className="animate-fade-in"
                />
                
                {/* Line */}
                <path
                  d={`M0,${80 - trendLine[0] * 0.8} ${trendLine.map((v, i) => `L${(i * 400) / 11},${80 - v * 0.8}`).join(" ")}`}
                  fill="none"
                  stroke="url(#lineGradient)"
                  strokeWidth="2"
                  strokeLinecap="round"
                  className="animate-draw-line"
                />
                
                {/* Data points */}
                {trendLine.map((v, i) => (
                  <circle
                    key={i}
                    cx={(i * 400) / 11}
                    cy={80 - v * 0.8}
                    r="3"
                    fill="hsl(231 82% 62%)"
                    className="animate-scale-in"
                    style={{ animationDelay: `${i * 0.05}s` }}
                  />
                ))}
              </svg>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
