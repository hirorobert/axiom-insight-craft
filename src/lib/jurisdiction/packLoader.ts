/**
 * packLoader — the ONLY module allowed to import a jurisdiction pack, and only through dynamic `import()`.
 *
 * A pack's code is fetched (a separate bundle chunk) only when its jurisdiction was EXPLICITLY selected for the workspace.
 * An unset, unknown or pack-less jurisdiction resolves to `null` and imports nothing, so no jurisdiction-specific module,
 * default or terminology can reach a workspace that did not choose it. `jurisdictionBoundary.test.ts` enforces
 * that no other file imports `@/jurisdiction-packs/*`.
 */
import type { JurisdictionPack } from "./packTypes";

const LOADERS: Readonly<Record<string, () => Promise<{ default: JurisdictionPack }>>> = {
  TZ: () => import("@/jurisdiction-packs/tz"),
};

export const LOADABLE_PACK_CODES: readonly string[] = Object.keys(LOADERS);

export async function loadJurisdictionPack(code: string | null | undefined): Promise<JurisdictionPack | null> {
  if (!code || !Object.prototype.hasOwnProperty.call(LOADERS, code)) return null;
  return (await LOADERS[code]()).default;
}
