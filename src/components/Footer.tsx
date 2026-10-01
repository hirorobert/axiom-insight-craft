import { Link } from "react-router-dom";
import { CFOCloseWordmark } from "@/components/CFOCloseWordmark";
import { FOOTER, BRAND } from "@/constants/copy";
import { COMMERCIAL_NOTICE, LANDING_FOOTER_NOTE } from "@/content/landing/landingContent";
import { contactHref } from "@/lib/serviceEnquiry/entryPoints";
import { SERVICE_ENQUIRY_SURFACES } from "@/lib/serviceEnquiry/serviceEnquiryGate";

// No price is rendered in the footer: proposed plan sizes appear in exactly one place, the service
// chooser. The footer carries the disclosures instead (commercial status and the scope note).
const PRODUCT_LINKS = [
  { label: "Services", href: "/#services" },
  { label: "Plans",    href: "/pricing"   },
] as const;

const ACCOUNT_LINKS = [
  { label: "Sign in",   href: "/auth" },
  { label: "Questions", href: "/#faq" },
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
            <p className="mt-4 max-w-xs text-[11px] leading-5 text-muted-foreground">
              {LANDING_FOOTER_NOTE}
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

      {/* ── Commercial status — a disclosure, stated once, at the foot of the page ── */}
      <div className="border-t border-border">
        <p
          data-testid="commercial-verification-notice"
          className="mx-auto max-w-7xl px-6 py-4 text-[11px] leading-5 text-muted-foreground lg:px-10"
        >
          {COMMERCIAL_NOTICE}
        </p>
      </div>

      {/* ── Legal bar ─────────────────────────────────────────────────── */}
      <div className="border-t border-border">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 px-6 py-4 sm:flex-row lg:px-10">
          <p className="text-[11px] text-muted-foreground">
            © {new Date().getFullYear()} {BRAND.name}. All rights reserved.
          </p>
          <div className="flex items-center gap-6">
            {SERVICE_ENQUIRY_SURFACES.footerContactLink && (
              <Link
                to={contactHref("site_footer")}
                className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                Contact
              </Link>
            )}
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
