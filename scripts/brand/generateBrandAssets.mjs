#!/usr/bin/env node
// Generates CFOClose's browser icons, web-app icons and social preview from the APPROVED logo
// (brand/source/CFOClose_logo.png, supplied by the owner: white "CFOCLOSE" over two gold rules on navy). Nothing is
// redrawn or invented:
//   - small icons (favicon 16/32/48, apple-touch 180, web-app 192/512, maskable 512) use the logo's own first "C",
//     cropped from the source pixels, above the logo's own double gold rule, on the logo's navy — a full wordmark is
//     unreadable at 16–48 px;
//   - the social preview (1200×630) places the full approved lockup on the logo's navy.
// The colours are sampled from the source, not typed. Rendering runs in headless Chrome (canvas), as the browser
// acceptance scripts do. Output goes to public/ and is committed; re-run only when the approved logo changes.
//
//   node scripts/brand/generateBrandAssets.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../browser-acceptance/cdp.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = path.join(REPO, "brand/source/CFOClose_logo.png");
const OUT = path.join(REPO, "public");
const src = `data:image/png;base64,${fs.readFileSync(SOURCE).toString("base64")}`;

const browser = await Browser.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto("about:blank");

const rendered = await page.evaluate(async (dataUrl) => {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const W = img.naturalWidth, H = img.naturalHeight;
  const base = document.createElement("canvas"); base.width = W; base.height = H;
  const b = base.getContext("2d"); b.drawImage(img, 0, 0);
  const px = b.getImageData(0, 0, W, H).data;
  const at = (x, y) => { const i = (y * W + x) * 4; return [px[i], px[i + 1], px[i + 2]]; };
  const navy = at(5, 5);
  const isNavy = (c) => Math.abs(c[0] - navy[0]) + Math.abs(c[1] - navy[1]) + Math.abs(c[2] - navy[2]) < 60;
  const isLight = (c) => c[0] > 200 && c[1] > 200 && c[2] > 200;
  const isGold = (c) => c[0] > 150 && c[1] > 120 && c[2] < 120 && c[0] > c[2] + 60;
  // Bounds of the letters (light pixels) and of the gold rules, measured from the source.
  let lx0 = W, lx1 = 0, ly0 = H, ly1 = 0, gy0 = H, gy1 = 0, gx0 = W, gx1 = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const c = at(x, y);
    if (isLight(c)) { lx0 = Math.min(lx0, x); lx1 = Math.max(lx1, x); ly0 = Math.min(ly0, y); ly1 = Math.max(ly1, y); }
    else if (isGold(c)) { gy0 = Math.min(gy0, y); gy1 = Math.max(gy1, y); gx0 = Math.min(gx0, x); gx1 = Math.max(gx1, x); }
  }
  // The first letter: from the left edge of the letters to the first fully navy column after it.
  let cx1 = lx0;
  for (let x = lx0 + 5; x < lx1; x++) {
    let any = false;
    for (let y = ly0; y <= ly1; y++) if (isLight(at(x, y))) { any = true; break; }
    if (!any) { cx1 = x - 1; break; }
  }
  const gold = at(Math.round((gx0 + gx1) / 2), gy0 + 2);
  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  // The two rules: rows of gold, split where navy appears between them.
  const goldRows = [];
  for (let y = gy0; y <= gy1; y++) goldRows.push(isGold(at(Math.round((gx0 + gx1) / 2), y)));
  const firstEnd = goldRows.indexOf(false);
  const secondStart = goldRows.indexOf(true, firstEnd);
  const rule = { t: firstEnd, gap: secondStart - firstEnd, t2: gy1 - gy0 + 1 - secondStart };

  // A square monogram: the source "C" over the double rule, scaled to fit, on navy.
  const monogram = (size, pad) => {
    const cv = document.createElement("canvas"); cv.width = size; cv.height = size;
    const g = cv.getContext("2d");
    g.fillStyle = rgb(navy); g.fillRect(0, 0, size, size);
    const cw = cx1 - lx0 + 1, ch = ly1 - ly0 + 1;
    const ruleH = rule.t + rule.gap + rule.t2;
    const stackH = ch + (gy0 - ly1) + ruleH; // letter, the source's own spacing, the rules
    const inner = size * (1 - 2 * pad);
    const s = Math.min(inner / Math.max(cw, cw), inner / stackH);
    const dw = cw * s, dh = ch * s;
    const top = (size - stackH * s) / 2;
    const left = (size - dw) / 2;
    g.imageSmoothingQuality = "high";
    g.drawImage(base, lx0, ly0, cw, ch, left, top, dw, dh);
    g.fillStyle = rgb(gold);
    const r1 = top + (gy0 - ly0) * s;
    const lineW = dw * 1.15, lineX = (size - lineW) / 2;
    g.fillRect(lineX, r1, lineW, Math.max(1, rule.t * s));
    g.fillRect(lineX, r1 + (rule.t + rule.gap) * s, lineW, Math.max(1, rule.t2 * s));
    return cv.toDataURL("image/png");
  };
  // The full lockup centred on navy (social preview).
  const lockup = (w, h, scale) => {
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const g = cv.getContext("2d");
    g.fillStyle = rgb(navy); g.fillRect(0, 0, w, h);
    const sx = Math.min(lx0, gx0), sy = ly0, sw = Math.max(lx1, gx1) - sx + 1, sh = gy1 - ly0 + 1;
    const s = (w * scale) / sw;
    g.imageSmoothingQuality = "high";
    g.drawImage(base, sx, sy, sw, sh, (w - sw * s) / 2, (h - sh * s) / 2, sw * s, sh * s);
    return cv.toDataURL("image/png");
  };
  return {
    navy: rgb(navy), gold: rgb(gold),
    icons: { 16: monogram(16, 0.06), 32: monogram(32, 0.08), 48: monogram(48, 0.1), 180: monogram(180, 0.16),
      192: monogram(192, 0.16), 512: monogram(512, 0.16), "512-maskable": monogram(512, 0.24) },
    og: lockup(1200, 630, 0.62),
  };
}, src);

const png = (d) => Buffer.from(d.split(",")[1], "base64");
const write = (name, buf) => { fs.writeFileSync(path.join(OUT, name), buf); console.log(`  ${name}  ${buf.length} B`); };
write("favicon-16x16.png", png(rendered.icons[16]));
write("favicon-32x32.png", png(rendered.icons[32]));
write("favicon-48x48.png", png(rendered.icons[48]));
write("apple-touch-icon.png", png(rendered.icons[180]));
write("icon-192.png", png(rendered.icons[192]));
write("icon-512.png", png(rendered.icons[512]));
write("icon-512-maskable.png", png(rendered.icons["512-maskable"]));
write("og-image.png", png(rendered.og));

// favicon.ico: an ICO container holding the 16, 32 and 48 px PNGs (PNG-in-ICO, supported by every current browser).
const entries = [16, 32, 48].map((s) => ({ s, data: png(rendered.icons[s]) }));
const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
let offset = 6 + 16 * entries.length;
const dir = entries.map(({ s, data }) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(s === 256 ? 0 : s, 0); e.writeUInt8(s === 256 ? 0 : s, 1); e.writeUInt8(0, 2); e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
  offset += data.length;
  return e;
});
write("favicon.ico", Buffer.concat([header, ...dir, ...entries.map((e) => e.data)]));
console.log(`sampled navy ${rendered.navy}, gold ${rendered.gold}`);
await browser.close();
