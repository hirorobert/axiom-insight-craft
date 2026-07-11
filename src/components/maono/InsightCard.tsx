/**
 * InsightCard · Maono Intelligence Engine
 *
 * Renders a single maono_insights row.
 * confidence_level and numeric_validation_passed drive visual treatment.
 *
 * IRON DOME:
 *   - validation_failed insights show an amber warning badge.
 *   - They are NOT shown in CFO/Director/Manager views (filtered upstream).
 *   - Accountant role sees them with a "Pending Review" badge.
 */

import React, { useState } from "react";

export type ConfidenceLevel = "high" | "medium" | "low" | "none" | "validation_failed";
export type InsightType = "root_cause" | "risk" | "decision" | "action";

export interface InsightRow {
  id:                       string;
  insight_type:             InsightType;
  ai_output:                string;
  confidence_level:         ConfidenceLevel;
  numeric_validation_passed: boolean;
  numeric_validation_detail?: any;
  subject_pl_categories?:   string[];
  created_at:               string;
  ai_model_used?:           string;
}

interface InsightCardProps {
  insight:        InsightRow;
  defaultExpanded?: boolean;
}

const CONFIDENCE_STYLE: Record<ConfidenceLevel, { badge: string; label: string; dot: string }> = {
  high:             { badge: "bg-green-100 text-green-800",  label: "High confidence",       dot: "bg-green-500" },
  medium:           { badge: "bg-blue-100 text-blue-800",    label: "Medium confidence",     dot: "bg-blue-500"  },
  low:              { badge: "bg-yellow-100 text-yellow-800",label: "Low confidence",        dot: "bg-yellow-500"},
  none:             { badge: "bg-gray-100 text-gray-600",    label: "Insufficient history",  dot: "bg-gray-400"  },
  validation_failed:{ badge: "bg-amber-100 text-amber-800",  label: "Pending validation",    dot: "bg-amber-500" },
};

const TYPE_LABEL: Record<InsightType, string> = {
  root_cause: "Root Cause Analysis",
  risk:       "Risk Assessment",
  decision:   "Decision Paths",
  action:     "Recommended Actions",
};

function formatMarkdown(text: string): React.ReactNode {
  // Minimal markdown rendering: bold, headers, horizontal rules
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];

  lines.forEach((line, i) => {
    if (line.startsWith("## ")) {
      elements.push(
        <h3 key={i} className="text-sm font-semibold text-gray-900 mt-4 mb-1 border-b border-gray-200 pb-1">
          {line.slice(3)}
        </h3>
      );
    } else if (line.startsWith("**") && line.endsWith("**") && line.length > 4) {
      elements.push(
        <p key={i} className="text-sm font-semibold text-gray-800 mt-3 mb-0.5">
          {line.slice(2, -2)}
        </p>
      );
    } else if (line.startsWith("---")) {
      elements.push(<hr key={i} className="my-3 border-gray-200" />);
    } else if (line.trim() === "") {
      elements.push(<div key={i} className="h-1" />);
    } else {
      // Inline bold: **text**
      const parts = line.split(/(\*\*[^*]+\*\*)/g);
      elements.push(
        <p key={i} className="text-sm text-gray-700 leading-relaxed">
          {parts.map((part, j) =>
            part.startsWith("**") && part.endsWith("**")
              ? <strong key={j}>{part.slice(2, -2)}</strong>
              : part
          )}
        </p>
      );
    }
  });

  return <>{elements}</>;
}

export function InsightCard({ insight, defaultExpanded = false }: InsightCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const conf = CONFIDENCE_STYLE[insight.confidence_level];

  const isValidationFailed = insight.confidence_level === "validation_failed";
  const cardBorder = isValidationFailed
    ? "border-amber-300 bg-amber-50"
    : "border-gray-200 bg-white";

  return (
    <div className={`rounded-lg border ${cardBorder} shadow-sm overflow-hidden`}>
      {/* Header */}
      <button
        className="w-full flex items-start gap-3 p-4 text-left hover:bg-gray-50 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <div className={`mt-1 h-2.5 w-2.5 rounded-full flex-shrink-0 ${conf.dot}`} />

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">
              {TYPE_LABEL[insight.insight_type]}
            </span>
            {insight.subject_pl_categories?.slice(0, 3).map(cat => (
              <span key={cat} className="text-xs bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">
                {cat.replace(/_/g, " ")}
              </span>
            ))}
          </div>

          <div className="flex items-center gap-2 mt-1">
            <span className={`text-xs font-medium rounded-full px-2 py-0.5 ${conf.badge}`}>
              {conf.label}
            </span>
            {isValidationFailed && (
              <span className="text-xs text-amber-700">
                ⚠ Some figures could not be auto-verified — accountant review required
              </span>
            )}
          </div>
        </div>

        <span className="text-gray-400 text-sm flex-shrink-0 ml-2">
          {expanded ? "▲" : "▼"}
        </span>
      </button>

      {/* Body */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-gray-100">
          {isValidationFailed && (
            <div className="mt-3 rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800">
              <strong>Validation notice:</strong> This insight was generated by AI. The numeric
              validation system could not verify all figures against the source data.
              An accountant should review before this is shared with senior leadership.
              {insight.numeric_validation_detail?.numeric?.failed?.length > 0 && (
                <span className="block mt-1">
                  Unverified figures: {insight.numeric_validation_detail.numeric.failed.map((n: number) =>
                    n.toLocaleString()).join(", ")} TZS
                </span>
              )}
            </div>
          )}

          <div className="mt-3 prose prose-sm max-w-none">
            {formatMarkdown(insight.ai_output)}
          </div>

          <div className="mt-3 pt-3 border-t border-gray-100 flex items-center justify-between text-xs text-gray-400">
            <span>Generated {new Date(insight.created_at).toLocaleString()}</span>
            {insight.ai_model_used && (
              <span>{insight.ai_model_used}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
