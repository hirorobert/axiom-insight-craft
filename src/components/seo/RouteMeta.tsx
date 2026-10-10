/**
 * Applies the route's search identity (src/lib/seo/publicMeta.ts) to the document head on every navigation: title,
 * description, canonical URL, Open Graph title/description/URL and robots. Rendered once inside the router; renders
 * nothing. The static head in index.html carries the homepage defaults for crawlers and social previews that do not run
 * scripts; it has no canonical of its own, so the canonical below is the only one.
 */
import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { routeMeta } from "@/lib/seo/publicMeta";

function setMeta(attr: "name" | "property", key: string, content: string | null) {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  if (content === null) { el?.remove(); return; }
  if (!el) { el = document.createElement("meta"); el.setAttribute(attr, key); document.head.appendChild(el); }
  el.setAttribute("content", content);
}

export function RouteMeta() {
  const { pathname } = useLocation();
  useEffect(() => {
    const m = routeMeta(pathname, window.location.hostname);
    document.title = m.title;
    setMeta("name", "robots", m.robots);
    if (m.description !== null) { setMeta("name", "description", m.description); setMeta("property", "og:description", m.description); setMeta("name", "twitter:description", m.description); }
    setMeta("property", "og:title", m.title);
    setMeta("name", "twitter:title", m.title);
    let link = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (m.canonical === null) link?.remove();
    else {
      if (!link) { link = document.createElement("link"); link.rel = "canonical"; document.head.appendChild(link); }
      link.href = m.canonical;
    }
    setMeta("property", "og:url", m.canonical);
  }, [pathname]);
  return null;
}
