/**
 * Saved layout templates as the editor lists them: the newest version of each template. Pure. Older versions stay in
 * the database (insert-only); a confirmation names the exact version it came from.
 */
import type { LayoutProfile } from "./layoutClient";

export interface TemplateReadRow { id: string; template_key: string; version: number; name: string; profile: LayoutProfile }
export interface TemplateListItem { id: string; templateKey: string; version: number; name: string; profile: LayoutProfile }

export function latestTemplateVersions(rows: readonly TemplateReadRow[]): TemplateListItem[] {
  const newest = new Map<string, TemplateReadRow>();
  for (const r of rows) {
    const cur = newest.get(r.template_key);
    if (!cur || r.version > cur.version) newest.set(r.template_key, r);
  }
  return [...newest.values()]
    .map((r) => ({ id: r.id, templateKey: r.template_key, version: r.version, name: r.name, profile: r.profile }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.templateKey.localeCompare(b.templateKey));
}
