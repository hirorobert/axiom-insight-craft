#!/usr/bin/env node
// Production-build check of CFOClose's public search identity (run after `vite build`, on dist/):
//   - the built head names CFOClose, carries no legacy SAFF/engine naming and no Lovable branding, has no static canonical
//     (each route sets its own), and points og:image/twitter:image at the preferred origin;
//   - every referenced icon, the manifest and its icons, and the social image exist in dist/ with the stated pixel sizes;
//   - favicon.ico is a real ICO holding 16, 32 and 48 px images;
//   - the sitemap lists exactly the registry's sitemap pages (src/lib/seo/publicPages.json), each on https://cfoclose.com,
//     and robots.txt points at that sitemap and keeps authenticated areas out;
//   - every registered page has a distinct title (apart from /pricing, which canonicalises to /plans) and description.
//
//   node scripts/ci/assertPublicMetadata.mjs dist
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = path.resolve(process.argv[2] ?? path.join(REPO, "dist"));
const registry = JSON.parse(fs.readFileSync(path.join(REPO, "src/lib/seo/publicPages.json"), "utf8"));
const ORIGIN = registry.origin;
const problems = [];
const fail = (m) => problems.push(m);

const html = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
const head = html.slice(0, html.indexOf("</head>"));
const attr = (re) => (head.match(re) ?? [])[1] ?? null;

/** PNG pixel size from its IHDR chunk, or null. */
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}
const distFile = (url) => path.join(DIST, url.replace(/^https:\/\/cfoclose\.com/, "").replace(/^\//, ""));

// 1. The head
if (!/<title>CFOClose[^<]*<\/title>/.test(head)) fail("the built <title> does not name CFOClose");
if (/SAFF|KINGA|HESABU|SAFISHA|MAONO/i.test(head)) fail("the built head carries legacy SAFF or engine naming");
if (/lovable/i.test(head)) fail("the built head carries Lovable branding");
if (/<link[^>]+rel="canonical"/.test(head)) fail("the built head has a static canonical (it would point every route at one page)");
for (const k of ["og:image", "twitter:image"]) {
  const v = attr(new RegExp(`(?:property|name)="${k}" content="([^"]+)"`));
  if (v !== `${ORIGIN}/og-image.png`) fail(`${k} is ${v}, not ${ORIGIN}/og-image.png`);
}

// 2. Icons, manifest, social image
const expectPng = (rel, w, h) => {
  const f = distFile(rel);
  if (!fs.existsSync(f)) return fail(`${rel} is missing from the build`);
  const s = pngSize(fs.readFileSync(f));
  if (!s || s[0] !== w || s[1] !== h) fail(`${rel} is ${s ? s.join("x") : "not a PNG"}, expected ${w}x${h}`);
};
for (const m of head.matchAll(/<link[^>]+rel="(icon|apple-touch-icon|manifest)"[^>]*>/g)) {
  const href = (m[0].match(/href="([^"]+)"/) ?? [])[1];
  if (!href || !fs.existsSync(distFile(href))) fail(`referenced ${m[1]} ${href} is missing from the build`);
}
expectPng("/favicon-16x16.png", 16, 16);
expectPng("/favicon-32x32.png", 32, 32);
expectPng("/apple-touch-icon.png", 180, 180);
expectPng("/og-image.png", 1200, 630);
const ico = fs.existsSync(distFile("/favicon.ico")) ? fs.readFileSync(distFile("/favicon.ico")) : null;
if (!ico) fail("favicon.ico is missing from the build");
else {
  const n = ico.readUInt16LE(4);
  const sizes = [...Array(n).keys()].map((i) => ico.readUInt8(6 + 16 * i) || 256).sort((a, b) => a - b);
  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1 || sizes.join(",") !== "16,32,48") fail(`favicon.ico holds ${sizes.join(",")}, expected 16,32,48`);
}
const manifestPath = distFile("/site.webmanifest");
if (!fs.existsSync(manifestPath)) fail("site.webmanifest is missing from the build");
else {
  const mf = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (mf.name !== "CFOClose" || mf.short_name !== "CFOClose") fail("the manifest does not name CFOClose");
  for (const i of mf.icons ?? []) { const [w, h] = i.sizes.split("x").map(Number); expectPng(i.src, w, h); }
}
if (fs.existsSync(path.join(DIST, "favicon.svg"))) fail("the interim favicon.svg is still shipped");

// 3. Sitemap and robots
const sitemap = fs.readFileSync(path.join(DIST, "sitemap.xml"), "utf8");
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const expected = registry.pages.filter((p) => p.sitemap).map((p) => `${ORIGIN}${p.path === "/" ? "/" : p.path}`);
if (JSON.stringify([...locs].sort()) !== JSON.stringify([...expected].sort())) fail(`the sitemap lists ${locs.join(", ")}; expected ${expected.join(", ")}`);
for (const l of locs) if (!l.startsWith(`${ORIGIN}/`)) fail(`sitemap URL ${l} is not on ${ORIGIN}`);
const robots = fs.readFileSync(path.join(DIST, "robots.txt"), "utf8");
if (!robots.includes(`Sitemap: ${ORIGIN}/sitemap.xml`)) fail("robots.txt does not point at the preferred sitemap");
for (const p of ["/dashboard", "/workspace/", "/settings", "/commercial/admin", "/admin/"]) if (!robots.includes(`Disallow: ${p}`)) fail(`robots.txt does not keep ${p} out`);

// 4. Distinct titles and descriptions
const indexable = registry.pages.filter((p) => !p.canonical);
for (const k of ["title", "description"]) {
  const seen = new Set();
  for (const p of indexable) { if (seen.has(p[k])) fail(`two public pages share the ${k} "${p[k]}"`); seen.add(p[k]); }
}
for (const p of registry.pages) if (/SAFF|lovable|KINGA|HESABU|SAFISHA|MAONO|tax computation|audit opinion/i.test(`${p.title} ${p.description}`)) fail(`${p.path} metadata makes an unsupported claim or uses a legacy name`);

if (problems.length) { console.error(`PUBLIC_METADATA: FAILED\n  - ${problems.join("\n  - ")}`); process.exit(1); }
console.log(`PUBLIC_METADATA: OK — ${locs.length} sitemap pages on ${ORIGIN}, icons 16/32/48/180/192/512, social image 1200x630, no static canonical`);
