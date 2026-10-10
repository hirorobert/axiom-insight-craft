#!/usr/bin/env node
// Serves the PRODUCTION build (dist/) on loopback and reads, in headless Chrome, the head each route actually ends up with
// after the app runs: title, description, canonical, og:url and robots. Every public page must name itself on
// https://cfoclose.com; /pricing must canonicalise to /plans; signed-in routes must carry no canonical and be noindex.
// On loopback every route is noindex (only https://cfoclose.com may be indexed) — that is asserted too.
//
//   node scripts/ci/routeMetadataInBrowser.mjs [dist] [evidence.json]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../browser-acceptance/cdp.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DIST = path.resolve(process.argv[2] ?? path.join(REPO, "dist"));
const OUT = process.argv[3] ? path.resolve(process.argv[3]) : null;
const registry = JSON.parse(fs.readFileSync(path.join(REPO, "src/lib/seo/publicPages.json"), "utf8"));
const { preview } = await import("vite");
const server = await preview({ root: REPO, configFile: path.join(REPO, "vite.config.ts"), envDir: fs.mkdtempSync(path.join(os.tmpdir(), "cfoclose-no-env-")),
  logLevel: "error", build: { outDir: DIST }, preview: { port: 4174, strictPort: true, host: "127.0.0.1" } });
const browser = await Browser.launch();
const page = await (await browser.newContext()).newPage();
const read = () => page.evaluate(() => ({
  title: document.title,
  description: document.querySelector('meta[name="description"]')?.getAttribute("content") ?? null,
  canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? null,
  canonicalCount: document.querySelectorAll('link[rel="canonical"]').length,
  ogUrl: document.querySelector('meta[property="og:url"]')?.getAttribute("content") ?? null,
  robots: document.querySelector('meta[name="robots"]')?.getAttribute("content") ?? null,
  icon: document.querySelector('link[rel="icon"]')?.getAttribute("href") ?? null,
}));
const problems = [];
const seen = {};
for (const p of [...registry.pages, { path: "/dashboard", private: true }, { path: "/auth", private: true }]) {
  await page.goto(`http://127.0.0.1:4174${p.path}`);
  await page.waitFor((t) => document.title === t || (t === null && document.title === "CFOClose"), [p.private ? null : p.title], { label: `title for ${p.path}`, timeout: 20000 }).catch(() => {});
  const got = await read();
  seen[p.path] = got;
  if (p.private) {
    if (got.canonical !== null || got.robots !== "noindex,nofollow") problems.push(`${p.path}: ${JSON.stringify(got)}`);
    continue;
  }
  const canonical = `${registry.origin}${p.canonical ?? p.path}`;
  if (got.title !== p.title || got.description !== p.description || got.canonical !== canonical || got.ogUrl !== canonical || got.canonicalCount !== 1
      || got.robots !== "noindex,nofollow" /* loopback is not the production host */) problems.push(`${p.path}: ${JSON.stringify(got)}`);
}
if (OUT) fs.writeFileSync(OUT, JSON.stringify(seen, null, 2));
await browser.close();
await new Promise((r) => server.httpServer.close(() => r()));
if (problems.length) { console.error(`ROUTE_METADATA: FAILED\n  - ${problems.join("\n  - ")}`); process.exit(1); }
console.log(`ROUTE_METADATA: OK — ${Object.keys(seen).length} routes read from the production build in Chrome`);
for (const [k, v] of Object.entries(seen)) console.log(`  ${k.padEnd(10)} ${v.title} | canonical ${v.canonical} | ${v.robots}`);
process.exit(0);
