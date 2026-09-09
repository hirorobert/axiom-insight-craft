import { BRAND } from "@/constants/copy";

interface Props {
  className?: string;
}

/**
 * Public CFOClose text wordmark: "CFOCLOSE" (max weight, tight tracking) +
 * ".com" (lighter weight) in the site's own navy foreground color — a CSS
 * recreation of the approved logo image (bold navy "CFOCLOSE.com", no
 * icon), built from this site's existing Inter font stack rather than a
 * new asset or webfont dependency. Not pixel-identical to the source
 * image by design (confirmed acceptable) — an exact vector/raster asset
 * replacement can supersede this if one is supplied later. Used only on
 * public surfaces (Header, Footer, Auth). The authenticated workspace's
 * brand mark is a separate concern (Ω∞ Charter Phase 3/4).
 */
export function CFOCloseWordmark({ className = "" }: Props) {
  return (
    <span className={`inline-flex items-baseline text-foreground ${className}`}>
      <span className="font-black uppercase tracking-tight">{BRAND.name}</span>
      <span className="font-medium">.com</span>
    </span>
  );
}
