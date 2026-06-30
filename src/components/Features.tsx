import { FileCheck, Calculator, BarChart3, GitCompare } from "lucide-react";

const features = [
  {
    icon: FileCheck,
    title: "Trial Balance Validation",
    description: "Upload CSV or Excel. Axiom validates Dr = Cr, maps all accounts automatically using 50+ pattern rules, and checks the balance sheet equation. Blocks export until all checks pass.",
    highlights: ["Auto-classification of 46+ account types", "Balance sheet equation check", "Imbalance detection to TZS 1"],
  },
  {
    icon: Calculator,
    title: "Corporate Tax Engine (ITA Cap.332)",
    description: "Computes the full ITA waterfall: depreciation add-back, ITA wear & tear by class, thin capitalisation (s.24A), minimum tax (s.65), and penalty under TAA s.76. Gap vs existing provision shown instantly.",
    highlights: ["All 6 ITA asset classes (37.5% to 5% SL)", "Thin cap: resident bank exclusion applied", "Minimum tax gate: 3-year loss history"],
  },
  {
    icon: BarChart3,
    title: "Statutory Findings Engine",
    description: "Kinga analyses the processed TB and generates findings for SDL underpayment, PAYE anomalies, service levy, and other TRA exposure items. Each finding cites the specific ITA or TAA section.",
    highlights: ["SDL, PAYE, service levy checks", "TRA exposure quantified in TZS", "Evidence-linked findings trail"],
  },
  {
    icon: GitCompare,
    title: "Comparative Analysis (IAS 1 / IPSAS 1)",
    description: "Link two fiscal periods and run the comparative engine. Produces IS and BS movement tables, retained earnings reconciliation, ECL adequacy check, and AMT 3-year risk status.",
    highlights: ["Current vs prior year side-by-side", "RE reconciliation per IAS 1.106", "ECL and AMT risk flags"],
  },
];

export function Features() {
  return (
    <section id="features" className="py-24 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">
            What Axiom Does
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Four engines. Each one does exactly what it says. No features that are
            not yet built.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-8">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="p-8 rounded-2xl bg-card border border-border hover:border-primary/40 transition-colors duration-200"
            >
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-6">
                <feature.icon size={24} className="text-primary" />
              </div>

              <h3 className="text-xl font-bold text-foreground mb-3">
                {feature.title}
              </h3>

              <p className="text-muted-foreground mb-6 leading-relaxed">
                {feature.description}
              </p>

              <ul className="space-y-2">
                {feature.highlights.map((highlight) => (
                  <li key={highlight} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
                    {highlight}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
