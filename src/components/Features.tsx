import { FileCheck, TrendingUp, Building2, CheckCircle2 } from "lucide-react";

const features = [
  {
    icon: FileCheck,
    title: "Compliance Engine",
    subtitle: "Carpenter",
    description: "Transform trial balance into audit-ready financial statements with full notes, disclosures, and signed trails. Multi-jurisdiction support included.",
    highlights: ["Auto-generated disclosures", "Jurisdiction-aware formatting", "Append-only audit trails"],
  },
  {
    icon: TrendingUp,
    title: "Intelligence Engine",
    subtitle: "Analyst",
    description: "Unlock strategic insights with trend analysis, peer benchmarking, predictive alerts, and scenario modeling. Turn numbers into narratives.",
    highlights: ["Real-time trend detection", "Industry benchmarking", "What-if scenarios"],
  },
  {
    icon: Building2,
    title: "Enterprise & White-Label",
    subtitle: "Scale",
    description: "Embed Axiom seamlessly into your firm's workflow. Custom branding, SSO, API access, and dedicated success management included.",
    highlights: ["Custom branding", "SSO & API access", "Dedicated support"],
  },
];

export function Features() {
  return (
    <section id="features" className="py-24 px-6 relative">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl sm:text-4xl font-bold mb-4">
            Two Engines. One Platform.
          </h2>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Axiom combines compliance automation with strategic intelligence to 
            transform how accounting firms deliver value.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8">
          {features.map((feature, index) => (
            <div
              key={feature.title}
              className="group relative p-8 rounded-2xl bg-card border border-border hover:border-primary/50 transition-all duration-300 hover:-translate-y-1"
              style={{ animationDelay: `${index * 0.1}s` }}
            >
              {/* Gradient overlay on hover */}
              <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-primary/5 to-accent/5 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
              
              <div className="relative">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center mb-6 shadow-lg">
                  <feature.icon size={24} className="text-primary-foreground" />
                </div>

                <div className="mb-4">
                  <span className="text-xs font-medium text-accent uppercase tracking-wider">
                    {feature.subtitle}
                  </span>
                  <h3 className="text-xl font-bold text-foreground mt-1">
                    {feature.title}
                  </h3>
                </div>

                <p className="text-muted-foreground mb-6 leading-relaxed">
                  {feature.description}
                </p>

                <ul className="space-y-3">
                  {feature.highlights.map((highlight) => (
                    <li key={highlight} className="flex items-center gap-2 text-sm text-muted-foreground">
                      <CheckCircle2 size={16} className="text-accent flex-shrink-0" />
                      {highlight}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
