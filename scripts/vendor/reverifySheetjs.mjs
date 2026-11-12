#!/usr/bin/env node
// Manual re-verification of the vendored SheetJS release against its publisher. NOT run by CI (it needs the network).
//
//   node scripts/vendor/reverifySheetjs.mjs
//
// 1. Downloads the release tarball from its source URL into memory and compares its size, SHA-256 and SHA-512 with the pins
//    in scripts/ci/assertVendoredDependencies.mjs, and its bytes with the committed vendor/sheetjs/xlsx-0.20.3.tgz.
// 2. Reads every file of the committed tarball's package/ directory from the tagged release source on git.sheetjs.com (the
//    API raw route at the pinned tag) and compares bytes.
// Nothing downloaded is written to disk, extracted to disk, imported or executed. Exit 0 means every comparison matched;
// exit 1 lists each mismatch or failed request. Record the run (date, result) in vendor/sheetjs/PROVENANCE.md when used.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTarball, VENDORED } from "../ci/assertVendoredDependencies.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const s = VENDORED.sheetjs;
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const problems = [];

async function get(url) {
  const res = await fetch(url, { redirect: "error" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const committed = fs.readFileSync(path.join(REPO, s.tarball.path));
let upstream = null;
try {
  upstream = await get(s.sourceUrl);
  const integrity = `sha512-${crypto.createHash("sha512").update(upstream).digest("base64")}`;
  console.log(`source   ${s.sourceUrl}: ${upstream.length} bytes, sha256 ${sha256(upstream)}`);
  if (upstream.length !== s.tarball.size) problems.push(`source tarball is ${upstream.length} bytes, pinned ${s.tarball.size}`);
  if (sha256(upstream) !== s.tarball.sha256) problems.push(`source tarball SHA-256 ${sha256(upstream)}, pinned ${s.tarball.sha256}`);
  if (integrity !== s.tarball.integrity) problems.push(`source tarball ${integrity}, pinned ${s.tarball.integrity}`);
  if (!upstream.equals(committed)) problems.push(`source tarball differs from the committed ${s.tarball.path}`);
} catch (e) {
  problems.push(`could not download the source tarball: ${e.message}`);
}

const members = readTarball(committed);
let same = 0;
for (const [member, bytes] of [...members].sort(([a], [b]) => a.localeCompare(b))) {
  const rel = member.replace(/^package\//, "");
  const url = `${s.tag.api}/raw/${rel.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(s.tag.ref)}`;
  try {
    const tagged = await get(url);
    if (tagged.equals(bytes)) same += 1;
    else problems.push(`${member}: tag ${s.tag.ref} has ${tagged.length} bytes sha256 ${sha256(tagged)}; tarball ${bytes.length} bytes sha256 ${sha256(bytes)}`);
  } catch (e) {
    problems.push(`${member}: ${e.message}`);
  }
}
console.log(`tag      ${s.tag.api} @ ${s.tag.ref} (commit ${s.tag.commit}): ${same} of ${members.size} tarball files identical`);

if (problems.length) {
  for (const p of problems) console.error(`REVERIFY_SHEETJS: ${p}`);
  process.exit(1);
}
console.log(`REVERIFY_SHEETJS: OK (SheetJS ${s.version}: the source tarball equals the committed one and the pins; every packaged file equals tag ${s.tag.ref})`);
