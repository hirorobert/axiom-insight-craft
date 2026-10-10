// @vitest-environment jsdom
/**
 * Search identity: one preferred origin, a distinct title, description and canonical per public page, /pricing folded into
 * /plans, everything else noindex, previews noindex — and the head actually reflects it on navigation.
 */
import { createElement as h } from "react";
import { act } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mount, type Mounted } from "@/lib/workbench/testkit/dom";
import { RouteMeta } from "@/components/seo/RouteMeta";
import { PREFERRED_ORIGIN, PUBLIC_PAGES, isPreferredHost, routeMeta } from "./publicMeta";

const ROOT = path.resolve(__dirname, "../../..");
let m: Mounted | null = null;
afterEach(() => { m?.unmount(); m = null; document.head.innerHTML = ""; });

describe("the registry", () => {
  it("uses https://cfoclose.com as the one preferred origin", () => {
    expect(PREFERRED_ORIGIN).toBe("https://cfoclose.com");
    expect(isPreferredHost("cfoclose.com")).toBe(true);
    for (const h of ["www.cfoclose.com", "cfoclose.lovable.app", "id-preview--x.lovable.app", "localhost"]) expect(isPreferredHost(h), h).toBe(false);
  });
  it("gives every indexable public page its own title and description, naming CFOClose and no withheld service", () => {
    const indexable = PUBLIC_PAGES.filter((p) => !p.canonical);
    expect(new Set(indexable.map((p) => p.title)).size).toBe(indexable.length);
    expect(new Set(indexable.map((p) => p.description)).size).toBe(indexable.length);
    for (const p of PUBLIC_PAGES) {
      expect(p.title, p.path).toMatch(/CFOClose/);
      expect(`${p.title} ${p.description}`, p.path).not.toMatch(/SAFF|Lovable|tax computation|tax return|filing|audit opinion|assurance|KINGA|HESABU|SAFISHA|MAONO/i);
    }
  });
  it("every public page in the registry is a real route of the app", () => {
    const app = fs.readFileSync(path.join(ROOT, "src/App.tsx"), "utf8") + fs.readFileSync(path.join(ROOT, "src/lib/serviceEnquiry/serviceEnquiryRoutes.tsx"), "utf8");
    for (const p of PUBLIC_PAGES) {
      if (p.path === "/") expect(app).toMatch(/<Route path="\/" element=\{<Index \/>\}/);
      else expect(app, p.path).toMatch(new RegExp(`path="${p.path}"`));
    }
  });
  it("the sitemap lists exactly the registry's sitemap pages on the preferred origin", () => {
    const xml = fs.readFileSync(path.join(ROOT, "public/sitemap.xml"), "utf8");
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((x) => x[1]).sort();
    expect(locs).toEqual(PUBLIC_PAGES.filter((p) => p.sitemap).map((p) => `${PREFERRED_ORIGIN}${p.path}`).sort());
  });
});

describe("routeMeta", () => {
  it("a public page on production: its own canonical, indexable", () => {
    expect(routeMeta("/terms", "cfoclose.com")).toEqual({ title: "Terms of Service — CFOClose", description: expect.any(String), canonical: "https://cfoclose.com/terms", robots: "index,follow" });
    expect(routeMeta("/terms/", "cfoclose.com").canonical).toBe("https://cfoclose.com/terms");
    expect(routeMeta("/", "cfoclose.com").canonical).toBe("https://cfoclose.com/");
  });
  it("/pricing shows the same catalogue as /plans and canonicalises to it", () => {
    expect(routeMeta("/pricing", "cfoclose.com").canonical).toBe("https://cfoclose.com/plans");
  });
  it("authenticated, administrative and unknown routes are never indexed and carry no canonical", () => {
    for (const p of ["/auth", "/dashboard", "/workspace/abc/2026", "/settings", "/admin/enquiries", "/commercial/admin", "/nope"]) {
      expect(routeMeta(p, "cfoclose.com"), p).toMatchObject({ canonical: null, robots: "noindex,nofollow" });
    }
  });
  it("a preview or any other host is noindex even for public pages; the canonical still names production", () => {
    expect(routeMeta("/plans", "cfoclose.lovable.app")).toMatchObject({ canonical: "https://cfoclose.com/plans", robots: "noindex,nofollow" });
  });
});

describe("RouteMeta applies it to the document head", () => {
  it("sets the title, description, canonical, Open Graph URL and robots for the route; a private route removes the canonical", async () => {
    m = mount(h(MemoryRouter, { initialEntries: ["/privacy"] }, h(RouteMeta)));
    await act(async () => {});
    expect(document.title).toBe("Privacy Policy — CFOClose");
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe("https://cfoclose.com/privacy");
    expect(document.head.querySelector('meta[property="og:url"]')?.getAttribute("content")).toBe("https://cfoclose.com/privacy");
    // jsdom's host is localhost: not production, so not indexable.
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe("noindex,nofollow");
    m.unmount();
    m = mount(h(MemoryRouter, { initialEntries: ["/dashboard"] }, h(RouteMeta)));
    await act(async () => {});
    expect(document.head.querySelector('link[rel="canonical"]')).toBeNull();
    expect(document.title).toBe("CFOClose");
  });
});
