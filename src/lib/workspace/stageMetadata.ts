/**
 * stageMetadata — Canonical source of truth for all workspace stages.
 *
 * Single place for:
 *   - Stage slug (route segment)
 *   - User-visible accounting label
 *   - Tab label (abbreviated)
 *   - Description (tooltip / overview)
 *   - Icon (Lucide component reference — NOT a rendered JSX element)
 *   - Canonical sequence order
 *
 * Import from here instead of duplicating arrays across components.
 * Do NOT add engine-name strings (SAFISHA, HESABU, KINGA, MAONO) here.
 *
 * Icon usage in consumers:
 *   const Icon = config.icon;
 *   <Icon className="w-3.5 h-3.5" />
 */

import {
  ShieldCheck,
  GitCompare,
  Calculator,
  Scale,
  ClipboardCheck,
  FileText,
  BarChart3,
  type LucideIcon,
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
  /** Lucide icon component — assign to a capitalized variable before rendering */
  icon: LucideIcon;
  /** 1-based sequence number — defines accounting workflow order */
  sequence: number;
}

export const STAGE_CONFIGS: Record<WorkspaceMission, StageConfig> = {
  prepare: {
    slug:        "prepare",
    label:       "Prepare Data",
    tabLabel:    "PREPARE",
    description: "Import trial balance, map accounts, verify EFDMS",
    icon:        ShieldCheck,
    sequence:    1,
  },
  reconcile: {
    slug:        "reconcile",
    label:       "Reconcile",
    tabLabel:    "RECONCILE",
    description: "EFDMS reconciliation and adjusting journal review",
    icon:        GitCompare,
    sequence:    2,
  },
  statements: {
    slug:        "statements",
    label:       "Prepare Statements",
    tabLabel:    "STATEMENTS",
    description: "Validate and sign off financial statements",
    icon:        Calculator,
    sequence:    3,
  },
  tax: {
    slug:        "tax",
    label:       "Compute Tax",
    tabLabel:    "TAX",
    description: "Corporate income tax computation under ITA Cap.332",
    icon:        Scale,
    sequence:    4,
  },
  compliance: {
    slug:        "compliance",
    label:       "Compliance Review",
    tabLabel:    "COMPLIANCE",
    description: "TRA audit readiness, client summaries, evidence packages",
    icon:        ClipboardCheck,
    sequence:    5,
  },
  filing: {
    slug:        "filing",
    label:       "Prepare Filing",
    tabLabel:    "FILING",
    description: "Assemble and submit the TRA filing package",
    icon:        FileText,
    sequence:    6,
  },
  monitor: {
    slug:        "monitor",
    label:       "Monitor",
    tabLabel:    "MONITOR",
    description: "Portfolio analytics and engagement intelligence",
    icon:        BarChart3,
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
