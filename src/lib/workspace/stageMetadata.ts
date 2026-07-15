/**
 * stageMetadata — Canonical source of truth for all workspace stages.
 *
 * Single place for:
 *   - Stage slug (route segment)
 *   - User-visible accounting label
 *   - Tab label (abbreviated)
 *   - Description (tooltip / overview)
 *   - Icon (lucide-react node)
 *   - Canonical sequence order
 *
 * Import from here instead of duplicating arrays across components.
 * Do NOT add engine-name strings (SAFISHA, HESABU, KINGA, MAONO) here.
 */

import React from "react";
import {
  ShieldCheck,
  GitCompare,
  Calculator,
  Scale,
  ClipboardCheck,
  FileText,
  BarChart3,
} from "lucide-react";
import type { WorkspaceMission } from "./types";

export interface StageConfig {
  /** Route segment — canonical slug */
  slug: WorkspaceMission;
  /** Full accounting label shown in tables, headings, and breadcrumbs */
  label: string;
  /** Abbreviated label for sub-nav tabs */
  tabLabel: string;
  /** One-line description for tooltips and overview rows */
  description: string;
  /** Lucide icon rendered in tabs and overview table */
  icon: React.ReactNode;
  /** 1-based sequence number — defines accounting workflow order */
  sequence: number;
}

export const STAGE_CONFIGS: Record<WorkspaceMission, StageConfig> = {
  prepare: {
    slug:        "prepare",
    label:       "Prepare Data",
    tabLabel:    "PREPARE",
    description: "Import trial balance, map accounts, verify EFDMS",
    icon:        <ShieldCheck className="w-3.5 h-3.5" />,
    sequence:    1,
  },
  reconcile: {
    slug:        "reconcile",
    label:       "Reconcile",
    tabLabel:    "RECONCILE",
    description: "EFDMS reconciliation and adjusting journal review",
    icon:        <GitCompare className="w-3.5 h-3.5" />,
    sequence:    2,
  },
  statements: {
    slug:        "statements",
    label:       "Prepare Statements",
    tabLabel:    "STATEMENTS",
    description: "Validate and sign off financial statements",
    icon:        <Calculator className="w-3.5 h-3.5" />,
    sequence:    3,
  },
  tax: {
    slug:        "tax",
    label:       "Compute Tax",
    tabLabel:    "TAX",
    description: "Corporate income tax computation under ITA Cap.332",
    icon:        <Scale className="w-3.5 h-3.5" />,
    sequence:    4,
  },
  compliance: {
    slug:        "compliance",
    label:       "Compliance Review",
    tabLabel:    "COMPLIANCE",
    description: "TRA audit readiness, client summaries, evidence packages",
    icon:        <ClipboardCheck className="w-3.5 h-3.5" />,
    sequence:    5,
  },
  filing: {
    slug:        "filing",
    label:       "Prepare Filing",
    tabLabel:    "FILING",
    description: "Assemble and submit the TRA filing package",
    icon:        <FileText className="w-3.5 h-3.5" />,
    sequence:    6,
  },
  monitor: {
    slug:        "monitor",
    label:       "Monitor",
    tabLabel:    "MONITOR",
    description: "Portfolio analytics and engagement intelligence",
    icon:        <BarChart3 className="w-3.5 h-3.5" />,
    sequence:    7,
  },
};

/**
 * Canonical stage order — the single source of truth for sub-nav rendering
 * and any component that needs to iterate over stages in workflow order.
 */
export const STAGE_SEQUENCE: WorkspaceMission[] = [
  "prepare",
  "reconcile",
  "statements",
  "tax",
  "compliance",
  "filing",
  "monitor",
];
