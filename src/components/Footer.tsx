import { Link } from "react-router-dom";
import { CFOCloseWordmark } from "@/components/CFOCloseWordmark";
import { FOOTER, BRAND, NAV, PRICING } from "@/constants/copy";

const PRODUCT_LINKS = [
  { label: "Outcomes",  href: "/#outcomes"  },
  { label: "Method",    href: "/#method"    },
  { label: "Controls",  href: "/#security"  },
  { label: "Pricing",   href: "/pricing"    },
] as const;

const ACCOUNT_LINKS = [
  { label: "Sign in",        href: "/auth"       },
  { label: "Choose outcome", href: "/#outcomes"  },
] as const;

export function Footer() {
  return (
    <footer className="border-t border-border bg-background">

      {/* ── Main footer grid ─────────────────────────────────────────── */}
      <div className="mx-auto max-w-7xl px-6 py-10 lg:px-10">
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-12">

          {/* Brand column */}
          <div className="sm:col-span-5 lg:col-span-4">
            <CFOCloseWordmark className="text-xl" />
            <p className="mt-3 max-w-xs text-xs leading-5 text-muted-foreground">
              {FOOTER.description}
            </p>
            <p className="mt-4 text-[10px] font-mono text-muted-foreground/45">
              {PRICING.CURRENCY_CODE} {PRICING.ANNUAL_USD}/yr · {PRICING.CURRENCY_CODE} {PRICING.MONTHLY_USD}/mo
            </p>
          </div>

          {/* Spacer */}
          <div className="hidden lg:block lg:col-span-2" />

          {/* Product links */}
          <div className="sm:col-span-3 lg:col-span-3">
            <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground/55">
              Product
            </p>
            <ul className="mt-4 space-y-2.5">
              {PRODUCT_LINKS.map(({ label, href }) => (
                <li key={href}>
                  <a
                    href={href}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Account links */}
          <div className="sm:col-span-3 lg:col-span-3">
            <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground/55">
              Account
            </p>
            <ul className="mt-4 space-y-2.5">
              {ACCOUNT_LINKS.map(({ label, href }) => (
                <li key={href}>
                  <a
                    href={href}
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* ── Legal bar ─────────────────────────────────────────────────── */}
      <div className="border-t border-border">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 px-6 py-4 sm:flex-row lg:px-10">
          <p className="text-[11px] text-muted-foreground">
            © {new Date().getFullYear()} {BRAND.name}. All rights reserved.
          </p>
          <div className="flex items-center gap-6">
            {FOOTER.legal.map(({ label, href }) => (
              <Link
                key={href}
                to={href}
                className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                {label}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </footer>
  );
}
