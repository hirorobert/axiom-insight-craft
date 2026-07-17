import { ShieldCheck, Scale, Lock, FileCheck, GitCommit, Landmark } from "lucide-react";

// Plain-language trust guarantees with evidence anchors.
// Evidence links point to on-page reference sections (Security Architecture,
// Financial Integrity, Platform Reference) rather than fabricated certifications.
const BADGES = [
  {
    icon: Landmark,
    title: "NBAA-aligned IFRS output",
    plain: "Statements follow IFRS as adopted in Tanzania.",
    evidence: "IAS 1 · IAS 7 · NBAA Act Cap.286",
    href: "#features",
  },
  {
    icon: Scale,
    title: "ITA Cap.332 + Finance Act 2026",
    plain: "Tax computation enacted on current statute.",
    evidence: "Wear & tear · Thin cap · Minimum tax",
    href: "#features",
  },
  {
    icon: ShieldCheck,
    title: "Firm-level data isolation",
    plain: "Every row scoped to your firm — enforced in the database.",
    evidence: "Row-level policies · Session-bound identity",
    href: "#security",
  },
  {
    icon: GitCommit,
    title: "Append-only audit trail",
    plain: "No record can be deleted or silently altered.",
    evidence: "Reversals create new rows with full attribution",
    href: "#integrity",
  },
  {
    icon: Lock,
    title: "Encrypted at rest & in transit",
    plain: "Enterprise-grade hosting with encrypted storage.",
    evidence: "TLS 1.2+ · AES-256 at rest",
    href: "#security",
  },
  {
    icon: FileCheck,
    title: "TRA-ready filing package",
    plain: "Tax computation PDF and XBRL instance in accepted format.",
    evidence: "TAA Cap.399 s.38 · IDRAS e-Filing",
    href: "#features",
  },
] as const;

export function TrustBadges() {
  return (
    <section
      aria-label="Certifications and security guarantees"
      className="px-6 py-14 bg-background border-t border-b border-border"
    >
      <div className="max-w-7xl mx-auto">
        <div className="mb-8 flex items-baseline justify-between gap-6 flex-wrap">
          <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground/60">
            Trust &amp; Compliance
          </p>
          <p className="text-xs text-muted-foreground max-w-md">
            Plain-language guarantees. Each links to the statutory basis or
            structural control that enforces it.
          </p>
        </div>

        <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-border border border-border">
          {BADGES.map(({ icon: Icon, title, plain, evidence, href }) => (
            <li key={title} className="bg-background">
              <a
                href={href}
                className="group block h-full p-5 hover:bg-muted/40 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-border text-primary/80 group-hover:text-primary">
                    <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground leading-snug mb-1">
                      {title}
                    </p>
                    <p className="text-xs text-muted-foreground leading-relaxed mb-2">
                      {plain}
                    </p>
                    <p className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground/55">
                      {evidence}
                    </p>
                  </div>
                </div>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}