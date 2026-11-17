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

// The provider's legal identity (commercial handoff Update 4, S1/S5; dossier 28.2 A2): the seller's country of registration, the
// Privacy Policy's hosting disclosure and the Terms' governing-law clause name the country of the PROVIDER, not a customer's tax
// regime. Exactly these sentences are removed from an entry chunk before the statutory test; anything else that names the country,
// and every statutory token, still fails. Keep in step with src/lib/commercial/businessIdentity.ts, Terms.tsx and Privacy.tsx.
const LEGAL_IDENTITY = [
  "registered in the United Republic of Tanzania under the Business Names Act",
  "Kati, Pangani, Tanzania",
  "Tanzania business name reg. 705538",
  "registration no. 705538, United Republic of Tanzania",
  "stored and processed outside Tanzania by the service providers",
  "laws of the United Republic of Tanzania, and the courts of Tanzania have",
];
const withoutLegalIdentity = (code) => LEGAL_IDENTITY.reduce((acc, phrase) => acc.split(phrase).join(" "), code);

const packChunks = fs.readdirSync(path.join(DIST, "assets")).filter((f) => /^tzPack-.*\.js$/.test(f));
if (packChunks.length !== 1) throw new Error(`expected exactly one tzPack chunk, found ${packChunks.length}`);
if (referenced.some((r) => r.includes("tzPack"))) throw new Error("the TZ pack chunk is referenced from index.html (statically loaded)");

const offenders = referenced.filter((r) => STATUTORY.test(withoutLegalIdentity(fs.readFileSync(path.join(DIST, r), "utf8"))));
if (offenders.length) throw new Error(`statutory wording found in entry chunk(s): ${offenders.join(", ")}`);
if (!STATUTORY.test(fs.readFileSync(path.join(DIST, "assets", packChunks[0]), "utf8"))) throw new Error("the pack chunk no longer carries its statutory content — the guard is vacuous");
console.log(`PACK_ISOLATION: OK (entry: ${referenced.join(", ")}; pack: assets/${packChunks[0]})`);
