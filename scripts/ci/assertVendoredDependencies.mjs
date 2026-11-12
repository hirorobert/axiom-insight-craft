#!/usr/bin/env node
// Vendored-dependency guard. Third-party code this repository vendors instead of fetching (today: SheetJS 0.20.3, which is
// published only on cdn.sheetjs.com; see vendor/sheetjs/PROVENANCE.md) must be exactly the reviewed bytes, and nothing may
// fetch it, or any other code, from a host outside the reviewed set. Offline: no network, nothing executed.
//
//   node scripts/ci/assertVendoredDependencies.mjs [root]
//
// Checks, against the pinned manifest below:
//   1. the committed tarball's size, SHA-256 and SHA-512, and bun.lock's integrity for it; package.json names that file;
//   2. every vendored copy (the Deno build, its types, both LICENSE files) has its pinned SHA-256 AND equals the same member
//      inside the committed tarball, and the vendored directories hold exactly the manifest's files;
//   3. no package.json dependency, bun.lock URL, deno.lock entry, import map, deno.json, workflow or Deno import names
//      cdn.sheetjs.com; bun.lock URLs are registry tarballs on the reviewed registry hosts; Deno remote imports use only the
//      reviewed hosts; SheetJS is never imported remotely (URL, npm: or jsr:) and Edge Functions import only the vendored copy.
// Pure checker (checkVendoredDependencies) used by this CLI and by src/lib/__tests__/vendoredDependencies.test.ts.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

export const VENDORED = Object.freeze({
  sheetjs: Object.freeze({
    name: "xlsx",
    version: "0.20.3",
    license: "Apache-2.0",
    sourceUrl: "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz",
    tag: Object.freeze({ api: "https://git.sheetjs.com/api/v1/repos/sheetjs/sheetjs", ref: "v0.20.3", commit: "8a7cfd47bde8258c0d91df6a737bf0136699cdf8" }),
    packageJsonSpecifier: "file:vendor/sheetjs/xlsx-0.20.3.tgz",
    bunLockResolution: "xlsx@vendor/sheetjs/xlsx-0.20.3.tgz",
    tarball: Object.freeze({
      path: "vendor/sheetjs/xlsx-0.20.3.tgz",
      size: 2409319,
      sha256: "8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8",
      integrity: "sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==",
    }),
    files: Object.freeze([
      Object.freeze({ path: "vendor/sheetjs/LICENSE", member: "package/LICENSE", size: 11355, sha256: "4d2a38ac35cda06a555c84074a819d413339cd3691b822cae50f8f322fe01f64" }),
      Object.freeze({ path: "supabase/functions/_shared/vendor/sheetjs-0.20.3/xlsx.mjs", member: "package/xlsx.mjs", size: 1008308, sha256: "1a0fb062ee9781b13f6687371b202aaefc53b6ce55b530c027e01f9c087b77db" }),
      Object.freeze({ path: "supabase/functions/_shared/vendor/sheetjs-0.20.3/types/index.d.ts", member: "package/types/index.d.ts", size: 27917, sha256: "191e4e6aceae3602aa3a1e9a6bc0e98821d6d5fb787e2bc16e250439482bddb6" }),
      Object.freeze({ path: "supabase/functions/_shared/vendor/sheetjs-0.20.3/LICENSE", member: "package/LICENSE", size: 11355, sha256: "4d2a38ac35cda06a555c84074a819d413339cd3691b822cae50f8f322fe01f64" }),
    ]),
    denoDir: "supabase/functions/_shared/vendor/sheetjs-0.20.3",
  }),
});

// Every file allowed inside each vendored directory (anything else is unreviewed code).
const VENDOR_DIRS = Object.freeze({
  "vendor/sheetjs": ["LICENSE", "PROVENANCE.md", "xlsx-0.20.3.tgz"],
  "supabase/functions/_shared/vendor": ["sheetjs-0.20.3/LICENSE", "sheetjs-0.20.3/types/index.d.ts", "sheetjs-0.20.3/xlsx.mjs"],
});
// Registries bun.lock may resolve a package from (tarball URLs of the npm registry protocol only). The two pkg.dev hosts are
// the npm-registry cache already recorded by bun.lock before this guard existed (each entry carries its sha512 integrity).
const REGISTRY_BASES = Object.freeze([
  "https://registry.npmjs.org/",
  "https://europe-west1-npm.pkg.dev/lovable-core-prod/sandbox-npm-cache/",
  "https://europe-west4-npm.pkg.dev/lovable-core-prod/sandbox-npm-cache/",
]);
// Hosts a Deno import, import map or deno.lock may name (the hosts in use when this guard was added).
const DENO_REMOTE_HOSTS = Object.freeze(["deno.land", "esm.sh"]);
const FORBIDDEN_HOST = /cdn\.sheetjs\.com|sheetjs\.com/i;
const SHEETJS_NAME = /(?:^|[/@:])(?:xlsx|sheetjs)(?:[@/.]|$)/i;
const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/;

const sha = (alg, buf) => crypto.createHash(alg).update(buf).digest();
const posix = (p) => p.split(path.sep).join("/");

/** The regular files of a .tgz, as a Map of member path to bytes (ustar and pax path records). Reads only; runs nothing. */
export function readTarball(gz) {
  const tar = zlib.gunzipSync(gz);
  const out = new Map();
  let paxPath = null;
  for (let off = 0; off + 512 <= tar.length;) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => { const s = h.subarray(a, b); const z = s.indexOf(0); return s.subarray(0, z < 0 ? s.length : z).toString("utf8"); };
    const size = parseInt(str(124, 136).trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(345, 500);
    const name = paxPath ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    const body = tar.subarray(off + 512, off + 512 + size);
    paxPath = null;
    if (type === "x") {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"));
      if (m) paxPath = m[1];
    } else if (type === "0") {
      out.set(name, Buffer.from(body));
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(p, base) : [posix(path.relative(base, p))];
  });
}

/** Source files under `dir` (relative to root), skipping dependencies and the vendored code itself. */
function sourceFiles(root, dir) {
  const skip = new Set(["node_modules", ".git", "dist"]);
  const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []).flatMap((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return skip.has(e.name) || posix(path.relative(root, p)) === "supabase/functions/_shared/vendor" ? [] : walk(p);
    return SOURCE_EXT.test(e.name) ? [p] : [];
  });
  return walk(path.join(root, dir));
}

// import … from "x"; export … from "x"; import "x"; import("x"); // @deno-types="x"
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|@deno-types\s*=\s*)(["'])([^"'\n]+)\1/g;

function remoteHost(spec) {
  const m = /^https?:\/\/([^/?#]+)/i.exec(spec);
  return m ? m[1].toLowerCase() : null;
}

/** Violations of one Deno-side specifier found in `where` (`fromFile` is the importing file, for relative resolution). */
function specifierViolations(root, spec, where, fromFile) {
  const v = [];
  const host = remoteHost(spec);
  if (FORBIDDEN_HOST.test(spec)) v.push(`${where}: names ${JSON.stringify(spec)}; SheetJS is vendored, never fetched from its CDN`);
  else if (host && !DENO_REMOTE_HOSTS.includes(host)) v.push(`${where}: remote import from ${host} (${JSON.stringify(spec)}); reviewed hosts are ${DENO_REMOTE_HOSTS.join(", ")}`);
  if (SHEETJS_NAME.test(spec)) {
    const isRemote = Boolean(host) || /^(?:npm|jsr):/i.test(spec);
    if (isRemote) v.push(`${where}: imports SheetJS remotely (${JSON.stringify(spec)}); import ${VENDORED.sheetjs.denoDir}/xlsx.mjs by relative path`);
    else if (fromFile && posix(path.relative(root, fromFile)).startsWith("supabase/functions/") && (spec.startsWith("./") || spec.startsWith("../"))) {
      const target = posix(path.relative(root, path.resolve(path.dirname(fromFile), spec)));
      if (!target.startsWith(`${VENDORED.sheetjs.denoDir}/`)) v.push(`${where}: imports SheetJS from ${target}, not the vendored ${VENDORED.sheetjs.denoDir}`);
    } else if (fromFile && posix(path.relative(root, fromFile)).startsWith("supabase/functions/")) {
      v.push(`${where}: imports SheetJS as ${JSON.stringify(spec)}; an Edge Function imports only the vendored ${VENDORED.sheetjs.denoDir}/xlsx.mjs`);
    }
  }
  return v;
}

export function checkVendoredDependencies(root) {
  const v = [];
  const read = (rel) => (fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel)) : null);
  const s = VENDORED.sheetjs;

  // 1. The tarball, the lockfile integrity and the package.json specifier.
  const tgz = read(s.tarball.path);
  let members = new Map();
  if (!tgz) v.push(`${s.tarball.path} is missing`);
  else {
    if (tgz.length !== s.tarball.size) v.push(`${s.tarball.path}: ${tgz.length} bytes, pinned ${s.tarball.size}`);
    const h256 = sha("sha256", tgz).toString("hex");
    if (h256 !== s.tarball.sha256) v.push(`${s.tarball.path}: SHA-256 ${h256}, pinned ${s.tarball.sha256}`);
    const integrity = `sha512-${sha("sha512", tgz).toString("base64")}`;
    if (integrity !== s.tarball.integrity) v.push(`${s.tarball.path}: ${integrity}, pinned ${s.tarball.integrity}`);
    try { members = readTarball(tgz); } catch (e) { v.push(`${s.tarball.path}: not a readable tarball (${e.message})`); }
  }
  const pkgText = read("package.json")?.toString("utf8") ?? "{}";
  const pkg = JSON.parse(pkgText);
  if (pkg.dependencies?.[s.name] !== s.packageJsonSpecifier) v.push(`package.json dependencies.${s.name} is ${JSON.stringify(pkg.dependencies?.[s.name])}, expected ${JSON.stringify(s.packageJsonSpecifier)}`);
  const bunLock = read("bun.lock")?.toString("utf8") ?? "";
  const entry = new RegExp(`^\\s*"${s.name}":\\s*\\["([^"]*)",[^\\n]*"(sha512-[A-Za-z0-9+/=]+)"\\],?\\s*$`, "m").exec(bunLock);
  if (!entry) v.push(`bun.lock has no "${s.name}" package entry with an integrity`);
  else {
    if (entry[1] !== s.bunLockResolution) v.push(`bun.lock resolves ${s.name} as ${JSON.stringify(entry[1])}, expected ${JSON.stringify(s.bunLockResolution)}`);
    if (entry[2] !== s.tarball.integrity) v.push(`bun.lock integrity for ${s.name} is ${entry[2]}, pinned ${s.tarball.integrity}`);
  }

  // 2. Every vendored copy: pinned hash, and identical to its member inside the committed tarball.
  for (const f of s.files) {
    const bytes = read(f.path);
    if (!bytes) { v.push(`${f.path} is missing`); continue; }
    const h = sha("sha256", bytes).toString("hex");
    if (bytes.length !== f.size || h !== f.sha256) v.push(`${f.path}: ${bytes.length} bytes, SHA-256 ${h}; pinned ${f.size} bytes, ${f.sha256}`);
    const member = members.get(f.member);
    if (tgz && !member) v.push(`${s.tarball.path} has no ${f.member}`);
    else if (member && !member.equals(bytes)) v.push(`${f.path} differs from ${f.member} inside ${s.tarball.path}`);
  }
  for (const [dir, expected] of Object.entries(VENDOR_DIRS)) {
    const actual = listFiles(path.join(root, dir)).sort();
    const extra = actual.filter((f) => !expected.includes(f));
    const missing = expected.filter((f) => !actual.includes(f));
    for (const f of extra) v.push(`${dir}/${f} is not in the vendored manifest (unreviewed vendored file)`);
    for (const f of missing) v.push(`${dir}/${f} is missing`);
  }

  // 3. Nothing fetches SheetJS (or other code) from outside the reviewed hosts.
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "overrides", "resolutions"]) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (typeof spec === "string" && (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec) || FORBIDDEN_HOST.test(spec))) v.push(`package.json ${field}.${name} = ${JSON.stringify(spec)}: a dependency fetched from a URL`);
    }
  }
  for (const m of bunLock.matchAll(/"(https?:\/\/[^"]+)"/g)) {
    const url = m[1];
    const base = REGISTRY_BASES.find((b) => url.startsWith(b));
    if (!base || !/^(?:@[^/]+\/)?[^/@]+\/-\/[^/]+\.tgz$/.test(url.slice(base.length))) v.push(`bun.lock names ${url}: not a registry tarball on ${REGISTRY_BASES.join(", ")}`);
  }
  const textFiles = ["package.json", "bun.lock", "deno.lock", "supabase/config.toml"];
  const wfDir = path.join(root, ".github/workflows");
  if (fs.existsSync(wfDir)) for (const f of fs.readdirSync(wfDir)) if (/\.ya?ml$/.test(f)) textFiles.push(`.github/workflows/${f}`);
  const configFiles = [];
  const findConfigs = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!["node_modules", ".git", "dist", "vendor"].includes(e.name)) findConfigs(p); }
    else if (/^(?:deno\.jsonc?|import_map[\w.-]*\.json)$/.test(e.name)) configFiles.push(posix(path.relative(root, p)));
  });
  findConfigs(root);
  for (const rel of [...textFiles, ...configFiles]) {
    const t = read(rel)?.toString("utf8");
    if (t && FORBIDDEN_HOST.test(t)) v.push(`${rel} names sheetjs.com; SheetJS is vendored (vendor/sheetjs/PROVENANCE.md)`);
  }
  const denoLock = read("deno.lock")?.toString("utf8");
  if (denoLock) {
    for (const m of denoLock.matchAll(/"(https?:\/\/[^"]+)"/g)) {
      const host = remoteHost(m[1]);
      if (!DENO_REMOTE_HOSTS.includes(host)) v.push(`deno.lock names ${m[1]}: host ${host} is not reviewed`);
      else if (SHEETJS_NAME.test(new URL(m[1]).pathname)) v.push(`deno.lock names ${m[1]}: SheetJS is vendored, never fetched`);
    }
  }
  for (const rel of configFiles) {
    let json;
    try { json = JSON.parse(read(rel).toString("utf8")); } catch { v.push(`${rel} is not valid JSON`); continue; }
    const values = [];
    const collect = (o) => { if (typeof o === "string") values.push(o); else if (o && typeof o === "object") Object.values(o).forEach(collect); };
    collect(json.imports ?? {}); collect(json.scopes ?? {}); collect(json.compilerOptions ?? {});
    for (const spec of values) v.push(...specifierViolations(root, spec, rel, path.join(root, rel)));
  }
  for (const dir of ["supabase", "scripts"]) {
    for (const file of sourceFiles(root, dir)) {
      const rel = posix(path.relative(root, file));
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(SPECIFIER)) v.push(...specifierViolations(root, m[2], rel, file));
    }
  }
  return [...new Set(v)];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? ".");
  const violations = checkVendoredDependencies(root);
  if (violations.length) {
    for (const x of violations) console.error(`VENDORED_DEPENDENCIES: ${x}`);
    process.exit(1);
  }
  const s = VENDORED.sheetjs;
  console.log(`VENDORED_DEPENDENCIES: OK (SheetJS ${s.version}: ${s.tarball.path} sha256 ${s.tarball.sha256}; ${s.files.length} vendored copies pinned and equal to the tarball; no sheetjs.com, no remote SheetJS import, Deno remote hosts ${DENO_REMOTE_HOSTS.join(", ")} only)`);
}
