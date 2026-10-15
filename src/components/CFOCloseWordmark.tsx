import { BRAND } from "@/constants/copy";

interface Props {
  className?: string;
  /**
   * "panel" — the approved brand mark: light CFOCLOSE on brand slate with the two mint rules (hero, auth, footer).
   * "inline" — the same lockup for light surfaces (header): slate letters over the two finance-green rules.
   */
  variant?: "panel" | "inline";
}

/** The approved CFOClose brand colours (brand rules): slate #2E2F3A, paper #F5F5F5, finance green #247D52
 *  (double rule on light), mint #7FE0A0 (double rule on slate; too faint on white). */
export const BRAND_SLATE = "#2E2F3A";
export const BRAND_PAPER = "#F5F5F5";
export const BRAND_GREEN = "#247D52";
export const BRAND_MINT = "#7FE0A0";

/**
 * The CFOCLOSE brand mark, built in HTML/CSS (no raster asset, no webfont): bold uppercase "CFOCLOSE" over two gold
 * rules, as in the approved logo. The authenticated workspace uses the same component.
 */
export function CFOCloseWordmark({ className = "", variant = "inline" }: Props) {
  const panel = variant === "panel";
  return (
    <span
      className={`inline-flex flex-col items-stretch ${panel ? "px-[0.6em] pb-[0.45em] pt-[0.35em]" : ""} ${className}`}
      style={panel ? { backgroundColor: BRAND_SLATE } : undefined}
      aria-label={BRAND.name}
      role="img"
      data-testid="brand-mark"
    >
      <span aria-hidden="true" className="font-black uppercase leading-none tracking-[0.02em]" style={{ color: panel ? BRAND_PAPER : BRAND_SLATE }}>
        {BRAND.name}
      </span>
      <span aria-hidden="true" className="mt-[0.18em] block h-[0.07em] min-h-[2px]" style={{ backgroundColor: panel ? BRAND_MINT : BRAND_GREEN }} />
      <span aria-hidden="true" className="mt-[0.06em] block h-[0.07em] min-h-[2px]" style={{ backgroundColor: panel ? BRAND_MINT : BRAND_GREEN }} />
    </span>
  );
}
