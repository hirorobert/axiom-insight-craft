import { BRAND } from "@/constants/copy";

interface Props {
  className?: string;
}

/**
 * Public CFOClose text wordmark. Original — plain text set in this site's
 * own typography, not derived from, resembling, or implying affiliation
 * with any other organization's visual system. Used only on public
 * surfaces (Header, Footer, Auth). The authenticated workspace's brand
 * mark and any future icon/wordmark graphic are a separate design-system
 * concern (Ω∞ Charter Phase 3).
 */
export function CFOCloseWordmark({ className = "" }: Props) {
  return (
    <span className={`font-bold tracking-tight text-foreground ${className}`}>
      {BRAND.name}
    </span>
  );
}
