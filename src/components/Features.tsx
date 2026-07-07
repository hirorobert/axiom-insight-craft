import { FileCheck, Calculator, BarChart3, GitCompare, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

const features = [
  {
    icon: FileCheck,
    title: "Trial Balance Validation",
    description: "Upload CSV or Excel. SAFF ERP validates Dr = Cr, classifies every account using 50+ pattern rules, and checks the balance sheet equation. Export is blocked until all checks pass.",
    highlights: [
      "Auto-classification of 46+ account types",
      "Balance sheet equation: Assets = Liabilities + Closing Equity",
      "Imbalance detected to TZS 1",
    ],
  },
  {
    icon: Calculator,
    title: "Corporate Tax Engine (ITA Cap.332)",
    description: "Computes the full ITA waterfall: depreciation add-back, wear & tear by class, thin capitalisation (s.24A), minimum tax (s.65), and penalty under TAA s.76. Gap vs existing provision shown instantly.",
    highlights: [
      "All 6 ITA asset classes (37.5% to 5% SL)",
      "Thin cap: resident bank exclusion applied",
      "Minimum tax gate: 3-year loss history (s.65)",
    ],
  },
  {
    icon: BarChart3,
    title: "Statutory Findings Engine",
    description: "Kinga analyses the processed TB and generates findings for SDL underpayment, PAYE anomalies, service levy, and other TRA exposure items. Each finding cites the specific ITA or TAA section.",
    highlights: [
      "SDL, PAYE, service levy checks",
      "TRA exposure quantified in TZS",
      "Evidence-linked findings trail",
    ],
  },
  {
    icon: GitCompare,
    title: "Comparative Analysis (IAS 1 / IPSAS 1)",
    description: "Link two fiscal periods and run the comparative engine. Produces IS and BS movement tables, retained earnings reconciliation per IAS 1.106, ECL adequacy check, and AMT 3-year risk status.",
    highlights: [
      "Current vs prior year side-by-side",
      "RE reconciliation per IAS 1.106",
      "ECL and AMT risk flags",
    ],
  },
];

export function Features() {
  return (
    <section id="features" className="pt-10 pb-20 px-6">
      <div className="max-w-7xl mx-auto">

        <div className="text-center mb-14">
          <h2 className="text-3xl sm:text-4xl font-bold mb-3">
            What SAFF ERP Does
          </h2>
          <p className="text-muted-foreground max-w-xl mx-auto">
            Four engines. Each one does exactly what it says.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="p-7 rounded-2xl bg-card border border-border hover:border-primary/40 transition-colors duration-200"
            >
              <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center mb-5">
                <feature.icon size={22} className="text-primary" />
              </div>

              <h3 className="text-lg font-bold text-foreground mb-2">
                {feature.title}
              </h3>

              <p className="text-sm text-foreground/60 mb-5 leading-relaxed">
                {feature.description}
              </p>

              <ul className="space-y-1.5">
                {feature.highlights.map((h) => (
                  <li key={h} className="flex items-start gap-2 text-sm text-foreground/60">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0 mt-1.5" />
                    {h}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* CTA after features */}
        <div className="mt-12 text-center">
          <p className="text-muted-foreground mb-4">
            Ready to process your first trial balance?
          </p>
          <Button variant="hero" size="lg" asChild>
            <a href="#upload">
              Upload Now
              <ArrowRight size={16} />
            </a>
          </Button>
        </div>

      </div>
    </section>
  );
}