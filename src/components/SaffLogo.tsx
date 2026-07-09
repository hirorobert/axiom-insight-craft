// ============================================================
// SaffLogo — Iron Dome Nuclear Design · v3 LOCKED
//
// Thin router around the four approved SVG source files in
// src/assets/brand/. This component MUST NOT contain any inline
// SVG paths, <text> nodes, or font references — the wordmark and
// emblem live only inside the locked SVG bytes.
//
// Variant → file (per brand handoff §1):
//   "icon-simple"    saff-icon-simple.svg      12  → 32  px
//   "icon-detailed"  saff-icon-detailed.svg    32  → 256 px
//   "header"         saff-lockup-compact.svg   150 → 300 px
//   "full"           saff-lockup-full.svg      300 → unlimited
// ============================================================

import iconSimple from "@/assets/brand/saff-icon-simple.svg";
import iconDetailed from "@/assets/brand/saff-icon-detailed.svg";
import lockupCompact from "@/assets/brand/saff-lockup-compact.svg";
import lockupFull from "@/assets/brand/saff-lockup-full.svg";

export type SaffLogoVariant =
  | "icon-simple"
  | "icon-detailed"
  | "header"
  | "full";

interface Props {
  variant?: SaffLogoVariant;
  className?: string;
  /** When true, renders as decorative image (empty alt + aria-hidden). */
  decorative?: boolean;
}

const SRC: Record<SaffLogoVariant, string> = {
  "icon-simple": iconSimple,
  "icon-detailed": iconDetailed,
  header: lockupCompact,
  full: lockupFull,
};

export function SaffLogo({
  variant = "header",
  className = "",
  decorative = false,
}: Props) {
  return (
    <img
      src={SRC[variant]}
      alt={decorative ? "" : "SAFF ERP"}
      aria-hidden={decorative || undefined}
      className={className}
      style={{ display: "block" }}
      draggable={false}
    />
  );
}