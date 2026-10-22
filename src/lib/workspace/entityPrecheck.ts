/**
 * entityPrecheck — before a NEW entity is registered from an upload, is there already one the person can see with the
 * same name (written differently)? The comparison is the engine's own (supabase/functions/_shared/tbIngestion.ts
 * normaliseEntityName; parity pinned by entityPrecheck.test.ts): case, punctuation, a leading "The" and common legal-form
 * spellings are ignored. A match is a question, never a block and never an automatic merge: use the existing entity, or
 * confirm this is a different one.
 */
export function normaliseEntityName(name: string): string {
  return name.toLowerCase()
    .replace(/&/g, " and ").replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\blimited\b/g, "ltd").replace(/\bincorporated\b/g, "inc").replace(/\bcompany\b/g, "co").replace(/\bcorporation\b/g, "corp")
    .replace(/^\s*the\s+/, "").replace(/\s+/g, " ").trim();
}

export function findSameEntity<E extends { id: string; name: string }>(name: string, entities: readonly E[]): E | null {
  const n = normaliseEntityName(name);
  if (!n) return null;
  return entities.find((e) => normaliseEntityName(e.name) === n) ?? null;
}
