import { BRAND } from "@/constants/copy";

interface Props {
  className?: string;
  /**
   * "panel" — the approved brand mark: white CFOCLOSE on the brand navy with the two gold rules (hero, auth, footer).
   * "inline" — the same lockup for light surfaces (header): navy letters over the two gold rules.
   */
  variant?: "panel" | "inline";
}

/** The approved brand colours, sampled from the supplied logo (CFOClose_logo.png): navy #0D1D3B, gold #CBA64E. */
export const BRAND_NAVY = "#0D1D3B";
export const BRAND_GOLD = "#CBA64E";

/**
 * The CFOCLOSE brand mark, built in HTML/CSS (no raster asset, no webfont): bold uppercase "CFOCLOSE" over two gold
 * rules, as in the approved logo. The authenticated workspace uses the same component.
 */
export function CFOCloseWordmark({ className = "", variant = "inline" }: Props) {
  const panel = variant === "panel";
  return (
    <span
      className={`inline-flex flex-col items-stretch ${panel ? "px-[0.6em] pb-[0.45em] pt-[0.35em]" : ""} ${className}`}
      style={panel ? { backgroundColor: BRAND_NAVY } : undefined}
      aria-label={BRAND.name}
      role="img"
      data-testid="brand-mark"
    >
      <span aria-hidden="true" className="font-black uppercase leading-none tracking-[0.02em]" style={{ color: panel ? "#F5F7FA" : BRAND_NAVY }}>
        {BRAND.name}
      </span>
      <span aria-hidden="true" className="mt-[0.18em] block h-[0.07em] min-h-[2px]" style={{ backgroundColor: BRAND_GOLD }} />
      <span aria-hidden="true" className="mt-[0.06em] block h-[0.07em] min-h-[2px]" style={{ backgroundColor: BRAND_GOLD }} />
    </span>
  );
}
