import { Link } from "react-router-dom";
import { CFOCloseWordmark } from "@/components/CFOCloseWordmark";
import { FOOTER, BRAND } from "@/constants/copy";
import { COMMERCIAL_NOTICE, LANDING_FOOTER_NOTE } from "@/content/landing/landingContent";
import { contactHref } from "@/lib/serviceEnquiry/entryPoints";
import { SERVICE_ENQUIRY_SURFACES } from "@/lib/serviceEnquiry/serviceEnquiryGate";
import { ContactChannelList } from "@/components/contact/ContactChannels";

// No price is rendered in the footer: proposed plan sizes appear in exactly one place, the service
// chooser. The footer carries the disclosures instead (commercial status and the scope note).
const PRODUCT_LINKS = [
  { label: "Product",             href: "/#product"             },
  { label: "Plans",               href: "/pricing"              },
  { label: "Expert help",         href: "/#specialist-services" },
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
          <div className="sm:col-span-12 lg:col-span-4">
            <CFOCloseWordmark className="text-xl" />
            <p className="mt-3 max-w-xs text-xs leading-5 text-muted-foreground">
              {FOOTER.description}
            </p>
            <p className="mt-4 max-w-xs text-[11px] leading-5 text-muted-foreground">
              {LANDING_FOOTER_NOTE}
            </p>
          </div>

          {/* Spacer */}
          <div className="hidden lg:block lg:col-span-1" />

          {/* Product links */}
          <div className="sm:col-span-4 lg:col-span-2">
            <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground">
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
          <div className="sm:col-span-3 lg:col-span-2">
            <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground">
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

          {/* Contact: the published mailboxes (src/lib/contact/contactChannels.ts) */}
          <div className="sm:col-span-5 lg:col-span-3">
            <p className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground">
              Contact
            </p>
            <ContactChannelList className="mt-4" />
            <a
              href="https://www.linkedin.com/company/106631843/"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="CFOClose on LinkedIn (opens in a new tab)"
              className="mt-5 inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" className="h-4 w-4" fill="currentColor">
                <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.13 1.45-2.13 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z" />
              </svg>
            </a>
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
