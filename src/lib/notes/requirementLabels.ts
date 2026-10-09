// notes/requirementLabels.ts — the readable name of a reporting requirement, from the framework pack the server evaluated
// (fs_notes_status.packId). Pure. The requirement identifier (smes.note.*, smes.set.*, smes.schedule.*) is a technical
// key: it is shown only behind "Technical details", never as the task itself.

import { IFRS_FOR_SMES_2015, IFRS_FOR_SMES_2025 } from "@/lib/frameworkPacks/ifrsForSmes";
import type { FrameworkPack } from "@/lib/frameworkPacks/types";

const PACKS: Readonly<Record<string, FrameworkPack>> = { "ifrs-for-smes/2015": IFRS_FOR_SMES_2015, "ifrs-for-smes/2025": IFRS_FOR_SMES_2025 };

/** The readable name of a requirement; an identifier the pack does not know is described, never shown bare. */
export function requirementLabel(packId: string | null | undefined, requirementId: string): string {
  const pack = (packId && PACKS[packId]) || IFRS_FOR_SMES_2015;
  const r = pack.requirements.find((x) => x.id === requirementId);
  if (r) return r.label;
  const s = pack.schedules.find((x) => x.requirementId === requirementId || x.id === requirementId);
  if (s) return s.label;
  return "A requirement of the reporting framework";
}

/** "A, B and 3 more" — at most `max` names, the rest counted. */
export function namedList(names: readonly string[], max = 3): string {
  if (names.length <= max) return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join("; ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, max).join("; ")} and ${names.length - max} more`;
}
