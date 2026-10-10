/**
 * Search identity for CFOClose's public pages. Pure.
 *
 * One preferred origin (https://cfoclose.com), one registry of public pages (publicPages.json — read by the CI build
 * check too), and one decision per route:
 *   - a registered public page gets its own title, description and canonical URL on the preferred origin (/pricing,
 *     which shows the same catalogue as /plans, canonicalises to /plans) and may be indexed;
 *   - every other route (sign-in, the workspace, settings, administration, not-found) is noindex;
 *   - any host other than the preferred origin (a preview, a staging or a *.lovable.app address) is noindex, whatever the
 *     route, so previews never compete with production in search.
 * noindex is a search signal, not a security boundary: authenticated pages stay protected by sign-in and the database.
 */
import registry from "./publicPages.json";

export interface PublicPage {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly canonical?: string;
  readonly sitemap: boolean;
}

export const PREFERRED_ORIGIN: string = registry.origin;
export const SITE_NAME: string = registry.siteName;
export const PUBLIC_PAGES: readonly PublicPage[] = registry.pages;
/** The title for any page that is not a registered public page (it is never indexed). */
export const DEFAULT_TITLE = "CFOClose";

export interface RouteMeta {
  readonly title: string;
  readonly description: string | null;
  /** Absolute canonical URL on the preferred origin, or null (never indexed). */
  readonly canonical: string | null;
  readonly robots: "index,follow" | "noindex,nofollow";
}

const normalise = (pathname: string) => (pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname) || "/";

/** Whether this is the production host whose public pages may be indexed. */
export function isPreferredHost(hostname: string): boolean {
  return hostname === new URL(PREFERRED_ORIGIN).hostname;
}

export function publicPageFor(pathname: string): PublicPage | null {
  const p = normalise(pathname);
  return PUBLIC_PAGES.find((x) => x.path === p) ?? null;
}

export function routeMeta(pathname: string, hostname: string): RouteMeta {
  const page = publicPageFor(pathname);
  if (!page) return { title: DEFAULT_TITLE, description: null, canonical: null, robots: "noindex,nofollow" };
  return {
    title: page.title,
    description: page.description,
    canonical: `${PREFERRED_ORIGIN}${page.canonical ?? page.path}`,
    robots: isPreferredHost(hostname) ? "index,follow" : "noindex,nofollow",
  };
}
