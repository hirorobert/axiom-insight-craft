// ============================================================
// SaffLogo — Iron Dome Nuclear Design · Diamond Grade
// Inline SVG — renders pixel-perfect at every DPI/size.
//
// Palette:
//   Vault Navy  #0E1D30
//   Ledger Green #0E6B55
//   Slate       #55657A
//
// Variants:
//   "header" — emblem + wordmark only, tight viewBox (no tagline)
//   "full"   — complete lockup including tagline
// ============================================================

interface Props {
  variant?: "header" | "full";
  className?: string;
}

// Shared S-glyph path (used in both emblem and wordmark)
const S = "M0 0 H64 V24 H24 V38 H0 Z M0 38 H64 V100 H0 V76 H40 V62 H0 Z";

// ── Shared emblem + wordmark shapes ───────────────────────────────────────────
// The compact viewBox "24 35 658 152" clips dead space above/below the mark
// so the logo fills its container without whitespace bloat.
//
// Full viewBox "0 0 710 220" preserves the original coordinate space so the
// tagline renders at exactly its designed size.

export function SaffLogo({ variant = "header", className = "" }: Props) {
  if (variant === "header") {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="24 35 658 152"
        aria-label="SAFF ERP"
        role="img"
        className={className}
        style={{ display: "block" }}
      >
        <defs>
          {/* Unique ID to avoid collision when full + header both render */}
          <path id="saff-s-hdr" fillRule="evenodd" d={S} />
        </defs>

        {/* ── Shield emblem ── */}
        <g transform="translate(24,35)">
          <path fill="#0E1D30" d="M22 0 H128 L150 22 V120 L120 150 H22 L0 128 V22 Z" />
          {/* Ledger-green accent corner */}
          <path fill="#0E6B55" d="M130 150 L150 130 V150 Z" />
          {/* S glyph in white */}
          <use href="#saff-s-hdr" transform="translate(49,33) scale(0.82)" fill="#FFFFFF" />
        </g>

        {/* ── Wordmark: SAFF (navy) ERP (green) ── */}
        <g transform="translate(216,48) scale(0.8)">
          {/* S A F F — Vault Navy */}
          <g fill="#0E1D30">
            <use href="#saff-s-hdr" />
            {/* A */}
            <g transform="translate(78,0)">
              <path d="M0 100 L28 0 H52 L24 100 Z" />
              <path d="M80 100 L52 0 H28 L56 100 Z" />
              <rect x="14" y="64" width="52" height="24" />
            </g>
            {/* F */}
            <path transform="translate(172,0)" d="M0 0 H62 V24 H24 V42 H56 V66 H24 V100 H0 Z" />
            {/* F */}
            <path transform="translate(248,0)" d="M0 0 H62 V24 H24 V42 H56 V66 H24 V100 H0 Z" />
          </g>
          {/* E R P — Ledger Green */}
          <g fill="#0E6B55">
            {/* E */}
            <path transform="translate(348,0)" d="M0 0 H60 V24 H24 V40 H54 V64 H24 V76 H60 V100 H0 Z" />
            {/* R */}
            <g transform="translate(422,0)">
              <path fillRule="evenodd" d="M0 0 H70 V66 H24 V100 H0 Z M24 22 H48 V44 H24 Z" />
              <path d="M34 58 H58 L76 100 H52 Z" />
            </g>
            {/* P */}
            <path transform="translate(512,0)" fillRule="evenodd" d="M0 0 H70 V68 H24 V100 H0 Z M24 22 H48 V46 H24 Z" />
          </g>
        </g>
      </svg>
    );
  }

  // ── Full lockup — emblem + wordmark + tagline ──────────────────────────────
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="10 30 700 180"
      aria-label="SAFF ERP — Audit-Ready FS & Tax Reporting"
      role="img"
      className={className}
      style={{ display: "block" }}
    >
      <defs>
        <path id="saff-s-full" fillRule="evenodd" d={S} />
      </defs>

      {/* ── Shield emblem ── */}
      <g transform="translate(24,35)">
        <path fill="#0E1D30" d="M22 0 H128 L150 22 V120 L120 150 H22 L0 128 V22 Z" />
        <path fill="#0E6B55" d="M130 150 L150 130 V150 Z" />
        <use href="#saff-s-full" transform="translate(49,33) scale(0.82)" fill="#FFFFFF" />
      </g>

      {/* ── Wordmark ── */}
      <g transform="translate(216,48) scale(0.8)">
        <g fill="#0E1D30">
          <use href="#saff-s-full" />
          <g transform="translate(78,0)">
            <path d="M0 100 L28 0 H52 L24 100 Z" />
            <path d="M80 100 L52 0 H28 L56 100 Z" />
            <rect x="14" y="64" width="52" height="24" />
          </g>
          <path transform="translate(172,0)" d="M0 0 H62 V24 H24 V42 H56 V66 H24 V100 H0 Z" />
          <path transform="translate(248,0)" d="M0 0 H62 V24 H24 V42 H56 V66 H24 V100 H0 Z" />
        </g>
        <g fill="#0E6B55">
          <path transform="translate(348,0)" d="M0 0 H60 V24 H24 V40 H54 V64 H24 V76 H60 V100 H0 Z" />
          <g transform="translate(422,0)">
            <path fillRule="evenodd" d="M0 0 H70 V66 H24 V100 H0 Z M24 22 H48 V44 H24 Z" />
            <path d="M34 58 H58 L76 100 H52 Z" />
          </g>
          <path transform="translate(512,0)" fillRule="evenodd" d="M0 0 H70 V68 H24 V100 H0 Z M24 22 H48 V46 H24 Z" />
        </g>
      </g>

      {/* ── Tagline ── */}
      <text
        x="217" y="164"
        fontFamily="Arial, Helvetica, sans-serif"
        fontSize="16.5"
        fontWeight="600"
        letterSpacing="3"
        fill="#55657A"
        textLength="465"
        lengthAdjust="spacingAndGlyphs"
      >
        AUDIT-READY FS &amp; TAX REPORTING
      </text>
    </svg>
  );
}
