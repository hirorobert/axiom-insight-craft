import { Link } from "react-router-dom";
import { SaffLogo } from "@/components/SaffLogo";
import { FOOTER, BRAND } from "@/constants/copy";

export function Footer() {
  return (
    <footer className="border-t border-border py-12 px-6">
      <div className="max-w-7xl mx-auto">

        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-8 mb-10">

          <div className="max-w-xs mx-auto md:mx-0 text-center md:text-left">
            <div className="mb-3 flex justify-center md:justify-start">
              <SaffLogo variant="header" className="h-11 md:h-12 w-auto mx-auto md:mx-0" />
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {FOOTER.description}
            </p>
          </div>

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
                  <a href="#security" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                    Security
                  </a>
                </li>
                <li>
                  <Link to="/pricing" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                    Pricing
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="text-sm font-semibold text-foreground mb-3">Account</h4>
              <ul className="space-y-2">
                <li>
                  <a href="/auth" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                    Sign in
                  </a>
                </li>
                <li>
                  <a href="/auth" className="text-sm text-muted-foreground hover:text-foreground transition-colors">
                    Start free
                  </a>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <div className="pt-6 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            © {new Date().getFullYear()} {BRAND.name}. All rights reserved.
          </p>
          <div className="flex items-center gap-6">
            {FOOTER.legal.map((item) => (
              <Link
                key={item.href}
                to={item.href}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {item.label}
              </Link>
            ))}
          </div>
        </div>

      </div>
    </footer>
  );
}
