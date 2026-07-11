/**
 * ConfidenceScoreBar.tsx · SAFISHA Stage 6
 *
 * Small bar component showing a Safisha confidence score (0–100).
 * Colors use only the locked SAFF ERP palette:
 *   #0E6B55 = green (high confidence)
 *   #55657A = muted (medium)
 *   Destructive red (low)
 *
 * No new color tokens introduced.
 */

interface Props {
  score:    number;       // 0–100
  showLabel?: boolean;    // show numeric label (default: true)
  size?:    "sm" | "md"; // bar height
}

export default function ConfidenceScoreBar({ score, showLabel = true, size = "md" }: Props) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));

  const barColor =
    clamped >= 90 ? "bg-[#0E6B55]"
    : clamped >= 70 ? "bg-[#0E6B55]/70"
    : clamped >= 50 ? "bg-amber-500"
    : "bg-red-500";

  const labelColor =
    clamped >= 90 ? "text-[#0E6B55]"
    : clamped >= 70 ? "text-[#0E6B55]/80"
    : clamped >= 50 ? "text-amber-600"
    : "text-red-600";

  const barH = size === "sm" ? "h-1.5" : "h-2";

  const label =
    clamped >= 90 ? "High confidence"
    : clamped >= 70 ? "Moderate"
    : clamped >= 50 ? "Needs attention"
    : "Low — review required";

  return (
    <div className="space-y-1 w-full">
      {showLabel && (
        <div className="flex justify-between items-baseline">
          <span className="text-xs text-muted-foreground">Confidence</span>
          <span className={`text-xs font-semibold tabular-nums ${labelColor}`}>
            {clamped}%
          </span>
        </div>
      )}
      <div className={`w-full rounded-full bg-muted ${barH} overflow-hidden`}>
        <div
          className={`${barH} rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      {showLabel && (
        <p className={`text-[10px] ${labelColor}`}>{label}</p>
      )}
    </div>
  );
}
