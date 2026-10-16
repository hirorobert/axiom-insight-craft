// Technical SEO probe of the live public site. Read-only HTTP GETs; no credentials, no forms, no writes.
// Usage (repository root): node research/landing-review/evidence/seo-probe.mjs [origin] > research/landing-review/evidence/seo-probe.json
// Measures facts only. Recommendations live in ../REVIEW.md, kept apart from these numbers.
const ORIGIN = process.argv[2] ?? "https://cfoclose.com";
const UA = "Mozilla/5.0 (landing-review probe)";

import https from "node:https";
/** Bytes actually transferred for one GET with compression offered (fetch would transparently decompress). */
function transferBytes(path) {
  return new Promise((resolve, reject) => {
    https.get(ORIGIN + path, { headers: { "user-agent": UA, "accept-encoding": "br, gzip" } }, (res) => {
      let n = 0; res.on("data", (c) => { n += c.length; }); res.on("end", () => resolve({ bytes: n, encoding: res.headers["content-encoding"] ?? null }));
    }).on("error", reject);
  });
}

async function get(path, { gzip = false } = {}) {
  const res = await fetch(ORIGIN + path, { redirect: "manual", headers: { "user-agent": UA, ...(gzip ? { "accept-encoding": "gzip, br" } : {}) } });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, location: res.headers.get("location"), type: res.headers.get("content-type"), xRobots: res.headers.get("x-robots-tag"),
    encoding: res.headers.get("content-encoding"), bytes: buf.length, text: buf.toString("utf8") };
}

const pick = (html, re) => (html.match(re)?.[1] ?? null);
const all = (html, re) => [...html.matchAll(re)].map((m) => m[1]);

const home = await get("/");
const html = home.text;
const head = html.slice(0, html.indexOf("</head>"));
const body = html.slice(html.indexOf("<body"));
const bodyText = body.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<noscript[\s\S]*?<\/noscript>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const noscript = pick(body, /<noscript>([\s\S]*?)<\/noscript>/);
const jsonLd = all(head + body, /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g).map((s) => { try { const j = JSON.parse(s); return { type: j["@type"], count: Array.isArray(j.mainEntity) ? j.mainEntity.length : undefined }; } catch { return { type: "INVALID_JSON" }; } });

const robots = await get("/robots.txt");
const sitemap = await get("/sitemap.xml");
const sitemapUrls = all(sitemap.text, /<loc>([^<]+)<\/loc>/g);

// The host injects a per-request context token; strip it before comparing route shells.
const shell = (t) => t.replace(/data-context-token="[^"]*"/g, "");
const routes = {};
for (const p of ["/plans", "/contact", "/privacy", "/terms", "/auth", "/this-path-does-not-exist-404-probe"]) {
  const r = await get(p);
  routes[p] = { status: r.status, sameShellAsHome: shell(r.text) === shell(html), location: r.location };
}
const www = await fetch("https://www." + ORIGIN.replace(/^https?:\/\//, "") + "/", { redirect: "manual" }).then((r) => ({ status: r.status, location: r.headers.get("location") })).catch((e) => ({ error: String(e) }));
const http = await fetch(ORIGIN.replace("https://", "http://") + "/", { redirect: "manual" }).then((r) => ({ status: r.status, location: r.headers.get("location") })).catch((e) => ({ error: String(e) }));

const mainJs = pick(head, /src="(\/assets\/index-[^"]+\.js)"/);
const mainCss = pick(head, /href="(\/assets\/index-[^"]+\.css)"/);
const js = mainJs ? await transferBytes(mainJs) : null;
const jsRaw = mainJs ? await get(mainJs) : null;
const css = mainCss ? await transferBytes(mainCss) : null;
const hero = await get("/landing/trial-balance-review.png");

const out = {
  measuredAt: new Date().toISOString(),
  origin: ORIGIN,
  deployment: { commitShaMarker: pick(html, /data-commit-sha="([0-9a-f]{40})"/), xDeploymentId: null },
  home: { status: home.status, htmlBytes: home.bytes, xRobotsTag: home.xRobots },
  head: {
    lang: pick(html, /<html[^>]*\blang="([^"]+)"/),
    title: pick(head, /<title>([^<]*)<\/title>/),
    description: pick(head, /<meta name="description" content="([^"]*)"/),
    canonical: pick(head, /<link rel="canonical" href="([^"]*)"/),
    robotsMeta: pick(head, /<meta name="robots" content="([^"]*)"/),
    viewport: pick(head, /<meta name="viewport" content="([^"]*)"/),
    ogTitle: pick(head, /<meta property="og:title" content="([^"]*)"/),
    ogDescription: pick(head, /<meta property="og:description" content="([^"]*)"/),
    ogUrl: pick(head, /<meta property="og:url" content="([^"]*)"/),
    ogImage: pick(head, /<meta property="og:image" content="([^"]*)"/),
    twitterCard: pick(head, /<meta name="twitter:card" content="([^"]*)"/),
    jsonLd,
  },
  initialHtml: {
    h1Count: (body.match(/<h1\b/g) ?? []).length,
    visibleTextChars: bodyText.length,
    visibleTextSample: bodyText.slice(0, 200),
    hasNoscript: noscript !== null,
    noscriptTextChars: noscript ? noscript.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length : 0,
  },
  robotsTxt: { status: robots.status, type: robots.type, text: robots.text.slice(0, 600) },
  sitemap: { status: sitemap.status, type: sitemap.type, urls: sitemapUrls },
  routes,
  hostVariants: { www, http },
  weight: {
    mainJs: mainJs && { path: mainJs, transferBytes: js.bytes, encoding: js.encoding, uncompressedBytes: jsRaw.bytes },
    mainCss: mainCss && { path: mainCss, transferBytes: css.bytes, encoding: css.encoding },
    heroImage: { status: hero.status, type: hero.type, bytes: hero.bytes },
  },
};
const dep = await fetch(ORIGIN + "/", { method: "HEAD" }).then((r) => r.headers.get("x-deployment-id")).catch(() => null);
out.deployment.xDeploymentId = dep;
console.log(JSON.stringify(out, null, 2));
