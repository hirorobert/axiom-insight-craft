export function Footer() {
  return (
    <footer className="border-t border-border py-12 px-6">
      <div className="max-w-7xl mx-auto">

        {/* Brand + single column of real links */}
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-8 mb-10">

          <div className="max-w-xs">
            <div className="mb-3">
              <img
                src="/saff-erp-logo.svg"
                alt="SAFF ERP"
                className="h-9 w-auto"
                draggable={false}
              />
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Tanzania statutory compliance engine.<br />
              ITA Cap.332 R.E.2023 — corporate tax, SDL,
              PAYE, and comparative financial statements.
            </p>
          </div>

          {/* Only links that actually exist */}
          <div className="flex gap-16">
            <div>
              <h4 className="text-sm font-semibold text-foreground mb-3">Product</h4>
              <ul className="space-y-2">
                <li>
                  <a href="#features" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                    Features
                  </a>
                </li>
                <li>
                  <a href="#upload" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                    Upload TB
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="text-sm font-semibold text-foreground mb-3">Account</h4>
              <ul className="space-y-2">
                <li>
                  <a href="/auth" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                    Sign In
                  </a>
                </li>
                <li>
                  <a href="/auth" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                    Sign Up
                  </a>
                </li>
              </ul>
            </div>
          </div>
        </div>

        {/* Bottom strip */}
        <div className="pt-6 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            © {new Date().getFullYear()} SAFF ERP. All rights reserved.
          </p>
          <div className="flex items-center gap-6">
            <a href="#" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
              Privacy Policy
            </a>
            <a href="#" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
              Terms of Service
            </a>
            <span className="text-xs text-muted-foreground">Data stored on Supabase</span>
          </div>
        </div>

      </div>
    </footer>
  );
}