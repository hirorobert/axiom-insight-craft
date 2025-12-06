export function Footer() {
  return (
    <footer id="contact" className="border-t border-border py-16 px-6">
      <div className="max-w-7xl mx-auto">
        <div className="grid md:grid-cols-4 gap-12 mb-12">
          {/* Brand */}
          <div className="md:col-span-2">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center text-primary-foreground font-bold text-sm">
                AX
              </div>
              <span className="text-lg font-semibold text-foreground">Axiom</span>
            </div>
            <p className="text-muted-foreground max-w-sm mb-6">
              Autonomous Financial Intelligence. Transform raw accounting data into 
              audit-ready statements and actionable business insights.
            </p>
            <p className="text-sm text-muted-foreground">
              © {new Date().getFullYear()} Axiom. All rights reserved.
            </p>
          </div>

          {/* Product */}
          <div>
            <h4 className="font-semibold text-foreground mb-4">Product</h4>
            <ul className="space-y-3">
              {["Features", "Pricing", "Security", "Integrations", "API Docs"].map((item) => (
                <li key={item}>
                  <a href="#" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                    {item}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Company */}
          <div>
            <h4 className="font-semibold text-foreground mb-4">Company</h4>
            <ul className="space-y-3">
              {["About", "Careers", "Blog", "Contact", "Partners"].map((item) => (
                <li key={item}>
                  <a href="#" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                    {item}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="pt-8 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-6">
            <a href="#" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Privacy Policy
            </a>
            <a href="#" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
              Terms of Service
            </a>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">SOC 2 Type II Certified</span>
            <span className="text-muted-foreground">•</span>
            <span className="text-sm text-muted-foreground">GDPR Compliant</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
