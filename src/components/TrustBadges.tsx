import { useEffect, useRef, useState } from "react";
import {
  ShieldCheck,
  Scale,
  Lock,
  FileCheck,
  GitCommit,
  Landmark,
} from "lucide-react";

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

const SECTION_IDS = Array.from(new Set(BADGES.map((b) => b.href.replace("#", ""))));

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !("matchMedia" in window)) {
      return;
    }

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);

    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

function focusEvidenceSection(id: string, prefersReducedMotion: boolean) {
  const el = document.getElementById(id);
  if (!el) return;

  el.scrollIntoView({
    behavior: prefersReducedMotion ? "auto" : "smooth",
    block: "start",
  });
  window.history.pushState(null, "", `#${id}`);

  // Move focus to the evidence section so keyboard users continue from the
  // destination rather than losing their place in the badge strip.
  if ("focus" in el && typeof (el as HTMLElement).focus === "function") {
    el.tabIndex = -1;
    (el as HTMLElement).focus({ preventScroll: true });
  }
}

export function TrustBadges() {
  const [activeId, setActiveId] = useState<string | null>(null);
  const prefersReducedMotion = usePrefersReducedMotion();
  const linkRefs = useRef<(HTMLAnchorElement | null)[]>([]);

  useEffect(() => {
    if (typeof window === "undefined" || !("IntersectionObserver" in window)) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);

        if (visible.length > 0) {
          setActiveId(visible[0].target.id);
        }
      },
      {
        rootMargin: "-40% 0px -40% 0px",
        threshold: [0, 0.25, 0.5, 0.75, 1],
      }
    );

    SECTION_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, []);

  const handleActivate = (href: string) => {
    const id = href.replace("#", "");
    focusEvidenceSection(id, prefersReducedMotion);
  };

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    e.preventDefault();
    handleActivate(href);
  };

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLAnchorElement>,
    href: string,
    index: number
  ) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleActivate(href);
      return;
    }

    // Arrow-key navigation keeps keyboard users inside the badge strip.
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      const next = linkRefs.current[index + 1] ?? linkRefs.current[0];
      next?.focus();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      const prev =
        linkRefs.current[index - 1] ??
        linkRefs.current[linkRefs.current.length - 1];
      prev?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      linkRefs.current[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      linkRefs.current[linkRefs.current.length - 1]?.focus();
    }
  };

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

        <ul
          role="listbox"
          aria-label="Trust guarantee evidence links"
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-px bg-border border border-border"
        >
          {BADGES.map(({ icon: Icon, title, plain, evidence, href }, index) => {
            const targetId = href.replace("#", "");
            const isActive = activeId === targetId;

            return (
              <li key={title} className="bg-background" role="none">
                <a
                  ref={(el) => {
                    linkRefs.current[index] = el;
                  }}
                  href={href}
                  role="option"
                  aria-selected={isActive}
                  aria-current={isActive ? "true" : undefined}
                  onClick={(e) => handleClick(e, href)}
                  onKeyDown={(e) => handleKeyDown(e, href, index)}
                  className={`group block h-full p-5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                    isActive
                      ? "bg-muted/60"
                      : "hover:bg-muted/40"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <span
                      className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border transition-colors ${
                        isActive
                          ? "border-primary/40 bg-primary/[0.06] text-primary"
                          : "border-border text-primary/80 group-hover:text-primary"
                      }`}
                    >
                      <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <p
                        className={`text-sm font-semibold leading-snug mb-1 ${
                          isActive ? "text-primary" : "text-foreground"
                        }`}
                      >
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
            );
          })}
        </ul>
      </div>
    </section>
  );
}