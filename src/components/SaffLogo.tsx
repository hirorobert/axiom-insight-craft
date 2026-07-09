// ============================================================
// SaffLogo — Iron Dome Nuclear Design · Diamond Bank Grade
//
// Rebuilt from scratch as a true typographic lockup:
//   • Vault-plate emblem with chamfered corners on all four sides
//   • Green inner keyline (bank-stationery detail)
//   • Serif-clean monogram set in Manrope 800
//   • Wordmark set in Manrope 800 (SAFF navy · ERP green)
//
// Palette:
//   Vault Navy   #0A1A2E
//   Ledger Green #0E6B55
//   Slate        #55657A
//
// Variants:
//   "header" — emblem + wordmark (compact)
//   "full"   — emblem + wordmark + tagline
// ============================================================

interface Props {
  variant?: "header" | "full";
  className?: string;
}

const NAVY = "#0A1A2E";
const GREEN = "#0E6B55";
const SLATE = "#55657A";

// Shield with all four corners chamfered — reads as a vault plate.
const SHIELD_OUTER = "M6 0 H38 L44 6 V38 L38 44 H6 L0 38 V6 Z";
// Inset shield for the inner keyline (3px inset all sides).
const SHIELD_INNER = "M9 3 H35 L41 9 V35 L35 41 H9 L3 35 V9 Z";

function Emblem({ x = 0, y = 0 }: { x?: number; y?: number }) {
  return (
    <g transform={`translate(${x},${y})`}>
      {/* Navy vault plate */}
      <path d={SHIELD_OUTER} fill={NAVY} />
      {/* Green inner keyline */}
      <path d={SHIELD_INNER} fill="none" stroke={GREEN} strokeWidth="1" opacity="0.55" />
      {/* Bottom-right corner mitre in green */}
      <path d="M38 44 L44 38 V44 Z" fill={GREEN} />
      {/* Monogram S */}
      <text
        x="22"
        y="31"
        fontFamily='"Manrope", system-ui, sans-serif'
        fontWeight={800}
        fontSize="26"
        fill="#FFFFFF"
        textAnchor="middle"
        style={{ letterSpacing: "-0.04em" }}
      >
        S
      </text>
    </g>
  );
}

function Wordmark({ x, y }: { x: number; y: number }) {
  return (
    <text
      x={x}
      y={y}
      fontFamily='"Manrope", system-ui, sans-serif'
      fontWeight={800}
      fontSize="26"
      style={{ letterSpacing: "-0.02em" }}
    >
      <tspan fill={NAVY}>SAFF</tspan>
      <tspan fill={GREEN} dx="6">ERP</tspan>
    </text>
  );
}

export function SaffLogo({ variant = "header", className = "" }: Props) {
  if (variant === "header") {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 210 44"
        aria-label="SAFF ERP"
        role="img"
        className={className}
        style={{ display: "block" }}
      >
        <Emblem x={0} y={0} />
        <Wordmark x={58} y={31} />
      </svg>
    );
  }

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 210 64"
      aria-label="SAFF ERP — Audit-Ready FS & Tax Reporting"
      role="img"
      className={className}
      style={{ display: "block" }}
    >
      <Emblem x={0} y={0} />
      <Wordmark x={58} y={28} />
      <text
        x="58"
        y="48"
        fontFamily='"Manrope", system-ui, sans-serif'
        fontWeight={500}
        fontSize="7"
        fill={SLATE}
        style={{ letterSpacing: "0.22em" }}
      >
        AUDIT-READY FS &amp; TAX REPORTING
      </text>
    </svg>
  );
}
