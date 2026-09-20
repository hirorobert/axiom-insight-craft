#!/usr/bin/env node
// Build-output guard: a jurisdiction pack must live in its OWN lazily-loaded chunk. The entry chunks referenced by
// dist/index.html (and the modulepreload set) must carry no statutory jurisdiction wording, and the pack chunk must exist.
import fs from "node:fs";
import path from "node:path";

const DIST = path.resolve(process.argv[2] ?? "dist");
const html = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
const referenced = [...html.matchAll(/(?:src|href)="\/?(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
if (referenced.length === 0) throw new Error("no script chunk referenced by dist/index.html");

// Statutory wording that must never ship to a workspace that did not select the jurisdiction (reference data such as
// ISO-4217 currency names, e.g. "Tanzanian Shilling", is deliberately not covered).
const STATUTORY = /\b(ITA|EFDMS|TAA)\b|Tanzania(?!n Shilling)|Finance Act|Cap\.\s?332|TRA Audit|TRA-/;

const packChunks = fs.readdirSync(path.join(DIST, "assets")).filter((f) => /^tzPack-.*\.js$/.test(f));
if (packChunks.length !== 1) throw new Error(`expected exactly one tzPack chunk, found ${packChunks.length}`);
if (referenced.some((r) => r.includes("tzPack"))) throw new Error("the TZ pack chunk is referenced from index.html (statically loaded)");

const offenders = referenced.filter((r) => STATUTORY.test(fs.readFileSync(path.join(DIST, r), "utf8")));
if (offenders.length) throw new Error(`statutory wording found in entry chunk(s): ${offenders.join(", ")}`);
if (!STATUTORY.test(fs.readFileSync(path.join(DIST, "assets", packChunks[0]), "utf8"))) throw new Error("the pack chunk no longer carries its statutory content — the guard is vacuous");
console.log(`PACK_ISOLATION: OK (entry: ${referenced.join(", ")}; pack: assets/${packChunks[0]})`);
